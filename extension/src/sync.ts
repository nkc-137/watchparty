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
const FRAGILE_HTML5 = /primevideo\.com|amazon\.|tubitv\.com|pluto\.tv/;

/**
 * How far out of sync a follower tolerates before correcting. A tight
 * threshold keeps Netflix and YouTube crisp; the fragile HTML5 players would
 * seek (and re-buffer) constantly at that tolerance, which looks far worse than
 * being a second or two off.
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
    hostname.includes("pluto.tv")
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
  return c ? [c.connected, c.serverUrl, c.roomCode, c.name, c.secret].join("|") : "";
}

/** Whether two content descriptions are the same, nulls included. */
export function sameContent(
  a: ContentInfo | null,
  b: ContentInfo | null
): boolean {
  if (!a || !b) return a === b;
  return a.site === b.site && a.id === b.id && a.title === b.title;
}
