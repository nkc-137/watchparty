/**
 * ISOLATED-world content script. The hub of the client:
 *  - reads config from chrome.storage,
 *  - opens the socket to the sync server,
 *  - bridges page playback events <-> server events,
 *  - drives the chat/member overlay,
 *  - as host, broadcasts periodic drift-correction state.
 */
import { io, Socket } from "socket.io-client";
import { NS, FromPage, ApplyMsg } from "./bridge";
import {
  ClientToServerEvents,
  ServerToClientEvents,
  JoinRoomResult,
  SyncState,
  StoredConfig,
} from "./protocol";
import { mountChat, ChatUI } from "./chat";

type WPSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: WPSocket | null = null;
let ui: ChatUI | null = null;
let isHost = false;

// How far out of sync a follower tolerates before correcting. Fragile HTML5
// players (Prime, Tubi) prefer a looser threshold so we don't seek (and
// re-buffer) constantly.
const IS_FRAGILE_HTML5 = /primevideo\.com|amazon\.|tubitv\.com/.test(location.hostname);
const DRIFT_TOLERANCE_SEC = IS_FRAGILE_HTML5 ? 2.5 : 1;

// Latest known local player state (fed by the page's periodic samples).
let local: { position: number; playing: boolean; videoId: number | null } = {
  position: 0,
  playing: false,
  videoId: null,
};

// When we apply a remote command we briefly ignore our own resulting local
// events. The page also self-suppresses; this is belt-and-suspenders.
let applyingUntil = 0;

function toPage(msg: ApplyMsg) {
  window.postMessage(msg, "*");
}

// --- Page bridge -------------------------------------------------------------
window.addEventListener("message", (ev) => {
  if (ev.source !== window) return;
  const data = ev.data as FromPage;
  if (!data || data.ns !== NS || data.dir !== "fromPage") return;

  if (data.kind === "ready") {
    ui?.setStatus(data.ready ? statusText() : "waiting for player…");
    return;
  }
  if (data.kind === "state") {
    local = { position: data.position, playing: data.playing, videoId: data.videoId };
    return;
  }
  if (data.kind === "playback") {
    if (Date.now() < applyingUntil) return; // don't echo applied commands
    local.position = data.position;
    socket?.emit("playbackEvent", {
      action: data.action,
      position: data.position,
      at: Date.now(),
      videoId: data.videoId,
    });
  }
});

// --- Applying remote events --------------------------------------------------
function apply(action: "play" | "pause" | "seek", position: number) {
  applyingUntil = Date.now() + 700;
  toPage({ ns: NS, dir: "toPage", kind: "apply", action, position });
}

/** Where the source should be *now*, compensating for network latency. */
function projected(state: SyncState): number {
  const elapsed = state.playing ? (Date.now() - state.at) / 1000 : 0;
  return state.position + elapsed;
}

// --- Connection --------------------------------------------------------------
function statusText(): string {
  if (!socket?.connected) return "offline";
  return isHost ? "connected · host" : "connected";
}

function connect(cfg: StoredConfig) {
  disconnect();
  if (!ui) {
    ui = mountChat({
      onSend: (text) => socket?.emit("chatMessage", text),
      onReaction: (emoji) => {
        socket?.emit("reaction", emoji);
        ui?.showReaction({ name: cfg.name, emoji, at: Date.now() }); // instant local feedback
      },
      onResync: () => socket?.emit("requestSync"),
    });
  }
  applyPanelVisibility();
  ui.setStatus("connecting…");

  const s: WPSocket = io(cfg.serverUrl, {
    transports: ["websocket"],
    reconnection: true,
  });
  socket = s;

  s.on("connect", () => {
    s.emit(
      "joinRoom",
      { roomCode: cfg.roomCode, name: cfg.name, secret: cfg.secret },
      (res: JoinRoomResult) => {
        if (!res.ok) {
          ui?.setStatus(`join failed: ${res.error}`);
          return;
        }
        isHost = res.youAreHost;
        ui?.setMembers(res.members);
        ui?.setStatus(statusText());
        // Catch a late joiner up to the room's current position.
        if (res.state) apply(res.state.playing ? "play" : "pause", projected(res.state));
      }
    );
  });

  s.on("disconnect", () => ui?.setStatus("reconnecting…"));

  s.on("playbackEvent", (e) => apply(e.action, e.position));

  s.on("syncState", (state) => {
    if (isHost) return; // host is the authority; ignore its own echoes
    const target = projected(state);
    const drift = Math.abs(local.position - target);
    if (drift > DRIFT_TOLERANCE_SEC) apply("seek", target);
    if (state.playing !== local.playing) apply(state.playing ? "play" : "pause", target);
  });

  s.on("members", (members) => {
    isHost = members.find((m) => m.id === s.id)?.isHost ?? isHost;
    ui?.setMembers(members);
    ui?.setStatus(statusText());
  });

  s.on("hostChanged", (hostId) => {
    isHost = hostId === s.id;
    ui?.setStatus(statusText());
  });

  s.on("chatMessage", (msg) => ui?.addMessage(msg));

  // Show reactions from others (we already rendered our own optimistically).
  s.on("reaction", (r) => {
    if (r.name === cfg.name) return;
    ui?.showReaction(r);
  });

  // Host was asked to resync everyone: emit a fresh authoritative state.
  s.on("syncRequested", () => {
    if (!isHost) return;
    s.emit("syncState", {
      position: local.position,
      playing: local.playing,
      at: Date.now(),
      videoId: local.videoId,
    });
  });
}

