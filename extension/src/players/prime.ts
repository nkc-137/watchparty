/**
 * Amazon Prime Video adapter. Prime plays through a standard HTML5 <video>
 * element. Its raw seek is fragile (rapid/large seeks crash the DRM pipeline
 * with "Video Unavailable"), so we throttle seeks and don't seek on a plain
 * pause unless meaningfully out of position.
 *
 * Positions are reported and applied in *content* time, not the <video>'s
 * stream time. Prime splices ads into the stream, so `currentTime` is
 * ahead of the scene by the length of every ad break so far, and the amount
 * differs between viewers. See ./primeClock.
 */
import { htmlVideoAdapter } from "./htmlVideo";
import { idFromUrl } from "./identity";
import { contentVideo } from "./media";
import { parsePrimeElapsed, primeClock } from "./primeClock";
import { PlayerAdapter } from "./types";

/** ASIN/GTI from the detail URL. */
export const PRIME_ID_PATTERNS = [
  /[?&]gti=([A-Za-z0-9.]+)/,
  /\/detail\/([A-Za-z0-9]{8,})/,
  /\/gp\/video\/detail\/([A-Za-z0-9]{8,})/,
];

/** Prime's "elapsed / total" time display in the player chrome. */
const TIME_INDICATOR = ".atvwebplayersdk-timeindicator-text";

/** Content seconds shown in Prime's own player UI, or null if not readable. */
function displayedTime(v: HTMLVideoElement): number | null {
  for (const el of Array.from(document.querySelectorAll(TIME_INDICATOR))) {
    const t = parsePrimeElapsed(el.textContent);
    // Content time can never exceed the stream it lives in.
    if (t !== null && (!isFinite(v.duration) || t <= v.duration + 1)) return t;
  }
  return null;
}

const base = htmlVideoAdapter({
  name: "prime",
  minSeekIntervalMs: 1500,
  playPauseDriftSec: 2.5,
  // Prime identifies a title by an ASIN/GTI in the detail URL. Note this is
  // series-level for episodic content, so it catches "wrong show" but not
  // always "wrong episode".
  contentId: () => idFromUrl(PRIME_ID_PATTERNS),
});

const clock = primeClock();
let clockVideo: HTMLVideoElement | null = null;

/** The content video, with the ad-offset clock fed from its latest sample. */
function track(): HTMLVideoElement | null {
  const v = contentVideo();
  if (!v) return null;
  if (v !== clockVideo) {
    // A new element (next episode, player rebuilt) has its own timeline.
    clock.reset();
    clockVideo = v;
  }
  clock.observe(v.currentTime, displayedTime(v));
  return v;
}

export const primeAdapter: PlayerAdapter = {
  ...base,
  getTime: () => {
    const v = track();
    return v ? clock.content(v.currentTime) : 0;
  },
  seek: (s) => {
    const v = track();
    if (v) v.currentTime = clock.stream(s);
  },
  consumeTimelineJump: () => clock.takeAdJump(),
};
