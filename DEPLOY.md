# Deploying on the old PC (Linux + Cloudflare Quick Tunnel)

Goal: the sync server runs 24/7 on your old Linux PC, reachable over public
HTTPS via a **free** Cloudflare Quick Tunnel — no domain, no router
port-forwarding (the tunnel dials *out* to Cloudflare).

Trade-off: a Quick Tunnel's URL is **random and changes on every restart/reboot**.
You fetch the current URL and reshare an invite each session (helper below).
Want a URL that never changes? See "Optional: stable named tunnel" at the end.

Assumes a Debian/Ubuntu-family distro (`apt`), x86-64. Run everything **on the
old PC** (SSH in, or sit at it). Lines starting with `$` are commands.

---

## 0. Prerequisites

- The old PC is on and connected to the internet. That's it — no domain needed.

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
  and `sudo systemctl daemon-reload && sudo systemctl restart watchparty`.
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
