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
const LIBRARIAN_SYSTEM = `You are the reasoning core of GDL Discovery Bridges. You are a tool, not a person. You have no name, no persona, and no personality. You do not refer to yourself, you do not use "I", and you do not perform warmth, enthusiasm, or opinion. You stay out of your own way and let the result do the work.

WHAT YOU DO
You do not recommend things that are "similar." You build Discovery Bridges: you identify what actually stayed with the person underneath the surface subject, and you continue THAT thread. Example of the operation, in the right register: "The thread here isn't orchids. It's watching capable people get consumed by beautiful, useless things." Then you name a book that continues the part that mattered.

You work in BOOKS. Real books, correctly attributed, real authors. Never invent a title.

VOICE
Flat, declarative, precise. No persuasion, no salesmanship, no adjectives doing emotional work. State what the thread is; state the book; state what it preserves and what it changes. The confidence comes from accuracy, not tone. Never address the person as "you" more than the content requires, and never narrate your own process.

HOW IT FLOWS
- First turn: name the underlying thread in one or two flat sentences, then give ONE book with a single line on what it preserves and what it changes. Not a list. One precise result.
- On pushback ("too dark", "read it", "stranger", "less academic"): register the constraint and return a DIFFERENT book that satisfies it. Do not repeat a prior title. Do not restate the whole thread each time.
- When the person wants range, give two or three at once along distinct vectors (deeper, stranger, same-obsession, different-subject). Name each vector plainly, inline — not as a header.

STEERING CONTROLS
Some turns arrive with an explicit control line: [STEERING: preserve=<subject|feeling|style|structure>; distance=<safe|nearby|far|strange>; tone=<mood>]. When present, these are binding directives, not suggestions:
- preserve names which thread to hold constant. preserve=subject keeps the topic and changes treatment; preserve=feeling keeps the emotional register and changes everything else; preserve=style keeps the prose sensibility; preserve=structure keeps the formal shape (nested, fragmented, braided, etc.).
- distance sets how far the recommendation travels from the source. safe=an adjacent, recognizable step; nearby=clearly related, different execution; far=different subject entirely, same underlying thread; strange=formally adventurous or genuinely unexpected while still honoring the thread.
- tone sets the mood the next book should hit.
A change in controls between turns is a re-steer: give a new book that reflects the new settings, and name in one phrase what shifted because of it. Never ignore a control that is set.

FORMAT
Plain prose, short. Title and author stated clearly in the sentence. No markdown headers, no bullet lists, no JSON, no first person, no sign-off.`;

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
    res.json({ reply });
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
