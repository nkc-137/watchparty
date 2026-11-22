/**
 * ISOLATED-world content script. The hub of the client:
 *  - connects only while this tab holds the party (see partyClient.ts),
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
import { isOurMessage, ContentApi, ContentRequest } from "./messages";
import { ConnParams, connKey, desiredConnection } from "./party";
import { followParty } from "./partyClient";
import {
  clockSync,
  correctionRate,
  driftToleranceFor,
  isWatchPage,
  planSync,
  projected,
  sameContent,
  seqGate,
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
// Orders host heartbeats against playback events, so a stale beat can't undo a seek.
const seqs = seqGate();

/**
 * Host: once our player has actually reached the latest relayed event's
 * target, our heartbeats describe the room again. Until then they describe
 * where it *was*, and the server would (rightly) drop them.
 */
function noteCaughtUp() {
  if (!isHost || !seqs.behind() || !target || Date.now() < applyingUntil) return;
  if (local.playing !== target.playing) return;
  if (Math.abs(local.position - projected(target, sampleAt())) > DRIFT_TOLERANCE_SEC) return;
  seqs.caughtUp();
}

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
    noteCaughtUp();
    steer(data.buffering);
    return;
  }
  if (data.kind === "playback") {
    if (Date.now() < applyingUntil) return; // don't echo applied commands
    local.position = data.position;
    local.sampledAt = data.sampledAt;
    const at = sampleAt();
    // We are where the room is going now; steer toward it, not the old target.
    const playing = data.action === "play" || (data.action === "seek" && local.playing);
    target = { position: data.position, playing, at };
    const s = socket;
    if (!s?.connected) return;
    seqs.sent();
    s.emit(
      "playbackEvent",
      { action: data.action, position: data.position, at, content: data.content },
      (seq) => seqs.acked(seq)
    );
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

function connect(cfg: ConnParams) {
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
        seqs.reset(res.seq ?? 0);
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
    if (typeof e.seq === "number") seqs.received(e.seq);
    apply(e.action, projected(ev, clock.now()));
  });

  s.on("syncState", (state) => {
    if (isHost) return; // host is the authority; ignore its own echoes
    // Sampled before the latest seek/play/pause took effect (ours included).
    if (!seqs.accepts(state)) return;
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
    if (isHost) {
      setRate(1); // the host is the reference; it never steers
      seqs.caughtUp(); // and whatever our player shows is now the room's truth
    }
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
    seq: seqs.stamp(),
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
  seqs.reset();
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
// The content script loads on every page of a supported site and survives
// their client-side (single-page-app) navigation. Whether to be connected, and
// to which room, is recomputed from three inputs whenever any of them changes:
// the master switch, whether *this tab* holds the party, and whether a title
// is open. Only a change in the resulting connection reconnects.

// Local preferences: the master switch and the overlay toggle. Null until
// read, and nothing connects before then — so a disabled extension never
// briefly comes alive on page load.
let prefs: StoredConfig | null = null;
let prefsLoaded = false;

// Identity of the connection we currently hold ("" for none).
let activeKey = "";

const party = followParty(reconcile);

/** Gather the DOM inputs isWatchPage() needs. */
function onWatchPage(): boolean {
  const durations = Array.from(document.querySelectorAll("video")).map((v) => v.duration);
  return isWatchPage(location.hostname, location.pathname, durations);
}

/** Master switch: off means fully dormant — no socket, no overlay, no events. */
function isEnabled(): boolean {
  return prefsLoaded && prefs?.enabled !== false; // default on, once known
}

/** Show/hide the whole overlay (launcher + panel) per the popup toggle. */
function applyPanelVisibility() {
  const root = document.getElementById("wp-root");
  if (root) root.style.display = prefs?.showPanel === false ? "none" : "";
}

/** Bring actual state in line with desired state. Idempotent, so cheap to poll. */
function reconcile() {
  const want = desiredConnection({
    enabled: isEnabled(),
    conn: party.current(),
    onWatchPage: onWatchPage(),
  });
  const key = connKey(want);
  if (key === activeKey) return;
  activeKey = key;
  // Leave the old room completely before joining another, so one tab is
  // never a member twice.
  teardown();
  if (want) connect(want);
}

chrome.storage.local.get("wp", (r) => {
  prefs = (r.wp as StoredConfig) || null;
  prefsLoaded = true;
  reconcile();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.wp) return;
  prefs = (changes.wp.newValue as StoredConfig) || null;
  applyPanelVisibility(); // display-only; never reconnects
  reconcile();
});

// The popup asks whether this tab can host the party before binding it.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !isOurMessage(msg)) return;
  if ((msg as ContentRequest).type !== "wp:probe") return;
  const reply: ContentApi["wp:probe"]["res"] = { onWatchPage: onWatchPage() };
  sendResponse(reply);
});

// Re-evaluate every second. This catches SPA URL changes (Netflix
// browse -> watch) AND Prime opening/closing its player without a URL change.
setInterval(reconcile, 1000);
window.addEventListener("popstate", reconcile);
