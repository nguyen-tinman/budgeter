// Custom-page definition validation + the get/set/reset/revert lifecycle,
// driven through the registry so the mutation gate and audit behavior are
// exercised on the same path the transports use.

import { describe, it, expect, beforeEach } from "vitest";
import {
  ALL_TOOLS,
  CUSTOM_PAGE_GUIDE,
  CUSTOM_PAGE_QUERY_TOOLS,
  MAX_RENDER_CHARS,
  NeedsConfirmationError,
  ToolArgError,
  ToolRegistry,
  validateCustomPageDefinition,
  type CustomPageDefinition,
  type ToolCallRecord,
  type ToolCtx,
} from "../src/index.js";

/** Minimal ToolCtx: the custom-page tools touch only `customPage`, `audit`
 *  and `tx`. Everything else stays absent so a handler that reached for
 *  another repo would fail loudly instead of silently passing. */
function mkCustomPageCtx(): ToolCtx & { audit: { records: ToolCallRecord[] } } {
  const records: ToolCallRecord[] = [];
  const rows = new Map<string, { value: string; updatedAt: string }>();
  let clock = 0;
  const stamp = () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++clock)).toISOString();
  const customPage: ToolCtx["customPage"] = {
    read: () => {
      const row = rows.get("def");
      return row ? { definitionJson: row.value, updatedAt: row.updatedAt } : null;
    },
    readPrev: () => {
      const row = rows.get("prev");
      return row ? { definitionJson: row.value } : null;
    },
    write: (definitionJson) => {
      const current = rows.get("def");
      if (current) rows.set("prev", { ...current });
      else rows.delete("prev");
      const updatedAt = stamp();
      rows.set("def", { value: definitionJson, updatedAt });
      return { updatedAt };
    },
    reset: () => {
      const current = rows.get("def");
      if (!current) return { hadDefinition: false };
      rows.set("prev", { ...current });
      rows.delete("def");
      return { hadDefinition: true };
    },
    revert: () => {
      const prev = rows.get("prev");
      if (!prev) return { reverted: false, updatedAt: null };
      const current = rows.get("def");
      if (current) rows.set("prev", { ...current });
      else rows.delete("prev");
      const updatedAt = stamp();
      rows.set("def", { value: prev.value, updatedAt });
      return { reverted: true, updatedAt };
    },
  };
  return {
    audit: {
      records,
      append: (r: ToolCallRecord) => {
        records.push(r);
      },
    },
    customPage,
    source: "in_app_llm",
    tx: <T,>(fn: () => T): T => fn(),
  } as unknown as ToolCtx & { audit: { records: ToolCallRecord[] } };
}

const lookupTool = (name: string) => ALL_TOOLS.find((t) => t.name === name);

/** A minimal valid `set` payload; spread over it to break one thing at a time. */
function setArgs(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "set",
    title: "Food spend on Tuesdays",
    queries: [
      { id: "food", tool: "query_transactions", args: { groupBy: "week", dayOfWeek: 2 } },
    ],
    render: 'bk.note(root, "hi");',
    ...over,
  };
}

