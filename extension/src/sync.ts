/**
 * Pure sync logic, deliberately free of DOM, chrome.* and socket access.
 *
 * This is the arithmetic and the decisions — where the host "really" is now,
 * whether we are far enough out to correct, whether a page is watchable, and
 * whether a config change is worth reconnecting for. Keeping it separate from
 * content.ts (which owns the socket, the overlay and the page bridge) is what
 * makes it testable in plain Node; content.ts stays the thin layer that gathers
 * inputs and applies results.
 */
import { ContentInfo, StoredConfig, SyncState } from "./protocol";

/** Sites whose HTML5 players re-buffer badly, so they get more slack. */
const FRAGILE_HTML5 = /primevideo\.com|amazon\.|tubitv\.com|pluto\.tv|einthusan\./;

/**
 * How far out of sync a follower tolerates before *seeking*. Drift below this
 * is not ignored: it is closed with a small playback-rate nudge (see
 * correctionRate), which costs no re-buffer. The fragile HTML5 players get a
 * wider seek threshold because a seek there is a visible stall.
 */
export function driftToleranceFor(hostname: string): number {
  return FRAGILE_HTML5.test(hostname) ? 2.5 : 1;
}

/**
 * Where the source should be *now*. A state travels to us over the network and
 * then sits in a queue, so its position is already stale on arrival; if it was
 * playing when sent, we add the time since.
 */
export function projected(state: SyncState, now = Date.now()): number {
  const elapsed = state.playing ? (now - state.at) / 1000 : 0;
  return state.position + elapsed;
}

/** What a follower should do about an incoming authoritative state. */
export interface SyncPlan {
  /** The position both actions refer to. */
  position: number;
  /** Whether we are far enough out to be worth a corrective seek. */
  seek: boolean;
  /** true = play, false = pause, null = playback state already matches. */
  setPlaying: boolean | null;
}

/**
 * Decide how to reconcile with the host. Seeking and play/pause are decided
 * independently: a follower can be at the right spot but paused, or playing but
 * drifted, and each needs its own correction.
 */
export function planSync(
  local: { position: number; playing: boolean },
  state: SyncState,
  toleranceSec: number,
  now = Date.now()
): SyncPlan {
  const position = projected(state, now);
  return {
    position,
    seek: Math.abs(local.position - position) > toleranceSec,
    setPlaying: state.playing === local.playing ? null : state.playing,
  };
}

/**
 * Whether a playable content page is open.
 *
 * Site-specific because the sites differ: Netflix and YouTube say so in the
 * URL, while Prime opens its player in place without a navigation, so the only
 * honest signal is a real content <video> in the DOM. Several videos are
 * normal (ads, trailers, previews), hence "any with a feature-length duration"
 * rather than "the first one".
 */
export function isWatchPage(
  hostname: string,
  pathname: string,
  videoDurations: number[]
): boolean {
  if (hostname.includes("netflix.com")) return /\/watch\//.test(pathname);
  if (hostname.includes("youtube.com")) return pathname === "/watch";
  if (
    hostname.includes("primevideo.com") ||
    hostname.includes("amazon.") ||
    hostname.includes("tubitv.com") ||
    hostname.includes("pluto.tv") ||
    hostname.includes("einthusan.")
  ) {
    return videoDurations.some((d) => isFinite(d) && d > 60);
  }
  return false;
}

/**
 * Connection-relevant config signature. Excludes display-only settings, so
 * toggling the overlay doesn't tear down a live connection mid-film.
 */
export function connSig(c: StoredConfig | null): string {
  return c
    ? [c.enabled !== false, c.connected, c.serverUrl, c.roomCode, c.name, c.secret].join("|")
    : "";
}

/** Whether two content descriptions are the same, nulls included. */
export function sameContent(
  a: ContentInfo | null,
  b: ContentInfo | null
): boolean {
  if (!a || !b) return a === b;
  return a.site === b.site && a.id === b.id && a.title === b.title;
}

