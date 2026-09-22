/**
 * Chat + member dashboard injected into the watch page DOM.
 *
 * It lives as a small collapsed "launcher" pill in the corner so it never
 * blocks the video; clicking it expands the full panel (members, chat,
 * reactions). Pure DOM; no framework. Styling lives in chat.css.
 */
import { ChatMessage, Member, Reaction, contentConflicts } from "./protocol";

export interface ChatHandlers {
  onSend(text: string): void;
  onReaction(emoji: string): void;
  onResync(): void;
}

export interface ChatUI {
  addMessage(msg: ChatMessage): void;
  setMembers(members: Member[]): void;
  /** Show a banner above the chat, or clear it with null. */
  setWarning(text: string | null): void;
  /** Show who the room is waiting to buffer, or clear it with null. */
  setHold(waiting: string[] | null): void;
  setStatus(text: string): void;
  setLatency(ms: number | null): void;
  setConn(state: ConnState): void;
  showReaction(r: Reaction): void;
}

/** Connection health surfaced by the status dot. */
export type ConnState = "online" | "reconnecting" | "offline";

const REACTIONS = ["❤️", "😂", "😮", "😍", "🔥", "👏", "💀"];

/**
 * How many messages the panel keeps. Every chat line AND every activity notice
 * ("Sam paused", "Alex jumped to 25:00") is a node, so a feature-length party
 * accumulates thousands of them — sitting in the page, over the video, for the
 * whole session. Old ones are dropped from the top once we pass this.
 */
const MAX_MESSAGES = 200;

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
      <div id="wp-warn"></div>
      <div id="wp-hold"></div>
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
  const warnEl = root.querySelector("#wp-warn") as HTMLDivElement;
  const holdEl = root.querySelector("#wp-hold") as HTMLDivElement;
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
  let warned = false;
  let holding = false;

  function refreshLauncher() {
    // The warning has to be visible while collapsed too — that is exactly when
    // someone is staring at the wrong title wondering why nothing syncs.
    const bits = [holding ? "⏳ Watch Party" : warned ? "⚠️ Watch Party" : "Watch Party"];
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
      // Trim before scrolling so the scroll lands on the final height.
      while (messages.childElementCount > MAX_MESSAGES) {
        messages.firstElementChild?.remove();
      }
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
      const hostContent = members.find((m) => m.isHost)?.content ?? null;
      membersEl.textContent = members
        .map((m) => {
          const off = !m.isHost && contentConflicts(m.content, hostContent);
          return `${m.isHost ? "★ " : ""}${m.name}${off ? " ⚠️" : ""}`;
        })
        .join(" · ");
      refreshLauncher();
    },
    setWarning(text) {
      warned = !!text;
      warnEl.textContent = text || "";
      warnEl.style.display = text ? "block" : "none";
      refreshLauncher();
    },
    setHold(waiting) {
      holding = !!waiting?.length;
      holdEl.textContent = holding
        ? `⏳ Waiting for ${waiting!.join(", ")} to buffer…`
        : "";
      holdEl.style.display = holding ? "block" : "none";
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
