import { ChatMessage, ContentInfo, Member, SyncState } from "./protocol";

export interface RoomMember extends Member {
  /**
   * The content id we last warned the room about for this member, so a
   * mismatch is announced once rather than on every state sample. null when
   * they are in step with the host.
   */
  warnedFor?: string | null;
}

/** What the room is waiting to do once everyone has buffered. */
export interface Hold {
  /** Position everyone is parked at, in seconds. */
  position: number;
  /** Whether the room wants to be playing when the hold lifts. */
  play: boolean;
  /** Fires if a member never reports ready, so a dead client can't freeze us. */
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * How much chat a late joiner is caught up with. Enough to read the room and
 * reply to what was just said, without dumping an hour of backlog on someone
 * who only wants to watch the film.
 */
export const MAX_HISTORY = 50;

export interface Room {
  code: string;
  members: Map<string, RoomMember>; // socketId -> member
  hostId: string | null;
  lastState: SyncState | null;
  /** Non-null while the room is paused waiting for someone to buffer. */
  hold: Hold | null;
  /** Recent chat, newest last, capped at MAX_HISTORY. */
  messages: ChatMessage[];
}

/**
 * In-memory registry of rooms. A room is created lazily on first join and
 * destroyed when the last member leaves. No persistence — fine for a
 * friends-and-family deployment.
 */
export class RoomRegistry {
  private rooms = new Map<string, Room>();

  join(roomCode: string, socketId: string, name: string): { room: Room; isHost: boolean } {
    let room = this.rooms.get(roomCode);
    if (!room) {
      room = {
        code: roomCode,
        members: new Map(),
        hostId: null,
        lastState: null,
        hold: null,
        messages: [],
      };
      this.rooms.set(roomCode, room);
    }
    const isHost = room.hostId === null;
    // Ready until told otherwise — a member who never reports never blocks.
    room.members.set(socketId, { id: socketId, name, isHost, ready: true });
    if (isHost) room.hostId = socketId;
    return { room, isHost };
  }

  /** Remove a member. Returns the room (if it still exists) and whether the host changed. */
  leave(roomCode: string, socketId: string): { room: Room | null; hostChanged: boolean } {
    const room = this.rooms.get(roomCode);
    if (!room) return { room: null, hostChanged: false };

    room.members.delete(socketId);

    if (room.members.size === 0) {
      // Drop the pending hold timer with the room, or it fires into the void.
      if (room.hold?.timer) clearTimeout(room.hold.timer);
      this.rooms.delete(roomCode);
      return { room: null, hostChanged: false };
    }

    let hostChanged = false;
    if (room.hostId === socketId) {
      // Promote the oldest remaining member to host.
      const next = room.members.keys().next().value as string;
      room.hostId = next;
      for (const m of room.members.values()) m.isHost = m.id === next;
      hostChanged = true;
    }
    return { room, hostChanged };
  }

  /**
   * Append to the room's scrollback, dropping the oldest once it is full.
   *
   * Only real chat is kept. Activity notices ("Sam paused", "Alex jumped to
   * 25:00") are status, not conversation: they are meaningless half an hour
   * later, and because every seek emits one they would otherwise crowd the
   * actual talk out of the buffer entirely.
   */
  record(room: Room, msg: ChatMessage): void {
    if (msg.system) return;
    room.messages.push(msg);
    if (room.messages.length > MAX_HISTORY) {
      room.messages.splice(0, room.messages.length - MAX_HISTORY);
    }
  }

  get(roomCode: string): Room | undefined {
    return this.rooms.get(roomCode);
  }

  /** Wire-safe view of the members (drops server-only bookkeeping). */
  memberList(room: Room): Member[] {
    return [...room.members.values()].map(({ id, name, isHost, content, ready }) => ({
      id,
      name,
      isHost,
      content: content ?? null,
      ready: ready !== false,
    }));
  }

  /** The host's content, which is the reference everyone else is compared to. */
  hostContent(room: Room): ContentInfo | null {
    const host = room.hostId ? room.members.get(room.hostId) : null;
    return host?.content ?? null;
  }
}
