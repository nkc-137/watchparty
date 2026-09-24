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
  RateLimiter,
  originAllowed,
  parseAllowedOrigins,
  secretMatches,
} from "../src/limits";
import {
  ServerToClientEvents,
  ClientToServerEvents,
  JoinRoomResult,
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

test("a member on a different title still drives the room", async () => {
  const host = await connect();
  await join(host, { roomCode: "content-other", name: "Host" });
  host.emit("setContent", { site: "prime", id: "B001", title: "Arrival" });

  const guest = await connect();
  await join(guest, { roomCode: "content-other", name: "Guest" });
  guest.emit("setContent", { site: "prime", id: "B002", title: "Arrival" });

  // Content is informational only; it never gates sync.
  const relayed = waitFor(host, "playbackEvent");
  guest.emit("playbackEvent", { action: "seek", position: 1200, at: Date.now() });
  const e = await relayed;
  assert.strictEqual(e.position, 1200);
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


// ---- abuse controls ---------------------------------------------------------

/** Connect + join against a purpose-built app. */
async function joinAt(url: string, room: string, name: string): Promise<Client> {
  const c: Client = io(url, { transports: ["websocket"], forceNew: true });
  opened.push(c);
  await new Promise((r) => c.on("connect", r));
  await new Promise((res) => c.emit("joinRoom", { roomCode: room, name }, res));
  return c;
}

test("originAllowed accepts the streaming sites and nothing else", async () => {
  for (const o of [
    "https://www.netflix.com",
    "https://www.primevideo.com",
    "https://www.amazon.com",
    "https://www.youtube.com",
    "https://tubitv.com",
    "https://pluto.tv",
  ]) {
    assert.strictEqual(originAllowed(o), true, o);
  }
  assert.strictEqual(originAllowed("https://evil.example"), false, "a random site");
  // Near-misses must not slip through a sloppy substring match.
  assert.strictEqual(originAllowed("https://netflix.com.evil.example"), false, "suffix trick");
  assert.strictEqual(originAllowed("https://notnetflix.com"), false, "prefix trick");
  // Non-browser clients send no Origin; JOIN_SECRET is what gates them.
  assert.strictEqual(originAllowed(undefined), true, "no origin");
});

test("originAllowed honors an explicit allowlist and the wildcard", async () => {
  assert.strictEqual(originAllowed("https://my.site", ["https://my.site"]), true);
  assert.strictEqual(originAllowed("https://www.netflix.com", ["https://my.site"]), false,
    "an explicit list replaces the defaults");
  assert.strictEqual(originAllowed("https://evil.example", "*"), true, "wildcard opts out");
});

test("parseAllowedOrigins reads the env var", async () => {
  assert.strictEqual(parseAllowedOrigins(undefined), undefined, "unset -> built-in list");
  assert.strictEqual(parseAllowedOrigins("  "), undefined, "blank -> built-in list");
  assert.strictEqual(parseAllowedOrigins("*"), "*");
  assert.deepStrictEqual(parseAllowedOrigins("https://a, https://b"), ["https://a", "https://b"]);
});

test("secretMatches is exact, and survives length mismatches", async () => {
  assert.strictEqual(secretMatches("movie-night", "movie-night"), true);
  assert.strictEqual(secretMatches("movie-night", "movie-nigh"), false, "shorter");
  assert.strictEqual(secretMatches("movie-night", "movie-nightX"), false, "longer");
  assert.strictEqual(secretMatches("movie-night", ""), false);
  // A non-string must not throw its way past the gate.
  assert.strictEqual(secretMatches("movie-night", undefined), false);
  assert.strictEqual(secretMatches("movie-night", { toString: () => "movie-night" }), false);
});

test("RateLimiter allows a burst up to the limit, then refuses until the window rolls", async () => {
  const rl = new RateLimiter({ limit: 3, windowMs: 1000 });
  assert.deepStrictEqual(
    [rl.allow(0), rl.allow(0), rl.allow(0), rl.allow(0)],
    [true, true, true, false],
    "fourth in the window is refused"
  );
  assert.strictEqual(rl.allow(1000), true, "new window, allowed again");
});

test("RateLimiter reports the moment it goes over, exactly once", async () => {
  const rl = new RateLimiter({ limit: 2, windowMs: 1000 });
  rl.allow(0);
  rl.allow(0);
  assert.strictEqual(rl.justExceeded(0), false, "not over yet");
  rl.allow(0);
  assert.strictEqual(rl.justExceeded(0), true, "first rejection warns");
  rl.allow(0);
  assert.strictEqual(rl.justExceeded(0), false, "further rejections stay quiet");
});

test("a chat flood is dropped and the sender is told once", async () => {
  const strict = createApp({ quiet: true, rateLimits: { chat: { limit: 2, windowMs: 60_000 } } });
  const port = await strict.listen(0);
  const url = `http://localhost:${port}`;

  const spammer = await joinAt(url, "flood", "Spammer");
  const bystander = await joinAt(url, "flood", "Bystander");

  const seen: string[] = [];
  bystander.on("chatMessage", (m) => { if (!m.system) seen.push(m.text); });
  const warnings: string[] = [];
  spammer.on("chatMessage", (m) => { if (m.system && m.text.includes("too fast")) warnings.push(m.text); });

  for (const t of ["1", "2", "3", "4", "5"]) spammer.emit("chatMessage", t);
  await new Promise((r) => setTimeout(r, 200));

  assert.deepStrictEqual(seen, ["1", "2"], "only the allowance gets through");
  assert.strictEqual(warnings.length, 1, "warned once, not per dropped message");

  await strict.close();
});

test("a seek storm is throttled too", async () => {
  const strict = createApp({
    quiet: true,
    rateLimits: { playback: { limit: 2, windowMs: 60_000 } },
  });
  const port = await strict.listen(0);
  const url = `http://localhost:${port}`;

  const host = await joinAt(url, "storm", "Host");
  const victim = await joinAt(url, "storm", "Victim");

  const relayed: number[] = [];
  victim.on("playbackEvent", (e) => relayed.push(e.position));
  for (let i = 0; i < 6; i++) {
    host.emit("playbackEvent", { action: "seek", position: i, at: Date.now() });
  }
  await new Promise((r) => setTimeout(r, 200));

  assert.deepStrictEqual(relayed, [0, 1], "the rest are dropped, not relayed");
  await strict.close();
});

test("a room refuses members past its cap", async () => {
  const small = createApp({ quiet: true, maxRoomSize: 2 });
  const port = await small.listen(0);
  const url = `http://localhost:${port}`;

  await joinAt(url, "tiny", "One");
  await joinAt(url, "tiny", "Two");

  const third: Client = io(url, { transports: ["websocket"], forceNew: true });
  opened.push(third);
  await new Promise((r) => third.on("connect", r));
  const res: JoinRoomResult = await new Promise((r) =>
    third.emit("joinRoom", { roomCode: "tiny", name: "Three" }, r)
  );

  assert.strictEqual(res.ok, false, "turned away");
  assert.strictEqual(res.error, "room is full");
  await small.close();
});

test("the cap is per room, and frees up when someone leaves", async () => {
  const small = createApp({ quiet: true, maxRoomSize: 1 });
  const port = await small.listen(0);
  const url = `http://localhost:${port}`;

  const only = await joinAt(url, "cap-a", "Only");
  // A different room is unaffected by another room being full.
  const other: JoinRoomResult = await new Promise(async (r) => {
    const c: Client = io(url, { transports: ["websocket"], forceNew: true });
    opened.push(c);
    await new Promise((ok) => c.on("connect", ok));
    c.emit("joinRoom", { roomCode: "cap-b", name: "Elsewhere" }, r);
  });
  assert.strictEqual(other.ok, true, "a different room still accepts joins");

  only.disconnect();
  await new Promise((r) => setTimeout(r, 120));

  const replacement: JoinRoomResult = await new Promise(async (r) => {
    const c: Client = io(url, { transports: ["websocket"], forceNew: true });
    opened.push(c);
    await new Promise((ok) => c.on("connect", ok));
    c.emit("joinRoom", { roomCode: "cap-a", name: "Replacement" }, r);
  });
  assert.strictEqual(replacement.ok, true, "the seat is free again");
  await small.close();
});

// ---- runner -----------------------------------------------------------------
async function main() {
  // The shared app runs with the flood limits effectively off: the behavioral
  // tests below send bursts no real client would, and throttling them would
  // only test the limiter by accident. The limits get their own apps, tuned
  // low, in the abuse-controls section.
  const app: RunningApp = createApp({
    quiet: true,
    rateLimits: {
      chat: { limit: 10_000, windowMs: 1000 },
      reaction: { limit: 10_000, windowMs: 1000 },
      playback: { limit: 10_000, windowMs: 1000 },
    },
  });
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
