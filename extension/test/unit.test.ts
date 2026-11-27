/**
 * Unit tests for the extension's pure logic.
 *
 * The browser-side halves of this extension (the socket, the overlay, the page
 * bridge) need a real browser to exercise, but the decisions underneath them —
 * where the host really is, whether to correct drift, what page we're on, which
 * title is playing — are plain functions, and those are where sync regressions
 * actually hide. They run here in plain Node, in the same self-contained runner
 * style as the server suite.
 */
import assert from "assert";
import {
  clockSync,
  correctionRate,
  driftToleranceFor,
  isSupportedSite,
  isWatchPage,
  planSync,
  projected,
  sameContent,
  seqGate,
  stallDetector,
} from "../src/sync";
import { cleanTitle, idFromUrl } from "../src/players/identity";
import { NETFLIX_ID_PATTERNS } from "../src/players/netflix";
import { YOUTUBE_ID_PATTERNS } from "../src/players/youtube";
import { PRIME_ID_PATTERNS } from "../src/players/prime";
import { parsePrimeElapsed, primeClock } from "../src/players/primeClock";
import { TUBI_ID_PATTERNS } from "../src/players/tubi";
import { PLUTO_ID_PATTERNS } from "../src/players/pluto";
import { EINTHUSAN_ID_PATTERNS } from "../src/players/einthusan";
import {
  ConnParams,
  NO_PARTY,
  PartyRecord,
  affectedTabs,
  connKey,
  desiredConnection,
  isConnParams,
  join,
  leave,
  tabClosed,
  tabReplaced,
  viewFor,
  viewGate,
} from "../src/party";
import { SyncState } from "../src/protocol";

// ---- tiny test harness ------------------------------------------------------
const cases: { name: string; fn: () => void }[] = [];
const test = (name: string, fn: () => void) => cases.push({ name, fn });

// ---- helpers ----------------------------------------------------------------
const T0 = 1_700_000_000_000; // fixed clock, so nothing depends on wall time
const state = (over: Partial<SyncState> = {}): SyncState => ({
  position: 100,
  playing: true,
  at: T0,
  ...over,
});

// ---- clockSync --------------------------------------------------------------

test("clockSync recovers the offset from a symmetric round trip", () => {
  const c = clockSync();
  // Server is 2s ahead; 100ms each way.
  c.add(T0, T0 + 2000 + 100, T0 + 200);
  assert.strictEqual(c.offset(), 2000);
  assert.strictEqual(c.now(T0), T0 + 2000);
});

test("clockSync trusts the fastest round trip", () => {
  const c = clockSync();
  c.add(T0, T0 + 2000 + 900, T0 + 1000); // slow, asymmetric: offset reads 2400
  c.add(T0, T0 + 2000 + 50, T0 + 100); // fast: offset 2000
  c.add(T0, T0 + 2000 + 10, T0 + 600); // slow again: offset 1710
  assert.strictEqual(c.offset(), 2000);
});

test("clockSync is zero until it has a sample, and after reset", () => {
  const c = clockSync();
  assert.strictEqual(c.offset(), 0);
  c.add(T0, T0 + 500, T0);
  c.reset();
  assert.strictEqual(c.offset(), 0);
});

// ---- correctionRate ---------------------------------------------------------

test("correctionRate leaves sub-deadband drift alone", () => {
  assert.strictEqual(correctionRate(0.1, false), 1);
  assert.strictEqual(correctionRate(-0.1, false), 1);
});

test("correctionRate speeds up when behind and slows down when ahead", () => {
  assert.ok(correctionRate(-0.5, false) > 1);
  assert.ok(correctionRate(0.5, false) < 1);
});

test("correctionRate is capped", () => {
  assert.strictEqual(correctionRate(-2, false), 1.1);
  assert.strictEqual(correctionRate(2, false), 0.9);
});

test("correctionRate keeps correcting inside the deadband until settled", () => {
  assert.notStrictEqual(correctionRate(-0.1, true), 1);
  assert.strictEqual(correctionRate(-0.03, true), 1);
});

// ---- projected --------------------------------------------------------------

test("projected advances a playing state by the time in flight", () => {
  // 2.5s late means the host has moved on 2.5s.
  assert.strictEqual(projected(state({ position: 100 }), T0 + 2500), 102.5);
});

test("projected leaves a paused state alone however stale it is", () => {
  const paused = state({ playing: false, position: 100 });
  assert.strictEqual(projected(paused, T0 + 60_000), 100);
});

