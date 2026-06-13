/**
 * Cross-platform system telemetry: CPU (total + per-core), RAM, disk I/O,
 * network I/O, GPU, battery, temperature, and AI-related processes.
 *
 * Design:
 *  - CPU + RAM come from Node's `os` module on every platform (free, exact).
 *  - A lightweight one-shot "extras" probe gathers disk/net/gpu/battery/temp/
 *    processes, dispatched by platform:
 *      win32  -> a ~0.3 s PowerShell one-shot (raw Win32_PerfRawData_* counters)
 *      linux  -> pure /proc + /sys file reads (no process spawn)
 *      darwin -> ps / netstat / pmset
 *  - Every probe returns the SAME normalized shape (cumulative byte/ms counters);
 *    Node keeps the previous sample and computes all rates against the wall
 *    clock, so the math is identical across platforms.
 *  - Anything a platform can't supply is reported null and simply hidden in the
 *    UI — never a crash. No resident helper process on any OS.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");

const SAMPLE_MS = 4000;
const PLATFORM = process.platform;
const CORES = os.cpus().length;
const PROC_RE = /^(node|claude|codex|chrome|gemini|powershell|pwsh|python)/i;
const CLK_TCK = 100; // Linux USER_HZ (standard); jiffies -> ms = *1000/CLK_TCK

const state = {
  available: false,
  platform: PLATFORM,
  sampledAt: null,
  cpu: { totalPct: null, perCore: [] },
  mem: { usedBytes: null, totalBytes: os.totalmem() },
  disk: { readBps: null, writeBps: null, busyPct: null },
  net: { upBps: null, downBps: null },
  gpu: null,
  battery: null,
  cpuTempC: null,
  cpuHistory: [],
  processes: [],
  pressure: { cpuHot: false, memHot: false, diskHot: false, gpuHot: false, thermalHot: false, slowdownLikely: false },
};

const HOT = { cpu: [90, 78], mem: [90, 82], disk: [92, 75], gpu: [97, 85], thermal: [90, 80] };
const hotStreak = { cpu: 0, mem: 0, disk: 0, gpu: 0, thermal: 0 };

function updatePressure() {
  const memPct = state.mem.totalBytes ? (state.mem.usedBytes / state.mem.totalBytes) * 100 : 0;
  const temp = Math.max(state.cpuTempC ?? 0, state.gpu?.tempC ?? 0);
  const readings = { cpu: state.cpu.totalPct ?? 0, mem: memPct, disk: state.disk.busyPct ?? 0, gpu: state.gpu ? state.gpu.utilPct : 0, thermal: temp };
  for (const key of Object.keys(readings)) {
    const [high, low] = HOT[key];
    if (readings[key] >= high) hotStreak[key] += 1;
    else if (readings[key] < low) hotStreak[key] = 0;
    state.pressure[`${key}Hot`] = hotStreak[key] >= 2 || (state.pressure[`${key}Hot`] && readings[key] >= low);
  }
  state.pressure.slowdownLikely = state.pressure.cpuHot || state.pressure.memHot || state.pressure.diskHot || state.pressure.thermalHot;
}

let prevRaw = null;
let prevSampleAt = null;
let prevCores = null;

function cookCpu() {
  const cores = os.cpus();
  const perCore = [];
  let totalBusy = 0, totalAll = 0;
  if (prevCores && prevCores.length === cores.length) {
    for (let i = 0; i < cores.length; i++) {
      const now = cores[i].times, was = prevCores[i].times;
      const idle = now.idle - was.idle;
      const all = (now.user - was.user) + (now.nice - was.nice) + (now.sys - was.sys) + (now.irq - was.irq) + idle;
      const pct = all > 0 ? Math.round(((all - idle) / all) * 100) : 0;
      perCore.push(Math.max(0, Math.min(100, pct)));
      totalBusy += all - idle; totalAll += all;
    }
  }
  prevCores = cores;
  const totalPct = totalAll > 0 ? Math.max(0, Math.min(100, Math.round((totalBusy / totalAll) * 100))) : null;
  state.cpu = { totalPct, perCore };
  if (totalPct != null) {
    state.cpuHistory.push(totalPct);
    if (state.cpuHistory.length > 60) state.cpuHistory.shift();
  }
  state.mem = { usedBytes: os.totalmem() - os.freemem(), totalBytes: os.totalmem() };
}

/** Unified delta math. `raw` shape (all cumulative):
 *  disk:{r,w,busyMs} net:{rx,tx} proc:[{n,pid,cpuCumMs?|cpuPct?,rss}] gpu:string bat:{pct,charging,onAC} cputemp:°C */
