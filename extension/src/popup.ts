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

/** Dim and disable everything the master switch governs when it's off. */
function applyEnabledUI(on: boolean) {
  document.body.classList.toggle("off", !on);
}

function restore() {
  chrome.storage.local.get("wp", (r) => {
    const cfg = r.wp as StoredConfig | undefined;
    if (!cfg) return;
    $("serverUrl").value = cfg.serverUrl || "";
    $("roomCode").value = cfg.roomCode || "";
    $("name").value = cfg.name || "";
    $("secret").value = cfg.secret || "";
    $("showPanel").checked = cfg.showPanel !== false; // default on
    $("enabled").checked = cfg.enabled !== false; // default on
    applyEnabledUI(cfg.enabled !== false);
    if (cfg.enabled === false) msg().textContent = "Extension is off.";
    else if (cfg.connected) msg().textContent = `In room "${cfg.roomCode}".`;
  });
}

// The master switch. Off makes the content script tear down completely — the
// socket leaves the room and closes, and the overlay is removed — so nothing is
// sent or received. The room config is kept so switching back on rejoins.
$("enabled").addEventListener("change", () => {
  const on = $("enabled").checked;
  applyEnabledUI(on);
  chrome.storage.local.get("wp", (r) => {
    const cfg = (r.wp as StoredConfig) || ({} as StoredConfig);
    chrome.storage.local.set({ wp: { ...cfg, enabled: on } });
    msg().textContent = on ? "Extension on." : "Extension off — sync and chat stopped.";
  });
});

// Toggling the overlay updates config live — sync keeps running either way.
$("showPanel").addEventListener("change", () => {
  const show = $("showPanel").checked;
  chrome.storage.local.get("wp", (r) => {
    const cfg = (r.wp as StoredConfig) || ({} as StoredConfig);
    chrome.storage.local.set({ wp: { ...cfg, showPanel: show } });
    const base = show ? "Chat overlay shown." : "Chat overlay hidden.";
    // With the master switch off there is no overlay on the page at all, so
    // say the setting was saved rather than implying it took effect.
    msg().textContent = cfg.enabled === false ? `${base} (Extension is off.)` : base;
  });
});

document.getElementById("join")!.addEventListener("click", () => {
  const f = fields();
  if (!f.serverUrl || !f.roomCode) {
    msg().textContent = "Server URL and room code are required.";
    return;
  }
  const cfg: StoredConfig = {
    ...f,
    connected: true,
    enabled: $("enabled").checked,
    showPanel: $("showPanel").checked,
  };
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
