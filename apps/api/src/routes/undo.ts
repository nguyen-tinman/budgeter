// Undo of assistant-driven changes, one step per USER turn.
//
// The snapshots themselves are taken by the chat route at the start of each
// user turn (see snapshotForUndo); this router only exposes the stack and
// applies it. Kept off /api/tools deliberately: undo is an app-level control
// the user drives from the UI, not a capability the assistant should be able to
// invoke on itself — a model that could rewind the database could also undo the
// evidence of what it just did.
import { Hono } from "hono";
import { listUndoSnapshots, undoLastUserTurn, UNDO_DEPTH } from "@budgetkit/db";

/** Every resource the client caches; a restore can change any of them. */
const ALL_RESOURCES = [
  "incomes",
  "expenses",
  "savings",
  "takeHome",
  "workspaces",
  "retirement",
  "statements",
  "customPage",
];

export function undoRouter(): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const snapshots = listUndoSnapshots();
    return c.json({
      ok: true,
      depth: UNDO_DEPTH,
      available: snapshots.length,
      snapshots,
    });
  });

  app.post("/", (c) => {
    let result;
    try {
      result = undoLastUserTurn();
    } catch (e) {
      return c.json({ ok: false, error: "undo_failed", message: (e as Error).message }, 500);
    }
    if (!result.restored) {
      return c.json({ ok: false, error: "nothing_to_undo", message: result.reason ?? "" }, 409);
    }
    return c.json({
      ok: true,
      snapshot: result.snapshot,
      remaining: result.remaining,
      // The restore can touch anything, so the client refetches everything
      // rather than trying to reason about which tables the turn wrote.
      affectedResources: ALL_RESOURCES,
    });
  });

  return app;
}