function cookSample(raw) {
  const now = Date.now();
  cookCpu();
  const elapsedMs = prevSampleAt ? now - prevSampleAt : 0;
  const elapsedSec = elapsedMs / 1000;

  if (raw.disk && prevRaw && prevRaw.disk && elapsedSec > 0) {
    const d = raw.disk, p = prevRaw.disk;
    state.disk = {
      readBps: Math.max(0, Math.round((d.r - p.r) / elapsedSec)),
      writeBps: Math.max(0, Math.round((d.w - p.w) / elapsedSec)),
      busyPct: d.busyMs != null && p.busyMs != null ? Math.max(0, Math.min(100, Math.round(((d.busyMs - p.busyMs) / elapsedMs) * 100))) : null,
    };
  }

  if (raw.net && prevRaw && prevRaw.net && elapsedSec > 0) {
    state.net = {
      downBps: Math.max(0, Math.round((raw.net.rx - prevRaw.net.rx) / elapsedSec)),
      upBps: Math.max(0, Math.round((raw.net.tx - prevRaw.net.tx) / elapsedSec)),
    };
  }

  if (Array.isArray(raw.proc)) {
    const prevByPid = new Map();
    if (prevRaw && Array.isArray(prevRaw.proc)) for (const p of prevRaw.proc) prevByPid.set(p.pid, p);
    const processes = [];
    for (const p of raw.proc) {
      let cpuPct = p.cpuPct ?? null;
      if (cpuPct == null && p.cpuCumMs != null && elapsedMs > 0) {
        const was = prevByPid.get(p.pid);
        if (was && was.cpuCumMs != null) cpuPct = Math.max(0, Math.min(100, Math.round(((p.cpuCumMs - was.cpuCumMs) / elapsedMs) * 100 / CORES * 10) / 10));
      }
      processes.push({ name: p.n, pid: p.pid, cpuPct, wsBytes: p.rss, cpuCumMs: p.cpuCumMs });
    }
    processes.sort((a, b) => (b.cpuPct ?? -1) - (a.cpuPct ?? -1) || (b.wsBytes || 0) - (a.wsBytes || 0));
    state.processes = processes.slice(0, 14);
  }

  if (typeof raw.gpu === "string" && raw.gpu.includes(",")) {
    const [name, util, memUsed, memTotal, temp, power] = raw.gpu.split(",").map((s) => s.trim());
    if (name && memTotal) state.gpu = {
      name, utilPct: Number(util), memUsedMB: Number(memUsed), memTotalMB: Number(memTotal),
      tempC: temp && temp !== "[N/A]" ? Number(temp) : null,
      powerW: power && power !== "[N/A]" ? Math.round(Number(power)) : null,
    };
  } else if (raw.gpu === null) state.gpu = null;

  if (raw.bat && typeof raw.bat.pct === "number") state.battery = { pct: raw.bat.pct, charging: !!raw.bat.charging, onAC: !!raw.bat.onAC };
  state.cpuTempC = typeof raw.cputemp === "number" && raw.cputemp > 0 && raw.cputemp < 120 ? raw.cputemp : null;

  prevRaw = raw;
  prevSampleAt = now;
  state.sampledAt = now;
  state.available = true;
  updatePressure();
}

