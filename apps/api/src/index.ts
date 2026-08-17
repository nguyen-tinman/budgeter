import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_VERSION, backfillOneTimeSpendDates } from "@budgetkit/core";
import { openDb, migrate, buildToolCtx } from "@budgetkit/db";
import { toolsRouter } from "./routes/tools.js";
import { chatRouter } from "./routes/chat.js";
import { llamaRouter, autoStartLlama, killSharedLlamaSync } from "./routes/llama.js";
import { undoRouter } from "./routes/undo.js";
import { customPageStatusRouter } from "./routes/custom_page_status.js";

/** Anchor cwd to the project root before any tool handler runs. Some tools
 *  (list_statements, catalogue_expenses) resolve paths via
 *  `pathMod.resolve("statements")` which is cwd-relative. In dev,
 *  `pnpm --filter @budgetkit/api dev` runs with cwd = apps/api/ and those
 *  tools fail to find the statement fixtures at <root>/statements/. Walk up
 *  from this source file's directory until we find package.json with the
 *  monorepo root marker, then chdir there. Idempotent if already correct. */
function chdirToProjectRoot(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  // From apps/api/src or dist, walk up looking for the monorepo root marker:
  // `pnpm-workspace.yaml`, which exists only at the repo root. (We key on the
  // workspace file alone — not the optional `statements/` dir — so a fresh
  // clone with no statements yet still anchors cwd to the root; the user can
  // then drop files into <root>/statements/ and have the tools find them.)
  let dir = here;
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) {
      if (process.cwd() !== dir) process.chdir(dir);
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Couldn't find the root — fall back to whatever cwd was set by the caller.
  // Tools that need ./statements will fail visibly; the API still runs.
}
chdirToProjectRoot();

const app = new Hono();

// Run migrations on startup so a fresh install Just Works.
const db = openDb();
migrate(db);

// Recover real spend dates for one-time expenses catalogued before the
// spend_date column existed, by matching them back to the originating statement
// transaction. This keeps the Trends chart placing one-offs in the month they
// were actually spent rather than the import date. Idempotent — only fills NULL
// one-time spend_dates, so steady-state boots are a no-op.
try {
  const bf = backfillOneTimeSpendDates(buildToolCtx(db, "api_direct"));
  if (bf.scanned > 0) {
    console.log(
      `[budgetkit-api] spend_date backfill: matched ${bf.matched}/${bf.scanned} one-time expenses from statements`,
    );
    // Audit trail for the live-DB writes this pass made. Log expense IDs only —
    // merchant labels are PII and must not appear at info level.
    if (bf.changed.length > 0) {
      console.log(
        `[budgetkit-api] spend_date backfill updated expense ids: ${bf.changed.map((c) => c.id).join(", ")}`,
      );
    }
  }
} catch (e) {
  console.warn(`[budgetkit-api] spend_date backfill skipped: ${(e as Error).message}`);
}

/** Hard cap on POST body size, in bytes. Sized against the chat context
 *  window: at a 128k token window the compaction threshold sits near ~119k
 *  tokens ≈ ~420 KB of message content, so the body cap must exceed that or a
 *  request could never fill the window (and auto-compaction could never fire —
 *  the cap would reject the turn first). 512 KB clears that with headroom for
 *  JSON overhead, while staying bounded enough that a runaway client or
 *  accidental paste-of-a-PDF can't blow up memory or burn an LLM round-trip on
 *  garbage. Surfaced as `payload_too_large` to distinguish from real LLM
 *  failures (which return `llm_unreachable`). Revisit alongside chat.ts
 *  CONTEXT_BUDGET_TOKENS if the window changes again. */
const REQUEST_BODY_LIMIT_BYTES = 512 * 1024;

const apiBodyLimit = bodyLimit({
  maxSize: REQUEST_BODY_LIMIT_BYTES,
  onError: (c) =>
    c.json(
      {
        ok: false,
        error: "payload_too_large",
        message: `Request body exceeds ${REQUEST_BODY_LIMIT_BYTES} bytes. Use /clear and try again with a shorter message.`,
        limitBytes: REQUEST_BODY_LIMIT_BYTES,
      },
      413,
    ),
});

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    app: "budgetkit-api",
    schemaVersion: SCHEMA_VERSION,
  }),
);

