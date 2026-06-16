# BudgetKit

A local-first personal finance app. All data stays on your machine — no cloud sync, no
account, no API keys. Track income, expenses, and savings; import bank statements; project
retirement; and (optionally) chat with a fully-offline AI assistant.

## What it is

- **SvelteKit web app** (Svelte 5 runes, editorial design system) at `localhost:5173`
- **Hono API** backed by `node:sqlite` (requires Node 24 LTS) at `127.0.0.1:3000`
- **Statement import** for Chase PDF and Amex XLSX/CSV — drop files in `statements/`
- **Local llama.cpp assistant** — *optional* AI chat that runs entirely offline; download
  the model from inside the app (the budgeting features work without it)
- **MCP server** (`apps/mcp`) exposing BudgetKit's tools to Claude Desktop or any
  MCP-compatible client

## Prerequisites

- **Node 24+** — `node:sqlite` and the dev tooling require it; older versions won't start
- **pnpm 10+** — `npm install -g pnpm`
- Windows 10/11 or macOS (Linux untested but should work)

## Quick start

### Launcher script

```bash
# Windows
run.bat

# macOS / Linux
bash run.sh
```

The script installs dependencies on first run, builds the shared packages, starts the API
and web dev servers, and opens your browser when the UI is ready.

### Manual start (any OS)

```bash
pnpm install
pnpm --filter @budgetkit/core build   # apps import core/db from their compiled dist/
pnpm --filter @budgetkit/db build
pnpm dev                               # starts API (127.0.0.1:3000) + web (localhost:5173)
```

Then open <http://localhost:5173>. The SQLite database and its schema are created
automatically on first run — there is nothing to migrate by hand.

## URLs

| Service | Address |
|---------|---------|
| Web UI | `http://localhost:5173` |
| API | `http://127.0.0.1:3000` |
| Health check | `http://127.0.0.1:3000/api/health` |

## The AI assistant (optional)

The in-app assistant talks to a local [llama.cpp](https://github.com/ggml-org/llama.cpp)
server running a small Qwen model — nothing is sent to the cloud. It is **not required** to
use BudgetKit. To enable it, open the **Setup** page in the app and use the one-click
download to fetch the llama.cpp binary and a model (≈1.3–3 GB). Until then, the chat panel
simply reports that the assistant is offline and every other feature works normally.

## Configuration (optional)

Everything has a sensible default; no `.env` file is needed. Override via environment
variables if you want to:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | API server port |
| `HOST` | `127.0.0.1` | API bind address (loopback only by default) |
| `LLAMA_SERVER_URL` | `http://127.0.0.1:8090` | Point the assistant at an existing OpenAI-compatible LLM server instead of the bundled launcher |
| `LLAMA_SERVER_BIN` | auto-discovered | Path to a `llama-server` binary to use instead of the one the Setup page downloads |
| `BUDGETKIT_DB` | `data/budgetkit.db` | SQLite database file location |

## Data & privacy

`statements/` and `data/` are git-ignored. Your bank statements and the SQLite database
(`data/budgetkit.db`) never leave your machine and are never committed. The only outbound
network calls are optional and user-initiated: downloading the assistant model from
Hugging Face, and fetching public IRS/FTB tax brackets when you ask the app to update its
tax tables.

## Project layout

```
apps/
  web/        SvelteKit UI (Dashboard, Budget, Import, Planning, Trends, Setup, Options)
  api/        Hono REST API, SQLite, chat + tool-calling, llama.cpp lifecycle
  mcp/        MCP server exposing BudgetKit tools to MCP clients
packages/
  core/       Domain logic — tax math, retirement projection, statement parsing, tools
  db/         SQLite schema, migrations, repositories
```

## Running tests

```bash
pnpm --filter @budgetkit/core test     # core math + parsing
pnpm --filter @budgetkit/api test      # API + tool integration
pnpm --filter @budgetkit/mcp test      # MCP protocol
pnpm -r test                           # full suite (500+ tests)
pnpm -r typecheck                      # type-check every package (0 errors expected)
```

## Database export / import

```bash
# Export a versioned bundle (db + manifest sidecar)
pnpm --filter @budgetkit/api exec tsx src/db/scripts/db-export.ts

# Import a bundle (auto-backs up the current DB first)
pnpm --filter @budgetkit/api exec tsx src/db/scripts/db-import.ts ./data/exports/budgetkit-export-<ts>.db
```

The **Setup** page also exposes a graphical Backup & Restore panel.
