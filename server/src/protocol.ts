/**
 * Shared wire protocol between the extension client and the sync server.
 * Keep this file dependency-free so it can be copied/imported by the extension too.
 */

export type PlaybackAction = "play" | "pause" | "seek";

/** A single playback control event originating from a member's player. */
export interface PlaybackEvent {
  action: PlaybackAction;
  /** Playback position in seconds at the moment the event was produced. */
  position: number;
  /** Sender clock time (Date.now()) — used for latency/drift compensation. */
  at: number;
  /** Netflix video id the sender is watching, for sanity checks. */
  videoId?: number | null;
}

/** Periodic authoritative state broadcast by the host for drift correction. */
export interface SyncState {
  position: number;
  playing: boolean;
  at: number;
  videoId?: number | null;
}

export interface ChatMessage {
  /** Server-assigned. */
  id: string;
  name: string;
  text: string;
  at: number;
}

export interface Member {
  id: string;
  name: string;
  isHost: boolean;
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
}
