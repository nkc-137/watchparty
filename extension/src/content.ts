/**
 * ISOLATED-world content script. The hub of the client:
 *  - reads config from chrome.storage,
 *  - opens the socket to the sync server,
 *  - bridges page playback events <-> server events,
 *  - drives the chat/member overlay,
 *  - as host, broadcasts periodic drift-correction state.
 */
import { io, Socket } from "socket.io-client";
import { NS, FromPage, ToPage } from "./bridge";
import {
  ClientToServerEvents,
  ServerToClientEvents,
  JoinRoomResult,
  StoredConfig,
  ContentInfo,
  Member,
  SyncState,
} from "./protocol";
import { mountChat, ChatUI } from "./chat";
import {
  clockSync,
  connSig,
  correctionRate,
  driftToleranceFor,
  isWatchPage,
  planSync,
  projected,
  sameContent,
  stallDetector,
} from "./sync";

type WPSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: WPSocket | null = null;
let ui: ChatUI | null = null;
let isHost = false;

const DRIFT_TOLERANCE_SEC = driftToleranceFor(location.hostname);

// Latest known local player state (fed by the page's periodic samples).
// `sampledAt` is local wall-clock ms when `position` was read.
let local: {
  position: number;
  playing: boolean;
  content: ContentInfo | null;
  sampledAt: number;
} = {
  position: 0,
  playing: false,
  content: null,
  sampledAt: Date.now(),
};

// Local-to-server clock offset. Every `at` we send is in server time, and every
// `at` we receive is projected against server time, so two members' clocks
// disagreeing no longer shows up as sync error.
const clock = clockSync();

/** A local sample's timestamp, in server time. */
const sampleAt = () => clock.now(local.sampledAt);

// Where the room should be: the latest authoritative state, kept between host
// heartbeats so the follower can steer toward it on every local sample.
let target: SyncState | null = null;
// Whether the room is parked waiting on someone to buffer.
let holding = false;

// Playback speed we last asked the page for (1 = not correcting).
let currentRate = 1;
function setRate(rate: number) {
  if (rate === currentRate) return;
  currentRate = rate;
  toPage({ ns: NS, dir: "toPage", kind: "rate", rate });
}

/**
 * Follower-side fine sync. Seeks handle big jumps (see the syncState handler);
 * everything under the seek threshold is closed by nudging playback speed,
 * which converges without a re-buffer.
 */
function steer(buffering: boolean) {
  const canSteer =
    !isHost &&
    !holding &&
    !buffering &&
    target?.playing &&
    local.playing &&
    socket?.connected &&
    Date.now() >= applyingUntil;
  if (!canSteer || !target) {
    setRate(1);
    return;
  }
  const drift = local.position - projected(target, sampleAt());
  // Past the seek threshold a seek is on its way; don't fight it with speed.
  if (Math.abs(drift) > DRIFT_TOLERANCE_SEC) {
    setRate(1);
    return;
  }
  setRate(correctionRate(drift, currentRate !== 1));
}

// Latest member list.
let members: Member[] = [];

// Whether our own player can keep playing. Reported to the server only on a
// flip, so a steady state costs nothing.
let localReady = true;
// Rides out the brief re-buffer after a seek so it doesn't hold the room.
const stall = stallDetector();

/** Tell the server when our player starts or stops buffering. */
function publishReady(buffering: boolean) {
  const ready = stall.ready(buffering);
  if (ready === localReady) return;
  localReady = ready;
  socket?.emit("setReady", ready);
}

/** Tell the server what we're watching whenever it changes. */
function publishContent(next: ContentInfo | null) {
  if (sameContent(local.content, next)) return;
  local.content = next;
  if (next && socket?.connected) socket.emit("setContent", next);
}

// When we apply a remote command we briefly ignore our own resulting local
// events. The page also self-suppresses; this is belt-and-suspenders.
let applyingUntil = 0;

