// Lightweight append-only log of assistant turn MECHANICS, written to
// data/chat-turns.log as JSONL.
//
// Why this exists: chat is stateless server-side, only MUTATING tool calls are
// audited (read-only ones leave no trace at all), and llama-server keeps just a
// short in-memory stderr tail. When the assistant misbehaves there is therefore
// nothing to inspect afterwards — every diagnosis has to be reproduced live.
// This closes that gap for debugging without touching the audit trail, which
// serves a different purpose (a tamper-relevant record of state changes).
//
// PRIVACY: metadata only. Never log message text, tool arguments, or tool
// results — the same rule auditSummary follows. Tool ERROR strings are
// included (they are our own validation messages and are what makes a failure
// diagnosable) but truncated. If you add a field, ask whether it could carry a
// merchant name or an amount; if it could, don't.
import { appendFileSync, statSync, renameSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

/** Where the log lands.
 *
 *  Two things this has to get right. It is cwd-relative, so the file follows
 *  wherever the API was started from — running from the repo root and running
 *  from apps/ produce different files, which is confusing but harmless.
 *
 *  What is NOT harmless: the test suite runs in apps/api and was therefore
 *  appending its stub-driven turns into the developer's real chat-turns.log,
 *  interleaving fake events (ms:0, fabricated overflow errors) with the record
 *  someone reaches for when diagnosing a live problem. I lost several minutes
 *  to exactly that confusion. Under vitest the log goes to a temp file instead,
 *  and BUDGETKIT_TURN_LOG overrides both. */
const LOG_PATH = process.env.BUDGETKIT_TURN_LOG
  ? resolve(process.env.BUDGETKIT_TURN_LOG)
  : process.env.VITEST
    ? resolve(tmpdir(), "budgetkit-test-chat-turns.log")
    : resolve("data", "chat-turns.log");
/** Rotate at 4 MB, keeping one previous generation. Bounded on purpose: this
 *  is a debugging aid on a single-user machine, not an archive. */
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_CHARS = 300;

export type TurnLogEvent =
  | { ev: "request"; source: "stream" | "blocking"; workspaceId?: number; approved?: number }
  | { ev: "model_call"; turn: number }
  | { ev: "model_done"; turn: number; ms: number; toolCalls: number; textChars: number }
  | { ev: "tool"; turn?: number; name: string; ms: number; ok: boolean; error?: string }
  | { ev: "pending"; count: number; tools: string[] }
  | { ev: "finish"; turns: number; toolCalls: number; textChars: number; ms: number; reason?: string }
  // `name` carries the tool involved when the error is about one (repeat_loop),
  // so the log line identifies which call looped without parsing the message.
  // `turn` is the loop index the error happened on, so an empty_answer line can
  // be lined up against the model_done that produced it.
  | { ev: "error"; where: string; message: string; name?: string; turn?: number }
  // Mid-turn compaction: `where` says which lever ran (in_flight = settled
  // turns folded into the summary; tool_result_truncated = a result was cut),
  // so a conversation that keeps compacting is visible as a pattern.
  | {
      ev: "compaction";
      where: string;
      droppedCount: number;
      keptRecentCount: number;
      turn?: number;
    };

let warned = false;

/** Append one event. Never throws: logging must not break a chat turn. */
export function logTurnEvent(event: TurnLogEvent): void {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...redact(event) }) + "\n";
    rotateIfNeeded();
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, line, "utf8");
  } catch (e) {
    // A read-only or full disk shouldn't take the assistant down — say so once.
    if (!warned) {
      warned = true;
      console.error(`[chat] turn log disabled: ${(e as Error).message}`);
    }
  }
}

function redact(event: TurnLogEvent): TurnLogEvent {
  return "error" in event && typeof event.error === "string"
    ? { ...event, error: event.error.slice(0, MAX_ERROR_CHARS) }
    : event;
}

function rotateIfNeeded(): void {
  try {
    if (statSync(LOG_PATH).size < MAX_BYTES) return;
    renameSync(LOG_PATH, `${LOG_PATH}.1`);
  } catch {
    // Missing file (first write) or a rename race — either way, just append.
  }
}

export { LOG_PATH as TURN_LOG_PATH };
