/**
 * Popup: collects server/room settings and saves them as preferences
 * (chrome.storage.local). Joining binds the party to the tab the popup was
 * opened over, through the background worker; only that tab connects.
 */
import { callBackground } from "./messages";
import { ConnParams } from "./party";
import { StoredConfig } from "./protocol";

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
const msg = () => document.getElementById("msg") as HTMLDivElement;

function fields(): ConnParams {
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

async function restore() {
  const cfg = (await chrome.storage.local.get("wp")).wp as StoredConfig | undefined;
  if (cfg) {
    $("serverUrl").value = cfg.serverUrl || "";
    $("roomCode").value = cfg.roomCode || "";
    $("name").value = cfg.name || "";
    $("secret").value = cfg.secret || "";
    $("showPanel").checked = cfg.showPanel !== false; // default on
    $("enabled").checked = cfg.enabled !== false; // default on
  }
  const on = cfg?.enabled !== false;
  applyEnabledUI(on);
  if (!on) {
    msg().textContent = "Extension is off.";
    return;
  }
  try {
    const { party } = await callBackground("wp:status", {});
    if (party) msg().textContent = `In room "${party.roomCode}".`;
  } catch {
    // No status is fine; the form still works.
  }
}

/** The tab the popup was opened over. */
async function activeTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

/** Remember the form for next time. Keeps the toggles; drops legacy fields. */
function savePrefs(conn: ConnParams): Promise<void> {
  const prefs: StoredConfig = {
    ...conn,
    enabled: $("enabled").checked,
    showPanel: $("showPanel").checked,
  };
  return chrome.storage.local.set({ wp: prefs });
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

document.getElementById("join")!.addEventListener("click", async () => {
  const conn = fields();
  if (!conn.serverUrl || !conn.roomCode) {
    msg().textContent = "Server URL and room code are required.";
    return;
  }
  const tabId = await activeTabId();
  if (tabId === undefined) {
    msg().textContent = "Couldn't find this tab.";
    return;
  }
  try {
    await savePrefs(conn);
    await callBackground("wp:join", { tabId, conn });
    msg().textContent = `Joining "${conn.roomCode}" in this tab…`;
  } catch {
    msg().textContent = "Couldn't join — try again.";
  }
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

document.getElementById("leave")!.addEventListener("click", async () => {
  try {
    await callBackground("wp:leave", {});
    msg().textContent = "Left the room.";
  } catch {
    msg().textContent = "Couldn't leave — try again.";
  }
});

void restore();
