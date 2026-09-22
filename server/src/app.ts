import http from "http";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import express from "express";
import { Server } from "socket.io";
import { Room, RoomRegistry } from "./rooms";
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
        room.lastState = {
          position: event.position,
          playing: event.action !== "pause",
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
