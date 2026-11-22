/**
 * Popup: collects server/room settings and saves them as preferences
 * (chrome.storage.local). Joining binds the party to the tab the popup was
 * opened over, through the background worker; only that tab connects.
 */
import { callBackground, callTab } from "./messages";
import { ConnParams, PartyRecord } from "./party";
import { StoredConfig } from "./protocol";
import { isSupportedSite } from "./sync";

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
const msg = () => document.getElementById("msg") as HTMLDivElement;
const partyRow = document.getElementById("party") as HTMLDivElement;
const partyText = document.getElementById("partyText") as HTMLSpanElement;
const gotoButton = document.getElementById("goto") as HTMLButtonElement;

// The tab holding the party, as last shown (for "Go to tab").
let partyTabId: number | undefined;

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
  if (!on) msg().textContent = "Extension is off.";
  await showParty();
}

/** The tab the popup was opened over. */
async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** Fetch the binding, or null if the worker can't be reached. */
async function fetchParty(): Promise<PartyRecord | null> {
  try {
    return await callBackground("wp:status", {});
  } catch {
    return null;
  }
}

/** Show where the party is relative to this tab, with a way to get there. */
async function showParty(): Promise<void> {
  const [rec, tab] = await Promise.all([fetchParty(), activeTab()]);
  const party = rec?.party ?? null;
  partyTabId = party?.tabId;
  partyRow.hidden = !party;
  if (!party) return;
  const here = party.tabId === tab?.id;
  partyText.textContent = here
    ? `In "${party.roomCode}" in this tab.`
    : `In "${party.roomCode}" in another tab.`;
  gotoButton.hidden = here;
}

type TabCheck = { ok: true; onWatchPage: boolean } | { ok: false; problem: string };

/**
 * Whether Watch Party is running in a tab, asked of its content script. A tab
 * opened before the extension was installed or updated has no live script, so
 * binding it would silently connect nothing; say what to do instead.
 */
async function checkTab(tab: chrome.tabs.Tab & { id: number }): Promise<TabCheck> {
  try {
    const reply = await callTab(tab.id, "wp:probe", {});
    return { ok: true, onWatchPage: !!reply?.onWatchPage };
  } catch {
    // tab.url is only visible on sites we have host access to — which are
    // exactly the supported ones, so a missing url means "not supported".
    const url = tab.url ? new URL(tab.url) : null;
    const supported = !!url && isSupportedSite(url.hostname, url.pathname);
    return {
      ok: false,
      problem: supported
        ? "Reload this tab, then Join."
        : "Open Netflix, Prime Video, YouTube, Tubi, Pluto TV or Einthusan in this tab, then Join.",
    };
  }
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
  const tab = await activeTab();
  if (tab?.id === undefined) {
    msg().textContent = "Couldn't find this tab.";
    return;
  }
  const tabId = tab.id;
  const check = await checkTab({ ...tab, id: tabId });
  if (!check.ok) {
    msg().textContent = check.problem;
    return;
  }
  try {
    const before = await fetchParty();
    await savePrefs(conn);
    await callBackground("wp:join", { tabId, conn });
    const moved = before?.party && before.party.tabId !== tabId;
    const done = moved ? `Moved the party to this tab ("${conn.roomCode}").` : `Joining "${conn.roomCode}" in this tab…`;
    msg().textContent = check.onWatchPage ? done : `${done} Start a title to sync.`;
  } catch {
    msg().textContent = "Couldn't join — try again.";
  }
  await showParty();
});

// Jump to the party tab, in whichever window it is.
gotoButton.addEventListener("click", async () => {
  if (partyTabId === undefined) return;
  try {
    const tab = await chrome.tabs.update(partyTabId, { active: true });
    if (tab) await chrome.windows.update(tab.windowId, { focused: true });
    window.close();
  } catch {
    await showParty(); // it closed meanwhile
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
  await showParty();
});

void restore();