// ---- drift tolerance --------------------------------------------------------

test("fragile HTML5 sites get a looser drift tolerance than Netflix/YouTube", () => {
  for (const h of ["www.primevideo.com", "www.amazon.com", "tubitv.com", "pluto.tv", "einthusan.tv"]) {
    assert.strictEqual(driftToleranceFor(h), 2.5, h);
  }
  for (const h of ["www.netflix.com", "www.youtube.com"]) {
    assert.strictEqual(driftToleranceFor(h), 1, h);
  }
});

// ---- planSync ---------------------------------------------------------------

test("planSync does nothing when we are already in step", () => {
  const plan = planSync({ position: 100.2, playing: true }, state(), 1, T0);
  assert.strictEqual(plan.seek, false, "no corrective seek");
  assert.strictEqual(plan.setPlaying, null, "no play/pause change");
});

test("planSync seeks once drift exceeds the tolerance, not before", () => {
  const local = { position: 100, playing: true };
  // 0.9s out with a 1s tolerance: leave it alone.
  assert.strictEqual(planSync(local, state({ position: 100.9 }), 1, T0).seek, false);
  // Exactly at the tolerance counts as in sync: the comparison is strict, so
  // a room sitting right on the threshold doesn't seek on every broadcast.
  assert.strictEqual(planSync(local, state({ position: 101 }), 1, T0).seek, false);
  // 1.5s out: correct it.
  assert.strictEqual(planSync(local, state({ position: 101.5 }), 1, T0).seek, true);
});

test("planSync compares against the projected position, not the raw one", () => {
  // Host sent 100 while playing, 3s ago, so it is really at ~103. A follower
  // sitting at 103 is in sync even though the raw numbers differ by 3.
  const plan = planSync({ position: 103, playing: true }, state({ position: 100 }), 1, T0 + 3000);
  assert.strictEqual(plan.seek, false, "no seek: we match where the host actually is");
  assert.strictEqual(plan.position, 103);
});

test("planSync corrects playback state independently of position", () => {
  // Right place, wrong state: pause us without a pointless seek.
  const paused = planSync({ position: 100, playing: false }, state({ playing: true }), 1, T0);
  assert.strictEqual(paused.seek, false);
  assert.strictEqual(paused.setPlaying, true, "start playing");

  const playing = planSync(
    { position: 100, playing: true },
    state({ playing: false }),
    1,
    T0
  );
  assert.strictEqual(playing.setPlaying, false, "pause");
});

test("planSync handles the late-joiner case: wrong place and wrong state", () => {
  const plan = planSync({ position: 0, playing: false }, state({ position: 600 }), 1, T0 + 1000);
  assert.strictEqual(plan.seek, true);
  assert.strictEqual(plan.setPlaying, true);
  assert.strictEqual(plan.position, 601, "seek target includes time in flight");
});

// ---- isWatchPage ------------------------------------------------------------

test("isWatchPage reads the URL on Netflix and YouTube", () => {
  assert.strictEqual(isWatchPage("www.netflix.com", "/watch/81001", []), true);
  assert.strictEqual(isWatchPage("www.netflix.com", "/browse", []), false);
  assert.strictEqual(isWatchPage("www.youtube.com", "/watch", []), true);
  assert.strictEqual(isWatchPage("www.youtube.com", "/results", []), false);
});

test("isWatchPage falls back to a feature-length video where the URL says nothing", () => {
  // Prime opens its player in place, so only the DOM tells us.
  assert.strictEqual(isWatchPage("www.primevideo.com", "/detail/B01", [7200]), true);
  // A short clip or a trailer is not the feature.
  assert.strictEqual(isWatchPage("www.primevideo.com", "/detail/B01", [30]), false);
  // A video still loading reports NaN/0 duration.
  assert.strictEqual(isWatchPage("tubitv.com", "/movies/1", [NaN, 0]), false);
  // The ad player plus the real feature: the feature wins.
  assert.strictEqual(isWatchPage("pluto.tv", "/on-demand", [15, 5400]), true);
  assert.strictEqual(isWatchPage("einthusan.tv", "/movie/watch/42yB/", [9000]), true);
});

test("isWatchPage says no on sites we don't handle", () => {
  assert.strictEqual(isWatchPage("example.com", "/watch", [7200]), false);
});

// ---- sameContent ------------------------------------------------------------

