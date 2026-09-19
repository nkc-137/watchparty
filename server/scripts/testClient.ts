/**
 * Headless two-client test for the sync server (M1 verification).
 *
 *   npm run build && node dist/index.js      # in one terminal
 *   npm run test:client                       # in another
 *
 * Spins up two socket clients in one room: "alice" (host) emits a playback
 * event + chat; "bob" should receive both. Exits non-zero on failure.
 */
import { io, Socket } from "socket.io-client";
import { ClientToServerEvents, ServerToClientEvents } from "../src/protocol";

const URL = process.env.SERVER_URL || "http://localhost:4000";
const ROOM = "testroom";

type C = Socket<ServerToClientEvents, ClientToServerEvents>;

function connect(name: string): Promise<C> {
  return new Promise((resolve) => {
    const s: C = io(URL, { transports: ["websocket"] });
    s.on("connect", () => resolve(s));
  });
}

async function main() {
  const received = { playback: false, chat: false };

  const alice = await connect("alice");
  const bob = await connect("bob");

  bob.on("playbackEvent", (e) => {
    console.log("[bob] playbackEvent", e);
    received.playback = true;
  });
  bob.on("chatMessage", (m) => {
    console.log("[bob] chatMessage", m);
    received.chat = true;
  });

  const join = (s: C, name: string) =>
    new Promise<void>((resolve, reject) => {
      s.emit("joinRoom", { roomCode: ROOM, name }, (res) => {
        console.log(`[${name}] join ->`, res.ok, "host=", res.youAreHost);
        res.ok ? resolve() : reject(new Error(res.error));
      });
    });

  await join(alice, "alice");
  await join(bob, "bob");

  alice.emit("playbackEvent", { action: "pause", position: 42, at: Date.now() });
  alice.emit("chatMessage", "hello bob");

  await new Promise((r) => setTimeout(r, 500));

  alice.close();
  bob.close();

  if (received.playback && received.chat) {
    console.log("PASS: relay works");
    process.exit(0);
  } else {
    console.error("FAIL:", received);
    process.exit(1);
  }
}

main();