function toPage(msg: ToPage) {
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
    local.sampledAt = data.sampledAt;
    publishContent(data.content);
    publishReady(data.buffering);
    steer(data.buffering);
    return;
  }
  if (data.kind === "playback") {
    if (Date.now() < applyingUntil) return; // don't echo applied commands
    local.position = data.position;
    local.sampledAt = data.sampledAt;
    socket?.emit("playbackEvent", {
      action: data.action,
      position: data.position,
      at: sampleAt(),
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
  clock.reset();

  s.on("connect", () => {
    // A quick burst so the clock offset is good within a second or two,
    // rather than waiting on the slow latency-badge probe.
    for (let i = 0; i < 5; i++) setTimeout(probe, i * 250);
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
        if (local.content) s.emit("setContent", local.content);
        if (!localReady) s.emit("setReady", false);
        // Catch a late joiner up to the room's current position.
        if (res.state) {
          target = res.state;
          apply(res.state.playing ? "play" : "pause", projected(res.state, clock.now()));
        }
      }
    );
  });

  s.on("disconnect", () => {
    ui?.setStatus("reconnecting…");
    ui?.setConn("reconnecting");
  });

  s.on("playbackEvent", (e) => {
    // The event spent time on the wire; if the room is (still) playing, the
    // sender has moved on since. A seek keeps whatever play state we're in.
    const playing = e.action === "play" || (e.action === "seek" && local.playing);
    const ev: SyncState = { position: e.position, playing, at: e.at };
    target = ev;
    apply(e.action, projected(ev, clock.now()));
  });

  s.on("syncState", (state) => {
    if (isHost) return; // host is the authority; ignore its own echoes
    target = state;
    const plan = planSync(
      { position: local.position, playing: local.playing },
      state,
      DRIFT_TOLERANCE_SEC,
      sampleAt()
    );
    if (plan.seek) apply("seek", plan.position);
    if (plan.setPlaying !== null) apply(plan.setPlaying ? "play" : "pause", plan.position);
  });

  s.on("members", (list) => {
    members = list;
    isHost = members.find((m) => m.id === s.id)?.isHost ?? isHost;
    ui?.setMembers(members);
    ui?.setStatus(statusText());
  });

  s.on("hostChanged", (hostId) => {
    isHost = hostId === s.id;
    if (isHost) setRate(1); // the host is the reference; it never steers
    ui?.setStatus(statusText());
  });

  // The room is parked until everyone has buffered. The server decides this;
  // we just obey and explain it. apply() suppresses the echo, so our own pause
  // is not reported back as a user action.
  s.on("hold", (state) => {
    holding = true;
    target = { position: state.position, playing: false, at: clock.now() };
    ui?.setHold(state.waiting);
    apply("pause", state.position);
  });

  s.on("holdRelease", (release) => {
    holding = false;
    target = { position: release.position, playing: release.play, at: clock.now() };
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
    if (isHost) broadcastState();
  });
}

/** Host: send our authoritative position, stamped with when it was read. */
function broadcastState() {
  socket?.emit("syncState", {
    position: local.position,
    playing: local.playing,
    at: sampleAt(),
    content: local.content,
  });
}

/** One ping: feeds the clock offset and the latency badge. */
function probe() {
  const s = socket;
  if (!s?.connected) return;
  const t0 = Date.now();
  s.emit("ping", (serverTime) => {
    const t1 = Date.now();
    clock.add(t0, serverTime, t1);
    ui?.setLatency(t1 - t0);
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
  target = null;
  holding = false;
  setRate(1);
  stall.reset();
  document.getElementById("wp-root")?.remove();
  ui = null;
}

// Host heartbeat. Followers project between beats, but the host's own player
// doesn't advance at exactly wall-clock speed (micro-stalls, frame drops), so
// a frequent beat keeps the target honest. One tiny message a second.
setInterval(() => {
  if (socket?.connected && isHost) broadcastState();
}, 1000);

// Latency badge + clock-offset refresh.
setInterval(() => {
  if (!socket?.connected) ui?.setLatency(null);
  else probe();
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

/** Master switch: off means fully dormant — no socket, no overlay, no events. */
function isEnabled(): boolean {
  return cfgCache?.enabled !== false; // default on
}

function shouldConnect(): boolean {
  return !!(isEnabled() && cfgCache && cfgCache.connected && cfgCache.serverUrl && cfgCache.roomCode && onWatchPage());
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
