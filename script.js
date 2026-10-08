// script.js
// ZeoX frontend — streams Zoe's replies from our own backend.

import { ZOE_SYSTEM_PROMPT, OPENING_LINE } from './persona.js';

const STORE_KEY = "zeox.conversation.v1";
let history = loadHistory();
let isTyping = false;

const chatEl     = document.getElementById("chat");
const inputEl    = document.getElementById("userInput");
const sendBtn    = document.getElementById("sendBtn");
let   welcomeEl  = document.getElementById("welcome");

function loadHistory() {
  try {
    const arr = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
    return Array.isArray(arr) ? arr.filter(m => m && m.role && m.content) : [];
  } catch { return []; }
}
function saveHistory() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(history.slice(-60))); } catch {}
}

const nowTime = () => new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function hideWelcome() { if (welcomeEl) { welcomeEl.remove(); welcomeEl = null; } }

function addMessage(text, who, ts = nowTime()) {
  hideWelcome();
  const row = document.createElement("div");
  row.className = `msg-row ${who}`;
  const bubble = document.createElement("div");
  bubble.className = `msg ${who}`;
  const span = document.createElement("span");
  span.className = "msg-text";
  span.textContent = text;
  bubble.appendChild(span);
  const time = document.createElement("div");
  time.className = "msg-time";
  time.textContent = ts;
  row.appendChild(bubble); row.appendChild(time);
  chatEl.appendChild(row);
  chatEl.scrollTop = chatEl.scrollHeight;
  return bubble;
}

function showTyping() {
  const t = document.createElement("div");
  t.className = "typing"; t.id = "typingIndicator";
  t.innerHTML = "<span></span><span></span><span></span>";
  chatEl.appendChild(t);
  chatEl.scrollTop = chatEl.scrollHeight;
}
function hideTyping() { document.getElementById("typingIndicator")?.remove(); }

async function streamZoeReply(onToken) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      stream: true,
      messages: [{ role: "system", content: ZOE_SYSTEM_PROMPT }, ...history]
    })
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).detail || ""; } catch {}
    throw new Error(detail || `server error ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const p = t.slice(5).trim();
      if (p === "[DONE]") return;
      try { const e = JSON.parse(p); if (e.t) onToken(e.t); } catch {}
    }
  }
}

async function sendMessage(presetText) {
  const text = (presetText ?? inputEl.value).trim();
  if (!text || isTyping) return;

  inputEl.value = ""; autoGrow(); updateSendState();
  const userTs = nowTime();
  addMessage(text, "me", userTs);
  history.push({ role: "user", content: text, ts: userTs });

  isTyping = true; sendBtn.disabled = true; inputEl.blur();
  showTyping();
  await new Promise(r => setTimeout(r, 500 + Math.random() * 700));

  try {
    hideTyping();
    const bubble = addMessage("", "zoe");
    bubble.classList.add("streaming");
    let full = "";
    const zoeTs = nowTime();
    await streamZoeReply((token) => {
      full += token;
      bubble.querySelector(".msg-text").textContent = full;
      chatEl.scrollTop = chatEl.scrollHeight;
    });
    bubble.classList.remove("streaming");
    if (full.trim()) {
      history.push({ role: "assistant", content: full.trim(), ts: zoeTs });
      saveHistory();
    } else {
      bubble.querySelector(".msg-text").textContent = "...say that again?";
    }
  } catch (e) {
    hideTyping();
    addMessage(`ugh, glitch on my end (${String(e.message || e).slice(0, 80)}). try again?`);
  } finally {
    isTyping = false;
    sendBtn.disabled = !inputEl.value.trim();
    inputEl.focus();
  }
}

function autoGrow() { inputEl.style.height = "auto"; inputEl.style.height = Math.min(inputEl.scrollHeight, 132) + "px"; }
function updateSendState() { sendBtn.disabled = isTyping || !inputEl.value.trim(); }

inputEl.addEventListener("input", () => { autoGrow(); updateSendState(); });
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
sendBtn.addEventListener("click", () => sendMessage());

document.getElementById("chips")?.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (chip && !isTyping) sendMessage(chip.dataset.text);
});

document.getElementById("newChatBtn").addEventListener("click", () => {
  if (isTyping) return;
  history = []; saveHistory();
  chatEl.querySelectorAll(".msg-row, .typing").forEach(el => el.remove());
  location.reload();
});

window.addEventListener("load", () => {
  if (history.length > 0) {
    history.forEach(m => addMessage(m.content, m.role === "user" ? "me" : "zoe", m.ts));
  } else {
    setTimeout(() => addMessage(OPENING_LINE, "zoe"), 500);
  }
  inputEl.focus();
});