/**
 * How long buffering must last before we call ourselves stalled. Every seek
 * re-buffers briefly — Prime's for most of a second — and reporting that
 * would park the whole room (including us) for a pause-then-resume hitch on
 * every skip. A real stall outlasts this easily.
 */
export const STALL_GRACE_MS = 1500;

/**
 * Turns raw "is the player buffering?" samples into "can we keep playing?",
 * treating buffering as a stall only once it has lasted `graceMs`.
 */
export function stallDetector(graceMs = STALL_GRACE_MS) {
  let since: number | null = null;
  return {
    /** Feed one sample; returns whether we are ready (not stalled). */
    ready(buffering: boolean, now = Date.now()): boolean {
      if (!buffering) {
        since = null;
        return true;
      }
      if (since === null) since = now;
      return now - since < graceMs;
    },
    reset() {
      since = null;
    },
  };
}

// --- Clock sync -----------------------------------------------------------------

/**
 * Estimates the offset between this machine's clock and the server's, NTP-style.
 *
 * Every `at` on the wire is a wall-clock timestamp that a *different* machine
 * projects from, so any skew between two laptops' clocks lands directly in the
 * sync error — a host whose clock runs a second fast makes every follower trail
 * by a second. Converting all timestamps to server time removes that, and it
 * also makes them consistent with the `at`s the server stamps itself.
 *
 * Each ping gives `offset = server - midpoint(send, receive)`, accurate to ±RTT/2.
 * The sample with the lowest RTT is the least distorted by queueing, so we keep
 * a short window and trust the fastest one.
 */
export function clockSync(window = 8) {
  const samples: { rtt: number; offset: number }[] = [];
  let best = 0;
  return {
    /** Record one ping: local send time, server's reply time, local receive time. */
    add(sentAt: number, serverTime: number, receivedAt: number) {
      const rtt = receivedAt - sentAt;
      if (!(rtt >= 0) || !isFinite(serverTime)) return;
      samples.push({ rtt, offset: serverTime - (sentAt + receivedAt) / 2 });
      if (samples.length > window) samples.shift();
      best = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset;
    },
    /** server time ≈ local time + offset(). 0 until the first sample. */
    offset: () => best,
    /** Current server time, by this machine's estimate. */
    now: (local = Date.now()) => local + best,
    reset() {
      samples.length = 0;
      best = 0;
    },
  };
}

// --- Soft drift correction ----------------------------------------------------

/** Below this, drift is noise (sample jitter, half-RTT error) — leave it alone. */
export const RATE_DEADBAND_SEC = 0.15;
/** Once correcting, keep going until this close, so we don't hover at the edge. */
export const RATE_SETTLE_SEC = 0.05;
/** How far playback speed may be nudged. ±10% is hard to notice with pitch kept. */
export const RATE_MAX_DELTA = 0.1;
/** Aim to close the gap over roughly this many seconds. */
const RATE_HORIZON_SEC = 3;

/**
 * Playback rate that closes a small drift smoothly instead of seeking.
 *
 * Seeking costs a re-buffer, which on the fragile HTML5 players is most of a
 * second and itself lands you *behind* — so seeking can't buy anything finer than
 * about a second. Speeding up or slowing down slightly can: it converges to
 * within a frame or two without a visible hitch. Seeks stay for big jumps only.
 *
 * `drift` is local minus target, in seconds (positive = we're ahead).
 * `correcting` is whether the last call returned something other than 1, for
 * hysteresis.
 */
export function correctionRate(drift: number, correcting: boolean): number {
  const abs = Math.abs(drift);
  if (abs < (correcting ? RATE_SETTLE_SEC : RATE_DEADBAND_SEC)) return 1;
  const delta = Math.min(RATE_MAX_DELTA, abs / RATE_HORIZON_SEC);
  // Round to 0.01 so tiny wobbles don't spam the player with rate changes.
  return Math.round((drift > 0 ? 1 - delta : 1 + delta) * 100) / 100;
}
