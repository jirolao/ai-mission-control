/**
 * LLM, AI Tracker — local dashboard server (http://127.0.0.1:5599).
 *
 * Watches Claude Code (~/.claude/projects) and Codex (~/.codex/sessions)
 * session logs plus live system telemetry, and serves a one-page dashboard.
 * Pure Node, no dependencies; transcripts are tailed incrementally (byte
 * offsets cached per file) so polling stays cheap during heavy sessions.
 *
 * Privacy by omission: /api/state never includes prompt text, task
 * descriptions, file paths, or thread names — only project names, progress,
 * and counters. The UI cannot leak what the server never sends.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const history = require("./history");
const telemetry = require("./telemetry");
const claudeUsage = require("./claudeUsage");
const projections = require("./projections");
const gemini = require("./gemini");

const PORT = 5599;
const HOME = os.homedir();
const CLAUDE_PROJECTS = path.join(HOME, ".claude", "projects");
const CODEX_SESSIONS = path.join(HOME, ".codex", "sessions");
const SETTINGS_PATH = path.join(__dirname, "settings.json");

const SCAN_WINDOW_MS = 8 * 24 * 60 * 60 * 1000; // ignore files older than 8 days
const RUNNING_MS = 90 * 1000;        // appended within 90s  -> running
const IN_MOTION_MS = 5 * 60 * 1000;  // appended within 5min -> winding down
const AGENT_ACTIVE_MS = 2 * 60 * 1000;

// ---------------------------------------------------------------------------
// Incremental JSONL tailing. Cache: path -> { offset, remainder, state }
// Memory discipline: every scan marks the files it touched; anything not
// touched for a while (file aged out of the window or deleted) is evicted.
// ---------------------------------------------------------------------------
const fileCache = new Map();
const touchedThisScan = new Set();
let scanCount = 0;

function evictStaleCacheEntries() {
  for (const key of fileCache.keys()) {
    if (!touchedThisScan.has(key)) fileCache.delete(key);
  }
}

function tailFile(filePath, makeInitialState, onLine) {
  touchedThisScan.add(filePath);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    fileCache.delete(filePath);
    return null;
  }
  let entry = fileCache.get(filePath);
  if (!entry || stat.size < entry.offset) {
    entry = { offset: 0, remainder: "", state: makeInitialState() };
    fileCache.set(filePath, entry);
  }
  if (stat.size > entry.offset) {
    const fd = fs.openSync(filePath, "r");
    try {
      const length = stat.size - entry.offset;
      const buffer = Buffer.alloc(Math.min(length, 64 * 1024 * 1024));
      fs.readSync(fd, buffer, 0, buffer.length, entry.offset);
      entry.offset += buffer.length;
      const chunk = entry.remainder + buffer.toString("utf8");
      const lines = chunk.split("\n");
      entry.remainder = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          onLine(entry.state, JSON.parse(trimmed));
        } catch {}
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  entry.state.mtimeMs = stat.mtimeMs;
  entry.state.sizeBytes = stat.size;
  return entry.state;
}

function listFilesRecursive(dir, suffix, out = []) {
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const item of items) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) listFilesRecursive(full, suffix, out);
    else if (item.name.endsWith(suffix)) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Progress estimation (shared). Honest by design: median-based, capped at 95%.
// ---------------------------------------------------------------------------
function estimateProgress(source, project, elapsedMs) {
  const { medianMs, usedFallback } = history.getMedian(source, project);
  const ratio = elapsedMs / medianMs;
  return {
    progressPct: Math.min(95, Math.round(ratio * 95)),
    etaMin: ratio < 1 ? Math.max(0, Math.round((medianMs - elapsedMs) / 60000)) : null,
    overrun: ratio >= 1 ? Math.round(ratio * 10) / 10 : null,
    lowConfidence: usedFallback,
  };
}

// Sessions seen "in motion" last poll: key -> { source, project, firstTs }
const inMotionLastPoll = new Map();
const completionRecorded = new Set();

function trackCompletion(nowInMotion) {
  for (const [key, info] of inMotionLastPoll) {
    if (!nowInMotion.has(key) && !completionRecorded.has(key) && info.firstTs) {
      history.recordCompletion(info.source, info.project, info.lastTs - info.firstTs);
      completionRecorded.add(key);
    }
  }
  inMotionLastPoll.clear();
  for (const [key, info] of nowInMotion) inMotionLastPoll.set(key, info);
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function newClaudeState() {
  return {
    models: {}, // model -> { input, output, cacheCreate, cacheRead, calls }
    firstTimestamp: null,
    lastTimestamp: null,
    usageByTime: [],
    turns: 0,
    toolCalls: 0,
    filesEdited: 0,
    tools: {}, // tool name -> count (for the "top tools" readout)
  };
}

function claudeLine(state, obj) {
  const t = obj.timestamp ? Date.parse(obj.timestamp) : null;
  if (t) {
    if (!state.firstTimestamp) state.firstTimestamp = t;
    state.lastTimestamp = t;
  }
  if (obj.type === "assistant" && obj.message) {
    state.turns += 1;
    const content = obj.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === "tool_use") {
          state.toolCalls += 1;
          state.tools[block.name] = (state.tools[block.name] || 0) + 1;
          if (EDIT_TOOLS.has(block.name)) state.filesEdited += 1;
        }
      }
    }
  }
  const usage = obj.message && obj.message.usage;
  if (usage && obj.message.role === "assistant") {
    const model = obj.message.model || "unknown";
    if (model === "<synthetic>") return;
    const m = (state.models[model] ??= { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, calls: 0 });
    m.input += usage.input_tokens || 0;
    m.output += usage.output_tokens || 0;
    m.cacheCreate += usage.cache_creation_input_tokens || 0;
    m.cacheRead += usage.cache_read_input_tokens || 0;
    m.calls += 1;
    if (t) {
      const total = (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.cache_creation_input_tokens || 0);
      state.usageByTime.push({ t, total, output: usage.output_tokens || 0 });
      // Only the trailing 7 days matter for the gauges — drop older events so
      // long-running sessions can't grow memory without bound.
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      while (state.usageByTime.length > 12000 || (state.usageByTime.length && state.usageByTime[0].t < cutoff)) {
        state.usageByTime.shift();
      }
    }
  }
}

/** Sum a Claude session's per-model token buckets into one detail object. */
function claudeTokenDetail(models) {
  const d = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  for (const m of Object.values(models)) {
    d.input += m.input;
    d.output += m.output;
    d.cacheRead += m.cacheRead;
    d.cacheCreate += m.cacheCreate;
  }
  const readableInput = d.input + d.cacheRead + d.cacheCreate;
  d.cacheHitPct = readableInput > 0 ? Math.round((d.cacheRead / readableInput) * 100) : 0;
  d.total = d.input + d.output + d.cacheCreate;
  return d;
}

