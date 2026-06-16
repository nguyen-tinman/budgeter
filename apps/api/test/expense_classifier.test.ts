// LLM expense classifier — unit + route tests. Drives the classify loop and
// the POST /api/chat/classify SSE route against a STUBBED LLM client so the
// tests are deterministic (no real llama-server). Mirrors chat.test.ts's
// stubClient + fresh-DB-per-test pattern.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import type {
  ChatRequest,
  ChatResponse,
  LlamaClient,
} from "../src/services/llama_client.js";
import {
  buildCategoryGrammar,
  buildClassifierMessages,
  matchCategory,
  recommendWorkspaceExpenses,
  applyExpenseCategories,
  CATEGORY_GUIDANCE,
} from "../src/services/expense_classifier.js";

// --- stub LLM client -------------------------------------------------------

function reply(content: string): ChatResponse {
  return {
    id: "stub",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
  };
}

/** Stub that decides a category from the expense label embedded in the user
 *  message, so we can assert label → category routing end-to-end. */
function labelStub(map: (label: string) => string): LlamaClient {
  return {
    baseUrl: "stub://classify",
    chat: async (req: ChatRequest) => {
      const user = req.messages.find((m) => m.role === "user")?.content ?? "";
      const label = /Description: (.*)/.exec(String(user))?.[1]?.trim() ?? "";
      return reply(map(label));
    },
    health: async () => ({ ok: true, status: 200 }),
  };
}

const ROUTE = (label: string): string => {
  const l = label.toLowerCase();
  if (l.includes("trader")) return "Food";
  if (l.includes("shell")) return "Transport";
  if (l.includes("spotify")) return "Subscriptions";
  return "Discretionary";
};

// --- DB harness ------------------------------------------------------------

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "budgetkit-classifier-"));
  process.env.BUDGETKIT_DB = join(tmpRoot, "test.db");
});

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(async () => {
  const { closeDb, defaultDbConfig } = await import("@budgetkit/db");
  closeDb();
  const cfg = defaultDbConfig();
  rmSync(cfg.path, { force: true });
  for (const side of ["-wal", "-shm"]) rmSync(`${cfg.path}${side}`, { force: true });
});

async function freshCtx() {
  const { openDb, migrate, buildToolCtx } = await import("@budgetkit/db");
  const db = openDb();
  migrate(db);
  return { db, ctx: buildToolCtx(db, "manual") };
}

const WS = 1; // migration seeds a 'Current' workspace at id 1
// Canonical ids from migrations/008 (see categories_drift.test.ts).
const ID = { Food: 4, Transport: 5, Subscriptions: 6, Discretionary: 8 };

// --- pure helpers ----------------------------------------------------------

describe("buildCategoryGrammar", () => {
  it("emits a GBNF enum of exactly the given names", () => {
    expect(buildCategoryGrammar(["Food", "Transport"])).toBe(
      'root ::= "Food" | "Transport"',
    );
  });

  it("escapes quotes/backslashes defensively", () => {
    expect(buildCategoryGrammar(['A"B'])).toBe('root ::= "A\\"B"');
  });
});

describe("buildClassifierMessages", () => {
  it("lists every category with its guidance and embeds the one transaction", () => {
    const msgs = buildClassifierMessages(["Food", "Transport"], {
      label: "TRADER JOES",
      amountDollars: 45,
    });
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("Food —");
    expect(msgs[0].content).toContain("Transport —");
    expect(msgs[1].role).toBe("user");
    expect(msgs[1].content).toBe("Description: TRADER JOES\nAmount: $45");
  });
});

describe("matchCategory", () => {
  const names = ["Food", "Transport", "Subscriptions", "Discretionary", "Annual fees"];

  it("matches exact names case-insensitively", () => {
    expect(matchCategory("Food", names)).toBe("Food");
    expect(matchCategory("  transport ", names)).toBe("Transport");
  });

  it("strips think blocks before matching", () => {
    expect(matchCategory("<think>hmm gas</think>Transport", names)).toBe("Transport");
  });

  it("matches a contained name, longest-first to avoid prefix collisions", () => {
    expect(matchCategory("looks like the annual fees line", names)).toBe("Annual fees");
  });

  it("falls back to Discretionary on an unrecognizable reply", () => {
    expect(matchCategory("banana", names)).toBe("Discretionary");
    expect(matchCategory("", names)).toBe("Discretionary");
  });
});

describe("CATEGORY_GUIDANCE drift guard", () => {
  it("has exactly one guidance entry per canonical DB category", async () => {
    const { ctx } = await freshCtx();
    const dbNames = ctx.categories.listAll().map((c) => c.name).sort();
    const guidanceNames = Object.keys(CATEGORY_GUIDANCE).sort();
    expect(guidanceNames).toEqual(dbNames);
  });
});

