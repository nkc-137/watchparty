/**
 * Helpers for identifying *what* is playing, shared by the site adapters.
 *
 * Two different things live here, and the distinction matters:
 *  - `contentId()` is the identity used to decide whether two people are
 *    watching the same thing. It must be stable across accounts, regions and
 *    languages, so it is always an id from the URL or the site's player API —
 *    never a title string.
 *  - `cleanTitle()` produces a label for the UI only. Titles are localized, so
 *    they are never used for the mismatch check.
 */

/** Site name suffixes to strip from document.title, e.g. " - Netflix". */
const TITLE_SUFFIXES =
  /\s*[-|–—]\s*(Netflix|YouTube|Prime Video|Amazon\.com|Tubi|Pluto TV)\s*$/i;

/** Leading unread/notification counters YouTube puts in the tab title: "(3) ". */
const TITLE_PREFIX = /^\(\d+\)\s*/;

/** A human-readable title for the overlay. Display only. */
export function cleanTitle(): string | null {
  const t = document.title.replace(TITLE_PREFIX, "").replace(TITLE_SUFFIXES, "").trim();
  return t || null;
}

/**
 * First capture group of the first pattern that matches the current URL.
 * Used by adapters whose content id lives in the path or query string.
 */
export function idFromUrl(patterns: RegExp[], url = location.href): string | null {
  for (const re of patterns) {
    const m = re.exec(url);
    if (m && m[1]) return m[1];
  }
  return null;
}