function disconnect() {
  if (socket) {
    socket.emit("leaveRoom");
    socket.close();
    socket = null;
  }
  ui?.setStatus("offline");
}

/** Full teardown: drop the socket AND remove the overlay from the page. */
function teardown() {
  disconnect();
  document.getElementById("wp-root")?.remove();
  ui = null;
}

// Host broadcasts its authoritative state a few times a second's worth apart.
setInterval(() => {
  if (!socket?.connected || !isHost) return;
  socket.emit("syncState", {
    position: local.position,
    playing: local.playing,
    at: Date.now(),
    videoId: local.videoId,
  });
}, 3000);

// Round-trip latency probe → overlay badge.
setInterval(() => {
  if (!socket?.connected) {
    ui?.setLatency(null);
    return;
  }
  const t0 = Date.now();
  socket.emit("ping", () => ui?.setLatency(Date.now() - t0));
}, 5000);

// --- Config + SPA-navigation wiring ------------------------------------------
// The content script now loads on every Netflix page and survives Netflix's
// client-side (single-page-app) navigation. We connect only while on a
// /watch/ page with a "connected" config, and reconcile whenever either the
// URL or the stored config changes — so no manual reload is needed.
let cfgCache: StoredConfig | null = null;

/**
 * Whether a playable content page is open. Site-specific because the sites
 * differ: Netflix uses a /watch/ URL; Prime opens its player in-place (the URL
 * often doesn't change), so we detect a real content <video> in the DOM.
 */
function onWatchPage(): boolean {
  const host = location.hostname;
  if (host.includes("netflix.com")) return /\/watch\//.test(location.pathname);
  if (host.includes("youtube.com")) return location.pathname === "/watch";
  if (
    host.includes("primevideo.com") ||
    host.includes("amazon.") ||
    host.includes("tubitv.com")
  ) {
    // These sites have several <video> elements (the first often has no
    // duration); treat the page as "playing" if ANY video has a real content
    // duration.
    return Array.from(document.querySelectorAll("video")).some(
      (v) => isFinite(v.duration) && v.duration > 60
    );
  }
  return false;
}

function shouldConnect(): boolean {
  return !!(cfgCache && cfgCache.connected && cfgCache.serverUrl && cfgCache.roomCode && onWatchPage());
}

/** Show/hide the whole overlay (launcher + panel) per the popup toggle. */
function applyPanelVisibility() {
  const root = document.getElementById("wp-root");
  if (root) root.style.display = cfgCache?.showPanel === false ? "none" : "";
}

/** Connection-relevant config signature (excludes the display-only toggle). */
function connSig(c: StoredConfig | null): string {
  return c ? [c.connected, c.serverUrl, c.roomCode, c.name, c.secret].join("|") : "";
}

/** Bring actual state in line with desired state. */
function reconcile() {
  if (shouldConnect()) {
    if (!socket) connect(cfgCache!);
  } else if (socket || ui) {
    teardown();
  }
}

chrome.storage.local.get("wp", (r) => {
  cfgCache = (r.wp as StoredConfig) || null;
  reconcile();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.wp) return;
  const prevSig = connSig(cfgCache);
  cfgCache = (changes.wp.newValue as StoredConfig) || null;

  if (connSig(cfgCache) === prevSig) {
    // Only the display toggle changed — don't disturb the live connection.
    applyPanelVisibility();
    return;
  }
  // A connection-relevant field changed: tear down so it reconnects cleanly.
  teardown();
  reconcile();
});

// Re-evaluate every second. This catches SPA URL changes (Netflix
// browse -> watch) AND Prime opening/closing its player without a URL change.
// reconcile() is idempotent, so polling it is cheap and safe.
setInterval(reconcile, 1000);
window.addEventListener("popstate", reconcile);
