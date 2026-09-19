/**
 * MAIN-world script. This is the ONLY file that touches Netflix's private
 * player API — if Netflix changes it, this is the one place to fix.
 *
 * Runs in the page's JS context so `netflix.appContext` is visible. It:
 *  - grabs the active player,
 *  - detects local play/pause/seek and reports them to the content script,
 *  - applies remote commands received from the content script,
 *  - emits a periodic state sample for host drift broadcasts.
 */
import { NS, FromPage, ToPage, ApplyMsg } from "./bridge";

// Netflix's globals are untyped; keep the surface tiny and defensive.
declare const netflix: any;

interface NetflixPlayer {
  getCurrentTime(): number; // ms
  seek(ms: number): void;
  play(): void;
  pause(): void;
  isPaused?(): boolean;
  getDuration?(): number;
}

function getPlayer(): NetflixPlayer | null {
  try {
    const videoPlayer =
      netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
    if (!videoPlayer) return null;
    const ids = videoPlayer.getAllPlayerSessionIds?.() || [];
    if (!ids.length) return null;
    return videoPlayer.getVideoPlayerBySessionId(ids[0]) || null;
  } catch {
    return null;
  }
}

function currentVideoId(): number | null {
  try {
    const sessions =
      netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
    const ids = sessions?.getAllPlayerSessionIds?.() || [];
    // Session id looks like "watch-<movieId>-..."; extract the numeric part.
    const m = /(\d+)/.exec(ids[0] || "");
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function post(msg: FromPage) {
  window.postMessage(msg, "*");
}

// --- Applying remote commands -------------------------------------------------
// When we apply a remote command we must not echo it back as a local event.
// A short suppression window after each self-initiated seek/play/pause does that.
let suppressUntil = 0;
function suppress(ms = 700) {
  suppressUntil = Date.now() + ms;
}

window.addEventListener("message", (ev) => {
  const data = ev.data as ToPage;
  if (!data || data.ns !== NS || data.dir !== "toPage") return;
  const p = getPlayer();
  if (!p) return;
  const cmd = data as ApplyMsg;
  suppress();
  if (cmd.action === "seek") p.seek(Math.round(cmd.position * 1000));
  else if (cmd.action === "play") {
    p.seek(Math.round(cmd.position * 1000));
    p.play();
  } else if (cmd.action === "pause") {
    p.seek(Math.round(cmd.position * 1000));
    p.pause();
  }
});

// --- Detecting local playback changes ----------------------------------------
let lastPaused: boolean | null = null;
let lastTime = 0; // seconds
let ready = false;

function sample() {
  const p = getPlayer();
  if (!p) {
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

  const time = p.getCurrentTime() / 1000; // seconds
  const paused = p.isPaused ? p.isPaused() : false;
  const vid = currentVideoId();
  const now = Date.now();
  const suppressed = now < suppressUntil;

  // Detect a manual seek: playback position jumped more than playback+tick
  // would explain (~0.6s of real time between 500ms samples).
  const drift = Math.abs(time - lastTime);
  const expected = paused ? 0 : 0.8;
  if (!suppressed && lastPaused !== null && drift > 1.5 + expected) {
    post({ ns: NS, dir: "fromPage", kind: "playback", action: "seek", position: time, videoId: vid });
  }

  // Detect play/pause transitions.
  if (!suppressed && lastPaused !== null && paused !== lastPaused) {
    post({
      ns: NS,
      dir: "fromPage",
      kind: "playback",
      action: paused ? "pause" : "play",
      position: time,
      videoId: vid,
    });
  }

  // Periodic state sample (content script decides whether to broadcast as host).
  post({ ns: NS, dir: "fromPage", kind: "state", position: time, playing: !paused, videoId: vid });

  lastPaused = paused;
  lastTime = time;
}

setInterval(sample, 500);
