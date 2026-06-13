/**
 * Gemini CLI lane. Reads the local session logs the official Gemini CLI writes
 * under ~/.gemini/tmp/<workspace>/chats/session-*.jsonl, the same way the
 * Claude/Codex lanes read their transcripts.
 *
 * Real log format (validated against gemini-cli 0.46): each session file is
 * JSONL — a header line {sessionId, projectHash, startTime, lastUpdated, kind},
 * append-only "$set" mutation lines, and message records:
 *   { id, timestamp, type:"user"|"gemini", content, model?, tokens? }
 * where a "gemini" record carries tokens {input, output, cached, thoughts,
 * tool, total} and the model name. Each "gemini" record is one model call.
 *
 * Consumer Gemini exposes no usage API, so the limit gauges are derived from
 * the published free Code Assist tier (60 req/min, 1000/day) counted against
 * this machine's own local request log. Everything stays local.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const GEMINI_DIR = path.join(os.homedir(), ".gemini");
const POLL_MS = 4000;
const IN_MOTION_MS = 5 * 60 * 1000;
const RUNNING_MS = 90 * 1000;
const FREE_RPM = 60;
const FREE_RPD = 1000;
const TYPICAL_SESSION_MS = 8 * 60 * 1000;

const state = {
  available: false,
  signedIn: false,
  reason: "starting",
  account: null,
  sessions: [],
  daily: { used: 0, limit: FREE_RPD },
  perMinute: { used: 0, limit: FREE_RPM },
  modelTotals: {},
  fetchedAt: null,
};

let timer = null;

function safeRead(p) { try { return fs.readFileSync(p, "utf8"); } catch { return null; } }

function detectAccount() {
  try {
    const a = JSON.parse(safeRead(path.join(GEMINI_DIR, "google_accounts.json")) || "{}");
    if (a.active) return a.active;
  } catch {}
  return fs.existsSync(path.join(GEMINI_DIR, "oauth_creds.json")) ? "signed in" : null;
}

/** Find all chat session files: ~/.gemini/tmp/<workspace>/chats/session-*.jsonl */
function sessionFiles() {
  const out = [];
  const tmp = path.join(GEMINI_DIR, "tmp");
  let workspaces;
  try { workspaces = fs.readdirSync(tmp, { withFileTypes: true }); } catch { return out; }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    const chats = path.join(tmp, ws.name, "chats");
    let files;
    try { files = fs.readdirSync(chats); } catch { continue; }
    for (const f of files) if (f.startsWith("session-") && f.endsWith(".jsonl")) out.push(path.join(chats, f));
  }
  return out;
}

/** Parse one session file into { header, messages:[{t,type,model,tokens}] }. */
function parseSession(file) {
  const text = safeRead(file);
  if (!text) return null;
  let header = null;
  const messages = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.sessionId && o.startTime && !header) { header = o; continue; }
    // message records can appear standalone or inside a $set.messages array
    const records = o.type && o.timestamp ? [o] : Array.isArray(o.$set && o.$set.messages) ? o.$set.messages : null;
    if (!records) continue;
    for (const m of records) {
      if (!m || !m.timestamp || !m.type) continue;
      messages.push({ t: Date.parse(m.timestamp), type: m.type, model: m.model || null, tokens: m.tokens || null });
    }
  }
  return { header, messages };
}

function poll() {
  state.account = detectAccount();
  state.signedIn = Boolean(state.account);
  if (!fs.existsSync(GEMINI_DIR)) { state.available = false; state.reason = "gemini-cli-not-installed"; return; }

  const now = Date.now();
  const dayStart = new Date(now).setHours(0, 0, 0, 0);
  const files = sessionFiles();
  const sessions = [];
  const modelTotals = {};
  let dayReq = 0, minReq = 0;

  for (const file of files) {
    let stat; try { stat = fs.statSync(file); } catch { continue; }
    if (now - stat.mtimeMs > 8 * 24 * 60 * 60 * 1000) continue;
    const parsed = parseSession(file);
    if (!parsed) continue;
    const msgs = parsed.messages;

    // requests = model ("gemini") responses; tally for the free-tier gauges
    for (const m of msgs) {
      if (m.type !== "gemini") continue;
      if (m.t >= dayStart) dayReq += 1;
      if (now - m.t <= 60 * 1000) minReq += 1;
      if (m.model) modelTotals[m.model] = (modelTotals[m.model] || 0) + (m.tokens ? m.tokens.total || 0 : 0);
    }

    const ageMs = now - stat.mtimeMs;
    if (ageMs > IN_MOTION_MS) continue;

    // per-session detail for the operations card
    const start = parsed.header ? Date.parse(parsed.header.startTime) : (msgs[0] && msgs[0].t) || stat.mtimeMs;
    const elapsedMs = now - start;
    const det = { input: 0, output: 0, reasoning: 0, cached: 0, total: 0 };
    let model = "gemini", turns = 0, calls = 0;
    const recent = [];
    for (const m of msgs) {
      if (m.type === "user") turns += 1;
      if (m.type === "gemini") {
        calls += 1;
        if (m.model) model = m.model;
        if (m.tokens) {
          det.input += m.tokens.input || 0; det.output += m.tokens.output || 0;
          det.reasoning += m.tokens.thoughts || 0; det.cached += m.tokens.cached || 0;
          det.total += m.tokens.total || 0;
          recent.push({ t: m.t, output: m.tokens.output || 0 });
        }
      }
    }
    const ratio = elapsedMs / TYPICAL_SESSION_MS;
    const readable = det.input || 1;
    const recentOut = recent.filter((e) => now - e.t <= 3 * 60 * 1000);
    sessions.push({
      source: "gemini",
      id: parsed.header ? parsed.header.sessionId.slice(0, 8) : path.basename(file).slice(8, 16),
      project: parsed.header ? (parsed.header.kind === "main" ? "Gemini CLI" : parsed.header.kind) : "Gemini",
      status: ageMs <= RUNNING_MS ? "running" : "winding-down",
      startedAt: start,
      lastActivityMs: ageMs,
      elapsedMin: Math.round(elapsedMs / 60000),
      progressPct: Math.min(95, Math.round(ratio * 95)),
      etaMin: ratio < 1 ? Math.max(0, Math.round((TYPICAL_SESSION_MS - elapsedMs) / 60000)) : null,
      overrun: ratio >= 1 ? Math.round(ratio * 10) / 10 : null,
      lowConfidence: true,
      turns,
      toolCalls: calls,
      filesEdited: 0,
      tokensPerMin: recentOut.length ? Math.round(recentOut.reduce((s, e) => s + e.output, 0) / 3) : null,
      totalTokens: det.total,
      tokenDetail: { input: det.input, output: det.output, reasoning: det.reasoning, cached: det.cached, cacheHitPct: Math.round((det.cached / readable) * 100) },
      topTools: [],
      effort: null,
      model,
      agents: [],
    });
  }

  state.sessions = sessions.sort((a, b) => a.lastActivityMs - b.lastActivityMs);
  state.modelTotals = modelTotals;
  state.daily = { used: Math.min(dayReq, FREE_RPD), limit: FREE_RPD };
  state.perMinute = { used: Math.min(minReq, FREE_RPM), limit: FREE_RPM };
  state.fetchedAt = now;
  state.available = state.signedIn || sessions.length > 0 || dayReq > 0;
  state.reason = state.available ? null : state.signedIn ? "no-recent-sessions" : "not-signed-in (run: gemini)";
}

function start() { if (timer) return; poll(); timer = setInterval(poll, POLL_MS); timer.unref(); }
function getGemini() { return state; }

module.exports = { start, getGemini };