test("sameContent compares every field, and treats nulls consistently", () => {
  const a = { site: "netflix", id: "1", title: "Arrival" };
  assert.strictEqual(sameContent(a, { ...a }), true);
  assert.strictEqual(sameContent(a, { ...a, id: "2" }), false);
  assert.strictEqual(sameContent(a, { ...a, title: "Other" }), false);
  assert.strictEqual(sameContent(null, null), true);
  assert.strictEqual(sameContent(a, null), false);
});

// ---- title cleanup ----------------------------------------------------------

test("cleanTitle strips site branding and tab counters", () => {
  assert.strictEqual(cleanTitle("Arrival - Netflix"), "Arrival");
  assert.strictEqual(cleanTitle("(3) Some Video - YouTube"), "Some Video");
  assert.strictEqual(cleanTitle("The Expanse | Prime Video"), "The Expanse");
  assert.strictEqual(cleanTitle("Some Film - Tubi"), "Some Film");
  assert.strictEqual(cleanTitle("Sigma (2026) Hindi in HD - Einthusan"), "Sigma (2026) Hindi in HD");
  assert.strictEqual(cleanTitle("   "), null, "an empty title is unknown, not blank");
});

test("cleanTitle keeps a dash that belongs to the title", () => {
  assert.strictEqual(cleanTitle("Spider-Man - Netflix"), "Spider-Man");
});

// ---- content ids ------------------------------------------------------------

test("idFromUrl returns the first pattern that matches, or null", () => {
  assert.strictEqual(idFromUrl([/a=(\d+)/, /b=(\d+)/], "https://x/?b=2"), "2");
  assert.strictEqual(idFromUrl([/a=(\d+)/], "https://x/?c=3"), null);
});

test("each site's id patterns pull the right id out of real URLs", () => {
  const table: [string, RegExp[], string | null][] = [
    ["https://www.netflix.com/watch/81001?trackId=2", NETFLIX_ID_PATTERNS, "81001"],
    ["https://www.netflix.com/browse", NETFLIX_ID_PATTERNS, null],

    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30", YOUTUBE_ID_PATTERNS, "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ", YOUTUBE_ID_PATTERNS, "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", YOUTUBE_ID_PATTERNS, "dQw4w9WgXcQ"],

    ["https://www.primevideo.com/detail/0H7HR4KGQ2Q0K1MZ/ref=x", PRIME_ID_PATTERNS, "0H7HR4KGQ2Q0K1MZ"],
    ["https://www.primevideo.com/region/eu/detail/0ABCDEFGHI/", PRIME_ID_PATTERNS, "0ABCDEFGHI"],
    ["https://www.amazon.com/gp/video/detail/B08XYZ1234/", PRIME_ID_PATTERNS, "B08XYZ1234"],

    ["https://tubitv.com/movies/612042/some-slug", TUBI_ID_PATTERNS, "612042"],
    ["https://tubitv.com/tv-shows/570362/s01_e01", TUBI_ID_PATTERNS, "570362"],

    ["https://pluto.tv/us/on-demand/movies/some-movie-id/watch", PLUTO_ID_PATTERNS, "some-movie-id"],
    ["https://pluto.tv/us/live-tv/comedy-channel", PLUTO_ID_PATTERNS, "comedy-channel"],

    ["https://einthusan.tv/movie/watch/42yB/?lang=hindi", EINTHUSAN_ID_PATTERNS, "42yB"],
    ["https://einthusan.tv/movie/results/?lang=hindi", EINTHUSAN_ID_PATTERNS, null],
  ];
  for (const [url, patterns, want] of table) {
    assert.strictEqual(idFromUrl(patterns, url), want, url);
  }
});

test("Pluto prefers the episode id over the series id", () => {
  // Otherwise everyone in a series would look like they're on the same thing.
  assert.strictEqual(
    idFromUrl(
      PLUTO_ID_PATTERNS,
      "https://pluto.tv/us/on-demand/series/abc123/season/1/episode/ep-7/watch"
    ),
    "ep-7"
  );
});

test("stallDetector rides out a brief re-buffer, like the one after a seek", () => {
  const s = stallDetector(1500);
  assert.strictEqual(s.ready(true, 0), true);
  assert.strictEqual(s.ready(true, 1000), true);
  assert.strictEqual(s.ready(false, 1400), true);
  // The clock restarts after recovering, so short blips never add up.
  assert.strictEqual(s.ready(true, 2000), true);
  assert.strictEqual(s.ready(true, 3000), true);
});

