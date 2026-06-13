/**
 * Time-to-limit projections. Each usage window (claude-5h, claude-week,
 * codex-5h, codex-week) gets a small ring buffer of {t, pct} samples. A least-
 * squares slope over the recent rising samples projects when the gauge will
 * hit 100%. Honest: returns null unless usage is actually climbing, and the
 * answer is always presented as an estimate in the UI.
 *
 * Memory: at most KEEP samples per series, a handful of series — a few KB.
 */
const KEEP = 40;
const series = new Map(); // key -> [{ t, pct }]

function record(key, pct, atMs) {
  if (typeof pct !== "number" || !atMs) return;
  let arr = series.get(key);
  if (!arr) {
    arr = [];
    series.set(key, arr);
  }
  const last = arr[arr.length - 1];
  // Only store on change or every few minutes, so the slope reflects real movement.
  if (!last || last.pct !== pct || atMs - last.t > 5 * 60 * 1000) {
    arr.push({ t: atMs, pct });
    if (arr.length > KEEP) arr.shift();
  }
}

function project(key, nowMs) {
  const arr = series.get(key);
  if (!arr || arr.length < 3) return null;
  // Use samples from the trailing 90 minutes for a responsive slope.
  const recent = arr.filter((s) => nowMs - s.t <= 90 * 60 * 1000);
  if (recent.length < 3) return null;
  const n = recent.length;
  const t0 = recent[0].t;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const s of recent) {
    const x = (s.t - t0) / 60000; // minutes
    const y = s.pct;
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom; // %/min
  if (slope <= 0.01) return null; // flat or falling — no meaningful ETA
  const current = recent[recent.length - 1].pct;
  const minutesToFull = (100 - current) / slope;
  if (minutesToFull <= 0 || minutesToFull > 60 * 24 * 7) return null;
  return { etaMin: Math.round(minutesToFull), ratePerHour: Math.round(slope * 60 * 10) / 10 };
}

module.exports = { record, project };
