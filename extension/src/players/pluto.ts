/**
 * Pluto TV (pluto.tv) adapter. Free, ad-supported service that plays through a
 * standard HTML5 <video> element, so it uses the shared HTML5 adapter with the
 * same seek-hardening as Prime/Tubi.
 *
 * Note: Pluto's live-TV channels are continuous streams with no meaningful
 * duration, so syncing is most useful for on-demand titles (which report a real
 * duration and gate the adapter on).
 */
import { htmlVideoAdapter } from "./htmlVideo";
import { idFromUrl } from "./identity";

/** Episode id when there is one, so a series lands episode-level. */
export const PLUTO_ID_PATTERNS = [
  /\/on-demand\/series\/[^/]+\/season\/\d+\/episode\/([^/?#]+)/,
  /\/on-demand\/(?:movies|series)\/([^/?#]+)/,
  /\/live-tv\/([^/?#]+)/,
];

export const plutoAdapter = htmlVideoAdapter({
  name: "pluto",
  minSeekIntervalMs: 1500,
  playPauseDriftSec: 2.5,
  // Prefer the episode id when there is one, so a series lands episode-level.
  contentId: () => idFromUrl(PLUTO_ID_PATTERNS),
});