test("stallDetector reports a stall once buffering outlasts the grace period", () => {
  const s = stallDetector(1500);
  s.ready(true, 0);
  assert.strictEqual(s.ready(true, 1499), true);
  assert.strictEqual(s.ready(true, 1500), false);
  assert.strictEqual(s.ready(false, 4000), true);
});

test("stallDetector.reset forgets a stall in progress", () => {
  const s = stallDetector(1500);
  s.ready(true, 0);
  s.reset();
  assert.strictEqual(s.ready(true, 1500), true);
});

test("seqGate: a host lagging a relayed seek stamps the old seq until it catches up", () => {
  const g = seqGate(5000);
  g.reset(3);
  g.received(4, 0);
  assert.strictEqual(g.behind(), true);
  assert.strictEqual(g.stamp(1000), 3);
  g.caughtUp();
  assert.strictEqual(g.behind(), false);
  assert.strictEqual(g.stamp(1500), 4);
});

test("seqGate: a host that never visibly catches up is trusted again after the timeout", () => {
  const g = seqGate(5000);
  g.received(1, 0);
  assert.strictEqual(g.stamp(4999), 0);
  assert.strictEqual(g.stamp(5000), 1);
});

test("seqGate: our own event counts as caught up the moment it is acked", () => {
  const g = seqGate();
  g.received(1, 0); // still applying someone else's seek…
  g.sent(); // …when we seek ourselves
  g.acked(2);
  assert.strictEqual(g.behind(), false);
  assert.strictEqual(g.stamp(0), 2);
});

test("seqGate: a follower ignores beats older than the latest event, and all beats while unacked", () => {
  const g = seqGate();
  g.received(2, 0);
  assert.strictEqual(g.accepts({ seq: 1 }), false);
  assert.strictEqual(g.accepts({ seq: 2 }), true);
  assert.strictEqual(g.accepts({}), true); // older host without seqs
  g.sent();
  assert.strictEqual(g.accepts({ seq: 2 }), false); // relayed before our rewind landed
  g.acked(3);
  assert.strictEqual(g.accepts({ seq: 2 }), false);
  assert.strictEqual(g.accepts({ seq: 3 }), true);
});

test("isSupportedSite matches the manifest's sites, and only them", () => {
  assert.strictEqual(isSupportedSite("www.youtube.com", "/watch"), true);
  assert.strictEqual(isSupportedSite("netflix.com", "/browse"), true);
  assert.strictEqual(isSupportedSite("www.amazon.com", "/gp/video/detail/X"), true);
  assert.strictEqual(isSupportedSite("www.amazon.com", "/dp/B000"), false, "only Amazon's video pages");
  assert.strictEqual(isSupportedSite("einthusan.tv", "/movie/watch/x"), true);
  assert.strictEqual(isSupportedSite("notyoutube.com", "/watch"), false);
  assert.strictEqual(isSupportedSite("youtube.com.evil.example", "/watch"), false);
  assert.strictEqual(isSupportedSite("www.google.com", "/"), false);
});

// ---- party binding ----------------------------------------------------------

const room = (over: Partial<ConnParams> = {}): ConnParams => ({
  serverUrl: "https://s.example",
  roomCode: "movie-night",
  name: "Sam",
  secret: "shh",
  ...over,
});
const joined = (tabId = 7, rev = 0): PartyRecord => join({ party: null, rev }, tabId, room());

test("join binds the party to one tab and bumps the revision", () => {
  const rec = join(NO_PARTY, 7, room());
  assert.strictEqual(rec.party?.tabId, 7);
  assert.strictEqual(rec.party?.roomCode, "movie-night");
  assert.strictEqual(rec.rev, NO_PARTY.rev + 1);
});

test("joining from another tab moves the party there in one step", () => {
  const moved = join(joined(7), 9, room({ roomCode: "other" }));
  assert.strictEqual(moved.party?.tabId, 9);
  assert.strictEqual(moved.party?.roomCode, "other", "the new room travels with the new tab");
  assert.strictEqual(viewFor(moved, 7).conn, null, "the old tab is let go");
});

test("join keeps only the connection fields from what it is given", () => {
  const sneaky = { ...room(), tabId: 99, extra: true } as unknown as ConnParams;
  const rec = join(NO_PARTY, 7, sneaky);
  assert.strictEqual(rec.party?.tabId, 7, "the caller's tab id wins");
  assert.ok(!("extra" in (rec.party as object)));
});

