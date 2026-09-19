/**
 * Amazon Prime Video adapter. Prime plays through a standard HTML5 <video>
 * element, so we control it directly — no private API needed.
 *
 * The tricky part is picking the *content* video: Prime may have several
 * <video> elements (ads, trailers, previews). We choose the largest on-screen
 * video that has a real duration, which is the main feature during playback.
 */
import { PlayerAdapter } from "./types";

function contentVideo(): HTMLVideoElement | null {
  const vids = Array.from(document.querySelectorAll("video")) as HTMLVideoElement[];
  let best: HTMLVideoElement | null = null;
  let bestArea = 0;
  for (const v of vids) {
    if (!isFinite(v.duration) || v.duration <= 0) continue;
    const r = v.getBoundingClientRect();
    const area = r.width * r.height;
    if (area >= bestArea) {
      best = v;
      bestArea = area;
    }
  }
  // Fall back to any video if none reported a duration yet.
  return best || vids[0] || null;
}

export const primeAdapter: PlayerAdapter = {
  name: "prime",
  // Prime's raw HTML5 seek is fragile: throttle seeks and don't seek on a
  // simple pause unless we're meaningfully out of position.
  minSeekIntervalMs: 1500,
  playPauseDriftSec: 2.5,
  // Consider a player "available" only once we have a real content video with a
  // meaningful duration — this keeps us off menu/trailer pages.
  available: () => {
    const v = contentVideo();
    return !!v && isFinite(v.duration) && v.duration > 60;
  },
  getTime: () => contentVideo()?.currentTime ?? 0,
  isPaused: () => contentVideo()?.paused ?? true,
  seek: (s) => {
    const v = contentVideo();
    if (v) v.currentTime = s;
  },
  play: () => {
    void contentVideo()?.play();
  },
  pause: () => contentVideo()?.pause(),
  videoId: () => {
    // Prime content ids (ASINs) are alphanumeric, not numeric, so we can't map
    // them to a number. videoId is only a cosmetic sanity check, so return null.
    return null;
  },
};