// --- the recommend loop (no writes) ----------------------------------------

describe("recommendWorkspaceExpenses", () => {
  it("returns a recommendation per changed row and writes NOTHING", async () => {
    const { ctx } = await freshCtx();
    ctx.expenses.add({ workspaceId: WS, label: "Trader Joes #12", amountDollars: 50, frequency: "monthly" });
    ctx.expenses.add({ workspaceId: WS, label: "Shell 0451", amountDollars: 40, frequency: "monthly" });
    ctx.expenses.add({ workspaceId: WS, label: "Mystery Co", amountDollars: 9, frequency: "monthly" });

    const lines: Array<{ label: string; changed: boolean }> = [];
    const result = await recommendWorkspaceExpenses(labelStub(ROUTE), ctx, WS, {
      onLine: (l) => lines.push({ label: l.label, changed: l.changed }),
    });

    expect(result.examined).toBe(3);
    expect(result.total).toBe(3);
    expect(result.changedCount).toBe(3);
    expect(result.recommendations).toEqual([
      { id: 1, label: "Trader Joes #12", currentCategoryId: null, currentCategoryName: null, recommendedCategoryId: ID.Food, recommendedCategoryName: "Food" },
      { id: 2, label: "Shell 0451", currentCategoryId: null, currentCategoryName: null, recommendedCategoryId: ID.Transport, recommendedCategoryName: "Transport" },
      { id: 3, label: "Mystery Co", currentCategoryId: null, currentCategoryName: null, recommendedCategoryId: ID.Discretionary, recommendedCategoryName: "Discretionary" },
    ]);
    // onLine fires for every reviewed row.
    expect(lines).toHaveLength(3);
    // CRITICAL: recommend phase must not touch the DB.
    expect(ctx.expenses.list(WS).every((e) => e.categoryId === null)).toBe(true);
  });

  it("omits rows whose suggestion equals the current category", async () => {
    const { ctx } = await freshCtx();
    // Spotify already correct (stub returns Subscriptions); Shell is uncategorized.
    ctx.expenses.add({ workspaceId: WS, label: "Spotify USA", amountDollars: 12, frequency: "monthly", categoryId: ID.Subscriptions });
    ctx.expenses.add({ workspaceId: WS, label: "Shell", amountDollars: 40, frequency: "monthly" });

    const result = await recommendWorkspaceExpenses(labelStub(ROUTE), ctx, WS);

    expect(result.examined).toBe(2);
    expect(result.changedCount).toBe(1);
    expect(result.recommendations.map((r) => r.label)).toEqual(["Shell"]);
    expect(result.recommendations[0]).toMatchObject({
      currentCategoryId: null,
      recommendedCategoryId: ID.Transport,
      recommendedCategoryName: "Transport",
    });
  });

  it("includes the current category name when a row already has one", async () => {
    const { ctx } = await freshCtx();
    // Currently Discretionary, stub will move it to Food.
    ctx.expenses.add({ workspaceId: WS, label: "Trader Joes", amountDollars: 50, frequency: "monthly", categoryId: ID.Discretionary });

    const result = await recommendWorkspaceExpenses(labelStub(ROUTE), ctx, WS);

    expect(result.recommendations[0]).toEqual({
      id: 1,
      label: "Trader Joes",
      currentCategoryId: ID.Discretionary,
      currentCategoryName: "Discretionary",
      recommendedCategoryId: ID.Food,
      recommendedCategoryName: "Food",
    });
  });

  it("halts mid-loop on abort, still writing nothing", async () => {
    const { ctx } = await freshCtx();
    ctx.expenses.add({ workspaceId: WS, label: "Trader Joes", amountDollars: 50, frequency: "monthly" });
    ctx.expenses.add({ workspaceId: WS, label: "Shell", amountDollars: 40, frequency: "monthly" });
    ctx.expenses.add({ workspaceId: WS, label: "Costco", amountDollars: 80, frequency: "monthly" });

    const controller = new AbortController();
    let calls = 0;
    const client: LlamaClient = {
      baseUrl: "stub://abort",
      chat: async (req: ChatRequest) => {
        calls += 1;
        if (calls === 1) controller.abort();
        const user = req.messages.find((m) => m.role === "user")?.content ?? "";
        const label = /Description: (.*)/.exec(String(user))?.[1]?.trim() ?? "";
        return reply(ROUTE(label));
      },
      health: async () => ({ ok: true, status: 200 }),
    };

    const result = await recommendWorkspaceExpenses(client, ctx, WS, { signal: controller.signal });

    expect(result.examined).toBe(1);
    expect(result.total).toBe(3);
    expect(calls).toBe(1);
    expect(ctx.expenses.list(WS).every((e) => e.categoryId === null)).toBe(true);
  });
});

