/**
 * Amazon Prime Video adapter. Prime plays through a standard HTML5 <video>
 * element. Its raw seek is fragile (rapid/large seeks crash the DRM pipeline
 * with "Video Unavailable"), so we throttle seeks and don't seek on a plain
 * pause unless meaningfully out of position.
 */
import { htmlVideoAdapter } from "./htmlVideo";
import { idFromUrl } from "./identity";

/** ASIN/GTI from the detail URL. */
export const PRIME_ID_PATTERNS = [
  /[?&]gti=([A-Za-z0-9.]+)/,
  /\/detail\/([A-Za-z0-9]{8,})/,
  /\/gp\/video\/detail\/([A-Za-z0-9]{8,})/,
];

export const primeAdapter = htmlVideoAdapter({
  name: "prime",
  minSeekIntervalMs: 1500,
  playPauseDriftSec: 2.5,
  // Prime identifies a title by an ASIN/GTI in the detail URL. Note this is
  // series-level for episodic content, so it catches "wrong show" but not
  // always "wrong episode".
  contentId: () => idFromUrl(PRIME_ID_PATTERNS),
});
