# Deploying the sync server (Linux)

Goal: the sync server runs 24/7 on a spare Linux PC, reachable over public HTTPS
via a **free** Cloudflare Quick Tunnel — no domain, no router port-forwarding
(the tunnel dials *out* to Cloudflare).

Trade-off: a Quick Tunnel's URL is **random and changes on every restart/reboot**.
You fetch the current URL and reshare an invite each session. Want a URL that
never changes? See "Optional: stable named tunnel" at the end.

There are two ways to run it. **Docker is the recommended path** (server + tunnel
in one stack, easy to manage in Portainer and monitor in Uptime Kuma). The
systemd path is kept below as an alternative for a no-Docker setup.

---

## Recommended: Docker stack (server + tunnel)

The repo ships a `docker-compose.yml` that runs **two containers**:

- `watchparty-docker` — the sync server, host port **4001** → container 4000,
  with a healthcheck.
- `watchparty-tunnel-docker` — a Cloudflare Quick Tunnel reaching the server over
  the internal Docker network (`http://watchparty:4000`); no host port needed.

### Deploy with Portainer (Git stack)

1. **Stacks → Add stack → Repository**.
2. Repository URL: `https://github.com/nkc-137/watchparty`
3. Reference: `refs/heads/main`, Compose path: `docker-compose.yml`
4. Add an environment variable **`JOIN_SECRET`** = your shared party password.
5. **Deploy the stack.** Portainer builds the image from `server/Dockerfile` and
   starts both containers. (The server service uses `build:` only — no registry
   pull — so don't enable any "re-pull image" toggle.)

### Or deploy with the Docker CLI

```bash
$ git clone https://github.com/nkc-137/watchparty ~/watchparty   # or git pull
$ cd ~/watchparty
$ JOIN_SECRET=your-party-password docker compose up -d --build
```

### Get the public URL

```bash
$ docker logs watchparty-tunnel-docker 2>&1 | grep trycloudflare
```

Handy helper for `~/.bashrc`:

```bash
party-url-docker() {
  docker logs watchparty-tunnel-docker 2>&1 \
    | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1
}
```

### Verify

```bash
$ curl -s localhost:4001/health                    # {"ok":true,...}  (LAN)
$ curl -s "$(party-url-docker)/health"             # {"ok":true,...}  (internet)
```

### Monitor with Uptime Kuma

Add an **HTTP(s)** monitor to `http://<laptop-lan-ip>:4001/health` (use the LAN
IP, not `localhost`, if Kuma itself runs in Docker). Keep this LAN monitor as the
source of truth; a monitor on the public `trycloudflare.com` URL will go red
after each redeploy because that URL changes.

### Updating

Push server changes, then in Portainer hit **Pull and redeploy** (or CLI:
`git pull && docker compose up -d --build`). The public URL changes on redeploy —
re-grab it with `party-url-docker` and reshare the invite.

---

# Alternative: systemd (no Docker)

Assumes a Debian/Ubuntu-family distro (`apt`), x86-64. Run everything **on the
PC** (SSH in, or sit at it). Lines starting with `$` are commands.

> Note: the server listens on `:4000` here. If the Docker stack (`:4001`) is also
> running, the two coexist fine on different ports.

## 0. Prerequisites

- The PC is on and connected to the internet. That's it — no domain needed.

---

## 1. Get the project onto the PC

Copy the `watchparty/` folder over. Easiest options:

```bash
# from your Mac, over SSH (replace user@oldpc):
$ scp -r /Users/kapilchandra/watchparty user@oldpc:~/watchparty
```

or put it on GitHub and `git clone` it on the PC. You only strictly need the
`server/` folder on the PC; the `extension/` is built once and shared with
players (see Step 7).

---

## 2. Install Node.js 18+

```bash
$ curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
$ sudo apt-get install -y nodejs
$ node --version    # expect v20.x
```

(Fedora: `sudo dnf install nodejs`. Arch: `sudo pacman -S nodejs npm`.)

---

## 3. Build the server

```bash
$ cd ~/watchparty/server
$ npm install
$ npm run build     # produces dist/index.js
```

Quick local check (Ctrl-C to stop):

```bash
$ JOIN_SECRET=ourparty PORT=4000 node dist/index.js
# in another shell:
$ curl localhost:4000/health   # -> {"ok":true,...}
```

---

## 4. Run the server as a systemd service

So it starts on boot and restarts on crash. Create the unit
(`sudo nano /etc/systemd/system/watchparty.service`):

```ini
[Unit]
Description=Watch Party sync server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# use your actual username and the absolute path to the repo:
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER/watchparty/server
ExecStart=/usr/bin/node dist/index.js
Environment=PORT=4000
Environment=JOIN_SECRET=CHANGE_ME_shared_password
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Enable and start it:

```bash
$ sudo systemctl daemon-reload
$ sudo systemctl enable --now watchparty
$ systemctl status watchparty          # should be active (running)
$ journalctl -u watchparty -f          # live logs (Ctrl-C to exit)
```

**Set `JOIN_SECRET` to a real password** — it's the gate that keeps strangers
out of your rooms.

---

## 5. Install cloudflared

```bash
$ curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
$ sudo dpkg -i cloudflared.deb
$ cloudflared --version
```

(For ARM boards use `cloudflared-linux-arm64.deb`. Non-deb distros: download the
matching binary from the same releases page.)

---

## 6. Run the Quick Tunnel as a service (survives reboot)

No login and no domain needed for a Quick Tunnel. Create the unit
(`sudo nano /etc/systemd/system/watchparty-tunnel.service`):

```ini
[Unit]
Description=Watch Party quick tunnel
After=network-online.target watchparty.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/cloudflared tunnel --url http://localhost:4000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

(Confirm the path with `which cloudflared` and fix `ExecStart` if it differs.)

```bash
$ sudo systemctl daemon-reload
$ sudo systemctl enable --now watchparty-tunnel
```

WebSockets pass through automatically — no extra config needed. Now both the
server and the tunnel come back automatically after a power cut or reboot.

---

## 7. Get the current public URL

The URL is printed in the tunnel's logs. Grab the latest one:

```bash
$ journalctl -u watchparty-tunnel --no-pager \
    | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1
# -> https://something-random.trycloudflare.com
$ curl https://<that-url>/health    # -> {"ok":true,...}
```

Add a `party-url` helper to your shell (`~/.zshrc` or `~/.bashrc`) so you can
fetch it anytime:

```bash
party-url() {
  journalctl -u watchparty-tunnel --no-pager \
    | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1
}
```

**Remember:** this URL changes every time the tunnel restarts (including
reboots), so re-run `party-url` and reshare the invite each movie night.

---

## 8. Point the extension at the URL and invite people

Each participant does this once:

1. Build the extension (once, on any machine): `cd extension && npm install && npm run build`.
   Share the `extension/dist` folder with friends (zip it).
2. In Chrome: `chrome://extensions` → Developer mode → **Load unpacked** → select `dist`.
3. In the popup, set **Server URL** = the current `party-url` value, a shared
   **Room code**, their **Name**, and the **Secret** (= your `JOIN_SECRET`).

Shortcut: fill it once yourself, click **Copy invite**, and send friends the
token — they hit **Paste invite** and only type their name.

Everyone opens the **same Netflix title**, then **Join**. Done.

---

## Operations cheat-sheet

```bash
# server
sudo systemctl restart watchparty
journalctl -u watchparty -f

# tunnel
sudo systemctl restart watchparty-tunnel   # NOTE: changes the public URL
journalctl -u watchparty-tunnel -f
party-url                                   # print the current public URL

# after pulling new code:
cd ~/watchparty/server && npm install && npm run build && sudo systemctl restart watchparty
```

## Security notes

- Keep `JOIN_SECRET` set and non-trivial; rotate it by editing the service file
  and `sudo systemctl daemon-reload && sudo systemctl restart watchparty`. It is
  compared in constant time, so a wrong guess leaks nothing about the real one.
- The server ships with abuse controls on by default, all tunable by env var:

  | Variable | Default | What it does |
  | --- | --- | --- |
  | `ALLOWED_ORIGINS` | the streaming sites | Comma-separated browser origins allowed to open a socket. `*` accepts any site (the old behavior) — only set it if you connect from a custom page. |
  | `MAX_ROOM_SIZE` | `20` | Members per room; further joins are refused with "room is full". |

  Per-socket flood limits on chat, reactions and playback events are always on.
  They are generous enough that a real movie night never notices, and a member
  who trips one is told privately to slow down.
- The server only relays timing + chat text, never video or credentials, so the
  exposure surface is tiny — but the secret still keeps randoms out of your rooms.
- No inbound firewall changes are needed; the tunnel is an outbound connection.

---

## Optional: stable named tunnel (needs a domain)

A Quick Tunnel's URL changes on every restart. For a permanent URL like
`party.yourdomain.com`, add a domain to Cloudflare (any registrar; free plan),
then instead of §6–§7:

```bash
$ cloudflared tunnel login                              # authorize your domain
$ cloudflared tunnel create watchparty                  # note the Tunnel ID
$ cloudflared tunnel route dns watchparty party.yourdomain.com
```

Write `~/.cloudflared/config.yml`:

```yaml
tunnel: watchparty
credentials-file: /home/YOUR_USER/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: party.yourdomain.com
    service: http://localhost:4000
  - service: http_status:404
```

Then run it as a service: `sudo cloudflared service install && sudo systemctl
enable --now cloudflared`. Participants use `https://party.yourdomain.com` — a
URL that never changes.
