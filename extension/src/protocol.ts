/**
 * Client-side mirror of the server wire protocol
 * (server/src/protocol.ts). Keep the two in sync.
 */
export type PlaybackAction = "play" | "pause" | "seek";

export interface PlaybackEvent {
  action: PlaybackAction;
  position: number;
  at: number;
  videoId?: number | null;
}

export interface SyncState {
  position: number;
  playing: boolean;
  at: number;
  videoId?: number | null;
}

export interface ChatMessage {
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

export interface JoinRoomResult {
  ok: boolean;
  error?: string;
  youAreHost: boolean;
  members: Member[];
  state?: SyncState | null;
}

export interface Reaction {
  name: string;
  emoji: string;
  at: number;
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
}

export interface ServerToClientEvents {
  playbackEvent: (event: PlaybackEvent & { from: string }) => void;
  syncState: (state: SyncState) => void;
  chatMessage: (msg: ChatMessage) => void;
  members: (members: Member[]) => void;
  hostChanged: (hostId: string) => void;
  reaction: (r: Reaction) => void;
  syncRequested: () => void;
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
