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
  connSig,
  driftToleranceFor,
  isWatchPage,
  planSync,
  projected,
  sameContent,
} from "../src/sync";
import { cleanTitle, idFromUrl } from "../src/players/identity";
import { NETFLIX_ID_PATTERNS } from "../src/players/netflix";
import { YOUTUBE_ID_PATTERNS } from "../src/players/youtube";
import { PRIME_ID_PATTERNS } from "../src/players/prime";
import { TUBI_ID_PATTERNS } from "../src/players/tubi";
import { PLUTO_ID_PATTERNS } from "../src/players/pluto";
import { contentConflicts as extensionConflicts } from "../src/protocol";
import { contentConflicts as serverConflicts } from "../../server/src/protocol";
import { StoredConfig, SyncState } from "../src/protocol";

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
const cfg = (over: Partial<StoredConfig> = {}): StoredConfig => ({
  serverUrl: "https://s.example",
  roomCode: "movie-night",
  name: "Sam",
  secret: "shh",
  connected: true,
  ...over,
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
  for (const h of ["www.primevideo.com", "www.amazon.com", "tubitv.com", "pluto.tv"]) {
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

// ---- connSig ----------------------------------------------------------------

test("connSig ignores display-only settings so the overlay toggle can't drop the socket", () => {
  assert.strictEqual(
    connSig(cfg({ showPanel: true })),
    connSig(cfg({ showPanel: false })),
    "showPanel must not be connection-relevant"
  );
});

test("connSig treats the master switch as connection-relevant", () => {
  // Flipping it must change the signature, because that is what triggers the
  // teardown that closes the socket and removes the overlay. If it were
  // excluded, switching off would leave a live connection behind.
  assert.notStrictEqual(connSig(cfg({ enabled: false })), connSig(cfg({ enabled: true })));
});

test("connSig treats a missing master switch as on", () => {
  // Installs predating the switch have no `enabled` field; they must not look
  // like a config change and reconnect on upgrade.
  assert.strictEqual(connSig(cfg({ enabled: undefined })), connSig(cfg({ enabled: true })));
});

test("connSig changes when anything connection-relevant changes", () => {
  const base = connSig(cfg());
  assert.notStrictEqual(connSig(cfg({ roomCode: "other" })), base);
  assert.notStrictEqual(connSig(cfg({ serverUrl: "https://other" })), base);
  assert.notStrictEqual(connSig(cfg({ secret: "different" })), base);
  assert.notStrictEqual(connSig(cfg({ name: "Alex" })), base);
  assert.notStrictEqual(connSig(cfg({ connected: false })), base);
  assert.strictEqual(connSig(null), "", "no config is its own signature");
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

// ---- protocol parity --------------------------------------------------------

test("the extension's protocol copy agrees with the server's", () => {
  // protocol.ts is duplicated by hand ("keep the two in sync"), so a silent
  // drift in the mismatch rule would split the room's behavior in half.
  const nf = (id: string | null) => ({ site: "netflix", id, title: "T" });
  const pairs: [any, any][] = [
    [nf("1"), nf("2")],
    [nf("1"), nf("1")],
    [nf(null), nf("2")],
    [nf("1"), null],
    [null, null],
    [nf("1"), { site: "prime", id: "B00ABCDEFG", title: "T" }],
    [
      { site: "prime", id: "B001", title: "T" },
      { site: "prime", id: "B002", title: "T" },
    ],
  ];
  for (const [a, b] of pairs) {
    assert.strictEqual(
      extensionConflicts(a, b),
      serverConflicts(a, b),
      `disagreement on ${JSON.stringify([a, b])}`
    );
  }
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