function topTools(tools, n = 4) {
  return Object.entries(tools)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => ({ name, count }));
}

const AGENT_PATH_RE = /[\\/]([0-9a-f-]{36})[\\/]subagents[\\/]agent-([^\\/]+)\.jsonl$/;

function scanClaude(now, nowInMotion) {
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(CLAUDE_PROJECTS, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return { available: false, sessions: [], totals: null };
  }

  const windows = { fiveHour: 0, week: 0, today: 0 };
  const modelTotals = {};
  const mains = []; // { file, project, state }
  const agentsBySession = new Map(); // sessionId -> [{ id, state }]

  for (const dir of projectDirs) {
    const project = history.decodeClaudeProjectDir(dir.name);
    for (const file of listFilesRecursive(path.join(CLAUDE_PROJECTS, dir.name), ".jsonl")) {
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (now - stat.mtimeMs > SCAN_WINDOW_MS) continue;

      const agentMatch = file.match(AGENT_PATH_RE);
      const state = tailFile(file, newClaudeState, claudeLine);
      if (!state) continue;

      if (agentMatch) {
        const list = agentsBySession.get(agentMatch[1]) ?? [];
        list.push({ id: agentMatch[2].slice(0, 8), state });
        agentsBySession.set(agentMatch[1], list);
      } else {
        mains.push({ file, project, state });
      }

      // Usage windows + model totals include agents (their tokens count too).
      for (const event of state.usageByTime) {
        const age = now - event.t;
        if (age <= 5 * 60 * 60 * 1000) windows.fiveHour += event.total;
        if (age <= 7 * 24 * 60 * 60 * 1000) windows.week += event.total;
        if (new Date(event.t).toDateString() === new Date(now).toDateString()) windows.today += event.total;
      }
      for (const [model, m] of Object.entries(state.models)) {
        const target = (modelTotals[model] ??= { input: 0, output: 0, cacheRead: 0, calls: 0 });
        target.input += m.input + m.cacheCreate;
        target.output += m.output;
        target.cacheRead += m.cacheRead;
        target.calls += m.calls;
      }
    }
  }

  const sessions = [];
  for (const { file, project, state } of mains) {
    const ageMs = now - state.mtimeMs;
    if (ageMs > IN_MOTION_MS) continue;
    const sessionId = path.basename(file, ".jsonl");
    const elapsedMs = state.firstTimestamp ? now - state.firstTimestamp : 0;
    const estimate = estimateProgress("claude", project, elapsedMs);
    const recentOutput = state.usageByTime.filter((e) => now - e.t <= 3 * 60 * 1000);
    const tokensPerMin = Math.round(recentOutput.reduce((sum, e) => sum + e.output, 0) / 3);
    const models = Object.entries(state.models).sort((a, b) => b[1].calls - a[1].calls);

    const agents = (agentsBySession.get(sessionId) ?? [])
      .filter((a) => now - a.state.mtimeMs <= IN_MOTION_MS)
      .map((a) => {
        const agentElapsed = a.state.firstTimestamp ? now - a.state.firstTimestamp : 0;
        const agentModels = Object.entries(a.state.models).sort((x, y) => y[1].calls - x[1].calls);
        return {
          id: a.id,
          active: now - a.state.mtimeMs <= AGENT_ACTIVE_MS,
          elapsedMin: Math.round(agentElapsed / 60000),
          progressPct: estimateProgress("subagent", null, agentElapsed).progressPct,
          model: agentModels.length ? agentModels[0][0] : "—",
          totalTokens: a.state.usageByTime.reduce((sum, e) => sum + e.total, 0),
          toolCalls: a.state.toolCalls,
          filesEdited: a.state.filesEdited,
        };
      });

    nowInMotion.set(`claude:${sessionId}`, {
      source: "claude",
      project,
      firstTs: state.firstTimestamp,
      lastTs: state.lastTimestamp ?? now,
    });

    const detail = claudeTokenDetail(state.models);
    sessions.push({
      source: "claude",
      id: sessionId.slice(0, 8),
      project,
      status: ageMs <= RUNNING_MS ? "running" : "winding-down",
      startedAt: state.firstTimestamp,
      lastActivityMs: ageMs,
      elapsedMin: Math.round(elapsedMs / 60000),
      ...estimate,
      tokensPerMin,
      totalTokens: detail.total,
      tokenDetail: { input: detail.input, output: detail.output, cacheRead: detail.cacheRead, cacheHitPct: detail.cacheHitPct },
      turns: state.turns,
      toolCalls: state.toolCalls,
      filesEdited: state.filesEdited,
      topTools: topTools(state.tools),
      model: models.length ? models[0][0] : "unknown",
      agents,
    });
  }
  sessions.sort((a, b) => a.lastActivityMs - b.lastActivityMs);
  return { available: true, sessions, totals: { windows, modelTotals } };
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------
function newCodexState() {
  return {
    model: null,
    cwd: null,
    effort: null,
    rateLimits: null,
    rateLimitsAt: null,
    totalUsage: null,
    firstTimestamp: null,
    lastTimestamp: null,
    turns: 0,
    toolCalls: 0,
    filesPatched: 0,
    tools: {},
    outByTime: [], // { t, output } for tokens/min — from per-turn deltas
    lastTotalTokens: 0,
  };
}

function codexLine(state, obj) {
  const t = obj.timestamp ? Date.parse(obj.timestamp) : null;
  if (t) {
    if (!state.firstTimestamp) state.firstTimestamp = t;
    state.lastTimestamp = t;
  }
  const payload = obj.payload || {};
  if (obj.type === "turn_context") {
    if (typeof payload.model === "string") state.model = payload.model;
    if (typeof payload.cwd === "string") state.cwd = payload.cwd;
    const effort = payload.effort || payload.reasoning_effort || (payload.reasoning && payload.reasoning.effort);
    if (typeof effort === "string") state.effort = effort;
  }
  const ptype = payload.type;
  if (ptype === "function_call" || ptype === "custom_tool_call") {
    state.toolCalls += 1;
    const name = payload.name || "tool";
    state.tools[name] = (state.tools[name] || 0) + 1;
  } else if (ptype === "patch_apply_end") {
    state.filesPatched += 1;
  } else if (ptype === "agent_message") {
    state.turns += 1;
  } else if (ptype === "token_count") {
    if (payload.rate_limits) {
      state.rateLimits = payload.rate_limits;
      state.rateLimitsAt = t;
    }
    if (payload.info && payload.info.total_token_usage) {
      state.totalUsage = payload.info.total_token_usage;
      const total = payload.info.total_token_usage.total_tokens || 0;
      const out = payload.info.last_token_usage ? payload.info.last_token_usage.output_tokens || 0 : Math.max(0, total - state.lastTotalTokens);
      state.lastTotalTokens = total;
      if (t && out > 0) {
        state.outByTime.push({ t, output: out });
        const cutoff = Date.now() - 6 * 60 * 60 * 1000;
        while (state.outByTime.length > 3000 || (state.outByTime.length && state.outByTime[0].t < cutoff)) {
          state.outByTime.shift();
        }
      }
    }
  }
}

function scanCodex(now, nowInMotion) {
  const files = listFilesRecursive(CODEX_SESSIONS, ".jsonl").filter((f) => path.basename(f).startsWith("rollout-"));
  if (!files.length && !fs.existsSync(CODEX_SESSIONS)) {
    return { available: false, sessions: [], rateLimits: null, modelTotals: {} };
  }
  const sessions = [];
  const modelTotals = {};
  let latestLimits = null;

  for (const file of files) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (now - stat.mtimeMs > SCAN_WINDOW_MS) continue;
    const state = tailFile(file, newCodexState, codexLine);
    if (!state) continue;

    if (state.rateLimits && (!latestLimits || (state.rateLimitsAt || 0) > latestLimits.at)) {
      latestLimits = { at: state.rateLimitsAt || state.mtimeMs, data: state.rateLimits };
    }
    if (state.totalUsage && state.model) {
      modelTotals[state.model] = (modelTotals[state.model] || 0) + (state.totalUsage.total_tokens || 0);
    }

    const ageMs = now - state.mtimeMs;
    if (ageMs > IN_MOTION_MS) continue;
    const project = state.cwd ? path.basename(state.cwd) : "Codex";
    const elapsedMs = state.firstTimestamp ? now - state.firstTimestamp : 0;
    const estimate = estimateProgress("codex", project, elapsedMs);
    const uuidMatch = path.basename(file).match(/[0-9a-f]{8}-[0-9a-f]{4}/);
    const recentOut = state.outByTime.filter((e) => now - e.t <= 3 * 60 * 1000);
    const tokensPerMin = recentOut.length ? Math.round(recentOut.reduce((s, e) => s + e.output, 0) / 3) : null;
    const u = state.totalUsage || {};
    const readableInput = (u.input_tokens || 0); // input_tokens already includes cached
    const cacheHitPct = readableInput > 0 ? Math.round(((u.cached_input_tokens || 0) / readableInput) * 100) : 0;

    nowInMotion.set(`codex:${path.basename(file)}`, {
      source: "codex",
      project,
      firstTs: state.firstTimestamp,
      lastTs: state.lastTimestamp ?? now,
    });

    sessions.push({
      source: "codex",
      id: uuidMatch ? uuidMatch[0] : path.basename(file).slice(0, 8),
      project,
      status: ageMs <= RUNNING_MS ? "running" : "winding-down",
      startedAt: state.firstTimestamp,
      lastActivityMs: ageMs,
      elapsedMin: Math.round(elapsedMs / 60000),
      ...estimate,
      tokensPerMin,
      totalTokens: u.total_tokens || 0,
      tokenDetail: {
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        reasoning: u.reasoning_output_tokens || 0,
        cached: u.cached_input_tokens || 0,
        cacheHitPct,
      },
      turns: state.turns,
      toolCalls: state.toolCalls,
      filesEdited: state.filesPatched,
      topTools: topTools(state.tools),
      effort: state.effort,
      model: state.model || "unknown",
      agents: [],
    });
  }
  sessions.sort((a, b) => a.lastActivityMs - b.lastActivityMs);
  return { available: true, sessions, rateLimits: latestLimits, modelTotals };
}