describe("validateCustomPageDefinition", () => {
  it("accepts a well-formed definition and normalizes it to version 1", () => {
    const def = validateCustomPageDefinition(setArgs({ note: "Last 10 weeks" }), lookupTool);
    expect(def.version).toBe(1);
    expect(def.title).toBe("Food spend on Tuesdays");
    expect(def.note).toBe("Last 10 weeks");
    expect(def.queries).toHaveLength(1);
    expect(def.queries[0]!.tool).toBe("query_transactions");
  });

  it("drops an empty note rather than storing a blank caption", () => {
    const def = validateCustomPageDefinition(setArgs({ note: "" }), lookupTool);
    expect(def.note).toBeUndefined();
  });

  it("rejects a missing title, missing queries, and missing render", () => {
    for (const field of ["title", "queries", "render"] as const) {
      const args = setArgs();
      delete args[field];
      expect(() => validateCustomPageDefinition(args, lookupTool)).toThrow(ToolArgError);
    }
  });

  it("rejects an empty queries array", () => {
    expect(() => validateCustomPageDefinition(setArgs({ queries: [] }), lookupTool)).toThrow(
      /is missing: "queries"/,
    );
  });

  it("tells a retrying model the whole shape, not just the field it omitted", () => {
    // A bare "field X is missing" makes small models supply X and drop
    // something else next attempt; the error carries a complete example so a
    // retry can converge. Assert the payload-level guidance, not the prose.
    for (const field of ["title", "queries", "render"] as const) {
      const args = setArgs();
      delete args[field];
      let message = "";
      try {
        validateCustomPageDefinition(args, lookupTool);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/ONE call/);
      // Every absent field is named in one error — a caller fixing them one
      // per attempt never converges.
      expect(message).toContain(`missing: "${field}"`);
      for (const required of ["title", "queries", "render"]) {
        expect(message).toContain(`"${required}"`);
      }
      expect(message).toContain('"tool":"query_transactions"');
    }
  });

  it("rejects a render body that does not compile, naming the syntax error", () => {
    // Verbatim shape of a body the model actually stored: one extra closing
    // paren. Before this check it validated fine and only failed later in the
    // browser, where the model could no longer act on it.
    const args = setArgs({
      render: 'bk.note(root, "x: " + ((data.q && data.q.error) || "none")));',
    });
    let message = "";
    try {
      validateCustomPageDefinition(args, lookupTool);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/not valid JavaScript/);
    // Must carry the engine's own diagnosis, not just "invalid".
    expect(message).toMatch(/\)/);
    // And restate the contract, since a syntax error often means the model
    // wrapped the body in a function declaration.
    expect(message).toMatch(/BODY of/);
  });

  it("accepts a render body that compiles, including one using every bk helper", () => {
    const args = setArgs({
      render:
        'var g = (data.food && data.food.groups) || [];' +
        ' bk.barChart(root, { bars: g.map(function (r) { return { label: r.key, value: r.value }; }) });' +
        ' bk.note(root, bk.formatDollars(1234.5));',
    });
    expect(() => validateCustomPageDefinition(args, lookupTool)).not.toThrow();
  });

  it("rejects a tool outside the query allowlist", () => {
    // add_expense is a real tool — it is rejected for being MUTATING, not for
    // being unknown. This is the load-bearing containment check.
    const args = setArgs({
      queries: [{ id: "boom", tool: "add_expense", args: {} }],
    });
    expect(() => validateCustomPageDefinition(args, lookupTool)).toThrow(
      /not an allowed custom-page query tool/,
    );
  });

  it("rejects duplicate query ids", () => {
    const args = setArgs({
      queries: [
        { id: "a", tool: "list_categories", args: {} },
        { id: "a", tool: "list_workspaces", args: {} },
      ],
    });
    expect(() => validateCustomPageDefinition(args, lookupTool)).toThrow(/duplicate query id "a"/);
  });

  it("rejects a query id that is not identifier-shaped", () => {
    const args = setArgs({ queries: [{ id: "9-bad", tool: "list_categories", args: {} }] });
    expect(() => validateCustomPageDefinition(args, lookupTool)).toThrow(/"id" must match/);
  });

  it("rejects a render body over the character cap", () => {
    const args = setArgs({ render: "x".repeat(MAX_RENDER_CHARS + 1) });
    expect(() => validateCustomPageDefinition(args, lookupTool)).toThrow(/"render" exceeds/);
  });

  it("rejects query args that fail the TARGET tool's schema, naming the query id", () => {
    // query_transactions requires groupBy; dayOfWeek must be 0..6.
    const missingRequired = setArgs({
      queries: [{ id: "spend", tool: "query_transactions", args: { dayOfWeek: 2 } }],
    });
    expect(() => validateCustomPageDefinition(missingRequired, lookupTool)).toThrow(
      /query "spend" \(query_transactions\).*groupBy/s,
    );

    const outOfRange = setArgs({
      queries: [
        { id: "spend", tool: "query_transactions", args: { groupBy: "week", dayOfWeek: 9 } },
      ],
    });
    expect(() => validateCustomPageDefinition(outOfRange, lookupTool)).toThrow(
      /query "spend".*maximum 6/s,
    );
  });

  it("accepts $WORKSPACE_ID where the target tool expects an integer", () => {
    const args = setArgs({
      queries: [{ id: "exp", tool: "list_expenses", args: { workspaceId: "$WORKSPACE_ID" } }],
    });
    const def = validateCustomPageDefinition(args, lookupTool);
    // Stored VERBATIM — substitution happens at page load with the real id.
    expect(def.queries[0]!.args.workspaceId).toBe("$WORKSPACE_ID");
  });

  it("still rejects a non-placeholder string where an integer is expected", () => {
    const args = setArgs({
      queries: [{ id: "exp", tool: "list_expenses", args: { workspaceId: "current" } }],
    });
    expect(() => validateCustomPageDefinition(args, lookupTool)).toThrow(/expected number/);
  });

  // The live failure: the stored definition declared `retirement_plot` but read
  // `data.retirement`. Both halves validate individually; only the page load
  // catches it, and the model never sees a page load.
  it("rejects a render reading a query id nothing declares", () => {
    const args = setArgs({
      queries: [{ id: "retirement_plot", tool: "compute_retirement", args: { workspaceId: "$WORKSPACE_ID" } }],
      render: "var q = data.retirement; bk.note(root, String(q));",
    });
    expect(() => validateCustomPageDefinition(args, lookupTool)).toThrow(
      /data\.retirement.*Declared query ids: "retirement_plot"/s,
    );
  });

  it("accepts a render whose reference matches the declared id", () => {
    const args = setArgs({
      queries: [{ id: "retirement_plot", tool: "compute_retirement", args: { workspaceId: "$WORKSPACE_ID" } }],
      render: 'var q = data.retirement_plot; if (q.error) { bk.note(root, "x"); return; }',
    });
    expect(() => validateCustomPageDefinition(args, lookupTool)).not.toThrow();
  });

  it("catches the same mismatch through bracket access", () => {
    const args = setArgs({ render: 'bk.note(root, String(data["fud"]));' });
    expect(() => validateCustomPageDefinition(args, lookupTool)).toThrow(/data\.fud/);
  });

  it("does not mistake text inside strings or comments for a data reference", () => {
    const args = setArgs({
      render: '// see data.oldName\nbk.note(root, "renamed from data.oldName"); var q = data.food;',
    });
    expect(() => validateCustomPageDefinition(args, lookupTool)).not.toThrow();
  });

  it("allows ordinary object plumbing on data", () => {
    const args = setArgs({
      render: 'var ks = Object.keys(data); bk.note(root, ks.join(",") + data.food);',
    });
    expect(() => validateCustomPageDefinition(args, lookupTool)).not.toThrow();
  });
});

