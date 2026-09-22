/**
 * Shared wire protocol between the extension client and the sync server.
 * Keep this file dependency-free so it can be copied/imported by the extension too.
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

/** A single playback control event originating from a member's player. */
export interface PlaybackEvent {
  action: PlaybackAction;
  /** Playback position in seconds at the moment the event was produced. */
  position: number;
  /** Sender clock time (Date.now()) — used for latency/drift compensation. */
  at: number;
  /** What the sender is watching, so receivers can reject cross-title events. */
  content?: ContentInfo | null;
}

/** Periodic authoritative state broadcast by the host for drift correction. */
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
  /** Server-assigned. */
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

export interface JoinRoomPayload {
  roomCode: string;
  name: string;
  /** Shared secret gate so randoms can't join. */
  secret?: string;
}

export interface JoinRoomResult {
  ok: boolean;
  error?: string;
  youAreHost: boolean;
  members: Member[];
  /** Last known state so a late joiner can catch up immediately. */
  state?: SyncState | null;
}

/** Client -> Server events. */
export interface ClientToServerEvents {
  joinRoom: (
    payload: JoinRoomPayload,
    ack: (result: JoinRoomResult) => void
  ) => void;
  leaveRoom: () => void;
  playbackEvent: (event: PlaybackEvent) => void;
  syncState: (state: SyncState) => void;
  chatMessage: (text: string) => void;
  reaction: (emoji: string) => void;
  /** Round-trip latency probe; server acks immediately. */
  ping: (ack: (serverTime: number) => void) => void;
  /** Ask the host to re-broadcast its authoritative state right now. */
  requestSync: () => void;
  /** Report what this member is watching; re-sent whenever it changes. */
  setContent: (info: ContentInfo) => void;
  /** Report buffering state. Edge-triggered: only sent when it flips. */
  setReady: (ready: boolean) => void;
}

export interface Reaction {
  name: string;
  emoji: string;
  at: number;
}

/** Server -> Client events. */
export interface ServerToClientEvents {
  playbackEvent: (event: PlaybackEvent & { from: string }) => void;
  syncState: (state: SyncState) => void;
  chatMessage: (msg: ChatMessage) => void;
  members: (members: Member[]) => void;
  hostChanged: (hostId: string) => void;
  reaction: (r: Reaction) => void;
  /** Sent only to the current host, asking it to emit a fresh syncState. */
  syncRequested: () => void;
  /** The room is holding at a position until everyone has buffered. */
  hold: (state: HoldState) => void;
  /** The hold is over — resume (or stay paused, per `play`). */
  holdRelease: (release: HoldRelease) => void;
}
