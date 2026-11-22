/**
 * Service worker: owner of the party binding — which tab is in the party.
 *
 * The socket itself lives in the content script (it has to sit beside the page
 * and its overlay). This worker decides which tab's content script may use it,
 * and keeps that decision right as tabs come and go.
 *
 * Listeners are registered synchronously at the top level, as MV3 requires
 * for the worker to be woken for them.
 */
import { BackgroundApi, BackgroundRequest, isOurMessage } from "./messages";
import { isConnParams, join, leave, tabClosed, tabReplaced, viewFor, PartyRecord } from "./party";
import { readParty, updateParty } from "./partyStore";

chrome.runtime.onInstalled.addListener(() => {
  console.log("Watch Party extension installed");
});

// Closing the party tab ends the party, so it can't resurface in a new tab.
chrome.tabs.onRemoved.addListener((tabId) => {
  void updateParty((rec) => tabClosed(rec, tabId));
});

// Prerendering and discarded-tab restores swap the id of what is, to the
// user, the same tab. The party follows it.
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  void updateParty((rec) => tabReplaced(rec, addedTabId, removedTabId));
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isOurMessage(msg)) return false;
  const reply = handle(msg as BackgroundRequest, sender);
  if (!reply) return false; // not ours to answer, or not allowed
  reply.then(sendResponse, (err) => {
    console.warn("Watch Party:", msg.type, "failed", err);
    sendResponse(undefined);
  });
  return true; // reply is async
});

type Reply<K extends keyof BackgroundApi> = Promise<BackgroundApi[K]["res"]>;

function handle(msg: BackgroundRequest, sender: chrome.runtime.MessageSender): Promise<unknown> | null {
  switch (msg.type) {
    case "wp:getView": {
      // A tab can only ask about itself: the id comes from Chrome, not the message.
      const tabId = sender.tab?.id;
      if (tabId === undefined || sender.frameId !== 0) return null;
      return readParty().then((rec) => viewFor(rec, tabId)) satisfies Reply<"wp:getView">;
    }
    case "wp:status":
      return fromExtensionPage(sender) ? (status() satisfies Reply<"wp:status">) : null;
    case "wp:join":
      if (!fromExtensionPage(sender) || !Number.isInteger(msg.tabId) || !isConnParams(msg.conn)) return null;
      return updateParty((rec) => join(rec, msg.tabId, msg.conn)) satisfies Reply<"wp:join">;
    case "wp:leave":
      return fromExtensionPage(sender) ? (updateParty(leave) satisfies Reply<"wp:leave">) : null;
    default:
      return null;
  }
}

/**
 * Join/leave and the room settings are for our own pages (the popup) only.
 * Content scripts run inside third-party sites, so they get just their own
 * tab's view, never control.
 */
function fromExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !sender.tab;
}

/**
 * The binding, self-healing if its tab has vanished without us hearing about
 * it (onRemoved is reliable, but a stale party would silently connect nowhere).
 */
async function status(): Promise<PartyRecord> {
  const rec = await readParty();
  const tabId = rec.party?.tabId;
  if (tabId === undefined || (await tabExists(tabId))) return rec;
  return updateParty((r) => tabClosed(r, tabId));
}

function tabExists(tabId: number): Promise<boolean> {
  return chrome.tabs.get(tabId).then(
    () => true,
    () => false
  );
}
