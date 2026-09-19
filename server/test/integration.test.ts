/**
 * Integration tests for the Watch Party sync server.
 *
 * These boot the REAL server on an ephemeral port and drive it with REAL
 * Socket.IO clients — exercising the full join/relay/host-election path over
 * the wire, not mocks. Run with:  npm test
 *
 * Self-contained runner (no test framework needed): each `test()` runs in
 * sequence; failures are collected and the process exits non-zero if any fail.
 */
import assert from "assert";
import http from "http";
import { io, Socket } from "socket.io-client";
import { createApp, RunningApp } from "../src/app";
import { ServerToClientEvents, ClientToServerEvents, JoinRoomResult } from "../src/protocol";

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

// ---- tiny test harness ------------------------------------------------------
interface Case {
  name: string;
  fn: () => Promise<void>;
}
const cases: Case[] = [];
const test = (name: string, fn: () => Promise<void>) => cases.push({ name, fn });

// ---- socket helpers ---------------------------------------------------------
let BASE = "";
const opened: Client[] = [];

function connect(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const s: Client = io(BASE, { transports: ["websocket"], forceNew: true });
    opened.push(s);
    const timer = setTimeout(() => reject(new Error("connect timeout")), 3000);
    s.on("connect", () => {
      clearTimeout(timer);
      resolve(s);
    });
  });
}

function join(
  s: Client,
  payload: { roomCode: string; name: string; secret?: string }
): Promise<JoinRoomResult> {
  return new Promise((resolve) => s.emit("joinRoom", payload, resolve));
}

/** Resolve with the first event matching `pred` (default: any). */
function waitFor<E extends keyof ServerToClientEvents>(
  s: Client,
  event: E,
  pred: (...args: any[]) => boolean = () => true,
  timeout = 2500
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      s.off(event as string, handler);
      reject(new Error(`timeout waiting for "${String(event)}"`));
    }, timeout);
    function handler(...args: any[]) {
      if (pred(...args)) {
        clearTimeout(timer);
        s.off(event as string, handler);
        resolve(args.length > 1 ? args : args[0]);
      }
    }
    s.on(event as string, handler as any);
  });
}

/** Assert an event does NOT arrive within `ms`. */
function expectNo(s: Client, event: keyof ServerToClientEvents, ms = 350): Promise<void> {
  return new Promise((resolve, reject) => {
    const handler = () => {
      s.off(event as string, handler);
      reject(new Error(`unexpected "${String(event)}"`));
    };
    s.on(event as string, handler as any);
    setTimeout(() => {
      s.off(event as string, handler);
      resolve();
    }, ms);
  });
}

const cleanup = () => {
  while (opened.length) opened.pop()?.disconnect();
};

// ---- tests ------------------------------------------------------------------

test("GET /health returns ok", async () => {
  const body: any = await new Promise((resolve, reject) => {
    http
      .get(`${BASE}/health`, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(JSON.parse(d)));
      })
      .on("error", reject);
  });
  assert.strictEqual(body.ok, true);
});

test("first joiner is host, second is not; both see 2 members", async () => {
  const a = await connect();
  const b = await connect();
  const ra = await join(a, { roomCode: "r1", name: "alice" });
  const rb = await join(b, { roomCode: "r1", name: "bob" });
  assert.ok(ra.ok && rb.ok, "both joins ok");
  assert.strictEqual(ra.youAreHost, true, "alice is host");
  assert.strictEqual(rb.youAreHost, false, "bob is not host");
  assert.strictEqual(rb.members.length, 2, "bob sees 2 members");
  cleanup();
});

test("playbackEvent relays to peers with from-id, not echoed to sender", async () => {
  const a = await connect();
  const b = await connect();
  await join(a, { roomCode: "r2", name: "alice" });
  await join(b, { roomCode: "r2", name: "bob" });

  const gotByB = waitFor(b, "playbackEvent");
  const noEcho = expectNo(a, "playbackEvent");
  a.emit("playbackEvent", { action: "pause", position: 42, at: Date.now() });

  const ev = await gotByB;
  assert.strictEqual(ev.action, "pause");
  assert.strictEqual(ev.position, 42);
  assert.ok(typeof ev.from === "string" && ev.from.length > 0, "carries sender id");
  await noEcho; // sender must not receive its own event
  cleanup();
});

test("system activity notices: joined + paused", async () => {
  const a = await connect();
  const b = await connect();
  // bob waits for a system "joined" mentioning himself once alice+bob are in.
  await join(a, { roomCode: "r3", name: "alice" });
  const bobJoined = waitFor(
    a,
    "chatMessage",
    (m: any) => m.system === true && /bob joined/.test(m.text)
  );
  await join(b, { roomCode: "r3", name: "bob" });
  await bobJoined;

  const paused = waitFor(
    b,
    "chatMessage",
    (m: any) => m.system === true && /alice paused/.test(m.text)
  );
  a.emit("playbackEvent", { action: "pause", position: 10, at: Date.now() });
  await paused;
  cleanup();
});

