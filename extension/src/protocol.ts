/**
 * Client-side mirror of the server wire protocol
 * (server/src/protocol.ts). Keep the two in sync.
 */
export type PlaybackAction = "play" | "pause" | "seek";

/**
 * What a member is currently watching. Used to catch the classic movie-night
 * failure: one person opens the wrong episode and then drags everyone else
 * around with their seeks.
 */
export interface ContentInfo {
  /** Adapter/site name, e.g. "netflix", "prime". */
  site: string;
  /** Stable per-title id within that site. null when the site can't be read. */
  id: string | null;
  /** Human-readable title. Display only — never used to decide a mismatch. */
  title: string | null;
}

/**
 * Whether two members are demonstrably watching different things.
 *
 * Deliberately conservative — it only returns true when we are *sure*:
 *  - different sites are never compared (the same film on Netflix and Prime is
 *    a legitimate party, and their ids are unrelated anyway),
 *  - an unknown id on either side means "can't tell", not "mismatch",
 * so the warning never fires on a room that is actually in sync.
 */
export function contentConflicts(
  a: ContentInfo | null | undefined,
  b: ContentInfo | null | undefined
): boolean {
  if (!a || !b) return false;
  if (a.site !== b.site) return false;
  if (!a.id || !b.id) return false;
  return a.id !== b.id;
}

export interface PlaybackEvent {
  action: PlaybackAction;
  position: number;
  at: number;
  /** What the sender is watching, so receivers can reject cross-title events. */
  content?: ContentInfo | null;
}

export interface SyncState {
  position: number;
  playing: boolean;
  at: number;
  content?: ContentInfo | null;
}

/**
 * A room-wide pause while someone catches up on buffering. The server owns
 * this: holds begin when a play is requested (or playback stalls) and at least
 * one member is not ready, and end when everyone is ready again.
 */
export interface HoldState {
  /** Display names of the members being waited on. */
  waiting: string[];
  /** Position everyone should hold at, in seconds. */
  position: number;
}

/** Sent when a hold ends. */
export interface HoldRelease {
  /** Position to resume from, in seconds. */
  position: number;
  /** Whether the room was trying to play (vs. was paused anyway). */
  play: boolean;
  /**
   * True when the hold was abandoned on a timeout rather than everyone
   * becoming ready — a member whose client stalled or died must not be able to
   * freeze the party indefinitely.
   */
  timedOut: boolean;
}

export interface ChatMessage {
  id: string;
  name: string;
  text: string;
  at: number;
  /** True for server-generated activity notices (joins, pauses, seeks…). */
  system?: boolean;
}

export interface Member {
  id: string;
  name: string;
  isHost: boolean;
  /** Last reported content, so the overlay can flag who is off-title. */
  content?: ContentInfo | null;
  /** False while this member's player is buffering. Unknown counts as ready. */
  ready?: boolean;
}

export interface JoinRoomResult {
  ok: boolean;
  error?: string;
  youAreHost: boolean;
  members: Member[];
  /** Recent chat so a late joiner doesn't land in an empty panel. */
  history?: ChatMessage[];
  state?: SyncState | null;
}

export interface Reaction {
  name: string;
  emoji: string;
  at: number;
  /**
   * Sender's socket id. The sender renders its own reaction optimistically and
   * needs to drop the echo — names can't do that, since two friends called
   * "Sam" would silently swallow each other's reactions.
   */
  from: string;
}

export interface ClientToServerEvents {
  joinRoom: (
    payload: { roomCode: string; name: string; secret?: string },
    ack: (result: JoinRoomResult) => void
  ) => void;
  leaveRoom: () => void;
  playbackEvent: (event: PlaybackEvent) => void;
  syncState: (state: SyncState) => void;
  chatMessage: (text: string) => void;
  reaction: (emoji: string) => void;
  ping: (ack: (serverTime: number) => void) => void;
  requestSync: () => void;
  /** Report what this member is watching; re-sent whenever it changes. */
  setContent: (info: ContentInfo) => void;
  /** Report buffering state. Edge-triggered: only sent when it flips. */
  setReady: (ready: boolean) => void;
}

export interface ServerToClientEvents {
  playbackEvent: (event: PlaybackEvent & { from: string }) => void;
  syncState: (state: SyncState) => void;
  chatMessage: (msg: ChatMessage) => void;
  members: (members: Member[]) => void;
  hostChanged: (hostId: string) => void;
  reaction: (r: Reaction) => void;
  syncRequested: () => void;
  /** The room is holding at a position until everyone has buffered. */
  hold: (state: HoldState) => void;
  /** The hold is over — resume (or stay paused, per `play`). */
  holdRelease: (release: HoldRelease) => void;
}

export interface StoredConfig {
  serverUrl: string;
  roomCode: string;
  name: string;
  secret: string;
  connected: boolean;
  /** Show the on-screen chat/dashboard overlay. Sync still runs when hidden. */
  showPanel?: boolean;
}
