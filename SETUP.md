# Setup Guide

AI Mission Control runs anywhere Node.js runs — **Windows, macOS, and Linux**. It is pure Node with **zero npm dependencies**, so there is nothing to compile and nothing to `npm install`. This guide covers every OS and how to connect each AI so it gets tracked.

---

## 1. Install Node.js 18+ (one-time)

The dashboard needs Node 18 or newer (it uses the built-in `fetch`).

| OS | How |
|---|---|
| **Windows** | Download the LTS installer from [nodejs.org](https://nodejs.org), or `winget install OpenJS.NodeJS.LTS`. |
| **macOS** | `brew install node`, or the installer from [nodejs.org](https://nodejs.org). |
| **Linux** | `sudo apt install nodejs` (Debian/Ubuntu) / `sudo dnf install nodejs` (Fedora), or [nvm](https://github.com/nvm-sh/nvm): `nvm install --lts`. |

Verify: `node -v` should print `v18.x` or higher.

---

## 2. Get the code

```bash
git clone https://github.com/jirolao/ai-mission-control.git
cd ai-mission-control
```

(No build step. No `npm install`.)

---

## 3. Run it

| OS | Start command | Or double-click |
|---|---|---|
| **Windows** | `node server.js` | `Open Mission Control.vbs` |
| **macOS** | `node server.js --open` | `start-macos.command` |
| **Linux** | `node server.js --open` | `./start.sh` (after `chmod +x start.sh`) |

Then open **http://127.0.0.1:5599** (the `--open` flag / the launchers do this for you).

`--open` opens your default browser. Running a second instance is harmless — it detects the port is in use and exits.

---

## 4. Connect your AIs

The dashboard reads each tool's **local** session logs and credentials — nothing is sent anywhere except, for Claude, the usage check to `api.anthropic.com`. A lane stays in "offline / sign-in" state until its tool is installed and used at least once.

### Claude Code
1. Install: `npm install -g @anthropic-ai/claude-code` (see [docs](https://docs.claude.com/en/docs/claude-code)).
2. Log in: run `claude`, then `/login` and follow the browser flow.
3. That's it. Mission Control reads `~/.claude/.credentials.json` (locally) to show your **exact** 5-hour and weekly limits, and reads `~/.claude/projects/**` for live session detail. It never refreshes or rotates the token, so your Claude Code login is never affected.

### Codex (uses your ChatGPT plan)
1. Install: `npm install -g @openai/codex` (see OpenAI's docs).
2. Log in with your ChatGPT account when prompted.
3. Mission Control reads `~/.codex/sessions/**` — Codex logs its own exact rate limits there, which *are* your ChatGPT-plan limits. (The ChatGPT web app shares this plan but exposes no separate local data, so there is intentionally no separate "ChatGPT" lane.)

### Gemini CLI (free Google Code Assist tier)
1. Install: `npm install -g @google/gemini-cli`.
2. Sign in with Google. The simplest way:
   ```bash
   # set the Google Code Assist auth method, then run once:
   GOOGLE_GENAI_USE_GCA=true GEMINI_CLI_TRUST_WORKSPACE=true gemini --skip-trust -p "hello"
   ```
   Answer **Y** to "Opening authentication page in your browser", complete the Google login, and approve. (Or just run `gemini` interactively and pick **Login with Google**.)
3. Mission Control reads `~/.gemini/**` and shows daily / per-minute request gauges against the published free-tier limits (1000/day, 60/min). If you use an API key instead of the Google account, set `GEMINI_API_KEY` — usage is then metered by Google, not shown here.

> You only need the AIs you actually use. Any lane whose tool isn't installed simply shows "offline" and the rest keep working.

---

## 5. Start automatically at login (optional)

### Windows
Put a **shortcut** to `Open Mission Control.vbs` in your Startup folder:
1. Press `Win+R`, type `shell:startup`, Enter.
2. Right-drag `Open Mission Control.vbs` into that folder → **Create shortcuts here**.

(Using a shortcut — not a copy — keeps the launcher's own-folder path resolution working.)

### macOS (LaunchAgent)
Create `~/Library/LaunchAgents/com.mission.control.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.mission.control</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/ABSOLUTE/PATH/TO/ai-mission-control/server.js</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict></plist>
```
Then `launchctl load ~/Library/LaunchAgents/com.mission.control.plist`. (Adjust the node path — `which node`.)

### Linux (systemd user service)
Create `~/.config/systemd/user/mission-control.service`:
```ini
[Unit]
Description=AI Mission Control
[Service]
ExecStart=/usr/bin/node /ABSOLUTE/PATH/TO/ai-mission-control/server.js
Restart=on-failure
[Install]
WantedBy=default.target
```
Then `systemctl --user enable --now mission-control`. (Adjust the node path — `which node`.)

---

## 6. Chrome "app window" (optional, any OS)

For a clean window with no browser tabs/address bar:
```bash
# Windows
start chrome --app=http://127.0.0.1:5599
# macOS
open -a "Google Chrome" --args --app=http://127.0.0.1:5599
# Linux
google-chrome --app=http://127.0.0.1:5599
```

---

## 7. Troubleshooting

- **Claude gauge says "rate-limited (backing off)"** — the usage endpoint throttles if hit too often (e.g., many quick restarts). It backs off automatically and recovers; just leave it running. Normal use polls once every 90 s.
- **Claude gauge says "token refreshing"** — open Claude Code once; it refreshes the on-disk token and the gauge recovers within ~90 s.
- **A lane shows "offline"** — that tool isn't installed or hasn't been run yet. Use it once.
- **GPU / battery / temperature missing** — these are best-effort per platform: GPU needs `nvidia-smi` (NVIDIA only); CPU temperature and battery aren't exposed on every machine. The rest of the dashboard is unaffected.
- **Port 5599 in use** — change `PORT` at the top of `server.js`.
- **3D feels heavy on an old GPU** — it already caps frame rate, lowers it under load, and pauses when the tab is hidden. For a static HUD, your browser's reduced-motion setting disables the animation entirely.

---

## Privacy

Everything is local. Session cards show **project names only** — never your prompts, file names, or folders (stripped server-side). The only outbound request is Claude's usage check to `api.anthropic.com`, sent with the token Claude Code already stored on your machine.
