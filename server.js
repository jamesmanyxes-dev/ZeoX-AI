// server.js
// zoeX backend — provider fallback chain.
// Tries Groq streaming first; if ANYTHING fails, falls back to Gemini,
// then OpenRouter. She always answers.

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Load .env if present (no dependency needed)
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

app.use(express.json({ limit: "1mb" }));
const noCache = { maxAge: 0, setHeaders: (res) => res.setHeader("Cache-Control", "no-cache") };
app.use(express.static(path.join(__dirname, "public"), noCache));
app.use(express.static(__dirname, noCache));

const GROQ_MODELS = [
  process.env.GROQ_MODEL,
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "qwen/qwen3.8-27b"
].filter(Boolean);

const GEMINI_MODELS = ["gemini-3.8-flash", "gemini-3.1-flash"];
const OPENROUTER_MODELS = [
  "meta-llama/llama-3.3-70b-instruct",
  "google/gemini-2.0-flash-001",
  "openai/gpt-oss-120b"
];

/* ────────── Groq (real streaming) ────────── */
async function groqStream(messages, onToken) {
  for (const model of GROQ_MODELS) {
    try {
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({ model, messages, temperature: 0.9, max_tokens: 300, top_p: 0.95, stream: true })
      });
      if (!r.ok) { console.error(`groq ${model} → ${r.status}: ${(await r.text()).slice(0, 200)}`); continue; }

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = "", got = 0;
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
          if (p === "[DONE]") continue;
          try {
            const d = JSON.parse(p).choices?.[0]?.delta?.content || "";
            if (d) { got += d.length; onToken(d); }
          } catch {}
        }
      }
      if (got > 0) return true;
      console.error(`groq ${model} → empty stream`);
    } catch (e) { console.error(`groq ${model} → ${e.message}`); }
  }
  return false;
}

/* ────────── Gemini ────────── */
async function geminiReply(messages, onToken) {
  if (!process.env.GEMINI_API_KEY) return false;
  const system = messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
  const contents = messages.filter(m => m.role !== "system")
    .map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));

  for (const model of GEMINI_MODELS) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
          body: JSON.stringify({
            contents,
            ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
            generationConfig: { temperature: 0.9, maxOutputTokens: 300 }
          })
        }
      );
      if (!r.ok) { console.error(`gemini ${model} → ${r.status}`); continue; }
      const text = (await r.json()).candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
      if (text.trim()) { streamOut(text, onToken); return true; }
      console.error(`gemini ${model} → empty`);
    } catch (e) { console.error(`gemini ${model} → ${e.message}`); }
  }
  return false;
}

/* ────────── OpenRouter ────────── */
async function openrouterReply(messages, onToken) {
  if (!process.env.OPENROUTER_API_KEY) return false;
  for (const model of OPENROUTER_MODELS) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`
        },
        body: JSON.stringify({ model, messages, temperature: 0.9, max_tokens: 300 })
      });
      if (!r.ok) { console.error(`openrouter ${model} → ${r.status}`); continue; }
      const text = (await r.json()).choices?.[0]?.message?.content || "";
      if (text.trim()) { streamOut(text, onToken); return true; }
      console.error(`openrouter ${model} → empty`);
    } catch (e) { console.error(`openrouter ${model} → ${e.message}`); }
  }
  return false;
}

// emit a full reply in small chunks so it still types out live
function streamOut(text, onToken) {
  const size = 6;
  for (let i = 0; i < text.length; i += size) {
    onToken(text.slice(i, i + size));
  }
}

/* ────────── endpoint ────────── */
app.post("/api/chat", async (req, res) => {
  const { messages, stream } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "no_messages", detail: "Send a messages array." });
  }

  // sanitize: providers reject extra fields like ts
  const clean = messages.map(m => ({ role: m.role, content: String(m.content ?? "") }));

  // always stream SSE to the browser — simpler and one code path
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive"
  });
  const push = (t) => res.write(`data: ${JSON.stringify({ t })}\n\n`);

  let ok = false;
  try { ok = await groqStream(clean, push); } catch (e) { console.error("groq crashed:", e.message); }
  if (!ok) { try { ok = await geminiReply(clean, push); } catch (e) { console.error("gemini crashed:", e.message); } }
  if (!ok) { try { ok = await openrouterReply(clean, push); } catch (e) { console.error("openrouter crashed:", e.message); } }

  if (!ok) {
    push({ t: "ugh my connections are all acting up rn. give me a sec and text me again?" });
  }
  res.write("data: [DONE]\n\n");
  res.end();
});

app.get("/health", (req, res) => res.json({
  ok: true, service: "zeox",
  groq: !!process.env.GROQ_API_KEY,
  gemini: !!process.env.GEMINI_API_KEY,
  openrouter: !!process.env.OPENROUTER_API_KEY
}));

app.listen(PORT, () => {
  console.log(`zoeX on port ${PORT} · groq:${!!process.env.GROQ_API_KEY} gemini:${!!process.env.GEMINI_API_KEY} openrouter:${!!process.env.OPENROUTER_API_KEY}`);
});
