/**
 * Picks the right PlayerAdapter for the current site. Add new sites here.
 */
import { PlayerAdapter } from "./types";
import { netflixAdapter } from "./netflix";
import { primeAdapter } from "./prime";
import { youtubeAdapter } from "./youtube";

export type { PlayerAdapter } from "./types";

export function selectAdapter(host = location.hostname): PlayerAdapter | null {
  if (host.includes("netflix.com")) return netflixAdapter;
  if (host.includes("primevideo.com") || host.includes("amazon."))
    return primeAdapter;
  if (host.includes("youtube.com")) return youtubeAdapter;
  return null;
}