// Apply body limit on the write paths (tools + chat + llama). Reads (GET) are
// unaffected. llama lifecycle endpoints take tiny JSON payloads, but an
// uncapped POST route is still a local memory-DoS vector (Codex F-1), so they
// share the same cap.
app.use("/api/tools/*", apiBodyLimit);
app.use("/api/chat/*", apiBodyLimit);
app.use("/api/chat", apiBodyLimit);
app.use("/api/llama/*", apiBodyLimit);
app.use("/api/undo", apiBodyLimit);
app.use("/api/custom-page/*", apiBodyLimit);

app.route("/api/tools", toolsRouter());
app.route("/api/chat", chatRouter());
app.route("/api/llama", llamaRouter());
app.route("/api/undo", undoRouter());
app.route("/api/custom-page/status", customPageStatusRouter());

const port = Number(process.env.PORT ?? 3000);
// Bind to loopback only. This is a local-first single-user app — there's no
// reason to expose the API on the LAN. Combined with route-level URL/path
// hardening, this keeps the SSRF/arbitrary-write attack surface limited to
// processes already on this machine.
const hostname = process.env.HOST ?? "127.0.0.1";
const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`[budgetkit-api] listening on http://${hostname}:${info.port}`);

  // Auto-launch the local inference server with the selected/default model
  // (sticky last-used, else the largest GGUF present). Fire-and-forget +
  // fully non-fatal: a missing model, missing binary, or launch failure logs
  // a warning and leaves the API running. We start it AFTER the listener is
  // up so a slow model load never delays serving HTTP. Skipped automatically
  // when no GGUF is downloaded (fresh install) or LLAMA_SERVER_URL is set.
  void autoStartLlama()
    .then((r) => {
      // eslint-disable-next-line no-console
      if (r.started) console.log(`[budgetkit-api] auto-started llama-server (model=${r.model})`);
      else console.warn(`[budgetkit-api] llama-server not auto-started: ${r.reason}`);
    })
    .catch((err) => {
      // autoStartLlama already swallows its own errors; this is belt-and-
      // suspenders so an unexpected rejection can't crash the process.
      // eslint-disable-next-line no-console
      console.warn(`[budgetkit-api] auto-start error (non-fatal): ${(err as Error).message}`);
    });
});

// ---------------------------------------------------------------------------
// Server lifecycle / child-process hygiene (C3).
//
// The API spawns llama-server (multi-GB VRAM) as a child. Without these
// handlers, a Ctrl+C'd or crashed API orphans that child — it keeps VRAM
// pinned until the user hunts the PID down. Every shutdown path below calls
// killSharedLlamaSync(), which synchronously SIGKILLs ONLY the exact child
// the launcher spawned (llama-server holds no durable state, so a hard kill
// loses nothing), and closes the Hono server so in-flight sockets are
// released.
//
// Windows note: signal delivery is limited — SIGINT arrives only from a real
// console Ctrl+C, and SIGTERM is generally not deliverable to a running
// process (TerminateProcess bypasses handlers entirely). The 'exit' handler
// is the synchronous catch-all that also covers process.exit() from anywhere
// in the codebase; 'beforeExit' covers the drained-event-loop case. A hard
// TerminateProcess/SIGKILL of the API itself cannot run ANY handler — that
// residual orphan risk is unavoidable on any platform.
// ---------------------------------------------------------------------------
let shuttingDown = false;
function shutdown(reason: string, exitCode: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  // eslint-disable-next-line no-console
  console.log(`[budgetkit-api] ${reason} — shutting down (releasing llama-server child + HTTP listener)`);
  try {
    killSharedLlamaSync();
  } catch {
    /* never block shutdown */
  }
  try {
    server.close();
  } catch {
    /* listener may not have bound yet */
  }
  process.exit(exitCode);
}
process.on("SIGINT", () => shutdown("SIGINT", 0));
process.on("SIGTERM", () => shutdown("SIGTERM", 0));
process.on("uncaughtException", (err) => {
  // Preserve crash semantics (exit code 1 + stack on stderr) — we only
  // interpose to reap the child first.
  // eslint-disable-next-line no-console
  console.error("[budgetkit-api] uncaughtException:", err);
  shutdown("uncaughtException", 1);
});
process.on("beforeExit", () => shutdown("beforeExit", 0));
process.on("exit", () => {
  // Synchronous catch-all: runs on process.exit() from any path (including
  // the shutdown() above — killNow() is idempotent). Async work is
  // impossible here; killSharedLlamaSync is fully synchronous by design.
  try {
    killSharedLlamaSync();
  } catch {
    /* nothing left to do */
  }
});
