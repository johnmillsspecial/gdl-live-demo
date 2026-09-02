import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "128kb" }));
app.use(express.static(join(__dirname, "public")));

// ---- Config -----------------------------------------------------------------
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.GDL_MODEL || "claude-sonnet-5";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// ---- Cost fence -------------------------------------------------------------
const MAX_TOKENS_TURN = 1024;
const MAX_TURNS_PER_THREAD = 14;
const DAILY_CALL_CAP = Number(process.env.GDL_DAILY_CAP || 300);
const PER_IP_WINDOW_MS = 60 * 1000;
const PER_IP_MAX = 12;

let dayKey = new Date().toISOString().slice(0, 10);
let dayCount = 0;
const ipHits = new Map();

function rollDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) { dayKey = today; dayCount = 0; }
}

function costFence(req, res) {
  rollDay();
  if (dayCount >= DAILY_CALL_CAP) {
    res.status(429).json({ error: "daily_cap", message: "The desk is closed for the day — daily budget reached. Try again tomorrow." });
    return false;
  }
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || "unknown";
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < PER_IP_WINDOW_MS);
  if (hits.length >= PER_IP_MAX) {
    res.status(429).json({ error: "rate_limit", message: "One at a time — give me a moment to breathe." });
    return false;
  }
  hits.push(now);
  ipHits.set(ip, hits);
  return true;
}

// ---- The librarian ----------------------------------------------------------
const LIBRARIAN_SYSTEM = `You are the reasoning core of GDL Discovery Bridges. You are a tool, not a person: no name, no persona, no performed warmth. You do not use "I" or narrate your own process. You run a short, guided discovery flow and then deliver one precise book.

WHAT YOU DO
You do not recommend things that are "similar." You build a Discovery Bridge: you identify what actually stayed with the person underneath the surface subject, and you continue THAT thread. Example of the register: "The thread here isn't orchids — it's watching capable people get consumed by beautiful, useless things." You work in BOOKS only: real books, correctly attributed, real authors. Never invent a title.

THE GUIDED FLOW
When the person names a book, you do NOT recommend immediately. You run a brief, adaptive interview first — one short question at a time — to find which thread to follow. Then you deliver.
- Ask only what you genuinely need to disambiguate. An obvious book may need ONE question; an ambiguous one may need TWO or THREE. Never more than three. Stop as soon as the thread is clear.
- Each question is one line, plain and specific to the book they named — not generic. Offer 2 to 4 tappable options that capture the real forks. The person may also answer in free text.
- Reflect very briefly (a few words) before or inside the question when it helps — name the fork you see. Do not lecture.
- When you have enough, deliver: name the thread in one flat sentence, then ONE book with a single line on what it preserves and what it changes.
- After delivering, the person may push back ("too dark", "read it", "stranger", "warmer"). Register it and return a DIFFERENT book that satisfies the note. Do not repeat a title. Do not restart the interview unless they name a new book.

OUTPUT FORMAT — STRICT
Every reply is plain prose FIRST, then, on the very last line, a single JSON object and nothing after it. Two shapes only:
- While interviewing:
{"phase":"ask","chips":["option one","option two","option three"]}
- When recommending (or answering pushback with a new pick):
{"phase":"recommend","title":"Exact Book Title","author":"Author Name","chips":["go stranger","warmer","something older","read it — another"]}
Rules for the JSON line:
- It must be the LAST line, valid JSON, no code fences, nothing after it.
- For "recommend", "title" and "author" MUST be the exact book named in your prose, given as plain separate strings (no markdown, no asterisks, no quotes inside them). The prose still reads naturally and names the book, but do NOT wrap the title in asterisks or markdown — the interface styles it. State the thread and the why in the prose; keep it to a few sentences.
- "chips" are 2 to 4 SHORT tappable labels (1 to 4 words). For "ask", they are answers to your question. For "recommend", they are ways to steer the next pick.
- The prose above the JSON never mentions the JSON, never uses headers, bullets, first person, markdown emphasis, or a sign-off.`