test("leave clears the party, and is a no-op when there is none", () => {
  const left = leave(joined());
  assert.strictEqual(left.party, null);
  assert.strictEqual(left.rev, joined().rev + 1);
  assert.strictEqual(leave(NO_PARTY), NO_PARTY, "unchanged record means nothing to write");
});

test("closing the party tab ends the party; closing another tab does not", () => {
  const rec = joined(7);
  assert.strictEqual(tabClosed(rec, 8), rec);
  assert.strictEqual(tabClosed(rec, 7).party, null);
});

test("a late close of the old tab can't end a party that has moved on", () => {
  // Popup moves the party 7 -> 9, then tab 7's close is processed.
  const moved = join(joined(7), 9, room());
  assert.strictEqual(tabClosed(moved, 7), moved);
});

test("the party follows a tab whose id Chrome replaced", () => {
  const rec = tabReplaced(joined(7), 70, 7);
  assert.strictEqual(rec.party?.tabId, 70);
  assert.strictEqual(rec.party?.roomCode, "movie-night");
  const other = joined(7);
  assert.strictEqual(tabReplaced(other, 80, 8), other, "unrelated replacements are ignored");
});

test("only the party tab is told the room settings", () => {
  const rec = joined(7);
  assert.deepStrictEqual(viewFor(rec, 7).conn, room());
  assert.strictEqual(viewFor(rec, 8).conn, null, "other tabs never see the secret");
  assert.ok(!("tabId" in (viewFor(rec, 7).conn as object)));
  assert.strictEqual(viewFor(NO_PARTY, 7).conn, null);
});

test("affectedTabs names both ends of a move, once each", () => {
  assert.deepStrictEqual(affectedTabs(joined(7), join(joined(7), 9, room())), [7, 9]);
  assert.deepStrictEqual(affectedTabs(joined(7), join(joined(7), 7, room({ name: "A" }))), [7]);
  assert.deepStrictEqual(affectedTabs(NO_PARTY, NO_PARTY), []);
});

test("viewGate drops a stale snapshot that arrives after a newer one", () => {
  // A tab's startup request was answered before a push, but delivered after it.
  const g = viewGate();
  assert.strictEqual(g.accepts({ conn: null, rev: 5 }), true);
  assert.strictEqual(g.accepts({ conn: room(), rev: 4 }), false);
  assert.strictEqual(g.accepts({ conn: null, rev: 5 }), true, "the same snapshot twice is fine");
  assert.strictEqual(g.accepts({ conn: room(), rev: 6 }), true);
});

test("desiredConnection needs the switch on, a party, a watch page and a usable room", () => {
  const ok = { enabled: true, conn: room(), onWatchPage: true };
  assert.deepStrictEqual(desiredConnection(ok), room());
  assert.strictEqual(desiredConnection({ ...ok, enabled: false }), null);
  assert.strictEqual(desiredConnection({ ...ok, conn: null }), null);
  assert.strictEqual(desiredConnection({ ...ok, onWatchPage: false }), null);
  assert.strictEqual(desiredConnection({ ...ok, conn: room({ serverUrl: "" }) }), null);
  assert.strictEqual(desiredConnection({ ...ok, conn: room({ roomCode: "" }) }), null);
});

test("connKey changes with anything connection-relevant, and only that", () => {
  const base = connKey(room());
  assert.strictEqual(connKey({ ...room() }), base);
  for (const over of [{ roomCode: "x" }, { serverUrl: "https://x" }, { name: "Alex" }, { secret: "y" }]) {
    assert.notStrictEqual(connKey(room(over)), base, JSON.stringify(over));
  }
  assert.strictEqual(connKey(null), "");
});

test("connKey can't be confused by separators inside a field", () => {
  assert.notStrictEqual(
    connKey(room({ roomCode: "a|b", name: "c" })),
    connKey(room({ roomCode: "a", name: "b|c" }))
  );
});

test("isConnParams accepts room settings and rejects anything else", () => {
  assert.strictEqual(isConnParams(room()), true);
  assert.strictEqual(isConnParams(room({ secret: "" })), true, "an empty secret is allowed");
  assert.strictEqual(isConnParams({ ...room(), name: 5 }), false);
  assert.strictEqual(isConnParams({ serverUrl: "x", roomCode: "y" }), false);
  assert.strictEqual(isConnParams(null), false);
  assert.strictEqual(isConnParams("room"), false);
});

// ---- primeClock -------------------------------------------------------------

