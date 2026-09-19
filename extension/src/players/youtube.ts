/**
 * YouTube adapter. YouTube's main player is the `#movie_player` element, which
 * exposes a stable API in the page context (MAIN world). This is more robust
 * than raw <video> seeking — comparable to Netflix — so no special tuning.
 */
import { PlayerAdapter } from "./types";

interface YTPlayer {
  getCurrentTime(): number; // seconds
  getDuration(): number;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  playVideo(): void;
  pauseVideo(): void;
  getPlayerState(): number; // -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
}

function player(): YTPlayer | null {
  const el = document.getElementById("movie_player") as unknown as YTPlayer | null;
  return el && typeof el.getCurrentTime === "function" ? el : null;
}

export const youtubeAdapter: PlayerAdapter = {
  name: "youtube",
  available: () => {
    const p = player();
    return !!p && p.getDuration() > 0;
  },
  getTime: () => player()?.getCurrentTime() ?? 0,
  // Paused = the "paused" state (2). Playing/buffering count as playing.
  isPaused: () => player()?.getPlayerState() === 2,
  seek: (s) => player()?.seekTo(s, true),
  play: () => player()?.playVideo(),
  pause: () => player()?.pauseVideo(),
  // YouTube video ids are alphanumeric; videoId is a numeric sanity check only.
  videoId: () => null,
};
