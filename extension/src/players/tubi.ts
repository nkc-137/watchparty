/**
 * Tubi (tubitv.com) adapter. Tubi is a free, ad-supported service that plays
 * through a standard HTML5 <video> element, so it uses the shared HTML5 adapter
 * with the same seek-hardening as Prime.
 */
import { htmlVideoAdapter } from "./htmlVideo";
import { idFromUrl } from "./identity";

/** Numeric id in the path: /movies/612042/..., /tv-shows/570362/... */
export const TUBI_ID_PATTERNS = [/tubitv\.com\/(?:movies|tv-shows|series|video)\/(\d+)/];

export const tubiAdapter = htmlVideoAdapter({
  name: "tubi",
  minSeekIntervalMs: 1500,
  playPauseDriftSec: 2.5,
  // Tubi puts a numeric id in the path: /movies/612042/..., /tv-shows/570362/...
  contentId: () => idFromUrl(TUBI_ID_PATTERNS),
});
