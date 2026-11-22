/**
 * Content-script side of the party binding: is this tab in the party, and if
 * so, which room?
 *
 * The answer arrives two ways — a pull when the script starts, and a push
 * from the background whenever the binding changes — and the two can cross in
 * flight. The revision on each view decides which is newer, so a slow startup
 * reply can never undo a change pushed after it.
 */
import { callBackground, ContentRequest, isOurMessage } from "./messages";
import { ConnParams, TabView, viewGate } from "./party";

export interface PartyClient {
  /** This tab's room, or null when the party is elsewhere (or nowhere). */
  current(): ConnParams | null;
}

const PULL_ATTEMPTS = 3;
const PULL_RETRY_MS = 1000;

/** Follow this tab's party; `onChange` runs whenever a newer view lands. */
export function followParty(onChange: () => void): PartyClient {
  const gate = viewGate();
  let conn: ConnParams | null = null;

  const accept = (view: TabView | undefined) => {
    if (!view || !gate.accepts(view)) return;
    conn = view.conn;
    onChange();
  };

  // Listen before asking, so a change made while the pull is in flight still
  // reaches us (and then wins over the pull on revision).
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (sender.id !== chrome.runtime.id || !isOurMessage(msg)) return;
    const req = msg as ContentRequest;
    if (req.type === "wp:viewChanged") accept(req.view);
  });

  void pull(accept);
  return { current: () => conn };
}

/**
 * Ask the background for our view. Retried briefly: the worker may be mid
 * start-up. If the extension was reloaded under us, this script is orphaned
 * and can never connect, which is the right outcome — it stays dormant.
 */
async function pull(accept: (view: TabView | undefined) => void) {
  for (let attempt = 1; attempt <= PULL_ATTEMPTS; attempt++) {
    try {
      accept(await callBackground("wp:getView", {}));
      return;
    } catch {
      if (attempt < PULL_ATTEMPTS) await new Promise((r) => setTimeout(r, PULL_RETRY_MS));
    }
  }
}