// ---------------------------------------------------------------------------
// Windows probe — one-shot PowerShell, raw perf counters (locale-independent)
// ---------------------------------------------------------------------------
const PS_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
$o=@{}
$d=Get-CimInstance Win32_PerfRawData_PerfDisk_PhysicalDisk -Filter "Name='_Total'"|Select-Object DiskReadBytesPersec,DiskWriteBytesPersec,PercentDiskTime
if($d){$o.disk=@{r=[double]$d.DiskReadBytesPersec;w=[double]$d.DiskWriteBytesPersec;busyMs=[double]$d.PercentDiskTime/10000}}
$ni=Get-CimInstance Win32_PerfRawData_Tcpip_NetworkInterface
if($ni){$o.net=@{rx=[double](($ni|Measure-Object BytesReceivedPersec -Sum).Sum);tx=[double](($ni|Measure-Object BytesSentPersec -Sum).Sum)}}
$pr=Get-CimInstance Win32_PerfRawData_PerfProc_Process|Where-Object{$_.Name -match '^(node|claude|codex|chrome|gemini|powershell|pwsh|python)'}|Select-Object Name,IDProcess,PercentProcessorTime,WorkingSetPrivate
if($pr){$o.proc=@($pr|ForEach-Object{@{n=$_.Name;pid=[long]$_.IDProcess;cpuCumMs=[double]$_.PercentProcessorTime/10000;rss=[long]$_.WorkingSetPrivate}})}
$g=& nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>$null
if($g){$o.gpu=[string]($g|Select-Object -First 1)}
$b=Get-CimInstance Win32_Battery|Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus
if($b){$o.bat=@{pct=[int]$b.EstimatedChargeRemaining;charging=($b.BatteryStatus -ne 1);onAC=($b.BatteryStatus -eq 2)}}
$tz=Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue|Select-Object -First 1
if($tz){$o.cputemp=[math]::Round(($tz.CurrentTemperature/10)-273.15,0)}
$o|ConvertTo-Json -Compress -Depth 5
`;
const PS_ENCODED = Buffer.from(PS_SCRIPT, "utf16le").toString("base64");

function winProbe(cb) {
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", PS_ENCODED], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  let buf = "";
  child.stdout.on("data", (c) => (buf += c));
  child.on("close", () => { try { cb(JSON.parse(buf.trim())); } catch { cb(null); } });
  child.on("error", () => cb(null));
}

// ---------------------------------------------------------------------------
// Linux probe — pure /proc + /sys reads (no spawn), nvidia-smi only if present
// ---------------------------------------------------------------------------
let nvidiaChecked = false, hasNvidia = false;
function readFileSafe(p) { try { return fs.readFileSync(p, "utf8"); } catch { return null; } }

function linuxProbe(cb) {
  const raw = {};
  // network: /proc/net/dev (skip lo)
  const netdev = readFileSafe("/proc/net/dev");
  if (netdev) {
    let rx = 0, tx = 0;
    for (const line of netdev.split("\n")) {
      const m = line.match(/^\s*([^:]+):\s+(.*)$/);
      if (!m || m[1].trim() === "lo") continue;
      const f = m[2].trim().split(/\s+/);
      rx += Number(f[0]) || 0; tx += Number(f[8]) || 0;
    }
    raw.net = { rx, tx };
  }
  // disk: /proc/diskstats (sum physical devices; busy = max io_ticks ms)
  const diskstats = readFileSafe("/proc/diskstats");
  if (diskstats) {
    let r = 0, w = 0, busyMs = 0;
    for (const line of diskstats.split("\n")) {
      const f = line.trim().split(/\s+/);
      if (f.length < 14) continue;
      const name = f[2];
      if (/^(loop|ram|sr|fd|dm-)/.test(name)) continue; // virtual devices
      if (/[a-z]\d+$/.test(name) && !/nvme\d+n\d+$/.test(name)) continue; // partitions (sda1), keep whole disks
      r += (Number(f[5]) || 0) * 512;
      w += (Number(f[9]) || 0) * 512;
      busyMs = Math.max(busyMs, Number(f[12]) || 0);
    }
    raw.disk = { r, w, busyMs };
  }
  // battery
  for (const bat of ["BAT0", "BAT1"]) {
    const cap = readFileSafe(`/sys/class/power_supply/${bat}/capacity`);
    if (cap != null) {
      const st = (readFileSafe(`/sys/class/power_supply/${bat}/status`) || "").trim();
      raw.bat = { pct: parseInt(cap, 10), charging: st !== "Discharging", onAC: st === "Charging" || st === "Full" };
      break;
    }
  }
  // cpu temp: hottest plausible thermal zone (milli-°C)
  let temp = null;
  for (let i = 0; i < 16; i++) {
    const t = readFileSafe(`/sys/class/thermal/thermal_zone${i}/temp`);
    if (t == null) continue;
    const c = Number(t) / 1000;
    if (c > 0 && c < 120) temp = Math.max(temp ?? 0, c);
  }
  if (temp != null) raw.cputemp = Math.round(temp);
  // processes: scan /proc for matching comm
  try {
    const pids = fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n));
    const proc = [];
    for (const pid of pids) {
      const comm = readFileSafe(`/proc/${pid}/comm`);
      if (!comm || !PROC_RE.test(comm.trim())) continue;
      const stat = readFileSafe(`/proc/${pid}/stat`);
      const status = readFileSafe(`/proc/${pid}/status`);
      if (!stat) continue;
      const parts = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const utime = Number(parts[11]) || 0, stime = Number(parts[12]) || 0;
      const cpuCumMs = (utime + stime) * (1000 / CLK_TCK);
      const rssM = status && status.match(/VmRSS:\s+(\d+)/);
      proc.push({ n: comm.trim(), pid: Number(pid), cpuCumMs, rss: rssM ? Number(rssM[1]) * 1024 : 0 });
    }
    raw.proc = proc;
  } catch {}
  // gpu (nvidia only, best effort)
  if (!nvidiaChecked) { nvidiaChecked = true; try { hasNvidia = require("child_process").spawnSync("which", ["nvidia-smi"]).status === 0; } catch {} }
  if (hasNvidia) {
    const child = spawn("nvidia-smi", ["--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw", "--format=csv,noheader,nounits"], { stdio: ["ignore", "pipe", "ignore"] });
    let g = "";
    child.stdout.on("data", (c) => (g += c));
    child.on("close", () => { raw.gpu = g.trim().split("\n")[0] || null; cb(raw); });
    child.on("error", () => { raw.gpu = null; cb(raw); });
  } else { raw.gpu = null; cb(raw); }
}

// ---------------------------------------------------------------------------
// macOS probe — ps / netstat / pmset (light spawns); GPU/temp degrade to null
// ---------------------------------------------------------------------------
function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("close", () => resolve(out));
    child.on("error", () => resolve(""));
  });
}

async function macProbe(cb) {
  const raw = { gpu: null, cputemp: null };
  try {
    const [ps, netstat, batt] = await Promise.all([
      run("ps", ["-axro", "comm,pid,%cpu,rss"]),
      run("netstat", ["-ib"]),
      run("pmset", ["-g", "batt"]),
    ]);
    // processes (mac ps %cpu is recent CPU; use directly)
    const proc = [];
    for (const line of ps.split("\n").slice(1)) {
      const m = line.trim().match(/^(.*?)\s+(\d+)\s+([\d.]+)\s+(\d+)$/);
      if (!m) continue;
      const name = m[1].split("/").pop();
      if (!PROC_RE.test(name)) continue;
      proc.push({ n: name, pid: Number(m[2]), cpuPct: Math.min(100, Number(m[3])), rss: Number(m[4]) * 1024 });
    }
    raw.proc = proc;
    // network: sum Ibytes/Obytes across en* interfaces (cumulative)
    let rx = 0, tx = 0;
    for (const line of netstat.split("\n")) {
      const f = line.trim().split(/\s+/);
      if (!/^en\d/.test(f[0]) || !line.includes("<Link#")) continue;
      rx += Number(f[6]) || 0; tx += Number(f[9]) || 0;
    }
    if (rx || tx) raw.net = { rx, tx };
    // battery
    const bm = batt.match(/(\d+)%;\s*([a-zA-Z ]+)/);
    if (bm) raw.bat = { pct: Number(bm[1]), charging: /charg/i.test(bm[2]) && !/discharg/i.test(bm[2]), onAC: /AC|charg/i.test(batt) && !/discharg/i.test(bm[2]) };
  } catch {}
  cb(raw);
}

const probe = PLATFORM === "win32" ? winProbe : PLATFORM === "linux" ? linuxProbe : PLATFORM === "darwin" ? macProbe : null;

let timer = null, stopped = false, running = false;
function sampleOnce() {
  if (stopped || running) return;
  if (!probe) { cookCpu(); state.available = true; if (!stopped) timer = setTimeout(sampleOnce, SAMPLE_MS); return; }
  running = true;
  probe((raw) => {
    running = false;
    if (raw) { try { cookSample(raw); } catch {} }
    else cookCpu();
    if (!stopped) timer = setTimeout(sampleOnce, SAMPLE_MS);
  });
}

function start() { if (timer || running) return; stopped = false; sampleOnce(); }
function stop() { stopped = true; if (timer) clearTimeout(timer); }
function getTelemetry() { return state; }

process.on("exit", stop);
process.on("SIGINT", () => { stop(); process.exit(0); });

module.exports = { start, stop, getTelemetry };