// ---------------------------------------------------------------------------
// Settings (optional Claude cap calibration)
// ---------------------------------------------------------------------------
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return { claudeCaps: { fiveHourTokens: null, weeklyTokens: null } };
  }
}

// Burn-rate sparkline: Claude 5-hour-window token total, sampled ≤ every 25s.
const burnSeries = [];
let lastBurnSampleAt = 0;

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.url === "/api/state") {
    const now = Date.now();
    const nowInMotion = new Map();
    touchedThisScan.clear();
    let claude, codex;
    try {
      claude = scanClaude(now, nowInMotion);
    } catch (error) {
      claude = { available: false, error: String(error), sessions: [] };
    }
    try {
      codex = scanCodex(now, nowInMotion);
    } catch (error) {
      codex = { available: false, error: String(error), sessions: [] };
    }
    claude.limits = claudeUsage.getClaudeLimits();
    const geminiData = gemini.getGemini();
    trackCompletion(nowInMotion);
    if (++scanCount % 10 === 0) evictStaleCacheEntries();

    // Feed projections from whichever percentages are live this poll.
    if (claude.limits.available) {
      projections.record("claude-5h", claude.limits.fiveHour?.pct, now);
      projections.record("claude-week", claude.limits.weekly?.pct, now);
    }
    const crl = codex.rateLimits && codex.rateLimits.data;
    if (crl) {
      projections.record("codex-5h", crl.primary?.used_percent, codex.rateLimits.at);
      projections.record("codex-week", crl.secondary?.used_percent, codex.rateLimits.at);
    }
    claude.projection = { fiveHour: projections.project("claude-5h", now), weekly: projections.project("claude-week", now) };
    codex.projection = { fiveHour: projections.project("codex-5h", now), weekly: projections.project("codex-week", now) };

    if (now - lastBurnSampleAt > 25000 && claude.totals) {
      lastBurnSampleAt = now;
      burnSeries.push(claude.totals.windows.fiveHour);
      if (burnSeries.length > 60) burnSeries.shift();
    }

    const sessionCount = (claude.sessions?.length || 0) + (codex.sessions?.length || 0) + (geminiData.sessions?.length || 0);
    const analytics = {
      claudeTodayTokens: claude.totals ? claude.totals.windows.today : 0,
      activeSessions: sessionCount,
      providersActive: [claude.sessions?.length && "claude", codex.sessions?.length && "codex", geminiData.sessions?.length && "gemini"].filter(Boolean),
      burnSeries,
    };

    const body = JSON.stringify({
      generatedAt: now,
      claude,
      codex,
      gemini: geminiData,
      telemetry: telemetry.getTelemetry(),
      history: history.summary(),
      analytics,
      settings: readSettings(),
    });
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(body);
    return;
  }
  if (req.url === "/" || req.url === "/index.html") {
    try {
      const html = fs.readFileSync(path.join(__dirname, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      res.writeHead(500);
      res.end("index.html missing");
    }
    return;
  }
  // Static assets (whitelisted; no path traversal — exact matches only).
  if (STATIC[req.url]) {
    try {
      const body = fs.readFileSync(path.join(__dirname, STATIC[req.url].file));
      res.writeHead(200, { "Content-Type": STATIC[req.url].type, "Cache-Control": "max-age=3600" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

const STATIC = {
  "/scene.js": { file: "scene.js", type: "text/javascript; charset=utf-8" },
  "/vendor/three.module.min.js": { file: "vendor/three.module.min.js", type: "text/javascript; charset=utf-8" },
};

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.log(`Mission Control already running on http://127.0.0.1:${PORT}`);
    process.exit(0);
  }
  throw error;
});

/** Open the dashboard in the default browser, cross-platform, no deps.
 *  Pass --open (or set MC_OPEN=1) to enable; headless runs stay clean. */
function openBrowser(url) {
  const { spawn } = require("child_process");
  const p = process.platform;
  const [cmd, args] = p === "win32" ? ["cmd", ["/c", "start", "", url]] : p === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true }).unref();
  } catch {}
}

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`AI Mission Control -> ${url}`);
  telemetry.start();
  claudeUsage.start();
  gemini.start();
  history.scanHistory(() => console.log("history scan complete"));
  if (process.argv.includes("--open") || process.env.MC_OPEN === "1") openBrowser(url);
});
