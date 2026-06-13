/**
 * Live Claude usage limits, read the safe, non-invasive way.
 *
 * Claude Code stores an OAuth access token in ~/.claude/.credentials.json and
 * refreshes it on its own while you use it. We simply read that token at poll
 * time and ask Anthropic's usage endpoint for the account's 5-hour / weekly
 * utilization. We deliberately DO NOT perform the refresh grant ourselves:
 * refreshing can rotate the token and would risk logging you out of Claude
 * Code. So when the on-disk token is briefly expired, we keep showing the last
 * good reading (flagged stale) until Claude Code refreshes it automatically.
 *
 * The token is read locally, sent only to api.anthropic.com over HTTPS, and is
 * never logged, written elsewhere, or included in /api/state.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const CREDS_PATH = path.join(os.homedir(), ".claude", ".credentials.json");
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const POLL_MS = 90 * 1000;
const BACKOFF_BASE_MS = 5 * 60 * 1000; // first 429 backoff
const BACKOFF_MAX_MS = 30 * 60 * 1000; // cap for repeated 429s (exponential)

const state = {
  available: false,
  fetchedAt: null,
  stale: false,
  fiveHour: null, // { pct, resetsAt }
  weekly: null,
  weeklyOpus: null,
  plan: null,
  reason: "starting",
};

let timer = null;
let nextAllowedAt = 0;
let backoffMs = BACKOFF_BASE_MS;

function readToken() {
  try {
    const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8"));
    const oauth = creds.claudeAiOauth || creds.oauth || creds;
    if (oauth && typeof oauth.accessToken === "string") {
      return { token: oauth.accessToken, plan: oauth.subscriptionType || null };
    }
  } catch {}
  return null;
}

/** Normalize one window object from the API, tolerating shape drift. */
function pickWindow(obj) {
  if (!obj || typeof obj !== "object") return null;
  const pct = typeof obj.utilization === "number" ? obj.utilization : typeof obj.used_percent === "number" ? obj.used_percent : null;
  if (pct == null) return null;
  return { pct: Math.round(pct * 10) / 10, resetsAt: obj.resets_at ?? obj.resetsAt ?? null };
}

/** Mark the current reading stale rather than blanking it, so the gauge holds
 *  its last good value through transient failures. */
function markStale(reason) {
  if (state.fiveHour || state.weekly) {
    state.stale = true;
    state.available = true; // keep showing last good, flagged
  } else {
    state.available = false;
  }
  state.reason = reason;
}

async function poll() {
  if (Date.now() < nextAllowedAt) return;
  const creds = readToken();
  if (!creds) return markStale("no-credentials");
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${creds.token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (response.status === 429) {
      nextAllowedAt = Date.now() + backoffMs;
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS); // ease off if it persists
      return markStale("rate-limited (backing off)");
    }
    if (response.status === 401) {
      // Token momentarily expired; Claude Code refreshes it as you work.
      return markStale("token refreshing — will recover automatically");
    }
    if (!response.ok) return markStale(`http-${response.status}`);

    const data = await response.json();
    const fiveHour = pickWindow(data.five_hour ?? data.fiveHour);
    const weekly = pickWindow(data.seven_day ?? data.sevenDay ?? data.seven_day_overall);
    if (!fiveHour && !weekly) return markStale("unrecognized-response");

    state.fiveHour = fiveHour;
    state.weekly = weekly;
    state.weeklyOpus = pickWindow(data.seven_day_opus ?? data.sevenDayOpus);
    state.plan = creds.plan;
    state.fetchedAt = Date.now();
    state.available = true;
    state.stale = false;
    backoffMs = BACKOFF_BASE_MS; // healthy response resets the backoff
    state.reason = null;
  } catch (error) {
    markStale(error.name === "AbortError" ? "timeout" : "network-error");
  }
}

function start() {
  if (timer) return;
  poll();
  timer = setInterval(poll, POLL_MS);
  timer.unref();
}

function getClaudeLimits() {
  return state;
}

module.exports = { start, getClaudeLimits };
