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
  StoredConfig,
  ContentInfo,
  Member,
  contentConflicts,
} from "./protocol";
import { mountChat, ChatUI } from "./chat";
import {
  connSig,
  driftToleranceFor,
  isWatchPage,
  planSync,
  projected,
  sameContent,
} from "./sync";

type WPSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: WPSocket | null = null;
let ui: ChatUI | null = null;
let isHost = false;

const DRIFT_TOLERANCE_SEC = driftToleranceFor(location.hostname);

// Latest known local player state (fed by the page's periodic samples).
let local: { position: number; playing: boolean; content: ContentInfo | null } = {
  position: 0,
  playing: false,
  content: null,
};

// Latest member list, kept so we can tell what the host is watching.
let members: Member[] = [];

// Whether our own player can keep playing. Reported to the server only on a
// flip, so a steady state costs nothing.
let localReady = true;

/** Tell the server when our player starts or stops buffering. */
function publishReady(buffering: boolean) {
  const ready = !buffering;
  if (ready === localReady) return;
  localReady = ready;
  socket?.emit("setReady", ready);
}

/** The host's content — the reference every mismatch is measured against. */
function hostContent(): ContentInfo | null {
  return members.find((m) => m.isHost)?.content ?? null;
}

/**
 * True when this tab is demonstrably on a different title than the host, in
 * which case we neither send nor apply playback events: our positions refer to
 * different videos, so acting on them would only scramble both sides.
 */
function offTitle(): boolean {
  return contentConflicts(local.content, hostContent());
}

/** Tell the server what we're watching whenever it changes. */
function publishContent(next: ContentInfo | null) {
  if (sameContent(local.content, next)) return;
  local.content = next;
  if (next && socket?.connected) socket.emit("setContent", next);
  refreshWarning();
}

/** Turn the member list into the one-line banner shown above the chat. */
function refreshWarning() {
  if (!ui) return;
  const host = members.find((m) => m.isHost);
  if (offTitle()) {
    const mine = local.content?.title;
    const theirs = host?.content?.title;
    ui.setWarning(
      `⚠️ You're watching ${mine ? `“${mine}”` : "a different title"}${
        theirs ? ` — the room is on “${theirs}”` : " — not what the room is on"
      }. Sync is paused until you open the same one.`
    );
    return;
  }
  const strays = members
    .filter((m) => !m.isHost && contentConflicts(m.content, hostContent()))
    .map((m) => m.name);
  ui.setWarning(
    strays.length
      ? `⚠️ ${strays.join(", ")} ${strays.length > 1 ? "are" : "is"} on a different title — not synced.`
      : null
  );
}

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
    local.position = data.position;
    local.playing = data.playing;
    publishContent(data.content);
    publishReady(data.buffering);
    return;
  }
  if (data.kind === "playback") {
    if (Date.now() < applyingUntil) return; // don't echo applied commands
    local.position = data.position;
    // Don't drag the room around from a different title.
    if (offTitle()) return;
    socket?.emit("playbackEvent", {
      action: data.action,
      position: data.position,
      at: Date.now(),
      content: data.content,
    });
  }
});

// --- Applying remote events --------------------------------------------------
function apply(action: "play" | "pause" | "seek", position: number) {
  applyingUntil = Date.now() + 700;
  toPage({ ns: NS, dir: "toPage", kind: "apply", action, position });
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
        // Instant local feedback; tagged with our own id so the echo is dropped.
        ui?.showReaction({ name: cfg.name, emoji, at: Date.now(), from: socket?.id ?? "" });
      },
      onResync: () => socket?.emit("requestSync"),
    });
  }
  applyPanelVisibility();
  ui.setStatus("connecting…");
  ui.setConn("reconnecting");

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
          ui?.setConn("offline");
          return;
        }
        isHost = res.youAreHost;
        members = res.members;
        ui?.setMembers(members);
        // Catch up on what was said before we arrived.
        if (res.history?.length) ui?.addHistory(res.history);
        ui?.setStatus(statusText());
        ui?.setConn("online");
        // Register what we're watching before anything else, so the room can
        // flag a mismatch immediately rather than after the first seek.
        if (local.content) s.emit("setContent", local.content);
        if (!localReady) s.emit("setReady", false);
        refreshWarning();
        // Catch a late joiner up to the room's current position — but only if
        // that position refers to the same title we have open.
        if (res.state && !contentConflicts(res.state.content, local.content)) {
          apply(res.state.playing ? "play" : "pause", projected(res.state));
        }
      }
    );
  });

  s.on("disconnect", () => {
    ui?.setStatus("reconnecting…");
    ui?.setConn("reconnecting");
  });

  s.on("playbackEvent", (e) => {
    // A position from a different title is meaningless here — drop it.
    if (contentConflicts(e.content, local.content)) return;
    apply(e.action, e.position);
  });

  s.on("syncState", (state) => {
    if (isHost) return; // host is the authority; ignore its own echoes
    if (contentConflicts(state.content, local.content)) return;
    const plan = planSync(local, state, DRIFT_TOLERANCE_SEC);
    if (plan.seek) apply("seek", plan.position);
    if (plan.setPlaying !== null) apply(plan.setPlaying ? "play" : "pause", plan.position);
  });

  s.on("members", (list) => {
    members = list;
    isHost = members.find((m) => m.id === s.id)?.isHost ?? isHost;
    ui?.setMembers(members);
    ui?.setStatus(statusText());
    refreshWarning();
  });

  s.on("hostChanged", (hostId) => {
    isHost = hostId === s.id;
    ui?.setStatus(statusText());
    refreshWarning();
  });

  // The room is parked until everyone has buffered. The server decides this;
  // we just obey and explain it. apply() suppresses the echo, so our own pause
  // is not reported back as a user action.
  s.on("hold", (state) => {
    ui?.setHold(state.waiting);
    apply("pause", state.position);
  });

  s.on("holdRelease", (release) => {
    ui?.setHold(null);
    if (release.play) apply("play", release.position);
  });

  s.on("chatMessage", (msg) => ui?.addMessage(msg));

  // Show reactions from others (we already rendered our own optimistically).
  s.on("reaction", (r) => {
    if (r.from === s.id) return;
    ui?.showReaction(r);
  });

  // Host was asked to resync everyone: emit a fresh authoritative state.
  s.on("syncRequested", () => {
    if (!isHost) return;
    s.emit("syncState", {
      position: local.position,
      playing: local.playing,
      at: Date.now(),
      content: local.content,
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
  ui?.setConn("offline");
}

/** Full teardown: drop the socket AND remove the overlay from the page. */
function teardown() {
  disconnect();
  members = [];
  localReady = true;
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
    content: local.content,
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

/** Gather the DOM inputs isWatchPage() needs. */
function onWatchPage(): boolean {
  const durations = Array.from(document.querySelectorAll("video")).map((v) => v.duration);
  return isWatchPage(location.hostname, location.pathname, durations);
}

function shouldConnect(): boolean {
  return !!(cfgCache && cfgCache.connected && cfgCache.serverUrl && cfgCache.roomCode && onWatchPage());
}

/** Show/hide the whole overlay (launcher + panel) per the popup toggle. */
function applyPanelVisibility() {
  const root = document.getElementById("wp-root");
  if (root) root.style.display = cfgCache?.showPanel === false ? "none" : "";
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
