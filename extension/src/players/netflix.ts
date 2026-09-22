/**
 * Netflix adapter. The ONLY place touching Netflix's private player API —
 * if Netflix changes their internals, fix it here.
 */
import { PlayerAdapter } from "./types";
import { cleanTitle, idFromUrl } from "./identity";

// Netflix's globals are untyped; keep the surface tiny and defensive.
declare const netflix: any;

interface NetflixPlayer {
  getCurrentTime(): number; // ms
  seek(ms: number): void;
  play(): void;
  pause(): void;
  isPaused?(): boolean;
}

function getPlayer(): NetflixPlayer | null {
  try {
    const videoPlayer =
      netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
    if (!videoPlayer) return null;
    const ids = videoPlayer.getAllPlayerSessionIds?.() || [];
    if (!ids.length) return null;
    return videoPlayer.getVideoPlayerBySessionId(ids[0]) || null;
  } catch {
    return null;
  }
}

export const netflixAdapter: PlayerAdapter = {
  name: "netflix",
  available: () => getPlayer() !== null,
  getTime: () => (getPlayer()?.getCurrentTime() ?? 0) / 1000,
  isPaused: () => {
    const p = getPlayer();
    return p?.isPaused ? p.isPaused() : false;
  },
  seek: (s) => getPlayer()?.seek(Math.round(s * 1000)),
  play: () => getPlayer()?.play(),
  pause: () => getPlayer()?.pause(),
  // Netflix ids are per-episode, so this catches "you opened episode 2".
  // The player session id is authoritative; the URL is the fallback for the
  // moment before the session exists.
  contentId: () => {
    try {
      const vp = netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
      const ids = vp?.getAllPlayerSessionIds?.() || [];
      const m = /watch-(\d+)/.exec(ids[0] || "");
      if (m) return m[1];
    } catch {
      /* fall through to the URL */
    }
    return idFromUrl([/netflix\.com\/watch\/(\d+)/]);
  },
  title: cleanTitle,
};
