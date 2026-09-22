/**
 * Shared <video> element access.
 *
 * Most sites here — including Netflix, which drives its own player API on top —
 * ultimately play through a normal HTML5 <video>, so readiness is best read off
 * the element itself rather than each site's bespoke API.
 */

/**
 * The main content video on the page.
 *
 * Sites often have several <video> elements (ads, trailers, previews), so we
 * pick the largest *visible* one with a real duration; a hidden or off-screen
 * ad player has zero area and never wins over the on-screen feature.
 */
export function contentVideo(): HTMLVideoElement | null {
  const vids = Array.from(document.querySelectorAll("video")) as HTMLVideoElement[];
  let best: HTMLVideoElement | null = null;
  let bestArea = 0;
  for (const v of vids) {
    if (!isFinite(v.duration) || v.duration <= 0) continue;
    const r = v.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > 0 && area > bestArea) {
      best = v;
      bestArea = area;
    }
  }
  // Fall back to any video with a duration, then any video at all, if none were
  // visible yet (e.g. still laying out).
  return best || vids.find((v) => isFinite(v.duration) && v.duration > 0) || vids[0] || null;
}

/**
 * Whether the content video cannot currently keep playing.
 *
 * `readyState` is polled rather than tracking `waiting`/`canplay` events,
 * because it is a level rather than an edge: a poll can't miss a transition or
 * get stuck in the wrong state after a seek, and the adapters are already
 * sampled on an interval. Below HAVE_FUTURE_DATA the element has nothing to
 * play next; `seeking` covers the gap while it re-fills after a jump.
 */
export function videoBuffering(): boolean {
  const v = contentVideo();
  if (!v) return false; // no player yet — "not buffering", not "stalled"
  return v.seeking || v.readyState < 3; // 3 = HAVE_FUTURE_DATA
}
