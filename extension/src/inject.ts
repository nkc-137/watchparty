/**
 * MAIN-world script. Site-agnostic playback bridge.
 *
 * It selects a per-site PlayerAdapter (see ./players) and:
 *  - detects local play/pause/seek and reports them to the content script,
 *  - applies remote commands received from the content script,
 *  - emits a periodic state sample for host drift broadcasts.
 *
 * All site-specific player access lives in ./players/* — this file is generic.
 */
import { NS, FromPage, ToPage, ApplyMsg } from "./bridge";
import { ContentInfo } from "./protocol";
import { selectAdapter, PlayerAdapter } from "./players";

const adapter: PlayerAdapter | null = selectAdapter();

/** What this tab is playing, re-read each sample so SPA navigation is picked up. */
function readContent(): ContentInfo | null {
  if (!adapter) return null;
  return { site: adapter.name, id: adapter.contentId(), title: adapter.title() };
}

function post(msg: FromPage) {
  window.postMessage(msg, "*");
}

// --- Applying remote commands -------------------------------------------------
// When we apply a remote command we must not echo it back as a local event.
// A short suppression window after each self-initiated seek/play/pause does that.
let suppressUntil = 0;

// Drift-correction speed the content script asked for. Re-applied on every
// sample while active, because sites swap <video> elements (next episode, ad
// breaks) and some reset playbackRate themselves. At 1 we leave the element
// alone, so a speed the viewer picked by hand is not overridden.
let desiredRate = 1;
function suppress(ms = 700) {
  suppressUntil = Date.now() + ms;
}

// Seek rate-limiting: fragile players (Prime) break under rapid/large seeks, so
// we enforce a per-adapter minimum gap and coalesce bursts to the latest target.
const minSeekMs = adapter?.minSeekIntervalMs ?? 0;
let lastSeekAt = 0;
let pendingSeek: number | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

function doSeek(pos: number) {
  suppress();
  adapter!.seek(pos);
  lastSeekAt = Date.now();
}

function requestSeek(pos: number) {
  const wait = minSeekMs - (Date.now() - lastSeekAt);
  if (wait <= 0) {
    doSeek(pos);
    return;
  }
  // Too soon — remember the latest target and flush when the window elapses.
  pendingSeek = pos;
  if (!pendingTimer) {
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      if (pendingSeek !== null) {
        doSeek(pendingSeek);
        pendingSeek = null;
      }
    }, wait);
  }
}

/** Only re-seek on play/pause if we're off by more than the adapter tolerates. */
function alignForPlayPause(pos: number) {
  const thr = adapter!.playPauseDriftSec ?? 0;
  if (thr === 0 || Math.abs(adapter!.getTime() - pos) > thr) requestSeek(pos);
}

window.addEventListener("message", (ev) => {
  const data = ev.data as ToPage;
  if (!data || data.ns !== NS || data.dir !== "toPage") return;
  if (!adapter || !adapter.available()) return;
  if (data.kind === "rate") {
    desiredRate = data.rate;
    adapter.setRate?.(desiredRate);
    return;
  }
  const cmd = data as ApplyMsg;
  if (cmd.action === "seek") requestSeek(cmd.position);
  else if (cmd.action === "play") {
    alignForPlayPause(cmd.position);
    suppress();
    adapter.play();
  } else if (cmd.action === "pause") {
    alignForPlayPause(cmd.position);
    suppress();
    adapter.pause();
  }
});

// --- Detecting local playback changes ----------------------------------------
let lastPaused: boolean | null = null;
let lastTime = 0; // seconds
let lastSampleAt = Date.now();
let ready = false;

function sample() {
  if (!adapter || !adapter.available()) {
    if (ready) {
      ready = false;
      post({ ns: NS, dir: "fromPage", kind: "ready", ready: false });
    }
    return;
  }
  if (!ready) {
    ready = true;
    post({ ns: NS, dir: "fromPage", kind: "ready", ready: true });
  }

  if (desiredRate !== 1) adapter.setRate?.(desiredRate);

  const time = adapter.getTime(); // seconds
  const paused = adapter.isPaused();
  const content = readContent();
  const buffering = adapter.isBuffering?.() ?? false;
  const now = Date.now();
  const suppressed = now < suppressUntil;

  // Detect a manual seek: playback position jumped more than playback+tick
  // would explain. Measured against real elapsed time (timers get throttled in
  // background tabs) and allowing for a rate nudge of up to ~10%.
  const drift = Math.abs(time - lastTime);
  const expected = paused ? 0 : ((now - lastSampleAt) / 1000) * 1.15 + 0.3;
  if (!suppressed && lastPaused !== null && drift > 1.5 + expected) {
    post({ ns: NS, dir: "fromPage", kind: "playback", action: "seek", position: time, content, sampledAt: now });
  }

  // Detect play/pause transitions.
  if (!suppressed && lastPaused !== null && paused !== lastPaused) {
    post({
      ns: NS,
      dir: "fromPage",
      kind: "playback",
      action: paused ? "pause" : "play",
      position: time,
      content,
      sampledAt: now,
    });
  }

  // Periodic state sample (content script decides whether to broadcast as host).
  post({
    ns: NS,
    dir: "fromPage",
    kind: "state",
    position: time,
    playing: !paused,
    content,
    buffering,
    sampledAt: now,
  });

  lastPaused = paused;
  lastTime = time;
  lastSampleAt = now;
}

if (adapter) setInterval(sample, 250);
