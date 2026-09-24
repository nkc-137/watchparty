/**
 * Helpers for identifying *what* is playing, shared by the site adapters.
 *
 *  - `idFromUrl()` reads a site's content id from the URL.
 *  - `cleanTitle()` produces a label for the UI.
 */

/** Site name suffixes to strip from document.title, e.g. " - Netflix". */
const TITLE_SUFFIXES =
  /\s*[-|–—]\s*(Netflix|YouTube|Prime Video|Amazon\.com|Tubi|Pluto TV)\s*$/i;

/** Leading unread/notification counters YouTube puts in the tab title: "(3) ". */
const TITLE_PREFIX = /^\(\d+\)\s*/;

/**
 * A human-readable title for the overlay. Display only.
 * Takes the raw title so it can be exercised without a document.
 */
export function cleanTitle(raw: string = document.title): string | null {
  const t = raw.replace(TITLE_PREFIX, "").replace(TITLE_SUFFIXES, "").trim();
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