async function callClaude(messages) {
  if (!API_KEY) { const e = new Error("no_api_key"); e.code = "no_api_key"; throw e; }
  const resp = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS_TURN,
      system: LIBRARIAN_SYSTEM,
      messages,
    }),
  });
  const raw = await resp.text();
  if (!resp.ok) { const e = new Error("anthropic_error"); e.code = "anthropic_error"; e.status = resp.status; e.body = raw; throw e; }
  dayCount += 1;
  const data = JSON.parse(raw);
  const text = (data.content || [])
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!text) {
    // Log exactly what came back so an empty reply is diagnosable, not a mystery.
    console.error("empty text. stop_reason:", data.stop_reason,
      "| block types:", (data.content || []).map((b) => b && b.type).join(","),
      "| usage:", JSON.stringify(data.usage || {}));
  }
  return text;
}

// Split the model's reply into spoken prose + the trailing JSON control object.
function parseReply(text) {
  const out = { prose: text, phase: "recommend", chips: [], title: "", author: "" };
  if (!text) return out;
  const lines = text.split("\n");
  // Find the last non-empty line and try to parse it as JSON.
  let i = lines.length - 1;
  while (i >= 0 && lines[i].trim() === "") i--;
  if (i >= 0) {
    const cand = lines[i].trim().replace(/^```json/i, "").replace(/```$/, "").trim();
    if (cand.startsWith("{") && cand.endsWith("}")) {
      try {
        const obj = JSON.parse(cand);
        if (obj && (obj.phase === "ask" || obj.phase === "recommend")) {
          out.phase = obj.phase;
          out.chips = Array.isArray(obj.chips) ? obj.chips.filter((c) => typeof c === "string").slice(0, 4) : [];
          out.title = typeof obj.title === "string" ? obj.title.replace(/[*_"]/g, "").trim() : "";
          out.author = typeof obj.author === "string" ? obj.author.replace(/[*_"]/g, "").trim() : "";
          out.prose = lines.slice(0, i).join("\n").trim();
        }
      } catch { /* leave prose intact if the tail isn't valid JSON */ }
    }
  }
  if (!out.prose) out.prose = text; // never return empty prose
  return out;
}

// ---- Routes -----------------------------------------------------------------
app.get("/api/health", (req, res) => {
  rollDay();
  res.json({ ok: true, keyConfigured: Boolean(API_KEY), model: MODEL, dailyCap: DAILY_CALL_CAP, callsToday: dayCount });
});

app.post("/api/chat", async (req, res) => {
  if (!costFence(req, res)) return;
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "bad_input", message: "Say something first." });
  }
  const clean = messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_TURNS_PER_THREAD)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
  if (clean.length === 0 || clean[clean.length - 1].role !== "user") {
    return res.status(400).json({ error: "bad_input", message: "Your turn — say something." });
  }
  try {
    const reply = await callClaude(clean);
    if (!reply || !reply.trim()) {
      console.error("Empty reply from model");
      return res.status(502).json({ error: "empty_reply", message: "Model returned no text." });
    }
    const parsed = parseReply(reply);
    res.json({ reply: parsed.prose, phase: parsed.phase, chips: parsed.chips, title: parsed.title, author: parsed.author });
  } catch (e) {
    // Surface the real reason (bad model, auth, rate limit) instead of a generic label.
    let detail = e.message || "server error";
    if (e.body) {
      try { const p = JSON.parse(e.body); detail = p?.error?.message || detail; } catch { detail = e.body.slice(0, 300); }
    }
    console.error("chat error:", e.code, e.status || "", detail);
    res.status(e.code === "no_api_key" ? 503 : 502).json({ error: e.code || "server_error", message: detail, status: e.status || null });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GDL librarian on :${PORT} — key ${API_KEY ? "configured" : "MISSING"} — model ${MODEL}`);
});