describe("custom-page tools — lifecycle through the registry", () => {
  let ctx: ReturnType<typeof mkCustomPageCtx>;
  let registry: ToolRegistry;

  beforeEach(() => {
    ctx = mkCustomPageCtx();
    registry = new ToolRegistry(ALL_TOOLS);
  });

  const get = async (args: object = {}) =>
    (await registry.invoke("get_custom_page", args, ctx)) as {
      exists: boolean;
      updatedAt: string | null;
      definition: CustomPageDefinition | null;
      hasPrevious: boolean;
      guide?: string;
    };

  it("reports a blank page before anything is written", async () => {
    const page = await get();
    expect(page.exists).toBe(false);
    expect(page.definition).toBeNull();
    expect(page.updatedAt).toBeNull();
    expect(page.hasPrevious).toBe(false);
    expect(page.guide).toBeUndefined();
  });

  it("returns the authoring guide only when asked", async () => {
    const page = await get({ includeGuide: true });
    expect(page.guide).toBe(CUSTOM_PAGE_GUIDE);
    // The guide must cover the two behaviors the addendum depends on.
    expect(page.guide).toMatch(/rewrite the WHOLE definition/);
    expect(page.guide).toMatch(/ONE set_custom_page call per turn/);
    for (const tool of CUSTOM_PAGE_QUERY_TOOLS) expect(page.guide).toContain(tool);
  });

  it("round-trips set → get", async () => {
    const res = (await registry.invoke("set_custom_page", setArgs(), ctx)) as {
      saved: boolean;
      action: string;
      updatedAt: string;
    };
    expect(res).toMatchObject({ saved: true, action: "set" });
    expect(res.updatedAt).toBeTruthy();

    const page = await get();
    expect(page.exists).toBe(true);
    expect(page.definition!.title).toBe("Food spend on Tuesdays");
    expect(page.definition!.version).toBe(1);
    expect(page.updatedAt).toBe(res.updatedAt);
    // First write has nothing to undo to — the page offers Reset instead.
    expect(page.hasPrevious).toBe(false);
  });

  it("set A → set B → revert → A → reset → blank", async () => {
    await registry.invoke("set_custom_page", setArgs({ title: "A" }), ctx);
    await registry.invoke("set_custom_page", setArgs({ title: "B" }), ctx);

    let page = await get();
    expect(page.definition!.title).toBe("B");
    expect(page.hasPrevious).toBe(true);

    const rev = (await registry.invoke("set_custom_page", { action: "revert" }, ctx)) as {
      reverted: boolean;
    };
    expect(rev.reverted).toBe(true);
    page = await get();
    expect(page.definition!.title).toBe("A");

    // Swap semantics: reverting again toggles back to B.
    await registry.invoke("set_custom_page", { action: "revert" }, ctx);
    page = await get();
    expect(page.definition!.title).toBe("B");

    const reset = (await registry.invoke("set_custom_page", { action: "reset" }, ctx)) as {
      hadDefinition: boolean;
    };
    expect(reset.hadDefinition).toBe(true);
    page = await get();
    expect(page.exists).toBe(false);
    expect(page.definition).toBeNull();
    // The reset itself is undoable.
    expect(page.hasPrevious).toBe(true);
  });

  it("reverting a RESET restores the page but leaves nothing further to undo", async () => {
    // The one asymmetric case (audit finding D1): blank is the ABSENCE of the
    // key, so reverting a reset has no current value to snapshot and cannot be
    // told apart from "no snapshot exists". The definition comes back, Undo
    // then disables, and Reset is how the user re-blanks.
    await registry.invoke("set_custom_page", setArgs({ title: "A" }), ctx);
    await registry.invoke("set_custom_page", { action: "reset" }, ctx);
    expect((await get()).hasPrevious).toBe(true);

    await registry.invoke("set_custom_page", { action: "revert" }, ctx);
    const page = await get();
    expect(page.definition!.title).toBe("A");
    expect(page.hasPrevious).toBe(false);

    const again = (await registry.invoke("set_custom_page", { action: "revert" }, ctx)) as {
      reverted: boolean;
    };
    expect(again.reverted).toBe(false);
  });

  it("revert with nothing to revert to reports reverted:false", async () => {
    const rev = (await registry.invoke("set_custom_page", { action: "revert" }, ctx)) as {
      saved: boolean;
      reverted: boolean;
      updatedAt: string | null;
    };
    expect(rev.reverted).toBe(false);
    expect(rev.saved).toBe(false);
    expect(rev.updatedAt).toBeNull();
  });

  it("reset on an already-blank page is a no-op", async () => {
    const reset = (await registry.invoke("set_custom_page", { action: "reset" }, ctx)) as {
      hadDefinition: boolean;
    };
    expect(reset.hadDefinition).toBe(false);
    expect((await get()).hasPrevious).toBe(false);
  });

  it("a rejected set leaves the stored page untouched", async () => {
    await registry.invoke("set_custom_page", setArgs({ title: "Good" }), ctx);
    await expect(
      registry.invoke("set_custom_page", setArgs({ title: "Bad", render: "" }), ctx),
    ).rejects.toThrow(ToolArgError);
    const page = await get();
    expect(page.definition!.title).toBe("Good");
    // The failed write must not have consumed the undo slot either.
    expect(page.hasPrevious).toBe(false);
  });

  it("rejects unknown top-level fields (additionalProperties:false)", async () => {
    await expect(
      registry.invoke("set_custom_page", setArgs({ path: "../../etc/passwd" }), ctx),
    ).rejects.toThrow(/unknown field "path"/);
  });
});

