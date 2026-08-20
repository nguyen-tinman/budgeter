@echo off
setlocal EnableExtensions
REM ==========================================================================
REM  BudgetKit launcher (Windows).
REM  Starts the API (http://127.0.0.1:3000) + web UI (http://localhost:5173)
REM  dev servers. Portable: runs from this script's own folder, so it works
REM  wherever the repo lives -- no hardcoded paths.
REM
REM  Pair: linux_start.sh is the same launcher for Linux (and macOS).
REM
REM  What it does:
REM    1. verifies pnpm is on PATH
REM    2. installs dependencies on first run (if node_modules is missing)
REM    3. builds the shared libs (@budgetkit/core, @budgetkit/db) -- the apps
REM       import these from their compiled dist/, so they must be built
REM    4. starts both dev servers via "pnpm dev" (tsx for API, Vite for web)
REM    5. opens the browser once the web UI answers (polls until ready)
REM    6. keeps the window open on exit so errors stay readable
REM
REM  Note: the in-app Assistant (chat) additionally needs the local LLM, which
REM  is set up / started from the Setup page in the UI -- it is NOT required to
REM  use the budgeting features.
REM ==========================================================================

cd /d "%~dp0"

where pnpm >nul 2>nul
if errorlevel 1 (
  echo [BudgetKit] pnpm was not found on PATH.
  echo [BudgetKit] Install Node 24+ then run:  npm install -g pnpm
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  REM NOTE: inside a parenthesized block, a bare ) in echo text closes the
  REM block early ("... was unexpected at this time."), so escape with ^.
  echo [BudgetKit] First run - installing dependencies ^(this can take a minute^)...
  call pnpm install
  if errorlevel 1 ( echo [BudgetKit] pnpm install failed. & pause & exit /b 1 )
)

echo [BudgetKit] Building shared packages (core, db)...
call pnpm --filter @budgetkit/core build
if errorlevel 1 ( echo [BudgetKit] core build failed. & pause & exit /b 1 )
call pnpm --filter @budgetkit/db build
if errorlevel 1 ( echo [BudgetKit] db build failed. & pause & exit /b 1 )

echo.
echo [BudgetKit] Starting servers:
echo [BudgetKit]   API : http://127.0.0.1:3000
echo [BudgetKit]   Web : http://localhost:5173
echo [BudgetKit] The browser will open once the web server answers. Press Ctrl+C to stop.
echo.

REM Open the browser once the web server answers (poll-until-ready, parallel).
REM Tries for up to 90 s (1 attempt/s), then gives up silently.
start "" /b powershell -NoProfile -Command "for($i=0;$i -lt 90;$i++){try{$null=Invoke-WebRequest 'http://localhost:5173' -UseBasicParsing -TimeoutSec 2;Start-Process 'http://localhost:5173';break}catch{Start-Sleep -Seconds 1}}"

REM Foreground: runs API + web concurrently; Ctrl+C stops both.
call pnpm dev

REM Keep the window open so errors stay readable if the servers exit unexpectedly.
echo.
echo [BudgetKit] Dev servers stopped.
pause

endlocal