test("chatMessage broadcasts to everyone incl. sender, with name", async () => {
  const a = await connect();
  const b = await connect();
  await join(a, { roomCode: "r4", name: "alice" });
  await join(b, { roomCode: "r4", name: "bob" });

  const atSender = waitFor(a, "chatMessage", (m: any) => m.text === "hi" && !m.system);
  const atPeer = waitFor(b, "chatMessage", (m: any) => m.text === "hi" && !m.system);
  a.emit("chatMessage", "hi");
  const [ms, mp] = await Promise.all([atSender, atPeer]);
  assert.strictEqual(ms.name, "alice");
  assert.strictEqual(mp.name, "alice");
  cleanup();
});

test("reaction relays to the room", async () => {
  const a = await connect();
  const b = await connect();
  await join(a, { roomCode: "r5", name: "alice" });
  await join(b, { roomCode: "r5", name: "bob" });

  const got = waitFor(b, "reaction");
  a.emit("reaction", "🔥");
  const r = await got;
  assert.strictEqual(r.emoji, "🔥");
  assert.strictEqual(r.name, "alice");
  cleanup();
});

test("ping acks with a server timestamp", async () => {
  const a = await connect();
  await join(a, { roomCode: "r6", name: "alice" });
  const t: number = await new Promise((resolve) => a.emit("ping", resolve));
  assert.strictEqual(typeof t, "number");
  assert.ok(t > 0);
  cleanup();
});

test("syncState from host relays; from non-host is ignored", async () => {
  const host = await connect();
  const peer = await connect();
  await join(host, { roomCode: "r7", name: "host" });
  await join(peer, { roomCode: "r7", name: "peer" });

  // Host's syncState should reach the peer.
  const gotFromHost = waitFor(peer, "syncState");
  host.emit("syncState", { position: 100, playing: true, at: Date.now() });
  const s = await gotFromHost;
  assert.strictEqual(s.position, 100);

  // Peer (non-host) emitting syncState must NOT be relayed to the host.
  const noRelay = expectNo(host, "syncState");
  peer.emit("syncState", { position: 999, playing: true, at: Date.now() });
  await noRelay;
  cleanup();
});

test("requestSync nudges host and returns last state to requester", async () => {
  const host = await connect();
  const peer = await connect();
  await join(host, { roomCode: "r8", name: "host" });
  await join(peer, { roomCode: "r8", name: "peer" });

  // Seed room state with a host playback event.
  host.emit("playbackEvent", { action: "play", position: 55, at: Date.now() });
  await waitFor(peer, "playbackEvent");

  const hostNudged = waitFor(host, "syncRequested");
  const peerGetsState = waitFor(peer, "syncState", (s: any) => s.position === 55);
  peer.emit("requestSync");
  await Promise.all([hostNudged, peerGetsState]);
  cleanup();
});

test("host handoff: remaining member is promoted when host leaves", async () => {
  const host = await connect();
  const peer = await connect();
  await join(host, { roomCode: "r9", name: "host" });
  const rp = await join(peer, { roomCode: "r9", name: "peer" });
  assert.strictEqual(rp.youAreHost, false);

  const promoted = waitFor(peer, "hostChanged");
  host.disconnect();
  const newHostId = await promoted;
  assert.strictEqual(newHostId, peer.id, "peer becomes the new host");
  cleanup();
});

test("late joiner receives current room state in the join ack", async () => {
  const host = await connect();
  await join(host, { roomCode: "r10", name: "host" });
  host.emit("playbackEvent", { action: "play", position: 123, at: Date.now() });
  // allow the server to record lastState
  await new Promise((r) => setTimeout(r, 100));

  const late = await connect();
  const res = await join(late, { roomCode: "r10", name: "late" });
  assert.ok(res.state, "join ack includes state");
  assert.strictEqual(res.state!.position, 123);
  cleanup();
});

// ---- secret-gated server (separate instance) --------------------------------
test("JOIN_SECRET gate: rejects wrong secret, accepts correct", async () => {
  const secured = createApp({ joinSecret: "s3cr3t", quiet: true });
  const port = await secured.listen(0);
  const url = `http://localhost:${port}`;

  const bad: Client = io(url, { transports: ["websocket"], forceNew: true });
  await new Promise((r) => bad.on("connect", r));
  const rBad: JoinRoomResult = await new Promise((res) =>
    bad.emit("joinRoom", { roomCode: "x", name: "n", secret: "wrong" }, res)
  );
  assert.strictEqual(rBad.ok, false, "wrong secret rejected");

  const good: Client = io(url, { transports: ["websocket"], forceNew: true });
  await new Promise((r) => good.on("connect", r));
  const rGood: JoinRoomResult = await new Promise((res) =>
    good.emit("joinRoom", { roomCode: "x", name: "n", secret: "s3cr3t" }, res)
  );
  assert.strictEqual(rGood.ok, true, "correct secret accepted");

  bad.disconnect();
  good.disconnect();
  await secured.close();
});

// ---- runner -----------------------------------------------------------------
async function main() {
  const app: RunningApp = createApp({ quiet: true });
  const port = await app.listen(0);
  BASE = `http://localhost:${port}`;

  let passed = 0;
  const failures: string[] = [];

  for (const c of cases) {
    try {
      await c.fn();
      console.log(`  ✓ ${c.name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${c.name}\n      ${(err as Error).message}`);
      failures.push(c.name);
    } finally {
      cleanup();
    }
  }

  await app.close();

  console.log(`\n${passed}/${cases.length} passed`);
  if (failures.length) {
    console.error(`FAILED: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("PASS");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
