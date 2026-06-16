// Generic tool routes:
//   GET  /api/tools              -> list tool descriptors (name, description, schemas)
//   POST /api/tools/:name        -> invoke a tool with JSON body as args
//
// Both routes write to tools_call_log via the registry's audit step. The
// convenience routes in other files (workspaces.ts, expenses.ts, etc.) are
// thin wrappers over this same registry.
//
// Mutation gate (C1 / audit API-3, API-4): mutating tools (no readOnly flag)
// require `"confirm": true` in the request body. The key is stripped before
// invocation (tool schemas use additionalProperties:false) and mapped to the
// registry's mutationConsent. Without it the route answers 409 with a
// structured `needs_confirmation` error naming the tool.

import { Hono } from "hono";
import {
  ALL_TOOLS,
  NeedsConfirmationError,
  ToolArgError,
  ToolRegistry,
} from "@budgetkit/core";
import { openDb, buildToolCtx } from "@budgetkit/db";

export function toolsRouter(): Hono {
  const router = new Hono();
  const registry = new ToolRegistry(ALL_TOOLS, { requireMutationConsent: true });

  router.get("/", (c) =>
    c.json({
      tools: registry.list().map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        outputSchema: t.outputSchema,
      })),
    }),
  );

  router.post("/:name", async (c) => {
    const name = c.req.param("name");
    let args: unknown;
    try {
      args = await c.req.json();
    } catch {
      args = {};
    }
    // Extract the confirmation flag. Always stripped (even for read-only
    // tools, where it is meaningless but harmless) so it never trips the
    // schema validator's unknown-field check.
    let confirm = false;
    if (args && typeof args === "object" && !Array.isArray(args)) {
      const rec = args as Record<string, unknown>;
      if ("confirm" in rec) {
        confirm = rec.confirm === true;
        const { confirm: _stripped, ...rest } = rec;
        args = rest;
      }
    }
    try {
      const db = openDb();
      const ctx = buildToolCtx(db, "api_direct");
      const result = await registry.invoke(name, args, ctx, { mutationConsent: confirm });
      return c.json({ ok: true, result });
    } catch (e) {
      const err = e as Error;
      if (err instanceof ToolArgError) {
        return c.json({ ok: false, error: "validation", message: err.message, path: err.path }, 400);
      }
      if (err instanceof NeedsConfirmationError) {
        // 409 Conflict: the request was well-formed but cannot run without
        // explicit confirmation. Structured so a client can render an
        // approve-and-retry flow.
        return c.json(
          {
            ok: false,
            error: "needs_confirmation",
            tool: err.toolName,
            message:
              `Tool "${err.toolName}" modifies budget data. ` +
              `Re-send the request with "confirm": true in the JSON body to execute it.`,
          },
          409,
        );
      }
      if (/Unknown tool/.test(err.message)) {
        return c.json({ ok: false, error: "not_found", message: err.message }, 404);
      }
      // Domain errors — known business-logic preconditions that the caller
      // can act on. Return 422 (Unprocessable Entity) so monitoring doesn't
      // false-alarm on these and clients can show a friendly message.
      if (
        /No tax_settings row/.test(err.message) ||
        /No retirement_settings row/.test(err.message) ||
        /Workspace .* not found/.test(err.message) ||
        /Cannot delete the 'Current'/.test(err.message) ||
        /must be <= high/.test(err.message) ||
        /must be > currentAge/.test(err.message) ||
        /must be in \[0,1\]/.test(err.message) ||
        /Only the LAST bracket may omit upTo/.test(err.message) ||
        /Brackets must be ascending/.test(err.message) ||
        /Bracket rates must be non-decreasing/.test(err.message) ||
        /The last bracket must omit upTo/.test(err.message) ||
        // Train F's import_tax_table / hardened set_tax_table validator —
        // these are caller-actionable preconditions, not server faults.
        /tax table validation failed/i.test(err.message)
      ) {
        return c.json({ ok: false, error: "domain", message: err.message }, 422);
      }
      return c.json({ ok: false, error: "internal", message: err.message }, 500);
    }
  });

  return router;
}
