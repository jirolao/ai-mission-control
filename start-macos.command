#!/usr/bin/env bash
# macOS / Linux launcher. Make executable once: chmod +x start.sh
# Starts the server from this folder and opens the dashboard in your browser.
cd "$(dirname "$0")" || exit 1
exec node server.js --open
