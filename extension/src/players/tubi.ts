/**
 * Tubi (tubitv.com) adapter. Tubi is a free, ad-supported service that plays
 * through a standard HTML5 <video> element, so it uses the shared HTML5 adapter
 * with the same seek-hardening as Prime.
 */
import { htmlVideoAdapter } from "./htmlVideo";

export const tubiAdapter = htmlVideoAdapter({
  name: "tubi",
  minSeekIntervalMs: 1500,
  playPauseDriftSec: 2.5,
});
