import http from "http";
import { randomUUID } from "crypto";
import express from "express";
import { Server } from "socket.io";
import { RoomRegistry } from "./rooms";
import {
  ClientToServerEvents,
  ServerToClientEvents,
  ChatMessage,
} from "./protocol";

const PORT = Number(process.env.PORT || 4000);
// Optional shared secret gate. Empty means no gate (fine for LAN testing).
const JOIN_SECRET = process.env.JOIN_SECRET || "";

const app = express();
app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));
app.get("/", (_req, res) => res.type("text").send("watchparty sync server"));

const server = http.createServer(app);

const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
  // The extension talks to us cross-origin (from netflix.com), so allow any origin.
  // Access is gated by room code + JOIN_SECRET, not by origin.
  cors: { origin: true },
});

const registry = new RoomRegistry();

// Per-socket bookkeeping so we know which room to clean up on disconnect.
interface SocketData {
  roomCode?: string;
  name?: string;
}

io.on("connection", (socket) => {
  const data: SocketData = {};

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
    console.log(`[join] ${name} (${socket.id}) -> ${roomCode} host=${isHost}`);
  });

  socket.on("playbackEvent", (event) => {
    if (!data.roomCode) return;
    const room = registry.get(data.roomCode);
    if (room) {
      room.lastState = {
        position: event.position,
        playing: event.action !== "pause",
        at: event.at,
        videoId: event.videoId ?? null,
      };
    }
    socket.to(data.roomCode).emit("playbackEvent", { ...event, from: socket.id });
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
    // Nudge the host to re-broadcast; fall back to last known state.
    io.to(room.hostId).emit("syncRequested");
    if (room.lastState) socket.emit("syncState", room.lastState);
  });

  const cleanup = () => {
    if (!data.roomCode) return;
    const { room, hostChanged } = registry.leave(data.roomCode, socket.id);
    if (room) {
      io.to(room.code).emit("members", registry.memberList(room));
      if (hostChanged && room.hostId) io.to(room.code).emit("hostChanged", room.hostId);
    }
    console.log(`[leave] ${data.name} (${socket.id}) <- ${data.roomCode}`);
    data.roomCode = undefined;
  };

  socket.on("leaveRoom", () => {
    socket.leave(data.roomCode || "");
    cleanup();
  });
  socket.on("disconnect", cleanup);
});

server.listen(PORT, () => {
  console.log(`watchparty sync server listening on :${PORT}`);
  if (!JOIN_SECRET) console.log("WARNING: JOIN_SECRET not set — no join gate");
});
