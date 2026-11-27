/**
 * Prime Video's content clock, as opposed to its stream clock.
 *
 * Prime inserts ads server-side: ad breaks are spliced into the same media
 * stream as the title, so `<video>.currentTime` counts every ad break the
 * stream contains up to that point. Two viewers at the same scene therefore
 * report different positions: one with ads is ahead by the ads' total length,
 * one on the ad-free tier is not. Syncing on the raw `currentTime` keeps that
 * gap forever, and a seek just moves both viewers with the gap still there.
 *
 * Prime's own time display ("12:34 / 1:45:23") shows content time, with ads
 * left out. So the "stream minus content" offset is the ad time spliced in
 * before the current point. This file tracks that offset and converts between
 * the two clocks. The display only ticks once a second, so the offset is
 * refined as it ticks instead of being read off a single sample.
 *
 * This module is pure (no DOM) so it can be unit-tested; prime.ts feeds it.
 */

/**
 * Parse the elapsed half of Prime's time indicator, e.g. "1:02:03 / 1:45:00".
 * Returns seconds, or null when the text is missing or isn't an elapsed time
 * (a remaining-time display such as "-1:32:49" can't be used).
 */
export function parsePrimeElapsed(text: string | null | undefined): number | null {
  if (!text) return null;
  const first = text.split("/")[0].trim();
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(first);
  if (!m) return null;
  return (Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3]);
}

/**
 * How long a new offset must hold before we trust it (after a seek or ad break).
 * Mid-ad the offset grows 1s per second, so it leaves its one-second band
 * after about 1s. This must be comfortably longer than that.
 */
export const OFFSET_SETTLE_MS = 2000;

/**
 * How many times the offset must have moved while unsettled to count as an ad
 * break. During an ad the stream clock runs while the display is frozen, so the
 * offset grows steadily and the candidate is replaced about once a second. A
 * seek moves it once (twice if the display lags the jump).
 */
const AD_MIN_MOVES = 3;

/**
 * Tracks the stream-minus-content offset.
 *
 * The display shows floor(content time), so each sample's
 * `stream - displayed` is the true offset plus up to one second. The smallest
 * value seen is the best estimate. A value outside that one-second window means
 * the offset itself changed: a seek moved us past a different number of ad
 * breaks, or an ad is playing. That only becomes the new estimate once it has
 * held for OFFSET_SETTLE_MS. Until then the old estimate stays in use, so
 * through an ad the reported position keeps advancing as if the title were
 * playing. It doesn't freeze, which would make a host's followers seek back
 * every few seconds.
 */
export function primeClock(settleMs = OFFSET_SETTLE_MS) {
  let offset: number | null = null;
  let candidate: number | null = null;
  let candidateSince = 0;
  let moves = 0; // how often the candidate moved since we became unsettled
  let adJump = false;

  const fits = (raw: number, base: number) => raw > base - 1 && raw < base + 1.05;

  return {
    /** Feed one sample. `displayed` is null when Prime's time display can't be read. */
    observe(stream: number, displayed: number | null, now = Date.now()) {
      if (displayed === null || !isFinite(stream)) return;
      const raw = stream - displayed;
      if (offset === null) {
        offset = raw;
        return;
      }
      if (fits(raw, offset)) {
        offset = Math.min(offset, raw);
        candidate = null;
        moves = 0;
        return;
      }
      if (candidate === null || !fits(raw, candidate)) {
        candidate = raw;
        candidateSince = now;
        moves++;
      } else {
        candidate = Math.min(candidate, raw);
      }
      if (now - candidateSince >= settleMs) {
        // A change that has held long enough: adopt it. If it built up while
        // the display stood still, that was an ad, not the viewer seeking.
        if (moves >= AD_MIN_MOVES) adJump = true;
        offset = candidate;
        candidate = null;
        moves = 0;
      }
    },

    /** Content position for a stream position (the stream clock until the display is read). */
    content(stream: number): number {
      return offset === null ? stream : Math.max(0, stream - offset);
    },

    /** Stream position to seek to for a content position. */
    stream(content: number): number {
      return content + (offset ?? 0);
    },

    /** Current offset estimate in seconds (null until the display has been read). */
    offset: () => offset,

    /**
     * True once after the offset was re-based at the end of an ad break. The
     * content position then jumps back by the ad's length, and that jump is
     * not something the viewer did.
     */
    takeAdJump(): boolean {
      const j = adJump;
      adJump = false;
      return j;
    },

    reset() {
      offset = candidate = null;
      candidateSince = 0;
      moves = 0;
      adJump = false;
    },
  };
}
