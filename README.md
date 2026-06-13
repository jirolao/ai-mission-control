# AI Mission Control

A local, real-time **mission-control dashboard for your AI coding agents** — Claude Code, Codex (ChatGPT plan), and Gemini CLI — wrapped in a reactive 3D sci-fi interface. See exactly how much of each plan you've used, what every running agent is doing and how close it is to finishing, and whether your machine is about to throttle your work — all on one screen.

Pure Node.js, **zero npm dependencies**, runs on **Windows / macOS / Linux**. Nothing leaves your machine (the only outbound call is Claude's own usage check to Anthropic).

> **Quick start:** install Node 18+, `git clone`, then `node server.js --open`. Full per-OS instructions and how to connect each AI: **[SETUP.md](SETUP.md)**.

## What it shows

**Provider lanes** — one per AI:
- **Claude** — exact 5-hour & weekly limit %, reset countdowns, plan, weekly-Opus split (live from Anthropic's usage API via the token Claude Code already stores locally).
- **Codex · ChatGPT plan** — exact 5-hour & weekly limit % from Codex's own logs (these *are* your ChatGPT-plan limits).
- **Gemini · CLI** — daily & per-minute request gauges against the free Code Assist tier, from local logs.
- Each lane also shows **per-model token allocation** and a **time-to-limit projection** ("≈5h to cap @ +12%/h") from your recent burn rate.

**Active operations** — one card per running session (project name only, never your prompts): live progress bar + ETA, and a stat grid of **elapsed, turns, tool calls, files edited, tokens/min, output, cache-hit %**, plus **reasoning tokens & effort** for Codex. Each Claude **subagent** gets its own mini progress bar.

**System telemetry** — CPU (live sparkline + per-core), RAM, GPU (temp/power/VRAM), disk, network, battery, and an AI-process table. **Overload alerts** flash the relevant bars red and warn you when CPU/RAM/disk/heat will likely slow your agents, or when a usage limit is about to throttle you.

**3D reactor** — a WebGL core that spins and glows with system load, three provider rings that fill with usage, and a token particle stream that quickens with activity. It caps its own frame rate, drops to low-power mode when the machine is hot, and pauses when the tab is hidden.

## Design notes

- **Pure Node, no dependencies.** Transcripts are tailed by byte offset; telemetry is a ~0.3 s one-shot probe per cycle (no resident helper); the browser repaints only what changed. Typical footprint ≈ 64 MB RAM, well under 1% CPU. Three.js is vendored locally (MIT) so it works fully offline.
- **Privacy by omission.** The server never even sends your prompts/filenames to the page — only project names, counts, and percentages.
- **Honest estimates.** Task progress is `elapsed ÷ this machine's median duration for that project`, capped at 95% and labeled an estimate; ETAs and projections are clearly marked as such.
- **Cross-platform telemetry.** CPU/RAM everywhere via Node; disk/net/GPU/battery/temp via a light per-OS probe (PowerShell on Windows, `/proc`+`/sys` on Linux, `ps`/`pmset`/`netstat` on macOS) that degrades gracefully to whatever your machine exposes.

## Install & connect your AIs

See **[SETUP.md](SETUP.md)** for: installing Node per OS, running the app, logging in to Claude Code / Codex / Gemini so each gets tracked, starting at login (Windows shortcut, macOS LaunchAgent, Linux systemd), and troubleshooting.

## Files

| File | Role |
|---|---|
| `server.js` | HTTP server, transcript scanning, `/api/state` |
| `telemetry.js` | Cross-OS system probe + overload pressure |
| `claudeUsage.js` | Claude usage uplink (read-only, no token rotation) |
| `gemini.js` | Gemini CLI lane |
| `history.js` | Per-project median durations (progress engine) |
| `projections.js` | Time-to-limit projections |
| `index.html` | HUD dashboard |
| `scene.js` + `vendor/three.module.min.js` | 3D reactor scene |

## License

MIT — see [LICENSE](LICENSE). Bundles [Three.js](https://threejs.org) (MIT).