describe("custom-page tools — mutation gate + audit", () => {
  it("set_custom_page needs mutation consent on a gated registry; the readers do not", async () => {
    const ctx = mkCustomPageCtx();
    const gated = new ToolRegistry(ALL_TOOLS, { requireMutationConsent: true });

    await expect(gated.invoke("set_custom_page", setArgs(), ctx)).rejects.toThrow(
      NeedsConfirmationError,
    );
    // Refused attempts are still audited (blocked mutation = audit event).
    expect(ctx.audit.records).toHaveLength(1);
    expect(ctx.audit.records[0]!.toolName).toBe("set_custom_page");
    expect((await gated.invoke("get_custom_page", {}, ctx) as { exists: boolean }).exists).toBe(
      false,
    );

    await gated.invoke("set_custom_page", setArgs(), ctx, { mutationConsent: true });
    expect((await gated.invoke("get_custom_page", {}, ctx) as { exists: boolean }).exists).toBe(
      true,
    );
    expect(ctx.audit.records).toHaveLength(2);
  });

  it("audits set_custom_page WITHOUT banking the render source or title", async () => {
    const ctx = mkCustomPageCtx();
    const registry = new ToolRegistry(ALL_TOOLS);
    await registry.invoke("set_custom_page", setArgs({ title: "SECRET LABEL" }), ctx);
    const row = ctx.audit.records.at(-1)!;
    expect(row.toolName).toBe("set_custom_page");
    expect(row.source).toBe("in_app_llm");
    // Redaction reduces strings to type tags, so neither the title nor the
    // render body lands in the long-lived log.
    expect(row.argsJson).not.toContain("SECRET LABEL");
    expect(row.argsJson).not.toContain("bk.note");
    expect(JSON.parse(row.argsJson)).toMatchObject({ title: "[string]", queries: { _count: 1 } });
  });

  it("get_custom_page is read-only: no audit row", async () => {
    const ctx = mkCustomPageCtx();
    const registry = new ToolRegistry(ALL_TOOLS);
    await registry.invoke("get_custom_page", { includeGuide: true }, ctx);
    expect(ctx.audit.records).toHaveLength(0);
  });
});
