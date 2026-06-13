/**
 * Gemini CLI lane. Reads local session logs the official Gemini CLI writes
 * under ~/.gemini, the same way the Claude/Codex lanes read their transcripts.
 *
 * Consumer Gemini exposes no usage API, so the "limit" gauges are derived
 * from the published free Code Assist tier (60 requests/min, 1000/day) counted
 * against this machine's own local request log. Everything stays local.
 *
 * Degrades gracefully: until you sign in (`gemini` → Login with Google) and
 * run a session, this reports available:false with a reason, and the dashboard
 * shows a "sign in" hint instead of a panel.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const GEMINI_DIR = path.join(os.homedir(), ".gemini");
const POLL_MS = 4000;
const IN_MOTION_MS = 5 * 60 * 1000;
const RUNNING_MS = 90 * 1000;
// Free Google Code Assist individual tier (published limits).
const FREE_RPM = 60;
const FREE_RPD = 1000;
const TYPICAL_SESSION_MS = 8 * 60 * 1000; // progress fallback until history exists

const state = {
  available: false,
  signedIn: false,
  reason: "starting",
  account: null,
  sessions: [],
  daily: { used: 0, limit: FREE_RPD },
  perMinute: { used: 0, limit: FREE_RPM },
  fetchedAt: null,
};

let timer = null;

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function detectAccount() {
  // Gemini CLI stores the signed-in Google account here once authenticated.
  const accounts = safeReadJson(path.join(GEMINI_DIR, "google_accounts.json"));
  if (accounts && (accounts.active || accounts.selectedAccount)) {
    return accounts.active || accounts.selectedAccount;
  }
  if (fs.existsSync(path.join(GEMINI_DIR, "oauth_creds.json"))) return "signed in";
  return null;
}

function walkJson(dir, out = [], depth = 0) {
  if (depth > 4) return out;
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const item of items) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) walkJson(full, out, depth + 1);
    else if (item.name.endsWith(".json") && !item.name.startsWith("projects.json")) out.push(full);
  }
  return out;
}

/** Pull an ordered list of message timestamps + roles from a Gemini log file,
 *  tolerating the CLI's log/checkpoint shapes (array, or {messages:[...]}). */
function extractMessages(data) {
  const arr = Array.isArray(data) ? data : Array.isArray(data?.messages) ? data.messages : null;
  if (!arr) return [];
  const out = [];
  for (const m of arr) {
    if (!m || typeof m !== "object") continue;
    const ts = m.timestamp ?? m.time ?? m.createdAt ?? m.date;
    const t = ts ? Date.parse(ts) : null;
    const role = m.role || m.type || m.sender || null;
    if (t) out.push({ t, role });
  }
  return out;
}

function poll() {
  const account = detectAccount();
  state.signedIn = Boolean(account);
  state.account = account;
  if (!fs.existsSync(GEMINI_DIR)) {
    state.available = false;
    state.reason = "gemini-cli-not-installed";
    return;
  }

  const now = Date.now();
  const files = walkJson(GEMINI_DIR);
  const sessions = [];
  let dayCount = 0;
  let minuteCount = 0;
  const dayStart = new Date(now).setHours(0, 0, 0, 0);

  for (const file of files) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (now - stat.mtimeMs > 8 * 24 * 60 * 60 * 1000) continue;
    const data = safeReadJson(file);
    if (!data) continue;
    const messages = extractMessages(data);
    if (!messages.length) continue;

    for (const m of messages) {
      const isUser = !m.role || /user|human/i.test(m.role);
      if (isUser) {
        if (m.t >= dayStart) dayCount += 1;
        if (now - m.t <= 60 * 1000) minuteCount += 1;
      }
    }

    const ageMs = now - stat.mtimeMs;
    if (ageMs <= IN_MOTION_MS) {
      const first = messages[0].t;
      const elapsedMs = now - first;
      const ratio = elapsedMs / TYPICAL_SESSION_MS;
      sessions.push({
        source: "gemini",
        id: path.basename(path.dirname(file)).slice(0, 8) || "gemini",
        project: path.basename(path.dirname(file)) || "Gemini",
        status: ageMs <= RUNNING_MS ? "running" : "winding-down",
        lastActivityMs: ageMs,
        elapsedMin: Math.round(elapsedMs / 60000),
        progressPct: Math.min(95, Math.round(ratio * 95)),
        etaMin: ratio < 1 ? Math.max(0, Math.round((TYPICAL_SESSION_MS - elapsedMs) / 60000)) : null,
        overrun: ratio >= 1 ? Math.round(ratio * 10) / 10 : null,
        lowConfidence: true,
        turns: messages.filter((m) => !m.role || /user|human/i.test(m.role)).length,
        totalTokens: 0,
        model: "gemini",
        agents: [],
      });
    }
  }

  state.sessions = sessions.sort((a, b) => a.lastActivityMs - b.lastActivityMs);
  state.daily = { used: Math.min(dayCount, FREE_RPD), limit: FREE_RPD };
  state.perMinute = { used: Math.min(minuteCount, FREE_RPM), limit: FREE_RPM };
  state.fetchedAt = now;
  state.available = state.signedIn || sessions.length > 0 || dayCount > 0;
  state.reason = state.available ? null : state.signedIn ? "no-recent-sessions" : "not-signed-in (run: gemini)";
}

function start() {
  if (timer) return;
  poll();
  timer = setInterval(poll, POLL_MS);
  timer.unref();
}

function getGemini() {
  return state;
}

module.exports = { start, getGemini };
