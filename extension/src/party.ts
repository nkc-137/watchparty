/**
 * The party binding: which browser tab is in the watch party, and which room
 * it is in.
 *
 * One tab holds the party. Every other tab — even one on a supported watch
 * page — stays dormant, so watching something else alongside the party can't
 * leak play/pause/seek into the room or let the room steer the other video.
 *
 * Pure logic, free of chrome.* like sync.ts: the background worker
 * (partyStore.ts) owns persistence and messaging, and applies these
 * transitions; the content script (partyClient.ts) consumes the views.
 */
import { StoredConfig } from "./protocol";

/** Everything a tab needs to join a room. Snapshotted when you click Join. */
export type ConnParams = Pick<StoredConfig, "serverUrl" | "roomCode" | "name" | "secret">;

/**
 * The live party. The room settings live next to the tab id so that joining,
 * switching rooms and moving tabs are each one atomic write: no reader can see
 * the new tab paired with the old room, or the old tab with the new room.
 */
export interface Party extends ConnParams {
  tabId: number;
}

/**
 * What the background persists. `rev` goes up on every change, so a tab can
 * order snapshots that reach it by different routes (its own startup request
 * and a pushed update) and never let an older one win.
 */
export interface PartyRecord {
  party: Party | null;
  rev: number;
}

export const NO_PARTY: PartyRecord = { party: null, rev: 0 };

// --- Transitions ---------------------------------------------------------------
// Each returns the record unchanged (same object) when nothing happened, so the
// store can skip a pointless write and notification.

/** Join, or move the party to this tab, or switch rooms — all the same act. */
export function join(rec: PartyRecord, tabId: number, conn: ConnParams): PartyRecord {
  return { party: { ...connOf(conn), tabId }, rev: rec.rev + 1 };
}

export function leave(rec: PartyRecord): PartyRecord {
  return rec.party ? { party: null, rev: rec.rev + 1 } : rec;
}

/** Closing the party tab ends the party; closing any other tab does nothing. */
export function tabClosed(rec: PartyRecord, tabId: number): PartyRecord {
  return rec.party?.tabId === tabId ? leave(rec) : rec;
}

/**
 * Chrome can swap a tab's id under it (prerendering, restoring a discarded
 * tab). It is still the same tab to the user, so the party follows it.
 */
export function tabReplaced(rec: PartyRecord, addedTabId: number, removedTabId: number): PartyRecord {
  if (rec.party?.tabId !== removedTabId) return rec;
  return { party: { ...rec.party, tabId: addedTabId }, rev: rec.rev + 1 };
}

// --- Per-tab views -----------------------------------------------------------

/**
 * What one tab is told: its room, or null when the party is in another tab.
 * Other tabs never see the room settings (the secret included).
 */
export interface TabView {
  conn: ConnParams | null;
  rev: number;
}

export function viewFor(rec: PartyRecord, tabId: number): TabView {
  const p = rec.party;
  return { conn: p && p.tabId === tabId ? connOf(p) : null, rev: rec.rev };
}

/** Tabs whose view may differ between two records — the ones to notify. */
export function affectedTabs(prev: PartyRecord, next: PartyRecord): number[] {
  const ids = [prev.party?.tabId, next.party?.tabId].filter((id): id is number => id !== undefined);
  return [...new Set(ids)];
}

/**
 * Orders views arriving at a tab. Equal revs are the same snapshot, so they
 * are accepted (harmlessly) rather than dropped.
 */
export function viewGate() {
  let rev = -1;
  return {
    accepts(view: TabView): boolean {
      if (view.rev < rev) return false;
      rev = view.rev;
      return true;
    },
  };
}

// --- Should this tab be connected? -------------------------------------------

/**
 * The room this tab should be in right now, or null for none. Everything that
 * gates a connection meets here, so the content script just reconciles to it.
 */
export function desiredConnection(input: {
  enabled: boolean;
  conn: ConnParams | null;
  onWatchPage: boolean;
}): ConnParams | null {
  const { enabled, conn, onWatchPage } = input;
  if (!enabled || !conn || !onWatchPage) return null;
  if (!conn.serverUrl || !conn.roomCode) return null;
  return conn;
}

/**
 * Identity of a connection. Only a change here warrants a reconnect, so
 * display-only settings (the overlay toggle) never drop a live socket.
 */
export function connKey(conn: ConnParams | null): string {
  return conn ? JSON.stringify([conn.serverUrl, conn.roomCode, conn.name, conn.secret]) : "";
}

function connOf(c: ConnParams): ConnParams {
  return { serverUrl: c.serverUrl, roomCode: c.roomCode, name: c.name, secret: c.secret };
}
