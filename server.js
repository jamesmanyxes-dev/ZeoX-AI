// server.js
// zoeX backend — hides the Groq key, streams Zoe's replies live.
// Robust: model fallback + real error messages so failures are debuggable.

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

// Preferred model first, then automatic fallbacks if one isn't available
const MODEL_CHAIN = [
  process.env.GROQ_MODEL,
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "qwen/qwen3.8-27b"
].filter(Boolean);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(__dirname));

// ─────────────────────────────────────────
// POST /api/chat
// Body: { messages, stream? }
// Streams SSE events: data: {"t":"chunk"} ... data: [DONE]
// ─────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { messages, stream } = req.body || {};

  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ error: "no_api_key",
      detail: "GROQ_API_KEY is not set. Put it in .env or your environment." });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "no_messages", detail: "Send a messages array." });
  }

  let lastErr = null;
  for (const model of MODEL_CHAIN) {
    try {
      const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model, messages,
          temperature: 0.9, max_tokens: 300, top_p: 0.95,
          stream: stream === true
        })
      });

      if (!groqRes.ok) {
        lastErr = `${groqRes.status} on ${model}: ${await groqRes.text()}`;
        continue; // try the next model
      }

      // ── streaming ──
      if (stream === true) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive"
        });
        const reader = groqRes.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        const push = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
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
              if (d) push({ t: d });
            } catch {}
          }
        }
        res.write("data: [DONE]\n\n");
        return res.end();
      }

      // ── non-streaming ──
      const data = await groqRes.json();
      return res.json({ reply: data.choices?.[0]?.message?.content?.trim() || "" });

    } catch (e) {
      lastErr = `network error on ${model}: ${e.message}`;
    }
  }

  console.error("All models failed:", lastErr);
  res.status(502).json({ error: "groq_failed", detail: lastErr || "unknown" });
});

app.get("/health", (req, res) =>
  res.json({ ok: true, service: "zeox", key: !!process.env.GROQ_API_KEY }));

app.listen(PORT, () => {
  console.log(`zoeX on port ${PORT} · key loaded: ${!!process.env.GROQ_API_KEY}`);
});