/**
 * Feed a clock 250ms samples of a viewer on Prime. `stream` is the <video>'s
 * currentTime and `content` is what Prime's time display would show (floored,
 * the way it is shown on screen). `adSec` seconds of ad play first, with the
 * display frozen. Returns the final stream and content times.
 */
function playPrime(
  c: ReturnType<typeof primeClock>,
  o: { stream: number; content: number; sec: number; adSec?: number; t: { now: number } }
) {
  let { stream, content } = o;
  const step = 0.25;
  for (let i = 0; i < (o.adSec ?? 0) / step; i++) {
    stream += step;
    o.t.now += step * 1000;
    c.observe(stream, Math.floor(content), o.t.now);
  }
  for (let i = 0; i < o.sec / step; i++) {
    stream += step;
    content += step;
    o.t.now += step * 1000;
    c.observe(stream, Math.floor(content), o.t.now);
  }
  return { stream, content };
}

test("parsePrimeElapsed reads the elapsed half of Prime's time display", () => {
  assert.strictEqual(parsePrimeElapsed("12:34 / 1:45:23"), 754);
  assert.strictEqual(parsePrimeElapsed("1:02:03 / 1:45:00"), 3723);
  assert.strictEqual(parsePrimeElapsed("0:05"), 5);
  assert.strictEqual(parsePrimeElapsed("-1:32:49"), null);
  assert.strictEqual(parsePrimeElapsed(""), null);
  assert.strictEqual(parsePrimeElapsed(null), null);
});

test("primeClock: viewers with and without ads report the same scene identically", () => {
  // Same scene at 10:00 of the title; one stream has 2 minutes of ads spliced in.
  const t = { now: T0 };
  const withAds = primeClock();
  const adFree = primeClock();
  const a = playPrime(withAds, { stream: 720, content: 600, sec: 3, t });
  const b = playPrime(adFree, { stream: 600, content: 600, sec: 3, t });
  assert.ok(Math.abs(withAds.content(a.stream) - a.content) < 0.3);
  assert.ok(Math.abs(adFree.content(b.stream) - b.content) < 0.3);
  // And a seek to a content time lands both on the same scene.
  assert.ok(Math.abs(withAds.stream(300) - 420) < 0.3);
  assert.ok(Math.abs(adFree.stream(300) - 300) < 0.3);
});

test("primeClock keeps advancing through an ad, then re-bases without calling it a seek", () => {
  const t = { now: T0 };
  const c = primeClock();
  let p = playPrime(c, { stream: 600, content: 600, sec: 2, t });
  // A 30s ad: the stream runs, the display stands still.
  const before = c.content(p.stream);
  p = playPrime(c, { ...p, sec: 0, adSec: 30, t });
  assert.ok(c.content(p.stream) > before + 29, "position should not freeze mid-ad");
  assert.strictEqual(c.takeAdJump(), false, "not re-based while the ad is still running");
  p = playPrime(c, { ...p, sec: 3, t });
  assert.ok(Math.abs(c.offset()! - 30) < 0.3);
  assert.ok(Math.abs(c.content(p.stream) - p.content) < 0.3);
  assert.strictEqual(c.takeAdJump(), true);
  assert.strictEqual(c.takeAdJump(), false, "reported once");
});

test("primeClock: seeking across an ad break re-bases but is still the viewer's seek", () => {
  const t = { now: T0 };
  const c = primeClock();
  let p = playPrime(c, { stream: 720, content: 600, sec: 2, t });
  // Rewind to 1:00, before the 2-minute ad break: the stream has no ads there.
  p = playPrime(c, { stream: 60, content: 60, sec: 3, t });
  assert.ok(Math.abs(c.offset()!) < 0.3);
  assert.ok(Math.abs(c.content(p.stream) - p.content) < 0.3);
  assert.strictEqual(c.takeAdJump(), false);
});

test("primeClock falls back to the stream clock until the display has been read", () => {
  const c = primeClock();
  c.observe(500, null, T0);
  assert.strictEqual(c.content(500), 500);
  assert.strictEqual(c.stream(500), 500);
});

// ---- runner -----------------------------------------------------------------
let passed = 0;
const failures: string[] = [];
for (const c of cases) {
  try {
    c.fn();
    console.log(`  ✓ ${c.name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${c.name}\n      ${(err as Error).message}`);
    failures.push(c.name);
  }
}
console.log(`\n${passed}/${cases.length} passed`);
if (failures.length) {
  console.error(`FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("PASS");
