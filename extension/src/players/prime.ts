/**
 * Amazon Prime Video adapter. Prime plays through a standard HTML5 <video>
 * element. Its raw seek is fragile (rapid/large seeks crash the DRM pipeline
 * with "Video Unavailable"), so we throttle seeks and don't seek on a plain
 * pause unless meaningfully out of position.
 */
import { htmlVideoAdapter } from "./htmlVideo";

export const primeAdapter = htmlVideoAdapter({
  name: "prime",
  minSeekIntervalMs: 1500,
  playPauseDriftSec: 2.5,
});
