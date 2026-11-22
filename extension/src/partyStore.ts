/**
 * Background-side owner of the party binding: persistence, serialization and
 * change notification. The decisions themselves are the pure transitions in
 * party.ts.
 *
 * Stored in chrome.storage.session, which outlives the service worker's
 * frequent restarts but is cleared when the browser closes — tab ids are only
 * unique within a browser session, so a remembered id could otherwise bind a
 * random tab after a restart.
 */
import { callTab } from "./messages";
import { NO_PARTY, PartyRecord, affectedTabs, viewFor } from "./party";

const KEY = "wpParty";

// Every read-modify-write runs one at a time. Without this, two events landing
// together (say the popup moving the party to tab B while tab A's close is
// being handled) could each read the old record and the last write would
// silently undo the other.
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(op: () => Promise<T>): Promise<T> {
  const run = queue.then(op);
  queue = run.catch(() => undefined); // one failed op mustn't wedge the queue
  return run;
}

async function load(): Promise<PartyRecord> {
  const stored = (await chrome.storage.session.get(KEY))[KEY] as PartyRecord | undefined;
  return stored ?? NO_PARTY;
}

/** The current binding, ordered after any change already in flight. */
export function readParty(): Promise<PartyRecord> {
  return serialized(load);
}

/**
 * Apply a transition. Persists it, then tells each tab whose view changed.
 * A transition that returns the record unchanged costs no write or message.
 */
export function updateParty(transition: (rec: PartyRecord) => PartyRecord): Promise<PartyRecord> {
  return serialized(async () => {
    const prev = await load();
    const next = transition(prev);
    if (next === prev) return prev;
    await chrome.storage.session.set({ [KEY]: next });
    notify(prev, next);
    return next;
  });
}

/**
 * Push the new view to the tabs it concerns. Best effort: a tab that is gone,
 * or has no content script yet, fails harmlessly — a content script pulls its
 * view when it starts, and the revision lets it discard whichever of the push
 * and the pull is older.
 */
function notify(prev: PartyRecord, next: PartyRecord) {
  for (const tabId of affectedTabs(prev, next)) {
    callTab(tabId, "wp:viewChanged", { view: viewFor(next, tabId) }).catch(() => undefined);
  }
}
