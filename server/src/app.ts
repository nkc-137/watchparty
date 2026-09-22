import http from "http";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import express from "express";
import { Server } from "socket.io";
import { Room, RoomMember, RoomRegistry } from "./rooms";
import {
  ClientToServerEvents,
  ServerToClientEvents,
  ChatMessage,
  ContentInfo,
  contentConflicts,
} from "./protocol";

export interface AppOptions {
  /** Shared secret gate. Empty/undefined means no gate. */
  joinSecret?: string;
  /** Suppress per-connection console logging (used in tests). */
  quiet?: boolean;
  /**
   * How long the room will wait for a buffering member before giving up and
   * playing without them. Configurable so tests don't have to sleep.
   */
  holdTimeoutMs?: number;
}

export interface RunningApp {
  httpServer: http.Server;
  io: Server<ClientToServerEvents, ServerToClientEvents>;
  /** Start listening. Resolves with the bound port (0 picks a free port). */
  listen(port: number): Promise<number>;
  /** Stop the server and drop all sockets. */
  close(): Promise<void>;
}

/** Format a position in seconds as M:SS or H:MM:SS. */
export function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return (h ? `${h}:` : "") + `${mm}:${String(sec).padStart(2, "0")}`;
}

/** "Sam", "Sam and Alex", "Sam, Alex and Jo". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Clamp a client-supplied ContentInfo to safe, bounded strings. */
export function sanitizeContent(info: unknown): ContentInfo {
  const raw = (info ?? {}) as Partial<Record<keyof ContentInfo, unknown>>;
  const str = (v: unknown, max: number) =>
    v == null || v === "" ? null : String(v).slice(0, max);
  return {
    site: str(raw.site, 32) ?? "",
    id: str(raw.id, 128),
    title: str(raw.title, 200),
  };
}

/**
 * Build the Watch Party sync server. Pure factory — does not listen until you
 * call `.listen()`, which keeps it testable on an ephemeral port.
 */
