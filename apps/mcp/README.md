# @budgetkit/mcp — BudgetKit MCP server

A hand-rolled **stdio JSON-RPC 2.0** [MCP](https://modelcontextprotocol.io) server
(`src/index.ts`) that exposes the full BudgetKit tool registry
(`packages/core/src/tools.ts` → `ALL_TOOLS`) to external MCP hosts such as
Claude Desktop. It drives the **same** `ToolRegistry` the in-app LLM chat and
the REST surface (`POST /api/tools/:name`) use — one tool, three transports —
and writes the same `tools_call_log` audit rows for every mutation.

Protocol surface: `initialize`, `tools/list`, `tools/call`, `ping`,
`shutdown`, line-delimited JSON over stdin/stdout (one JSON object per line;
stderr is diagnostics only).

## Build & run

The server depends on the workspace packages `@budgetkit/core` and
`@budgetkit/db` (which uses the `node:sqlite` builtin — **Node 23+ required**;
the repo is developed on Node 25).

```sh
# from the repo root
pnpm install
pnpm --filter @budgetkit/core build
pnpm --filter @budgetkit/db build

# Option A — run the TypeScript entry directly (what the tests do):
node --import tsx/esm apps/mcp/src/index.ts

# Option B — build to JS first, then run the dist entry:
pnpm --filter @budgetkit/mcp build
node apps/mcp/dist/index.js
```

On start it opens (and migrates) the BudgetKit SQLite database and prints a
diagnostic line to stderr: `[budgetkit-mcp] ready; N tools registered`.

**Database location**: `BUDGETKIT_DB` env var if set, else
`<repo-root>/data/budgetkit.db` (see `packages/db/src/database.ts`,
`defaultDbConfig`). Point `BUDGETKIT_DB` at a scratch file to experiment
without touching your real budget.

### Registering with Claude Desktop

Add an entry to `claude_desktop_config.json`
(Windows: `%APPDATA%\Claude\claude_desktop_config.json`,
macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "budgetkit": {
      "command": "node",
      "args": [
        "--import", "tsx/esm",
        "C:\\path\\to\\budget\\apps\\mcp\\src\\index.ts"
      ],
      "env": {
        "BUDGETKIT_DB": "C:\\path\\to\\budget\\data\\budgetkit.db"
      }
    }
  }
}
```

Use the `dist/index.js` path instead (no `--import tsx/esm` args) if you ran
the build step. `tsx` is a devDependency of this workspace, so the
`--import tsx/esm` form only works when the repo's `node_modules` are
installed and the server is launched from inside the repo tree.

## Confirm-before-mutation semantics (the mutation gate)

The registry is constructed with `requireMutationConsent: true`: every
**mutating** tool (anything without the `readOnly` flag — `add_*`, `update_*`,
`delete_*`, `set_*`, `create_scenario`, `catalogue_expenses`,
`ignore_statement`, …) refuses to run without explicit confirmation. Over
MCP this surfaces as:

- **`tools/list`** appends a `confirm` boolean property to every mutating
  tool's `inputSchema` and marks it `required`. Read-only tools
  (`list_*`, `get_*`, `compute_*`, `fetch_*`) are unchanged and never gated.
- **`tools/call`** with a mutating tool **must include `"confirm": true` in
  `arguments`**, set only after the user has explicitly approved that exact
  action. The key is stripped before the tool's own schema validation runs —
  the underlying tools never see it.
- A mutating call **without** `confirm: true` (missing or `false`) is
  rejected with a JSON-RPC error, **before any state changes**:

  ```json
  {
    "jsonrpc": "2.0",
    "id": 3,
    "error": {
      "code": -32602,
      "message": "Tool \"add_expense\" modifies budget data and was called without \"confirm\": true. Ask the user to approve this exact action, then retry the call with \"confirm\": true in arguments.",
      "data": { "code": "needs_confirmation", "tool": "add_expense" }
    }
  }
  ```

  Hosts should treat `error.data.code === "needs_confirmation"` as
  "ask the user, then retry with `confirm: true`" — it is a protocol
  condition, not a tool failure (tool failures come back as
  `result.isError: true` content).
- Refused attempts are still recorded in the `tools_call_log` audit table
  (redacted: field presence + safe scalars, never raw labels/amounts), as
  `{ "ok": false, "error": "needs_confirmation" }`.

The same policy gates the REST surface (`POST /api/tools/:name` wants
`"confirm": true` in the body, else HTTP 409) and the in-app chat (its
Approve/Reject UI supplies the consent) — the enforcement lives in
`ToolRegistry.invoke`, so no transport can bypass it.

**Consent semantics (what `confirm: true` is — and is not):** the flag is
*host-mediated consent*, not authentication. The server enforces that the bit
is present, but it cannot prove a human approved the action — any MCP client
on this machine's stdio can set `confirm: true` programmatically. MCP clients
are trusted at the OS/process level (this is a loopback-only, single-user
app); if you connect a host whose tool calls you do not fully control, the
host itself must surface the approval to the user before retrying with
`confirm: true`. Treat a host that auto-confirms as equivalent to giving it
unrestricted write access to the budget.

## Sharing the database with the API (one-writer constraint)

`packages/db/src/database.ts` keeps a **per-process** connection singleton —
it does NOT coordinate across processes. If the BudgetKit API and this MCP
server run at the same time against the same DB file, here is what actually
happens (verified empirically against `node:sqlite` with this package's
pragmas — WAL on, `busy_timeout` left at its default of **0**):

- **Concurrent reads are fine.** WAL mode lets either process read while the
  other writes; readers see a consistent snapshot (a write transaction in
  the other process is invisible until it commits).
- **Overlapping writes fail fast.** If one process holds the write lock
  (any mutation; both the data write and the audit-log row), a write from
  the other process errors **immediately** with `SQLITE_BUSY`:
  `database is locked` (errcode 5). With `busy_timeout = 0` there is no
  retry window — the colliding tool call simply fails and surfaces as a
  tool error to the MCP host. **The database file is not corrupted**; WAL
  preserves integrity, and the failed call can be retried.
- **Startup migration race.** Both processes run `migrate(db)` on startup.
  On an already-migrated DB this is read-mostly and harmless; on a fresh
  file, starting both at the exact same moment can collide on the migration
  writes with the same `database is locked` error. Start one, then the other.

**Practical guidance**: casual simultaneous use works — reads never
conflict, and BudgetKit writes are short single-transaction bursts — but any
mutation that lands while the API is mid-write (or vice versa) fails with
`database is locked` and must be retried. For heavy mutation sessions, run
one writer at a time (stop the API, or point this server at a separate
`BUDGETKIT_DB` — accepting that the two files then diverge).

## Tests

```sh
pnpm --filter @budgetkit/mcp test
```

The tests spawn the real server binary over stdio against a temp database
(`BUDGETKIT_DB` → tmpdir) — the closest thing to "Claude Desktop just
registered this server and called it", including the confirm-gate paths.
