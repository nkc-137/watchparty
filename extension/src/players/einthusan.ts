/**
 * Einthusan (einthusan.tv) adapter. Einthusan streams South Asian films over
 * HLS (hls.js) into a standard HTML5 <video> element, so it uses the shared
 * HTML5 adapter with the same seek-hardening as Prime/Tubi/Pluto.
 */
import { htmlVideoAdapter } from "./htmlVideo";
import { idFromUrl } from "./identity";

/** Short alphanumeric id in the path: /movie/watch/42yB/?lang=hindi */
export const EINTHUSAN_ID_PATTERNS = [/einthusan\.[a-z]+\/movie\/watch\/([\w-]+)/];

export const einthusanAdapter = htmlVideoAdapter({
  name: "einthusan",
  minSeekIntervalMs: 1500,
  playPauseDriftSec: 2.5,
  contentId: () => idFromUrl(EINTHUSAN_ID_PATTERNS),
});
