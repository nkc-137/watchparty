/**
 * Typed runtime messaging between the extension's contexts.
 *
 * The background worker is the single owner of the party binding: the popup
 * asks it to join or leave, content scripts ask it what their party is, and it
 * pushes changes to the tabs they affect. Every message names its reply type
 * here, so each end is checked against the same contract.
 */
import { ConnParams, PartyRecord, TabView } from "./party";

/** Requests the background answers, each with its reply. */
export interface BackgroundApi {
  /** Content script: what is this tab's party? (Startup pull.) */
  "wp:getView": { req: {}; res: TabView };
  /** Popup: the whole binding, for showing where the party is. */
  "wp:status": { req: {}; res: PartyRecord };
  /** Popup: join a room in this tab (also moves the party, or switches rooms). */
  "wp:join": { req: { tabId: number; conn: ConnParams }; res: PartyRecord };
  /** Popup: end the party, wherever it is. */
  "wp:leave": { req: {}; res: PartyRecord };
}

/** Requests a content script answers, each with its reply. */
export interface ContentApi {
  /** Background: this tab's party changed. (Push.) */
  "wp:viewChanged": { req: { view: TabView }; res: void };
  /** Popup: is Watch Party running in this tab, and is a title open? */
  "wp:probe": { req: {}; res: { onWatchPage: boolean } };
}

type Requests<Api extends { [K in keyof Api]: { req: object } }> = {
  [K in keyof Api]: { type: K } & Api[K]["req"];
}[keyof Api];

export type BackgroundRequest = Requests<BackgroundApi>;
export type ContentRequest = Requests<ContentApi>;

export function callBackground<K extends keyof BackgroundApi>(
  type: K,
  req: BackgroundApi[K]["req"]
): Promise<BackgroundApi[K]["res"]> {
  return chrome.runtime.sendMessage({ type, ...req });
}

/** Messages a tab's top frame only — content scripts don't run in iframes. */
export function callTab<K extends keyof ContentApi>(
  tabId: number,
  type: K,
  req: ContentApi[K]["req"]
): Promise<ContentApi[K]["res"]> {
  return chrome.tabs.sendMessage(tabId, { type, ...req }, { frameId: 0 });
}

/** Whether a value is a message of ours at all (anything else is ignored). */
export function isOurMessage(msg: unknown): msg is { type: string } {
  return typeof msg === "object" && msg !== null && typeof (msg as { type?: unknown }).type === "string" &&
    (msg as { type: string }).type.startsWith("wp:");
}