// --- applyExpenseCategories (the write step) -------------------------------

describe("applyExpenseCategories", () => {
  it("writes the given changes and counts actual updates, skipping unknown ids", async () => {
    const { ctx } = await freshCtx();
    const { id: a } = ctx.expenses.add({ workspaceId: WS, label: "A", amountDollars: 1, frequency: "monthly" });
    const { id: b } = ctx.expenses.add({ workspaceId: WS, label: "B", amountDollars: 2, frequency: "monthly" });

    const { updated } = applyExpenseCategories(ctx, [
      { id: a, categoryId: ID.Food },
      { id: 99999, categoryId: ID.Transport }, // does not exist
    ]);

    expect(updated).toBe(1);
    const byId = new Map(ctx.expenses.list(WS).map((e) => [e.id, e.categoryId]));
    expect(byId.get(a)).toBe(ID.Food);
    expect(byId.get(b)).toBeNull(); // untouched
  });
});

// --- the SSE route + apply route -------------------------------------------

async function appWith(client: LlamaClient): Promise<Hono> {
  const { chatRouter } = await import("../src/routes/chat.js");
  const app = new Hono();
  app.route("/api/chat", chatRouter({ client }));
  return app;
}

describe("POST /api/chat/classify", () => {
  it("streams recommendations in the done event WITHOUT writing", async () => {
    const { ctx } = await freshCtx();
    ctx.expenses.add({ workspaceId: WS, label: "Trader Joes", amountDollars: 50, frequency: "monthly" });
    ctx.expenses.add({ workspaceId: WS, label: "Shell", amountDollars: 40, frequency: "monthly" });

    const app = await appWith(labelStub(ROUTE));
    const res = await app.request("/api/chat/classify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: WS }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();

    expect(text).toContain("Reviewing 2 expenses");
    expect(text).toContain("Trader Joes → Food");
    expect(text).toContain("event: done");
    expect(text).toMatch(/"changedCount":2/);
    expect(text).toMatch(/"recommendedCategoryName":"Food"/);
    // No affectedResources on the recommend phase — nothing changed yet.
    expect(text).not.toContain("affectedResources");
    // DB still untouched.
    expect(ctx.expenses.list(WS).every((e) => e.categoryId === null)).toBe(true);
  });

  it("emits a validation error when workspaceId is missing", async () => {
    const app = await appWith(labelStub(ROUTE));
    const res = await app.request("/api/chat/classify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const text = await res.text();
    expect(text).toContain("event: error");
    expect(text).toContain("validation");
  });

  it("reports zero work for an empty workspace without calling the model", async () => {
    await freshCtx(); // migrate only; no expenses
    let called = false;
    const client: LlamaClient = {
      baseUrl: "stub://empty",
      chat: async () => {
        called = true;
        return reply("Food");
      },
      health: async () => ({ ok: true, status: 200 }),
    };
    const app = await appWith(client);
    const res = await app.request("/api/chat/classify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: WS }),
    });
    const text = await res.text();
    expect(called).toBe(false);
    expect(text).toContain("No expenses to review");
    expect(text).toMatch(/"changedCount":0/);
  });
});

describe("POST /api/chat/classify/apply", () => {
  it("commits only the accepted changes and reports the resource to refresh", async () => {
    const { ctx } = await freshCtx();
    const { id: a } = ctx.expenses.add({ workspaceId: WS, label: "Trader Joes", amountDollars: 50, frequency: "monthly" });
    const { id: b } = ctx.expenses.add({ workspaceId: WS, label: "Shell", amountDollars: 40, frequency: "monthly" });

    const app = await appWith(labelStub(ROUTE));
    const res = await app.request("/api/chat/classify/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ changes: [{ id: a, categoryId: ID.Food }] }),
    });
    const body = (await res.json()) as { ok: boolean; updated: number; affectedResources: string[] };

    expect(body).toEqual({ ok: true, updated: 1, affectedResources: ["expenses"] });
    const byId = new Map(ctx.expenses.list(WS).map((e) => [e.id, e.categoryId]));
    expect(byId.get(a)).toBe(ID.Food);
    expect(byId.get(b)).toBeNull(); // not in the accepted set
  });

  it("rejects a non-array body with a validation error", async () => {
    await freshCtx();
    const app = await appWith(labelStub(ROUTE));
    const res = await app.request("/api/chat/classify/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("validation");
  });
});
