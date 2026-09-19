/**
 * A long-lived virtual participant "bob" for live testing against the browser
 * host. Joins room "test", logs every event it receives to /tmp/bob.log, and
 * exposes a tiny HTTP control on :4100 so we can make bob emit events:
 *   curl localhost:4100/seek/1200     -> bob emits a seek to 1200s
 *   curl localhost:4100/pause/900     -> bob emits a pause at 900s
 *   curl localhost:4100/chat/hi       -> bob sends a chat message
 */
import http from "http";
import fs from "fs";
import { io, Socket } from "socket.io-client";
import { ClientToServerEvents, ServerToClientEvents } from "../src/protocol";

const URL = process.env.SERVER_URL || "http://localhost:4000";
const ROOM = process.env.ROOM || "test";
const SECRET = process.env.SECRET || undefined;

const LOG = "/tmp/bob.log";
fs.writeFileSync(LOG, "");
const log = (o: unknown) => fs.appendFileSync(LOG, JSON.stringify(o) + "\n");

const s: Socket<ServerToClientEvents, ClientToServerEvents> = io(URL, {
  transports: ["websocket"],
});

s.on("connect", () => {
  s.emit("joinRoom", { roomCode: ROOM, name: "bob", secret: SECRET }, (res) =>
    log({ evt: "joined", ok: res.ok, host: res.youAreHost, members: res.members.length })
  );
});
s.on("playbackEvent", (e) => log({ evt: "playbackEvent", ...e }));
s.on("syncState", (e) => log({ evt: "syncState", ...e }));
s.on("chatMessage", (m) => log({ evt: "chatMessage", name: m.name, text: m.text }));
s.on("reaction", (r) => log({ evt: "reaction", ...r }));
s.on("members", (m) => log({ evt: "members", count: m.length }));

http
  .createServer((req, res) => {
    const [, cmd, arg] = (req.url || "").split("/");
    if (cmd === "seek") s.emit("playbackEvent", { action: "seek", position: Number(arg), at: Date.now() });
    else if (cmd === "pause") s.emit("playbackEvent", { action: "pause", position: Number(arg), at: Date.now() });
    else if (cmd === "play") s.emit("playbackEvent", { action: "play", position: Number(arg), at: Date.now() });
    else if (cmd === "chat") s.emit("chatMessage", decodeURIComponent(arg || "hi"));
    res.end("ok\n");
  })
  .listen(4100, () => log({ evt: "control-ready" }));
