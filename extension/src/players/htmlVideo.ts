/**
 * Shared adapter for sites that play through a standard HTML5 <video> element
 * (Amazon Prime, Tubi, …). These sites often have several <video> elements
 * (ads, trailers, previews), so we pick the largest on-screen video that has a
 * real duration — the main feature during playback.
 *
 * Raw HTML5 seeking is fragile (rapid/large seeks can crash DRM pipelines), so
 * callers typically pass seek-hardening tuning (minSeekIntervalMs,
 * playPauseDriftSec).
 */
import { PlayerAdapter } from "./types";
import { cleanTitle } from "./identity";
import { contentVideo, videoBuffering } from "./media";

export interface HtmlVideoTuning {
  name: string;
  minSeekIntervalMs?: number;
  playPauseDriftSec?: number;
  /**
   * Reads the site's content id (see PlayerAdapter.contentId). Omit it and the
   * adapter reports null.
   */
  contentId?: () => string | null;
}

export function htmlVideoAdapter(t: HtmlVideoTuning): PlayerAdapter {
  return {
    name: t.name,
    minSeekIntervalMs: t.minSeekIntervalMs,
    playPauseDriftSec: t.playPauseDriftSec,
    // A content video with a meaningful duration means real playback (not a menu).
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
    isBuffering: videoBuffering,
    contentId: () => t.contentId?.() ?? null,
    title: cleanTitle,
  };
}
