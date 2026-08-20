#!/usr/bin/env bash
# ==========================================================================
#  BudgetKit launcher (Linux; also works on macOS). Mirrors windows_start.bat.
#  Starts the API (http://127.0.0.1:3000) + web UI (http://localhost:5173)
#  dev servers. Portable: runs from this script's own folder, so it works
#  wherever the repo lives -- no hardcoded paths.
#
#  What it does:
#    1. verifies pnpm is on PATH
#    2. installs dependencies on first run (if node_modules is missing)
#    3. builds the shared libs (@budgetkit/core, @budgetkit/db) -- the apps
#       import these from their compiled dist/, so they must be built
#    4. starts both dev servers via "pnpm dev" (tsx for API, Vite for web)
#    5. opens the browser once the web UI answers (polls until ready)
#
#  Note: the in-app Assistant (chat) additionally needs the local LLM, which
#  is set up / started from the Setup page in the UI -- it is NOT required to
#  use the budgeting features.
# ==========================================================================
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "[BudgetKit] pnpm was not found on PATH."
  echo "[BudgetKit] Install Node 24+ then run:  npm install -g pnpm"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "[BudgetKit] First run - installing dependencies (this can take a minute)..."
  pnpm install
fi

echo "[BudgetKit] Building shared packages (core, db)..."
pnpm --filter @budgetkit/core build
pnpm --filter @budgetkit/db build

echo
echo "[BudgetKit] Starting servers:"
echo "[BudgetKit]   API : http://127.0.0.1:3000"
echo "[BudgetKit]   Web : http://localhost:5173"
echo "[BudgetKit] The browser will open once the web server answers. Press Ctrl+C to stop."
echo

# Open the browser once the web server answers (poll-until-ready, backgrounded).
# Tries for up to 90 s (1 attempt/s), then gives up silently.
(
  for _ in $(seq 1 90); do
    if curl -sf -o /dev/null http://localhost:5173 2>/dev/null; then
      if command -v open >/dev/null 2>&1; then open http://localhost:5173
      elif command -v xdg-open >/dev/null 2>&1; then xdg-open http://localhost:5173
      fi
      break
    fi
    sleep 1
  done
) &

# Foreground: runs API + web concurrently; Ctrl+C stops both.
pnpm dev