export function createApp(opts: AppOptions = {}): RunningApp {
  const JOIN_SECRET = opts.joinSecret || "";
  const HOLD_TIMEOUT_MS = opts.holdTimeoutMs ?? 20_000;
  const log = opts.quiet ? () => {} : (...a: unknown[]) => console.log(...a);

  const app = express();
  app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));
  app.get("/", (_req, res) => res.type("text").send("watchparty sync server"));

  const httpServer = http.createServer(app);
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: { origin: true },
  });

  const registry = new RoomRegistry();

  const systemMessage = (text: string): ChatMessage => ({
    id: randomUUID(),
    name: "",
    text,
    at: Date.now(),
    system: true,
  });

  /**
   * Announce members who have drifted onto a different title than the host
   * (and those who have come back). Announcements are latched per member via
   * `warnedFor`, so a steady mismatch is reported once, not every sample.
   *
   * The host is the reference: if the host is on something unreadable, or the
   * sites differ, nothing is reported — see contentConflicts.
   */
  const refreshMismatches = (room: Room) => {
    const hostContent = registry.hostContent(room);
    for (const m of room.members.values()) {
      const off =
        m.id !== room.hostId && contentConflicts(m.content, hostContent);
      const key = off ? m.content?.id ?? null : null;
      if (key === m.warnedFor) continue;
      if (off) {
        const what = m.content?.title ? ` (${m.content.title})` : "";
        io.to(room.code).emit(
          "chatMessage",
          systemMessage(`⚠️ ${m.name} is watching something else${what} — their controls won't move the room`)
        );
      } else if (m.warnedFor) {
        io.to(room.code).emit(
          "chatMessage",
          systemMessage(`${m.name} is back on the same title`)
        );
      }
      m.warnedFor = key;
    }
  };

  // --- Buffering holds -------------------------------------------------------

  /**
   * Members the room is waiting on.
   *
   * Someone who is off-title is deliberately excluded: they are already not
   * being synced (see contentConflicts), so letting their buffering freeze
   * everyone else would punish the room for one person's mistake.
   */
  const blockers = (room: Room): RoomMember[] => {
    const hostContent = registry.hostContent(room);
    return [...room.members.values()].filter(
      (m) => m.ready === false && !contentConflicts(m.content, hostContent)
    );
  };

  /** Where the room is right now, projecting from the last known state. */
  const currentPosition = (room: Room): number => {
    const st = room.lastState;
    if (!st) return 0;
    return st.playing ? st.position + (Date.now() - st.at) / 1000 : st.position;
  };

  const clearHoldTimer = (room: Room) => {
    if (room.hold?.timer) clearTimeout(room.hold.timer);
    if (room.hold) room.hold.timer = null;
  };

  /**
   * Park the room at `position` until everyone has buffered. Returns true if a
   * hold is in effect, which callers use to decide whether to relay a play.
   */
  const beginHold = (room: Room, position: number): boolean => {
    const waiting = blockers(room);
    if (!waiting.length) return false;

    const names = waiting.map((m) => m.name);
    const isNew = !room.hold;
    clearHoldTimer(room);
    room.hold = {
      position,
      play: true,
      timer: setTimeout(() => releaseHold(room, true), HOLD_TIMEOUT_MS),
    };
    // The room is parked, so nothing is playing — a late joiner arriving now
    // should land paused at this position rather than chasing a moving target.
    if (room.lastState) {
      room.lastState = { ...room.lastState, position, playing: false, at: Date.now() };
    }

    io.to(room.code).emit("hold", { waiting: names, position });
    if (isNew) {
      io.to(room.code).emit(
        "chatMessage",
        systemMessage(`⏳ Waiting for ${listNames(names)} to buffer…`)
      );
    }
    return true;
  };

  /**
   * End a hold. `timedOut` means we gave up rather than everyone being ready;
   * `play` false means the hold was cancelled (someone hit pause), so the room
   * should stay where it is instead of resuming.
   */
  function releaseHold(room: Room, timedOut: boolean, play = true) {
    if (!room.hold) return;
    clearHoldTimer(room);
    const { position } = room.hold;
    room.hold = null;

    io.to(room.code).emit("holdRelease", { position, play, timedOut });
    if (room.lastState) {
      room.lastState = { ...room.lastState, position, playing: play, at: Date.now() };
    }
    if (!play) return; // a plain pause already speaks for itself in the chat
    io.to(room.code).emit(
      "chatMessage",
      systemMessage(
        timedOut
          ? "Gave up waiting — resuming without everyone."
          : "Everyone's buffered — resuming."
      )
    );
  }

  /** Re-evaluate a live hold after the set of blockers may have changed. */
  const refreshHold = (room: Room) => {
    if (!room.hold) return;
    const waiting = blockers(room);
    if (!waiting.length) {
      releaseHold(room, false);
      return;
    }
    // Still waiting, but on a different set of people — refresh the banner.
    io.to(room.code).emit("hold", {
      waiting: waiting.map((m) => m.name),
      position: room.hold.position,
    });
  };

  interface SocketData {
    roomCode?: string;
    name?: string;
  }

  io.on("connection", (socket) => {
    const data: SocketData = {};

    const emitSystem = (roomCode: string, text: string) => {
      io.to(roomCode).emit("chatMessage", systemMessage(text));
    };

    socket.on("joinRoom", (payload, ack) => {
      if (JOIN_SECRET && payload.secret !== JOIN_SECRET) {
        ack({ ok: false, error: "bad secret", youAreHost: false, members: [] });
        return;
      }
      const roomCode = String(payload.roomCode || "").trim().toLowerCase();
      const name = String(payload.name || "guest").slice(0, 40);
      if (!roomCode) {
        ack({ ok: false, error: "missing room code", youAreHost: false, members: [] });
        return;
      }

      const { room, isHost } = registry.join(roomCode, socket.id, name);
      data.roomCode = roomCode;
      data.name = name;
      socket.join(roomCode);

      const members = registry.memberList(room);
      ack({ ok: true, youAreHost: isHost, members, state: room.lastState });
      io.to(roomCode).emit("members", members);
      // A joiner arriving mid-hold needs the banner too.
      if (room.hold) {
        socket.emit("hold", {
          waiting: blockers(room).map((m) => m.name),
          position: room.hold.position,
        });
      }
      emitSystem(roomCode, `${name} joined`);
      log(`[join] ${name} (${socket.id}) -> ${roomCode} host=${isHost}`);
    });

    socket.on("setContent", (info) => {
      if (!data.roomCode) return;
      const room = registry.get(data.roomCode);
      const me = room?.members.get(socket.id);
      if (!room || !me) return;
      const next = sanitizeContent(info);
      const prev = me.content;
      if (prev && prev.site === next.site && prev.id === next.id && prev.title === next.title) {
        return; // unchanged — the client re-sends on every sample
      }
      me.content = next;
      io.to(room.code).emit("members", registry.memberList(room));
      refreshMismatches(room);
      // Going off-title removes you from the blockers, and vice versa.
      refreshHold(room);
    });

    socket.on("setReady", (ready) => {
      if (!data.roomCode) return;
      const room = registry.get(data.roomCode);
      const me = room?.members.get(socket.id);
      if (!room || !me) return;
      const next = ready !== false;
      if (me.ready === next) return; // edge-triggered; ignore repeats
      me.ready = next;
      io.to(room.code).emit("members", registry.memberList(room));

      if (!next) {
        // Stalled mid-playback: park the room so nobody runs ahead.
        if (room.lastState?.playing) beginHold(room, currentPosition(room));
        return;
      }
      refreshHold(room);
    });

    socket.on("playbackEvent", (event) => {
      if (!data.roomCode) return;
      const room = registry.get(data.roomCode);
      // A member who is demonstrably on another title must not drive the room:
      // their seeks would drag everyone to a position that means nothing here.
      if (
        room &&
        socket.id !== room.hostId &&
        contentConflicts(room.members.get(socket.id)?.content, registry.hostContent(room))
      ) {
        return;
      }
      if (room) {
        // A play can't go out while anyone is still buffering — that is the
        // whole point of the gate. Hold instead, and play on release.
        if (event.action === "play" && beginHold(room, event.position)) return;
        // Pausing cancels a pending hold: the room no longer wants to play, so
        // there is nothing left to wait for.
        if (event.action === "pause" && room.hold) releaseHold(room, false, false);
        // A seek during a hold moves the parking spot; the seek still relays so
        // everyone scrubs together while they wait.
        if (event.action === "seek" && room.hold) room.hold.position = event.position;

        room.lastState = {
          position: event.position,
          playing: event.action !== "pause" && !room.hold,
          at: event.at,
          content: event.content ?? null,
        };
      }
      socket.to(data.roomCode).emit("playbackEvent", { ...event, from: socket.id });

      const who = data.name || "someone";
      const verb =
        event.action === "pause"
          ? "paused"
          : event.action === "play"
          ? `resumed at ${fmtTime(event.position)}`
          : `jumped to ${fmtTime(event.position)}`;
      emitSystem(data.roomCode, `${who} ${verb}`);
    });

    socket.on("syncState", (state) => {
      if (!data.roomCode) return;
      const room = registry.get(data.roomCode);
      if (room) {
        // Only the host is trusted as the drift authority.
        if (room.hostId !== socket.id) return;
        room.lastState = state;
      }
      socket.to(data.roomCode).emit("syncState", state);
    });

    socket.on("chatMessage", (text) => {
      if (!data.roomCode) return;
      const msg: ChatMessage = {
        id: randomUUID(),
        name: data.name || "guest",
        text: String(text).slice(0, 500),
        at: Date.now(),
      };
      io.to(data.roomCode).emit("chatMessage", msg);
    });

    socket.on("reaction", (emoji) => {
      if (!data.roomCode) return;
      const clean = String(emoji).slice(0, 8);
      io.to(data.roomCode).emit("reaction", {
        name: data.name || "guest",
        emoji: clean,
        at: Date.now(),
      });
    });

    socket.on("ping", (ack) => ack(Date.now()));

    socket.on("requestSync", () => {
      if (!data.roomCode) return;
      const room = registry.get(data.roomCode);
      if (!room || !room.hostId) return;
      io.to(room.hostId).emit("syncRequested");
      if (room.lastState) socket.emit("syncState", room.lastState);
    });

    const cleanup = () => {
      if (!data.roomCode) return;
      const roomCode = data.roomCode;
      const who = data.name || "someone";
      const { room, hostChanged } = registry.leave(roomCode, socket.id);
      if (room) {
        io.to(room.code).emit("members", registry.memberList(room));
        emitSystem(room.code, `${who} left`);
        if (hostChanged && room.hostId) {
          io.to(room.code).emit("hostChanged", room.hostId);
          // The reference title moved with the host — recheck everyone.
          refreshMismatches(room);
        }
        // The person we were waiting for may have just walked out.
        refreshHold(room);
      }
      log(`[leave] ${data.name} (${socket.id}) <- ${roomCode}`);
      data.roomCode = undefined;
    };

    socket.on("leaveRoom", () => {
      socket.leave(data.roomCode || "");
      cleanup();
    });
    socket.on("disconnect", cleanup);
  });

  return {
    httpServer,
    io,
    listen(port: number) {
      return new Promise<number>((resolve) => {
        httpServer.listen(port, () => {
          resolve((httpServer.address() as AddressInfo).port);
        });
      });
    },
    close() {
      return new Promise<void>((resolve) => {
        io.close(() => resolve());
      });
    },
  };
}
