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
import { MAX_HISTORY } from "../src/rooms";
import {
  ServerToClientEvents,
  ClientToServerEvents,
  JoinRoomResult,
  contentConflicts,
} from "../src/protocol";

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
  assert.strictEqual(r.from, a.id, "carries the sender's socket id");
  cleanup();
});

test("reactions from two members with the same name stay distinguishable", async () => {
  // Clients drop the echo of their own reaction. Matching on the display name
  // meant two friends both called "Sam" cancelled each other out, so each saw
  // only their own; `from` is what makes the two senders tellable apart.
  const sam1 = await connect();
  const sam2 = await connect();
  await join(sam1, { roomCode: "same-name", name: "Sam" });
  await join(sam2, { roomCode: "same-name", name: "Sam" });

  const seenBySam2 = waitFor(sam2, "reaction");
  sam1.emit("reaction", "😂");
  const r = await seenBySam2;

  assert.strictEqual(r.name, "Sam", "same display name as the receiver");
  assert.strictEqual(r.from, sam1.id, "but attributed to the actual sender");
  assert.notStrictEqual(r.from, sam2.id, "so the receiver won't mistake it for its own");
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


// ---- content identity -------------------------------------------------------

test("contentConflicts only fires when we can actually tell titles apart", async () => {
  const nf = (id: string | null) => ({ site: "netflix", id, title: "T" });

  assert.strictEqual(contentConflicts(nf("1"), nf("2")), true, "same site, different id");
  assert.strictEqual(contentConflicts(nf("1"), nf("1")), false, "same title");
  // An unknown id on either side means "can't tell", never a mismatch.
  assert.strictEqual(contentConflicts(nf(null), nf("2")), false, "unknown id");
  assert.strictEqual(contentConflicts(nf("1"), nf(null)), false, "unknown id (other side)");
  assert.strictEqual(contentConflicts(null, nf("1")), false, "no content at all");
  // Different services are never compared: the same film legitimately has
  // unrelated ids on Netflix and Prime.
  assert.strictEqual(
    contentConflicts(nf("1"), { site: "prime", id: "B00ABCDEFG", title: "T" }),
    false,
    "cross-site"
  );
});

test("members list carries each member's content", async () => {
  const host = await connect();
  await join(host, { roomCode: "content-members", name: "Host" });
  host.emit("setContent", { site: "netflix", id: "81001", title: "Arrival" });

  const guest = await connect();
  const updated = waitFor(guest, "members", (ms: any[]) =>
    ms.some((m) => m.content?.id === "81001")
  );
  await join(guest, { roomCode: "content-members", name: "Guest" });
  const ms = await updated;

  const h = ms.find((m: any) => m.isHost);
  assert.strictEqual(h.content.site, "netflix");
  assert.strictEqual(h.content.title, "Arrival");
});

test("a member on another title cannot drive the room", async () => {
  const host = await connect();
  await join(host, { roomCode: "content-block", name: "Host" });
  host.emit("setContent", { site: "netflix", id: "81001", title: "Arrival" });

  const stray = await connect();
  await join(stray, { roomCode: "content-block", name: "Stray" });
  stray.emit("setContent", { site: "netflix", id: "81002", title: "Some Sequel" });

  // Their seek refers to a different video, so the host must never see it.
  const quiet = expectNo(host, "playbackEvent");
  stray.emit("playbackEvent", { action: "seek", position: 1200, at: Date.now() });
  await quiet;
});

test("a member on the same title still drives the room", async () => {
  const host = await connect();
  await join(host, { roomCode: "content-allow", name: "Host" });
  host.emit("setContent", { site: "netflix", id: "81001", title: "Arrival" });

  const friend = await connect();
  await join(friend, { roomCode: "content-allow", name: "Friend" });
  friend.emit("setContent", { site: "netflix", id: "81001", title: "Arrival" });

  const relayed = waitFor(host, "playbackEvent");
  friend.emit("playbackEvent", { action: "seek", position: 1200, at: Date.now() });
  const e = await relayed;
  assert.strictEqual(e.position, 1200);
});

test("an unreadable content id never blocks anyone", async () => {
  const host = await connect();
  await join(host, { roomCode: "content-unknown", name: "Host" });
  host.emit("setContent", { site: "prime", id: null, title: null });

  const friend = await connect();
  await join(friend, { roomCode: "content-unknown", name: "Friend" });
  friend.emit("setContent", { site: "prime", id: null, title: null });

  const relayed = waitFor(host, "playbackEvent");
  friend.emit("playbackEvent", { action: "play", position: 42, at: Date.now() });
  const e = await relayed;
  assert.strictEqual(e.position, 42);
});

test("the room is told once when someone drifts off-title, and once when they return", async () => {
  const host = await connect();
  await join(host, { roomCode: "content-notice", name: "Host" });
  host.emit("setContent", { site: "netflix", id: "81001", title: "Arrival" });

  const stray = await connect();
  await join(stray, { roomCode: "content-notice", name: "Stray" });

  const warned = waitFor(host, "chatMessage", (m: any) =>
    m.system && m.text.includes("Stray") && m.text.includes("watching something else")
  );
  stray.emit("setContent", { site: "netflix", id: "81002", title: "Some Sequel" });
  await warned;

  // A steady mismatch is latched: repeating the same content says nothing more.
  const quiet = expectNo(host, "chatMessage");
  stray.emit("setContent", { site: "netflix", id: "81002", title: "Some Sequel" });
  await quiet;

  const recovered = waitFor(host, "chatMessage", (m: any) =>
    m.system && m.text.includes("back on the same title")
  );
  stray.emit("setContent", { site: "netflix", id: "81001", title: "Arrival" });
  await recovered;
});


// ---- buffering holds --------------------------------------------------------

/** Put a room into "playing" so a stall has something to interrupt. */
async function startPlaying(host: Client, position = 100) {
  host.emit("playbackEvent", { action: "play", position, at: Date.now() });
  await new Promise((r) => setTimeout(r, 60));
}

test("play is held while someone is still buffering, and not relayed", async () => {
  const host = await connect();
  await join(host, { roomCode: "hold-play", name: "Host" });
  const slow = await connect();
  await join(slow, { roomCode: "hold-play", name: "Slow" });

  slow.emit("setReady", false);
  await new Promise((r) => setTimeout(r, 60));

  // The host's play must turn into a hold, not a play for everyone else.
  const held = waitFor(slow, "hold");
  const noPlay = expectNo(slow, "playbackEvent");
  host.emit("playbackEvent", { action: "play", position: 90, at: Date.now() });

  const state = await held;
  assert.deepStrictEqual(state.waiting, ["Slow"]);
  assert.strictEqual(state.position, 90);
  await noPlay;
});

test("the hold lifts once everyone is ready, and resumes at the hold position", async () => {
  const host = await connect();
  await join(host, { roomCode: "hold-release", name: "Host" });
  const slow = await connect();
  await join(slow, { roomCode: "hold-release", name: "Slow" });

  slow.emit("setReady", false);
  await new Promise((r) => setTimeout(r, 60));
  const held = waitFor(host, "hold");
  host.emit("playbackEvent", { action: "play", position: 90, at: Date.now() });
  await held;

  const released = waitFor(host, "holdRelease");
  slow.emit("setReady", true);
  const r = await released;
  assert.strictEqual(r.play, true, "room resumes");
  assert.strictEqual(r.timedOut, false, "released because everyone is ready");
  assert.strictEqual(r.position, 90);
});

test("a stall mid-playback parks the whole room", async () => {
  const host = await connect();
  await join(host, { roomCode: "hold-stall", name: "Host" });
  const slow = await connect();
  await join(slow, { roomCode: "hold-stall", name: "Slow" });
  await startPlaying(host);

  const held = waitFor(host, "hold", (st: any) => st.waiting.includes("Slow"));
  slow.emit("setReady", false);
  await held;
});

test("a member who never recovers is given up on, not waited on forever", async () => {
  const impatient = createApp({ quiet: true, holdTimeoutMs: 150 });
  const port = await impatient.listen(0);
  const url = `http://localhost:${port}`;

  const mk = async (name: string): Promise<Client> => {
    const c: Client = io(url, { transports: ["websocket"], forceNew: true });
    await new Promise((r) => c.on("connect", r));
    await new Promise((res) => c.emit("joinRoom", { roomCode: "t", name }, res));
    return c;
  };
  const host = await mk("Host");
  const gone = await mk("Gone");

  gone.emit("setReady", false);
  await new Promise((r) => setTimeout(r, 60));
  host.emit("playbackEvent", { action: "play", position: 10, at: Date.now() });

  const r: any = await new Promise((res) => host.on("holdRelease", res));
  assert.strictEqual(r.timedOut, true, "gave up");
  assert.strictEqual(r.play, true, "and played anyway");

  host.disconnect();
  gone.disconnect();
  await impatient.close();
});

test("pausing during a hold cancels it instead of resuming later", async () => {
  const host = await connect();
  await join(host, { roomCode: "hold-cancel", name: "Host" });
  const slow = await connect();
  await join(slow, { roomCode: "hold-cancel", name: "Slow" });

  slow.emit("setReady", false);
  await new Promise((r) => setTimeout(r, 60));
  const held = waitFor(slow, "hold");
  host.emit("playbackEvent", { action: "play", position: 90, at: Date.now() });
  await held;

  const cancelled = waitFor(slow, "holdRelease");
  host.emit("playbackEvent", { action: "pause", position: 90, at: Date.now() });
  const r = await cancelled;
  assert.strictEqual(r.play, false, "cancelled, so nothing resumes");

  // And becoming ready afterwards must not start playback behind our backs.
  const quiet = expectNo(slow, "holdRelease");
  slow.emit("setReady", true);
  await quiet;
});

test("a member who leaves stops being waited on", async () => {
  const host = await connect();
  await join(host, { roomCode: "hold-leave", name: "Host" });
  const slow = await connect();
  await join(slow, { roomCode: "hold-leave", name: "Slow" });

  slow.emit("setReady", false);
  await new Promise((r) => setTimeout(r, 60));
  const held = waitFor(host, "hold");
  host.emit("playbackEvent", { action: "play", position: 90, at: Date.now() });
  await held;

  const released = waitFor(host, "holdRelease");
  slow.disconnect();
  const r = await released;
  assert.strictEqual(r.play, true, "room carries on without them");
});

test("someone on a different title never holds the room", async () => {
  const host = await connect();
  await join(host, { roomCode: "hold-offtitle", name: "Host" });
  host.emit("setContent", { site: "netflix", id: "81001", title: "Arrival" });

  const stray = await connect();
  await join(stray, { roomCode: "hold-offtitle", name: "Stray" });
  stray.emit("setContent", { site: "netflix", id: "81002", title: "Some Sequel" });
  stray.emit("setReady", false);
  await new Promise((r) => setTimeout(r, 60));

  // They are already excluded from sync, so their buffering is not our problem:
  // the play relays as normal and no hold is announced.
  const relayed = waitFor(stray, "playbackEvent");
  host.emit("playbackEvent", { action: "play", position: 90, at: Date.now() });
  const e = await relayed;
  assert.strictEqual(e.action, "play");
});

test("members carry readiness, and a joiner mid-hold is told about it", async () => {
  const host = await connect();
  await join(host, { roomCode: "hold-join", name: "Host" });
  const slow = await connect();
  await join(slow, { roomCode: "hold-join", name: "Slow" });

  slow.emit("setReady", false);
  const ms = await waitFor(host, "members", (list: any[]) =>
    list.some((m) => m.name === "Slow" && m.ready === false)
  );
  assert.strictEqual(ms.find((m: any) => m.isHost).ready, true, "host still ready");

  const held = waitFor(host, "hold");
  host.emit("playbackEvent", { action: "play", position: 90, at: Date.now() });
  await held;

  // A latecomer must see the banner too, not sit there wondering why it's paused.
  const late = await connect();
  const toldOnJoin = waitFor(late, "hold");
  await join(late, { roomCode: "hold-join", name: "Late" });
  const st = await toldOnJoin;
  assert.deepStrictEqual(st.waiting, ["Slow"]);
});


// ---- chat history -----------------------------------------------------------

/** Send `texts` in order and resolve once the last has come back. */
async function say(c: Client, texts: string[]) {
  const last = waitFor(c, "chatMessage", (m: any) => m.text === texts[texts.length - 1]);
  for (const t of texts) c.emit("chatMessage", t);
  await last;
}

test("a late joiner is caught up with the chat they missed", async () => {
  const early = await connect();
  await join(early, { roomCode: "hist-basic", name: "Early" });
  await say(early, ["first", "second", "third"]);

  const late = await connect();
  const res = await join(late, { roomCode: "hist-basic", name: "Late" });

  assert.deepStrictEqual(
    res.history?.map((m) => m.text),
    ["first", "second", "third"],
    "in the order they were said"
  );
  assert.strictEqual(res.history?.[0].name, "Early", "attributed to whoever said it");
});

test("a fresh room has no history rather than undefined behavior", async () => {
  const first = await connect();
  const res = await join(first, { roomCode: "hist-empty", name: "First" });
  assert.deepStrictEqual(res.history, [], "empty, not missing");
});

test("history is capped, keeping the most recent messages", async () => {
  const talker = await connect();
  await join(talker, { roomCode: "hist-cap", name: "Talker" });
  await say(talker, Array.from({ length: 60 }, (_, i) => `msg-${i}`));

  const late = await connect();
  const res = await join(late, { roomCode: "hist-cap", name: "Late" });

  assert.strictEqual(res.history?.length, MAX_HISTORY, "capped at MAX_HISTORY");
  // The oldest are dropped, not the newest: you want the end of the conversation.
  assert.strictEqual(res.history?.[0].text, "msg-10");
  assert.strictEqual(res.history?.[MAX_HISTORY - 1].text, "msg-59");
});

test("activity notices are not replayed as history", async () => {
  // "Sam paused" is status, not conversation — stale on arrival, and every
  // seek emits one, so replaying them would bury the actual chat.
  const a = await connect();
  await join(a, { roomCode: "hist-sys", name: "Ann" });
  const b = await connect();
  await join(b, { roomCode: "hist-sys", name: "Bob" }); // emits "Bob joined"
  a.emit("playbackEvent", { action: "pause", position: 10, at: Date.now() });
  await say(a, ["real message"]);

  const late = await connect();
  const res = await join(late, { roomCode: "hist-sys", name: "Late" });

  assert.deepStrictEqual(res.history?.map((m) => m.text), ["real message"]);
  assert.strictEqual(
    res.history?.some((m) => m.system),
    false,
    "no system notices in the backlog"
  );
});

test("history does not leak between rooms", async () => {
  const a = await connect();
  await join(a, { roomCode: "hist-room-a", name: "Ann" });
  await say(a, ["secret to room a"]);

  const b = await connect();
  const res = await join(b, { roomCode: "hist-room-b", name: "Bob" });
  assert.deepStrictEqual(res.history, [], "a different room starts empty");
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
