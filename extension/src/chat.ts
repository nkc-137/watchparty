/**
 * Chat + member sidebar injected into the Netflix watch page DOM.
 * Pure DOM; no framework. Styling lives in chat.css.
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
  showReaction(r: Reaction): void;
}

const REACTIONS = ["😂", "😮", "😍", "🔥", "👏", "💀"];

export function mountChat(handlers: ChatHandlers): ChatUI {
  const root = document.createElement("div");
  root.id = "wp-root";
  root.innerHTML = `
    <div id="wp-header">
      <span id="wp-title">Watch Party</span>
      <span id="wp-latency" title="round-trip latency"></span>
      <span id="wp-status">connecting…</span>
      <button id="wp-toggle" title="Hide/show">–</button>
    </div>
    <div id="wp-members"></div>
    <div id="wp-messages"></div>
    <div id="wp-reactions"></div>
    <form id="wp-form">
      <input id="wp-input" type="text" placeholder="Say something…" maxlength="500" autocomplete="off" />
      <button id="wp-resync" type="button" title="Resync to host">⟳</button>
    </form>
  `;
  document.body.appendChild(root);

  const messages = root.querySelector("#wp-messages") as HTMLDivElement;
  const membersEl = root.querySelector("#wp-members") as HTMLDivElement;
  const statusEl = root.querySelector("#wp-status") as HTMLSpanElement;
  const latencyEl = root.querySelector("#wp-latency") as HTMLSpanElement;
  const reactionsBar = root.querySelector("#wp-reactions") as HTMLDivElement;
  const form = root.querySelector("#wp-form") as HTMLFormElement;
  const input = root.querySelector("#wp-input") as HTMLInputElement;
  const toggle = root.querySelector("#wp-toggle") as HTMLButtonElement;
  const resync = root.querySelector("#wp-resync") as HTMLButtonElement;

  for (const emoji of REACTIONS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "wp-react";
    b.textContent = emoji;
    b.addEventListener("click", () => handlers.onReaction(emoji));
    reactionsBar.appendChild(b);
  }

  toggle.addEventListener("click", () => root.classList.toggle("wp-collapsed"));
  resync.addEventListener("click", () => handlers.onResync());

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    handlers.onSend(text);
    input.value = "";
  });

  return {
    addMessage(msg) {
      const el = document.createElement("div");
      el.className = "wp-msg";
      const t = new Date(msg.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      el.innerHTML = `<span class="wp-name"></span><span class="wp-time"></span><span class="wp-text"></span>`;
      (el.querySelector(".wp-name") as HTMLElement).textContent = msg.name;
      (el.querySelector(".wp-time") as HTMLElement).textContent = t;
      (el.querySelector(".wp-text") as HTMLElement).textContent = msg.text;
      messages.appendChild(el);
      messages.scrollTop = messages.scrollHeight;
    },
    setMembers(members) {
      membersEl.textContent =
        members.map((m) => (m.isHost ? `★ ${m.name}` : m.name)).join(" · ");
    },
    setStatus(text) {
      statusEl.textContent = text;
    },
    setLatency(ms) {
      if (ms == null) {
        latencyEl.textContent = "";
        return;
      }
      latencyEl.textContent = `${ms} ms`;
      latencyEl.className = ms < 120 ? "wp-good" : ms < 300 ? "wp-ok" : "wp-bad";
    },
    showReaction(r) {
      const el = document.createElement("div");
      el.className = "wp-float";
      el.textContent = r.emoji;
      // Random horizontal drift so overlapping reactions don't stack.
      el.style.left = `${20 + Math.random() * 60}%`;
      root.appendChild(el);
      setTimeout(() => el.remove(), 2000);
    },
  };
}
