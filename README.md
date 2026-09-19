# Watch Party (Netflix + Prime Video)

Self-hosted, Teleparty-style watch party for **Netflix and Amazon Prime Video**.
Everyone streams from **their own** account; the server only synchronizes
playback (play/pause/seek) and relays chat — no video ever passes through it.
This keeps it legal and dodges Widevine DRM entirely.

Per-site player control lives in `extension/src/players/` (one adapter per
site). Adding another service later is mostly writing a new adapter.

```
[Chrome + extension] ─┐
[Chrome + extension]  ├── WSS ──> [sync server on old PC] ──(Cloudflare Quick Tunnel)──> public HTTPS
[Chrome + extension] ─┘
```

Current deployment: the server runs as a **systemd** service on a Linux PC, with
a **Cloudflare Quick Tunnel** (free, no domain) giving it a public HTTPS URL.
See [DEPLOY.md](DEPLOY.md) for the full step-by-step.

## Layout

- `server/` — Node + TypeScript + Socket.IO sync server (rooms, event relay, chat).
- `extension/` — Manifest V3 Chrome extension (Netflix player hook + chat overlay).

---

## Run the server

```bash
cd server
npm install
npm run build
JOIN_SECRET=some-shared-password PORT=4000 npm start
```

Headless sanity check (server must be running):

```bash
npm run test:client      # spins up two socket clients, asserts relay works
```

## Build & load the extension

```bash
cd extension
npm install
npm run build            # outputs extension/dist/
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** →
**Load unpacked** → select `extension/dist`.

## Use it

1. Everyone opens the **same** title on the **same** service — a Netflix
   `netflix.com/watch/<id>` page, or an Amazon Prime Video title that's playing.
2. Click the extension icon, fill in:
   - **Server URL** — e.g. `http://localhost:4000` for LAN, or your public
     `https://…` tunnel URL over the internet.
   - **Room code** — any shared string (e.g. `movie-night`).
   - **Name**, and the **Secret** if you set `JOIN_SECRET`.
3. Click **Join**. A chat panel appears; the first person to join is host.
4. Host's play/pause/seek drives everyone; host also broadcasts state every 3s
   to correct drift. Chat is shared by all.

> Note: browsers require a **secure origin** (`https://` / `wss://`) for
> production. `http://localhost` works for local testing; for real use put the
> server behind the Cloudflare Tunnel below.

---

## Deploy on the old PC

The current setup runs on a Debian/Ubuntu Linux PC with two `systemd` services:

- **`watchparty`** — the Node server on `localhost:4000` (with `JOIN_SECRET`).
- **`watchparty-tunnel`** — a Cloudflare **Quick Tunnel** (free, no domain)
  exposing it over public HTTPS.

Full walkthrough — Node install, the systemd unit files, and the tunnel — is in
**[DEPLOY.md](DEPLOY.md)**. Both services auto-start on boot.

Because a Quick Tunnel's URL is **random and changes on every restart/reboot**,
grab the current URL on the PC with:

```bash
journalctl -u watchparty-tunnel --no-pager \
  | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1
```

(A `party-url` shell helper for this is set up in DEPLOY.md.) For a **stable**
URL, add a domain to Cloudflare and use a named tunnel instead — see the
"named tunnel" note in DEPLOY.md. A private, no-domain alternative is Tailscale.

---

## How your friends join a watch party

Send this to anyone you invite. They need their own Netflix account.

1. **Install the extension** (one time):
   - Get the `extension/dist` folder from the host (a zip is fine), unzip it.
   - Chrome → `chrome://extensions` → turn on **Developer mode** →
     **Load unpacked** → select the `dist` folder. Pin the "Watch Party" icon.
2. **Open the movie/show** — everyone must be on the **same** title on the
   **same** service (Netflix or Prime Video). The host says which one.
3. **Join the room** — click the Watch Party icon, then either:
   - Click **Paste invite** (if the host sent you an invite token) and just add
     your **Name**, **or**
   - Fill in **Server URL**, **Room code**, **Name**, and **Secret** manually
     with the values the host gives you.
   - Click **Join**.
4. A chat panel appears on the right. The host controls play/pause/seek for
   everyone; chat and emoji reactions are shared. If you drift out of sync, hit
   the **⟳** button to snap back to the host's position.

Host side: fill the popup once, click **Copy invite**, and send the token — it
bundles the URL + room + secret so friends only type their name. Remember to
re-share a fresh invite whenever the tunnel URL changes.

---

## How the player hooks work

Content scripts can't see the page's JS globals (isolated world), so
`src/inject.ts` runs in the page's **MAIN world** (declared in `manifest.json`).
It picks a per-site **adapter** from `src/players/` and drives it generically:

- `players/netflix.ts` — Netflix's private player API
  (`netflix.appContext.state.playerApp.getAPI().videoPlayer`).
- `players/prime.ts` — Amazon Prime's standard HTML5 `<video>` element.

`inject.ts` bridges to `src/content.ts` (which owns the socket) via
`window.postMessage`. To add another service, write a new adapter implementing
`players/types.ts` and register it in `players/index.ts` — nothing else changes.

**Site robustness note:** Netflix exposes a real `seek()` API that buffers
gracefully. Prime only gives us the raw HTML5 `<video>`, and rapid/large seeks
can crash its DRM pipeline ("Video Unavailable"). Adapters therefore carry
optional tuning (`minSeekIntervalMs`, `playPauseDriftSec`) — Prime rate-limits
and coalesces seeks and won't re-seek on a plain pause unless it's off by >2.5s.
Followers on Prime also use a looser drift tolerance. Netflix keeps its original
tight, always-seek behavior (the defaults are no-ops).

## Verification checklist

- **Server relay:** `npm run test:client` prints `PASS`.
- **Player control:** on a Netflix title with the extension loaded, the overlay
  status reaches "connected"; pausing in one browser pauses the other within ~1s.
- **Two-profile sync:** two Chrome profiles in the same room + same title stay
  in sync on play/pause/seek.
- **Remote:** from a phone on cellular via the tunnel URL, a two-person party
  stays in sync end-to-end.

## Features

- Host-authoritative play/pause/seek sync with drift correction.
- Survives Netflix's single-page-app navigation: the overlay auto-mounts when
  you enter a `/watch/` page and tears down when you leave — no manual reload.
- Host handoff when the host disconnects.
- Shared chat with member list.
- **Emoji reactions** — floating over the video, quick-buttons in the overlay.
- **Latency badge** — live round-trip time to the server (green/amber/red).
- **Resync button** (⟳) — pull the host's current position on demand.
- **Copyable invites** — "Copy invite" encodes server+room+secret into a token;
  friends hit "Paste invite" to auto-fill everything but their name.

## Roadmap

"Wait for everyone to buffer before play", copyable deep links (vs. tokens),
per-title auto room codes.
