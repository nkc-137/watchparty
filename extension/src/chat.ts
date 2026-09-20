/**
 * Chat + member dashboard injected into the watch page DOM.
 *
 * It lives as a small collapsed "launcher" pill in the corner so it never
 * blocks the video; clicking it expands the full panel (members, chat,
 * reactions). Pure DOM; no framework. Styling lives in chat.css.
 */
import { ChatMessage, Member, Reaction } from "./protocol";

export interface ChatHandlers {
  onSend(text: string): void;
  onReaction(emoji: string): void;
  onResync(): void;
}

export interface ChatUI {
  addMessage(msg: ChatMessage): void;
  setMembers(members: Member[]): void;
  setStatus(text: string): void;
  setLatency(ms: number | null): void;
  setConn(state: ConnState): void;
  showReaction(r: Reaction): void;
}

/** Connection health surfaced by the status dot. */
export type ConnState = "online" | "reconnecting" | "offline";

const REACTIONS = ["❤️", "😂", "😮", "😍", "🔥", "👏", "💀"];

export function mountChat(handlers: ChatHandlers): ChatUI {
  const root = document.createElement("div");
  root.id = "wp-root";
  // Start collapsed so it stays out of the way until the user opens it.
  root.className = "wp-collapsed";
  root.dataset.conn = "reconnecting"; // until the socket connects
  root.innerHTML = `
    <button id="wp-launcher" title="Open Watch Party">
      <span class="wp-dot" title="connection"></span>
      <span id="wp-launch-info">Watch Party</span>
      <span id="wp-unread"></span>
    </button>
    <div id="wp-panel">
      <div id="wp-header">
        <span class="wp-dot" title="connection"></span>
        <span id="wp-title">Watch Party</span>
        <span id="wp-latency" title="round-trip latency"></span>
        <span id="wp-status">connecting…</span>
        <button id="wp-collapse" title="Collapse">–</button>
      </div>
      <div id="wp-members"></div>
      <div id="wp-messages"></div>
      <div id="wp-reactions"></div>
      <form id="wp-form">
        <input id="wp-input" type="text" placeholder="Say something…" maxlength="500" autocomplete="off" />
        <button id="wp-resync" type="button" title="Resync to host">⟳</button>
      </form>
    </div>
  `;
  document.body.appendChild(root);

  const launcher = root.querySelector("#wp-launcher") as HTMLButtonElement;
  const launchInfo = root.querySelector("#wp-launch-info") as HTMLSpanElement;
  const unreadEl = root.querySelector("#wp-unread") as HTMLSpanElement;
  const messages = root.querySelector("#wp-messages") as HTMLDivElement;
  const membersEl = root.querySelector("#wp-members") as HTMLDivElement;
  const statusEl = root.querySelector("#wp-status") as HTMLSpanElement;
  const latencyEl = root.querySelector("#wp-latency") as HTMLSpanElement;
  const reactionsBar = root.querySelector("#wp-reactions") as HTMLDivElement;
  const form = root.querySelector("#wp-form") as HTMLFormElement;
  const input = root.querySelector("#wp-input") as HTMLInputElement;
  const collapse = root.querySelector("#wp-collapse") as HTMLButtonElement;
  const resync = root.querySelector("#wp-resync") as HTMLButtonElement;

  let memberCount = 0;
  let latencyText = "";
  let unread = 0;

  function refreshLauncher() {
    const bits = ["Watch Party"];
    if (memberCount) bits.push(`${memberCount}\u{1F465}`); // 👥
    if (latencyText) bits.push(latencyText);
    launchInfo.textContent = bits.join(" · ");
    unreadEl.textContent = unread ? String(unread) : "";
    unreadEl.style.display = unread ? "inline-flex" : "none";
  }

  function expand() {
    root.classList.remove("wp-collapsed");
    unread = 0;
    refreshLauncher();
    input.focus();
  }
  function collapsePanel() {
    root.classList.add("wp-collapsed");
  }

  launcher.addEventListener("click", expand);
  collapse.addEventListener("click", collapsePanel);

  for (const emoji of REACTIONS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "wp-react";
    b.textContent = emoji;
    b.addEventListener("click", () => handlers.onReaction(emoji));
    reactionsBar.appendChild(b);
  }

  resync.addEventListener("click", () => handlers.onResync());

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    handlers.onSend(text);
    input.value = "";
  });

  refreshLauncher();

  return {
    addMessage(msg) {
      const el = document.createElement("div");
      if (msg.system) {
        // Activity notice: a subtle centered line, no name/timestamp.
        el.className = "wp-sys";
        el.textContent = msg.text;
      } else {
        el.className = "wp-msg";
        const t = new Date(msg.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        el.innerHTML = `<span class="wp-name"></span><span class="wp-time"></span><span class="wp-text"></span>`;
        (el.querySelector(".wp-name") as HTMLElement).textContent = msg.name;
        (el.querySelector(".wp-time") as HTMLElement).textContent = t;
        (el.querySelector(".wp-text") as HTMLElement).textContent = msg.text;
      }
      messages.appendChild(el);
      messages.scrollTop = messages.scrollHeight;
      // Badge unread on the launcher while collapsed — but only for real chat,
      // not activity notices, to avoid noise.
      if (!msg.system && root.classList.contains("wp-collapsed")) {
        unread++;
        refreshLauncher();
      }
    },
    setMembers(members) {
      memberCount = members.length;
      membersEl.textContent =
        members.map((m) => (m.isHost ? `★ ${m.name}` : m.name)).join(" · ");
      refreshLauncher();
    },
    setStatus(text) {
      statusEl.textContent = text;
    },
    // Colors both dots (launcher + header) via one data attribute on the root.
    setConn(state) {
      root.dataset.conn = state;
    },
    setLatency(ms) {
      if (ms == null) {
        latencyEl.textContent = "";
        latencyText = "";
        refreshLauncher();
        return;
      }
      latencyEl.textContent = `${ms} ms`;
      latencyEl.className = ms < 120 ? "wp-good" : ms < 300 ? "wp-ok" : "wp-bad";
      latencyText = `${ms}ms`;
      refreshLauncher();
    },
    showReaction(r) {
      const el = document.createElement("div");
      el.className = "wp-float";
      el.textContent = r.emoji;
      el.style.left = `${20 + Math.random() * 60}%`;
      root.appendChild(el);
      setTimeout(() => el.remove(), 2000);
    },
  };
}
