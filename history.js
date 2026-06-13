/**
 * Session-duration history: powers the progress/ETA estimates.
 *
 * At startup, every historical transcript gets a cheap scan (first ~16 KB for
 * the opening timestamp + Codex cwd, last ~64 KB for the closing timestamp).
 * Durations are grouped per project so a running session's progress bar is
 * "elapsed vs the median of this project's past sessions" — grounded in this
 * machine's real history, never a made-up number. Estimates stay estimates:
 * callers cap at 95% and label low-confidence groups.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const CLAUDE_PROJECTS = path.join(os.homedir(), ".claude", "projects");
const CODEX_SESSIONS = path.join(os.homedir(), ".codex", "sessions");

const HEAD_BYTES = 16 * 1024;
const TAIL_BYTES = 64 * 1024;
const MIN_DURATION_MS = 30 * 1000; // shorter runs are noise, not "tasks"

// Fallback medians (ms) when a group has too few samples.
const DEFAULTS = { claude: 15 * 60000, codex: 10 * 60000, subagent: 5 * 60000 };

const groups = new Map(); // "source:project" -> { durations: [], median: null }
const state = { ready: false };

function readChunk(filePath, position, length) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, position);
    return buffer.toString("utf8", 0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function firstTimestamp(text) {
  const match = text.match(/"timestamp":"([^"]+)"/);
  return match ? Date.parse(match[1]) : null;
}

function lastTimestamp(text) {
  let last = null;
  const re = /"timestamp":"([^"]+)"/g;
  for (let m; (m = re.exec(text)); ) last = m[1];
  return last ? Date.parse(last) : null;
}

function codexCwd(text) {
  const match = text.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return null;
  }
}

function walk(dir, out = []) {
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const item of items) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) walk(full, out);
    else if (item.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

function groupKey(source, project) {
  return `${source}:${project || "*"}`;
}

function pushDuration(key, durationMs) {
  let group = groups.get(key);
  if (!group) {
    group = { durations: [], median: null };
    groups.set(key, group);
  }
  group.durations.push(durationMs);
  group.median = null; // recompute lazily
}

function medianOf(group) {
  if (!group || group.durations.length === 0) return null;
  if (group.median == null) {
    const sorted = [...group.durations].sort((a, b) => a - b);
    group.median = sorted[Math.floor(sorted.length / 2)];
  }
  return group.median;
}

/** Friendly project label from a Claude project dir name. */
function decodeClaudeProjectDir(dirName) {
  const parts = dirName.replace(/^[A-Za-z]--/, "").split("-").filter(Boolean);
  return parts.length ? parts.slice(-2).join(" / ") : dirName;
}

function scanFile(filePath, source, project) {
  let size;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return;
  }
  if (size < 256) return;
  try {
    const head = readChunk(filePath, 0, Math.min(HEAD_BYTES, size));
    const tail = readChunk(filePath, Math.max(0, size - TAIL_BYTES), Math.min(TAIL_BYTES, size));
    const start = firstTimestamp(head);
    const end = lastTimestamp(tail);
    if (!start || !end || end - start < MIN_DURATION_MS) return;
    let resolvedProject = project;
    if (source === "codex") {
      const cwd = codexCwd(head);
      resolvedProject = cwd ? path.basename(cwd) : "codex";
    }
    pushDuration(groupKey(source, resolvedProject), end - start);
    pushDuration(groupKey(source, null), end - start); // source-wide bucket
  } catch {
    // unreadable/corrupt history file — skip silently
  }
}

/** One-time startup scan; chunked so the HTTP server stays responsive. */
function scanHistory(onDone) {
  const jobs = [];
  let projectDirs = [];
  try {
    projectDirs = fs.readdirSync(CLAUDE_PROJECTS, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {}
  for (const dir of projectDirs) {
    const project = decodeClaudeProjectDir(dir.name);
    for (const file of walk(path.join(CLAUDE_PROJECTS, dir.name))) {
      const isAgent = /[\\/]subagents[\\/]agent-[^\\/]+\.jsonl$/.test(file);
      jobs.push(() => scanFile(file, isAgent ? "subagent" : "claude", isAgent ? null : project));
    }
  }
  for (const file of walk(CODEX_SESSIONS)) {
    if (path.basename(file).startsWith("rollout-")) jobs.push(() => scanFile(file, "codex", null));
  }

  let index = 0;
  (function runChunk() {
    const stopAt = Math.min(index + 25, jobs.length);
    while (index < stopAt) jobs[index++]();
    if (index < jobs.length) setImmediate(runChunk);
    else {
      state.ready = true;
      if (onDone) onDone();
    }
  })();
}

/** Median lookup with graceful fallbacks. */
function getMedian(source, project) {
  const specific = groups.get(groupKey(source, project));
  if (specific && specific.durations.length >= 3) {
    return { medianMs: medianOf(specific), sampleCount: specific.durations.length, usedFallback: false };
  }
  const sourceWide = groups.get(groupKey(source, null));
  if (sourceWide && sourceWide.durations.length >= 3) {
    return { medianMs: medianOf(sourceWide), sampleCount: sourceWide.durations.length, usedFallback: true };
  }
  return { medianMs: DEFAULTS[source] || DEFAULTS.claude, sampleCount: 0, usedFallback: true };
}

/** Live sessions feed their final duration back in when they finish. */
function recordCompletion(source, project, durationMs) {
  if (durationMs < MIN_DURATION_MS) return;
  pushDuration(groupKey(source, project), durationMs);
  pushDuration(groupKey(source, null), durationMs);
}

/** Snapshot for the API: per-project medians (minutes) with sample counts. */
function summary() {
  const projects = {};
  for (const [key, group] of groups) {
    if (key.endsWith(":*")) continue;
    projects[key] = { medianMin: Math.round(medianOf(group) / 60000), samples: group.durations.length };
  }
  return { ready: state.ready, projects };
}

module.exports = { scanHistory, getMedian, recordCompletion, summary, decodeClaudeProjectDir, state };
