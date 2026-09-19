/**
 * Popup: collects server/room config, persists it to chrome.storage.local.
 * The content script watches that key and (dis)connects accordingly.
 */
import { StoredConfig } from "./protocol";

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
const msg = () => document.getElementById("msg") as HTMLDivElement;

function fields(): Omit<StoredConfig, "connected"> {
  return {
    serverUrl: $("serverUrl").value.trim(),
    roomCode: $("roomCode").value.trim().toLowerCase(),
    name: $("name").value.trim() || "guest",
    secret: $("secret").value,
  };
}

function restore() {
  chrome.storage.local.get("wp", (r) => {
    const cfg = r.wp as StoredConfig | undefined;
    if (!cfg) return;
    $("serverUrl").value = cfg.serverUrl || "";
    $("roomCode").value = cfg.roomCode || "";
    $("name").value = cfg.name || "";
    $("secret").value = cfg.secret || "";
    if (cfg.connected) msg().textContent = `In room "${cfg.roomCode}".`;
  });
}

document.getElementById("join")!.addEventListener("click", () => {
  const f = fields();
  if (!f.serverUrl || !f.roomCode) {
    msg().textContent = "Server URL and room code are required.";
    return;
  }
  const cfg: StoredConfig = { ...f, connected: true };
  chrome.storage.local.set({ wp: cfg }, () => {
    msg().textContent = `Joining "${f.roomCode}"… (make sure a Netflix title is open)`;
  });
});

// --- Invite links ------------------------------------------------------------
// Encode server+room+secret into a compact token others can paste. Not secret
// (base64, not encryption) — the JOIN_SECRET is the actual access gate.
const PREFIX = "watchparty:";

function makeInvite(): string {
  const f = fields();
  const token = btoa(JSON.stringify({ s: f.serverUrl, r: f.roomCode, k: f.secret }));
  return PREFIX + token;
}

function applyInvite(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith(PREFIX)) return false;
  try {
    const o = JSON.parse(atob(t.slice(PREFIX.length)));
    if (o.s) $("serverUrl").value = o.s;
    if (o.r) $("roomCode").value = o.r;
    if (o.k) $("secret").value = o.k;
    return true;
  } catch {
    return false;
  }
}

document.getElementById("copy")!.addEventListener("click", async () => {
  const f = fields();
  if (!f.serverUrl || !f.roomCode) {
    msg().textContent = "Fill server URL and room code first.";
    return;
  }
  await navigator.clipboard.writeText(makeInvite());
  msg().textContent = "Invite copied — share it with friends.";
});

document.getElementById("paste")!.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    msg().textContent = applyInvite(text)
      ? "Invite loaded — set your name and Join."
      : "Clipboard has no valid invite.";
  } catch {
    msg().textContent = "Couldn't read clipboard.";
  }
});

document.getElementById("leave")!.addEventListener("click", () => {
  chrome.storage.local.get("wp", (r) => {
    const cfg = (r.wp as StoredConfig) || ({} as StoredConfig);
    chrome.storage.local.set({ wp: { ...cfg, connected: false } }, () => {
      msg().textContent = "Left the room.";
    });
  });
});

restore();
