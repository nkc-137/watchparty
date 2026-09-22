/**
 * A PlayerAdapter abstracts one streaming site's video player behind a common,
 * seconds-based interface. Adapters run in the page's MAIN world (so Netflix's
 * `netflix.*` globals are reachable and the DOM `<video>` is accessible).
 *
 * To add a new site: implement this interface and register it in ./index.ts.
 */
export interface PlayerAdapter {
  /** Human name, used for logging/status. */
  readonly name: string;

  /** True when a controllable content player is currently available. */
  available(): boolean;

  /** Current playback position in seconds. */
  getTime(): number;

  /** Whether playback is currently paused. */
  isPaused(): boolean;

  /** Seek to an absolute position in seconds. */
  seek(seconds: number): void;

  play(): void;
  pause(): void;

  /**
   * Stable id for the title currently playing, unique within this site
   * (episode-level where the site allows it). Used to detect that someone
   * opened the wrong thing, so it must NOT be derived from a display title —
   * those are localized and differ per account. Return null when unknown;
   * unknown is treated as "can't tell", never as a mismatch.
   */
  contentId(): string | null;

  /** Human-readable title for the overlay. Display only; null if unknown. */
  title(): string | null;

  /**
   * True while the player cannot keep playing (buffering, or re-filling after a
   * seek). Optional: an adapter that can't tell is treated as always ready, so
   * a new site degrades to the old behavior rather than stalling the room.
   */
  isBuffering?(): boolean;

  // --- Optional robustness tuning (defaults keep Netflix's original behavior) ---

  /**
   * Minimum gap between applied seeks, in ms. Rapid/large seeks destabilize
   * fragile HTML5 players (Prime throws "Video Unavailable"). Seeks that arrive
   * inside the window are coalesced and applied once at the end. Default 0.
   */
  readonly minSeekIntervalMs?: number;

  /**
   * On a remote play/pause, only re-seek to align position if we're off by more
   * than this many seconds. Avoids a buffer-inducing seek on every pause for
   * fragile players. Default 0 = always seek (Netflix's robust behavior).
   */
  readonly playPauseDriftSec?: number;
}
