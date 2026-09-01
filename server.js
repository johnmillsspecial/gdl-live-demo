import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(express.static(join(__dirname, "public")));

// ---- Config -----------------------------------------------------------------
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.GDL_MODEL || "claude-sonnet-5";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// ---- Cost fence -------------------------------------------------------------
// Hard ceilings so a public demo can't run up an unbounded bill.
const MAX_TOKENS_REFLECT = 400;
const MAX_TOKENS_BRIDGES = 900;
const DAILY_CALL_CAP = Number(process.env.GDL_DAILY_CAP || 300); // calls/day across all users
const PER_IP_WINDOW_MS = 60 * 1000;
const PER_IP_MAX = 8; // calls per IP per minute

let dayKey = new Date().toISOString().slice(0, 10);
let dayCount = 0;
const ipHits = new Map(); // ip -> [timestamps]

function rollDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) {
    dayKey = today;
    dayCount = 0;
  }
}

function costFence(req, res) {
  rollDay();
  if (dayCount >= DAILY_CALL_CAP) {
    res.status(429).json({ error: "daily_cap", message: "Demo daily budget reached. Try again tomorrow." });
    return false;
  }
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || "unknown";
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < PER_IP_WINDOW_MS);
  if (hits.length >= PER_IP_MAX) {
    res.status(429).json({ error: "rate_limit", message: "Too many requests. Slow down a moment." });
    return false;
  }
  hits.push(now);
  ipHits.set(ip, hits);
  return true;
}

// ---- Anthropic call ---------------------------------------------------------
async function callClaude({ system, user, maxTokens }) {
  if (!API_KEY) {
    const err = new Error("no_api_key");
    err.code = "no_api_key";
    throw err;
  }
  const resp = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  const raw = await resp.text();
  if (!resp.ok) {
    const err = new Error("anthropic_error");
    err.code = "anthropic_error";
    err.status = resp.status;
    err.body = raw;
    throw err;
  }
  dayCount += 1;
  const data = JSON.parse(raw);
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function extractJson(text) {
  // Tolerate stray prose or ```json fences around the JSON payload.
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1) throw new Error("no_json");
  return JSON.parse(cleaned.slice(first, last + 1));
}

// ---- Prompts ----------------------------------------------------------------
// The whole point of GDL: model *remembered attraction*, not metadata.
const REFLECT_SYSTEM = `You are the reasoning core of GDL Discovery Bridges, a trajectory engine for human curiosity that works across books, albums, and films.
A person names a book, album, or film they loved, and selects the underlying drivers that actually stayed with them — NOT the genre or subject.
Your job in this step: reflect their taste back to them in one or two sentences. Name what mattered underneath the surface subject. Be specific and perceptive, the way a great independent bookseller would be — "what grabbed you wasn't orchids, it was watching intelligent people get consumed by beautiful, unusual things."
Do not recommend anything yet. Do not restate their drivers as a list. Speak in second person. Return ONLY valid JSON, no prose, no code fences:
{"reflection": "..."}`;

const BRIDGES_SYSTEM = `You are the reasoning core of GDL Discovery Bridges, a trajectory engine for human curiosity.
You do NOT recommend similar things. You build Discovery Bridges: each result continues the specific thread that mattered, along a named vector.
Given the loved item and the drivers that stayed with the person, produce exactly four bridges, one per vector, ranging across REAL breadth — draw from anything genuinely relevant across the whole field, not a fixed shortlist. Titles must be real, correctly attributed works. Match the medium of what they named: a book returns books, an album returns albums, a film returns films. Only cross into another medium when a vector genuinely lands better there (e.g. "Go stranger" reaching from a film to a novel), and when you do, make the shift explicit in the "why".
The four vectors:
- "Preserve the obsession" — same core appeal, deeper into the exact thing that grabbed them.
- "Mutate the subject" — same underlying appeal, entirely different surface subject.
- "Increase the depth" — same appeal, more intellectually demanding / more rigorous.
- "Go stranger" — same appeal, further out toward the strange, formally adventurous, or unexpected.
For each bridge: give the real title and author/creator, and one sentence that names what is being PRESERVED and what is CHANGING. Not "this is similar" — "this continues the part that mattered."
Return ONLY valid JSON, no prose, no code fences:
{"bridges":[{"vector":"Preserve the obsession","title":"...","creator":"...","why":"..."},{"vector":"Mutate the subject","title":"...","creator":"...","why":"..."},{"vector":"Increase the depth","title":"...","creator":"...","why":"..."},{"vector":"Go stranger","title":"...","creator":"...","why":"..."}]}`;

// ---- Routes -----------------------------------------------------------------
app.get("/api/health", (req, res) => {
  rollDay();
  res.json({
    ok: true,
    keyConfigured: Boolean(API_KEY),
    model: MODEL,
    dailyCap: DAILY_CALL_CAP,
    callsToday: dayCount,
  });
});

app.post("/api/reflect", async (req, res) => {
  if (!costFence(req, res)) return;
  const { loved, drivers } = req.body || {};
  if (!loved || !Array.isArray(drivers) || drivers.length === 0) {
    return res.status(400).json({ error: "bad_input", message: "Need a loved item and at least one driver." });
  }
  const user = `Loved: ${String(loved).slice(0, 200)}
Drivers that stayed with them: ${drivers.map((d) => String(d).slice(0, 60)).join(", ")}`;
  try {
    const text = await callClaude({ system: REFLECT_SYSTEM, user, maxTokens: MAX_TOKENS_REFLECT });
    const parsed = extractJson(text);
    res.json(parsed);
  } catch (e) {
    res.status(e.code === "no_api_key" ? 503 : 502).json({ error: e.code || "server_error", message: e.message });
  }
});

app.post("/api/bridges", async (req, res) => {
  if (!costFence(req, res)) return;
  const { loved, drivers } = req.body || {};
  if (!loved || !Array.isArray(drivers) || drivers.length === 0) {
    return res.status(400).json({ error: "bad_input", message: "Need a loved item and at least one driver." });
  }
  const user = `Loved: ${String(loved).slice(0, 200)}
Drivers that stayed with them: ${drivers.map((d) => String(d).slice(0, 60)).join(", ")}
Build the four Discovery Bridges, conditional on exactly these drivers.`;
  try {
    const text = await callClaude({ system: BRIDGES_SYSTEM, user, maxTokens: MAX_TOKENS_BRIDGES });
    const parsed = extractJson(text);
    res.json(parsed);
  } catch (e) {
    res.status(e.code === "no_api_key" ? 503 : 502).json({ error: e.code || "server_error", message: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GDL live demo on :${PORT} — key ${API_KEY ? "configured" : "MISSING"} — model ${MODEL}`);
});
