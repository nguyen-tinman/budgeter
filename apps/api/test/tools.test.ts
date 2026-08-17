// REST surface for the tool registry. Hono apps are testable in-process
// (app.fetch returns a Response), so no real listener is bound.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "budgetkit-tools-test-"));
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
  // Fresh DB per test for isolation.
  const { closeDb, defaultDbConfig } = await import("@budgetkit/db");
  closeDb();
  const cfg = defaultDbConfig();
  rmSync(cfg.path, { force: true });
  for (const side of ["-wal", "-shm"]) rmSync(`${cfg.path}${side}`, { force: true });
});

async function freshApp(): Promise<Hono> {
  const { openDb } = await import("@budgetkit/db");
  const { migrate } = await import("@budgetkit/db");
  const { toolsRouter } = await import("../src/routes/tools.js");
  const db = openDb();
  migrate(db);
  const app = new Hono();
  app.route("/api/tools", toolsRouter());
  return app;
}

describe("REST /api/tools", () => {
  it("GET /api/tools returns the registry with schemas", async () => {
    const app = await freshApp();
    const res = await app.request("/api/tools");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tools: Array<{ name: string }> };
    const names = body.tools.map((t) => t.name);
    expect(names).toContain("list_workspaces");
    expect(names).toContain("add_expense");
    expect(names).toContain("compute_take_home");
    expect(body.tools.length).toBeGreaterThanOrEqual(10);
  });

  it("POST /api/tools/list_workspaces returns the seeded Current workspace", async () => {
    const app = await freshApp();
    const res = await app.request("/api/tools/list_workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      result: Array<{ name: string; kind: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.result).toHaveLength(1);
    expect(body.result[0]!.name).toBe("Current");
    expect(body.result[0]!.kind).toBe("current");
  });

  it("POST /api/tools/add_expense → list_expenses round-trips", async () => {
    const app = await freshApp();
    const addRes = await app.request("/api/tools/add_expense", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: 1,
        label: "Rent",
        amountDollars: 1850,
        frequency: "monthly",
        confirm: true,
      }),
    });
    expect(addRes.status).toBe(200);
    const addBody = (await addRes.json()) as { ok: boolean; result: { id: number } };
    expect(addBody.result.id).toBeGreaterThan(0);

    const listRes = await app.request("/api/tools/list_expenses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: 1 }),
    });
    const listBody = (await listRes.json()) as {
      result: Array<{ label: string; amountDollars: number }>;
    };
    expect(listBody.result).toHaveLength(1);
    expect(listBody.result[0]!.label).toBe("Rent");
    expect(listBody.result[0]!.amountDollars).toBe(1850);
  });

  it("POST /api/tools/add_expense accepts spendDate for a one_time row and round-trips it", async () => {
    const app = await freshApp();
    const addRes = await app.request("/api/tools/add_expense", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: 1,
        label: "Flight to NYC",
        amountDollars: 420,
        frequency: "one_time",
        spendDate: "2026-03-12",
        confirm: true, // add_expense is mutating — the registry gate wants consent
      }),
    });
    expect(addRes.status).toBe(200); // schema accepts spendDate
    const addBody = (await addRes.json()) as { ok: boolean; result: { id: number } };
    expect(addBody.ok).toBe(true);
    expect(addBody.result.id).toBeGreaterThan(0);

    const listRes = await app.request("/api/tools/list_expenses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: 1 }),
    });
    const listBody = (await listRes.json()) as {
      result: Array<{ label: string; frequency: string; spendDate: string | null }>;
    };
    const row = listBody.result.find((r) => r.label === "Flight to NYC")!;
    expect(row.frequency).toBe("one_time");
    expect(row.spendDate).toBe("2026-03-12"); // persisted through the schema → repo
  });

  it("compute_expense_trends surfaces undated one-time rows (count + labels)", async () => {
    const app = await freshApp();
    // A dated one-time row (placed) and an undated one (surfaced, not placed).
    await app.request("/api/tools/add_expense", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: 1, label: "Dated Buy", amountDollars: 100, frequency: "one_time", spendDate: "2026-03-01", confirm: true }),
    });
    await app.request("/api/tools/add_expense", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: 1, label: "Undated Buy", amountDollars: 200, frequency: "one_time", confirm: true }),
    });
    const res = await app.request("/api/tools/compute_expense_trends", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: 1, months: 24 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { undatedOneTimeCount: number; undatedOneTimeLabels: string[] };
    };
    expect(body.result.undatedOneTimeCount).toBe(1);
    expect(body.result.undatedOneTimeLabels).toEqual(["Undated Buy"]);
  });

  it("returns 400 with structured error on validation failure", async () => {
    const app = await freshApp();
    const res = await app.request("/api/tools/add_expense", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: 1, label: "X" }), // missing amount/freq
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("validation");
    expect(body.message).toMatch(/missing required field/);
  });

  it("returns 404 for an unknown tool name", async () => {
    const app = await freshApp();
    const res = await app.request("/api/tools/not_a_tool", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("writes the audit log on each successful MUTATION (not on reads)", async () => {
    const app = await freshApp();
    // list_workspaces is a read — no audit row should appear.
    await app.request("/api/tools/list_workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    // add_expense is a mutation — must produce an audit row.
    await app.request("/api/tools/add_expense", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: 1,
        label: "AuditTest",
        amountDollars: 50,
        frequency: "monthly",
        confirm: true,
      }),
    });
    const { openDb } = await import("@budgetkit/db");
    const db = openDb();
    const rows = db
      .prepare("SELECT tool_name, source FROM tools_call_log ORDER BY id")
      .all() as Array<{ tool_name: string; source: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.map((r) => r.tool_name)).not.toContain("list_workspaces");
    expect(rows.map((r) => r.tool_name)).toContain("add_expense");
    expect(rows.find((r) => r.tool_name === "add_expense")!.source).toBe(
      "api_direct",
    );
  });

  it("compute_take_home computes a sensible $120k single CA result", async () => {
    const app = await freshApp();
    await app.request("/api/tools/add_income", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: 1,
        label: "Salary",
        grossAnnualDollars: 120000,
        taxStatus: "taxed",
        confirm: true,
      }),
    });
    const res = await app.request("/api/tools/compute_take_home", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: 1 }),
    });
    const body = (await res.json()) as {
      result: {
        grossCombinedDollars: number;
        annualTakeHomeDollars: number;
        effectiveTaxRate: number;
      };
    };
    expect(body.result.grossCombinedDollars).toBe(120000);
    expect(body.result.annualTakeHomeDollars).toBeGreaterThan(82000);
    expect(body.result.annualTakeHomeDollars).toBeLessThan(88000);
  });

  // M11 statement import — full round-trip from list → preview → selective
  // commit, end-to-end through the REST surface against a real DB. Only runs
  // when ./statements/ contains parseable fixtures.
  it("list_statements → catalogue_expenses preview → selective commit → list_expenses", async () => {
    const { existsSync, readdirSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    // The API server resolves ./statements/ relative to process.cwd(). Vitest
    // starts in apps/api/, so chdir up to the project root for this test.
    const projectRoot = resolve(__dirname, "..", "..", "..");
    const statementsRoot = resolve(projectRoot, "statements");
    if (!existsSync(statementsRoot) || readdirSync(statementsRoot).length === 0) {
      // No fixtures — skip rather than fail in CI / fresh checkouts.
      return;
    }
    const prevCwd = process.cwd();
    process.chdir(projectRoot);
    try {
      const app = await freshApp();

      // Step 1: enumerate available files.
      const lsRes = await app.request("/api/tools/list_statements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(lsRes.status).toBe(200);
      const lsBody = (await lsRes.json()) as {
        result: { files: Array<{ relativePath: string; kind: string }> };
      };
      const usable = lsBody.result.files.filter((f) => f.kind !== "unknown").slice(0, 4);
      if (usable.length === 0) return;

      // Step 2: preview candidates.
      const previewRes = await app.request("/api/tools/catalogue_expenses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // catalogue_expenses is registry-level mutating (readOnly: false) even
        // in preview mode, so the gate requires confirm on both calls.
        body: JSON.stringify({ statementPaths: usable.map((f) => f.relativePath), confirm: true }),
      });
      expect(previewRes.status).toBe(200);
      const previewBody = (await previewRes.json()) as {
        result: {
          candidates: Array<{
            label: string;
            sourceAccount: string;
            amountDollars: number;
            frequency: string;
          }>;
        };
      };
      const candidates = previewBody.result.candidates;
      if (candidates.length < 2) return;

      // Step 3: pick a 2-row subset, build acceptedKeys, commit.
      const subset = candidates.slice(0, 2);
      const keys = subset.map(
        (c) => `${c.label}|${c.sourceAccount}|${c.amountDollars}|${c.frequency}`,
      );
      const commitRes = await app.request("/api/tools/catalogue_expenses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          statementPaths: usable.map((f) => f.relativePath),
          commit: true,
          workspaceId: 1,
          acceptedKeys: keys,
          confirm: true,
        }),
      });
      expect(commitRes.status).toBe(200);
      const commitBody = (await commitRes.json()) as {
        result: { committedIds: number[] };
      };
      expect(commitBody.result.committedIds.length).toBe(2);

      // Step 4: verify the chosen rows landed in expenses.
      const listRes = await app.request("/api/tools/list_expenses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: 1 }),
      });
      const listBody = (await listRes.json()) as {
        result: Array<{ label: string; source: string }>;
      };
      expect(listBody.result.filter((r) => r.source === "imported").length).toBe(2);
      const importedLabels = listBody.result
        .filter((r) => r.source === "imported")
        .map((r) => r.label)
        .sort();
      expect(importedLabels).toEqual(subset.map((c) => c.label).sort());
    } finally {
      process.chdir(prevCwd);
    }
  }, 60_000);
});

describe("C1 — import persistence + idempotency (real DB, no statement files)", () => {
  // Exercises the commit-time persistence layer directly through the repos +
  // tools, so it runs even where ./statements/ fixtures are absent (e.g. the
  // remediation worktree, fresh checkouts, CI). The file-parsing path is
  // covered by the round-trip test above when fixtures exist.

  async function freshCtx() {
    const { openDb, migrate, buildToolCtx } = await import("@budgetkit/db");
    const db = openDb();
    migrate(db);
    return buildToolCtx(db, "api_direct");
  }

  it("record + insertMany populate statement_imports/transactions; trends reflects the budget", async () => {
    const ctx = await freshCtx();
    const app = await freshApp();

    // Resolve a real seeded category id so the trends series keys are stable.
    const catId = ctx.categories.listByName().get("Food") ?? null;
    expect(catId).not.toBeNull();

    const now = new Date();
    const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-15`;

    // Import persistence: record + insertMany populate the import + txn tables.
    const rec = ctx.statementImports.record({
      sourceAccount: "chase",
      fileHash: "hash-aaa",
      filePath: "statements/chase/test-a.pdf",
      txnCount: 2,
    });
    expect(rec.alreadyImported).toBe(false);
    ctx.transactions.insertMany(rec.importId, [
      { postedDate: thisMonth, merchantRaw: "WHOLE FOODS", merchantNormalized: "whole foods", amountDollars: -50, categoryId: catId, accountType: "chase" },
      { postedDate: thisMonth, merchantRaw: "TRADER JOES", merchantNormalized: "trader joes", amountDollars: -30, categoryId: catId, accountType: "chase" },
    ]);
    expect(ctx.transactions.totalCount()).toBe(2);

    // Trends is BUDGET-driven (transactions no longer feed it): a recurring
    // monthly expense renders as a flat monthly-equivalent across the window.
    ctx.expenses.add({ workspaceId: 1, label: "Groceries", amountDollars: 80, frequency: "monthly", categoryId: catId, source: "manual" });
    const res = await app.request("/api/tools/compute_expense_trends", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: 1, months: 24 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { categories: Record<string, { series: number[] }> };
    };
    const series = body.result.categories[String(catId)]!.series;
    expect(series[series.length - 1]).toBe(80); // flat monthly-equivalent from the budget
  });

  it("re-recording the same file_hash is idempotent (no double-count)", async () => {
    const ctx = await freshCtx();
    const first = ctx.statementImports.record({
      sourceAccount: "chase", fileHash: "hash-dup", filePath: "statements/x.pdf", txnCount: 1,
    });
    expect(first.alreadyImported).toBe(false);
    const second = ctx.statementImports.record({
      sourceAccount: "chase", fileHash: "hash-dup", filePath: "statements/x.pdf", txnCount: 1,
    });
    expect(second.alreadyImported).toBe(true);
    expect(second.importId).toBe(first.importId);
  });

  it("ignore_statement flips the flag once a statement_imports row exists", async () => {
    const ctx = await freshCtx();
    const app = await freshApp();
    ctx.statementImports.record({
      sourceAccount: "amex_gold", fileHash: "hash-ign", filePath: "statements/amex/g.xlsx", txnCount: 3,
    });
    const res = await app.request("/api/tools/ignore_statement", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ relativePath: "statements/amex/g.xlsx", ignored: true, confirm: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { updated: boolean } };
    expect(body.result.updated).toBe(true);
    expect(ctx.statementImports.list().find((r) => r.filePath === "statements/amex/g.xlsx")?.ignored).toBe(true);
  });

  it("catalogue_expenses rejects an over-cap statementPaths array (CWE-400/maxItems)", async () => {
    const app = await freshApp();
    const tooMany = Array.from({ length: 101 }, (_, i) => `statements/f${i}.pdf`);
    const res = await app.request("/api/tools/catalogue_expenses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ statementPaths: tooMany }),
    });
    // validateArgs throws before any file I/O; the router surfaces a non-200.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("sensitivity_settings persistence (migration 006, real DB)", () => {
  async function postTool(app: Hono, name: string, args: unknown) {
    return app.request(`/api/tools/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
  }

  it("get_sensitivity_settings returns null before any set", async () => {
    const app = await freshApp();
    const res = await postTool(app, "get_sensitivity_settings", { workspaceId: 1 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; result: unknown };
    expect(body.ok).toBe(true);
    expect(body.result).toBeNull();
  });

  it("set_sensitivity_settings → get round-trips through SQLite (dollars preserved)", async () => {
    const app = await freshApp();
    const setRes = await postTool(app, "set_sensitivity_settings", {
      workspaceId: 1,
      primaryLowDollars: 50000,
      primaryHighDollars: 200000,
      spouseLowDollars: 0,
      spouseHighDollars: 100000,
      confirm: true,
    });
    expect(setRes.status).toBe(200);
    const setBody = (await setRes.json()) as { result: { saved: boolean } };
    expect(setBody.result.saved).toBe(true);

    const getRes = await postTool(app, "get_sensitivity_settings", { workspaceId: 1 });
    const getBody = (await getRes.json()) as {
      result: {
        workspaceId: number;
        primaryLowDollars: number;
        primaryHighDollars: number;
        spouseLowDollars: number;
        spouseHighDollars: number;
      };
    };
    expect(getBody.result.workspaceId).toBe(1);
    expect(getBody.result.primaryLowDollars).toBe(50000);
    expect(getBody.result.primaryHighDollars).toBe(200000);
    expect(getBody.result.spouseLowDollars).toBe(0);
    expect(getBody.result.spouseHighDollars).toBe(100000);
  });

  it("set is an upsert: a second set overwrites the existing row", async () => {
    const app = await freshApp();
    await postTool(app, "set_sensitivity_settings", {
      workspaceId: 1,
      primaryLowDollars: 50000,
      primaryHighDollars: 200000,
      spouseLowDollars: 0,
      spouseHighDollars: 100000,
      confirm: true,
    });
    await postTool(app, "set_sensitivity_settings", {
      workspaceId: 1,
      primaryLowDollars: 60000,
      primaryHighDollars: 150000,
      spouseLowDollars: 10000,
      spouseHighDollars: 90000,
      confirm: true,
    });
    const getRes = await postTool(app, "get_sensitivity_settings", { workspaceId: 1 });
    const getBody = (await getRes.json()) as {
      result: { primaryLowDollars: number; spouseLowDollars: number };
    };
    expect(getBody.result.primaryLowDollars).toBe(60000);
    expect(getBody.result.spouseLowDollars).toBe(10000);
  });

  it("set_sensitivity_settings rejects an inverted primary range (lo >= hi)", async () => {
    const app = await freshApp();
    const res = await postTool(app, "set_sensitivity_settings", {
      workspaceId: 1,
      primaryLowDollars: 200000,
      primaryHighDollars: 50000,
      spouseLowDollars: 0,
      spouseHighDollars: 100000,
      confirm: true,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("compute_sensitivity still works alongside the persisted ranges", async () => {
    const app = await freshApp();
    // Persist ranges, then run the grid for those same ranges.
    await postTool(app, "set_sensitivity_settings", {
      workspaceId: 1,
      primaryLowDollars: 50000,
      primaryHighDollars: 200000,
      spouseLowDollars: 0,
      spouseHighDollars: 100000,
      confirm: true,
    });
    const res = await postTool(app, "compute_sensitivity", {
      workspaceId: 1,
      primaryRangeDollars: [50000, 200000],
      spouseRangeDollars: [0, 100000],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { primaryAxisDollars: number[]; spouseAxisDollars: number[]; grid: number[][] };
    };
    expect(body.result.grid).toHaveLength(5);
    expect(body.result.grid[0]).toHaveLength(5);
    expect(body.result.primaryAxisDollars[0]).toBe(50000);
    expect(body.result.spouseAxisDollars[4]).toBe(100000);
  });

  it("deleting a workspace cascades its sensitivity_settings row away", async () => {
    const app = await freshApp();
    // Clone Current to a scenario so we have a deletable workspace.
    const cloneRes = await postTool(app, "clone_workspace", { id: 1, name: "SensScenario", confirm: true });
    const cloneBody = (await cloneRes.json()) as { result: { id: number } };
    const wsId = cloneBody.result.id;
    await postTool(app, "set_sensitivity_settings", {
      workspaceId: wsId,
      primaryLowDollars: 50000,
      primaryHighDollars: 200000,
      spouseLowDollars: 0,
      spouseHighDollars: 100000,
      confirm: true,
    });
    // Sanity: the row exists.
    let getBody = (await (await postTool(app, "get_sensitivity_settings", { workspaceId: wsId })).json()) as {
      result: unknown;
    };
    expect(getBody.result).not.toBeNull();
    // Delete the workspace → FK ON DELETE CASCADE removes the settings row.
    await postTool(app, "delete_workspace", { id: wsId, confirm: true });
    getBody = (await (await postTool(app, "get_sensitivity_settings", { workspaceId: wsId })).json()) as {
      result: unknown;
    };
    expect(getBody.result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// C1 — mutation gate on POST /api/tools/:name (audit findings API-3 / API-4).
// Mutating tools require `"confirm": true` in the body; without it the route
// answers 409 with a structured needs_confirmation error. Read-only tools
// are never gated. The refusal must happen BEFORE any state changes.
// ---------------------------------------------------------------------------
describe("C1 — mutation gate on POST /api/tools/:name", () => {
  it("refuses a mutating tool without confirm: 409 + structured error, nothing written", async () => {
    const app = await freshApp();
    const res = await app.request("/api/tools/add_expense", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: 1,
        label: "Unconfirmed",
        amountDollars: 99,
        frequency: "monthly",
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      ok: boolean;
      error: string;
      tool: string;
      message: string;
    };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("needs_confirmation");
    expect(body.tool).toBe("add_expense");
    expect(body.message).toMatch(/"confirm": true/);

    // The mutation must NOT have run.
    const { openDb } = await import("@budgetkit/db");
    const db = openDb();
    const row = db.prepare("SELECT label FROM expenses WHERE label = ?").get("Unconfirmed");
    expect(row).toBeUndefined();
  });

  it("confirm: false is NOT consent — still 409", async () => {
    const app = await freshApp();
    const res = await app.request("/api/tools/delete_workspace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 1, confirm: false }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("needs_confirmation");
  });

  it("executes the same call once confirm: true is supplied (and strips the key)", async () => {
    const app = await freshApp();
    const res = await app.request("/api/tools/add_expense", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: 1,
        label: "Confirmed",
        amountDollars: 12,
        frequency: "monthly",
        confirm: true,
      }),
    });
    // 200 (not a 400 "unknown field confirm") proves the key was stripped
    // before schema validation — add_expense uses additionalProperties:false.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; result: { id: number } };
    expect(body.ok).toBe(true);
    expect(body.result.id).toBeGreaterThan(0);
  });

  it("read-only tools run without confirm (unaffected by the gate)", async () => {
    const app = await freshApp();
    const res = await app.request("/api/tools/list_workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; result: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.result).toHaveLength(1);
  });

  it("malformed args fail validation (400) even without confirm — validation precedes the gate", async () => {
    const app = await freshApp();
    const res = await app.request("/api/tools/add_expense", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: 1, label: "X" }), // missing amount/freq
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("validation");
  });

  it("a blocked attempt is still recorded in the audit log (refusals are auditable)", async () => {
    const app = await freshApp();
    await app.request("/api/tools/add_expense", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: 1,
        label: "BlockedAudit",
        amountDollars: 5,
        frequency: "monthly",
      }),
    });
    const { openDb } = await import("@budgetkit/db");
    const db = openDb();
    const rows = db
      .prepare("SELECT tool_name, result_json FROM tools_call_log ORDER BY id")
      .all() as Array<{ tool_name: string; result_json: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tool_name).toBe("add_expense");
    expect(JSON.parse(rows[0]!.result_json)).toMatchObject({
      ok: false,
      error: "needs_confirmation",
    });
    // Redaction still applies to blocked attempts: no raw label in the log.
    const argsRow = db
      .prepare("SELECT args_json FROM tools_call_log ORDER BY id")
      .get() as { args_json: string };
    expect(argsRow.args_json).not.toContain("BlockedAudit");
  });
});

// ---------------------------------------------------------------------------
// query_transactions — real SQLite aggregation — and the /custom page document
// over REST, where the mutation gate still applies (chat auto-applies it, this
// transport does not).
// ---------------------------------------------------------------------------

describe("query_transactions — grouped aggregation over seeded SQL", () => {
  async function freshCtx() {
    const { openDb, migrate, buildToolCtx } = await import("@budgetkit/db");
    const db = openDb();
    migrate(db);
    return buildToolCtx(db, "api_direct");
  }

  /** Seed one import's worth of rows. 2026-08-04 and 2026-08-11 are Tuesdays
   *  (dayOfWeek 2); their Sunday-start week keys are 2026-08-02 and
   *  2026-08-09. 2026-08-05 is a Wednesday in the SAME week as the first
   *  Tuesday, so a leaking weekday filter shows up in the sums. */
  function seed(ctx: Awaited<ReturnType<typeof freshCtx>>, catId: number): void {
    const rec = ctx.statementImports.record({
      sourceAccount: "chase",
      fileHash: `hash-${Math.random()}`,
      filePath: "statements/seed.csv",
      txnCount: 6,
    });
    ctx.transactions.insertMany(rec.importId, [
      { postedDate: "2026-08-04", merchantRaw: "WHOLE FOODS", merchantNormalized: "whole foods", amountDollars: -40, categoryId: catId, accountType: "chase" },
      { postedDate: "2026-08-04", merchantRaw: "TRADER JOES", merchantNormalized: "trader joes", amountDollars: -25, categoryId: catId, accountType: "chase" },
      { postedDate: "2026-08-11", merchantRaw: "WHOLE FOODS", merchantNormalized: "whole foods", amountDollars: -30, categoryId: catId, accountType: "chase" },
      // Wednesday, same week as 2026-08-04 — excluded by dayOfWeek:2.
      { postedDate: "2026-08-05", merchantRaw: "WHOLE FOODS", merchantNormalized: "whole foods", amountDollars: -100, categoryId: catId, accountType: "chase" },
      // A Tuesday CREDIT — excluded unless includeCredits.
      { postedDate: "2026-08-11", merchantRaw: "WHOLE FOODS", merchantNormalized: "whole foods", amountDollars: 10, categoryId: catId, accountType: "chase" },
      // Uncategorized Tuesday charge — lands in its own 'uncat' bucket.
      { postedDate: "2026-08-04", merchantRaw: "CORNER STORE", merchantNormalized: "corner store", amountDollars: -5, categoryId: null, accountType: "chase" },
    ]);
  }

  async function query(app: Hono, args: object) {
    const res = await app.request("/api/tools/query_transactions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        groups: Array<{ key: string; value: number; count: number }>;
        totalGroups: number;
        truncated: boolean;
      };
    };
    return body.result;
  }

  it("dayOfWeek:2 + groupBy:week returns only Tuesday charges, keyed by Sunday week-starts", async () => {
    const ctx = await freshCtx();
    const app = await freshApp();
    const catId = ctx.categories.listByName().get("Food")!;
    seed(ctx, catId);

    const r = await query(app, { categoryId: catId, dayOfWeek: 2, groupBy: "week" });
    // 2026-08-04 (40+25) in week 2026-08-02; 2026-08-11 (30) in week 2026-08-09.
    // The Wednesday $100 and the Tuesday credit are both absent.
    expect(r.groups).toEqual([
      { key: "2026-08-02", value: 65, count: 2 },
      { key: "2026-08-09", value: 30, count: 1 },
    ]);
    expect(r.totalGroups).toBe(2);
    expect(r.truncated).toBe(false);
  });

  it("groupBy day / dayOfWeek key on the date and the weekday number", async () => {
    const ctx = await freshCtx();
    const app = await freshApp();
    const catId = ctx.categories.listByName().get("Food")!;
    seed(ctx, catId);

    const byDay = await query(app, { categoryId: catId, groupBy: "day" });
    expect(byDay.groups.map((g) => g.key)).toEqual(["2026-08-04", "2026-08-05", "2026-08-11"]);
    expect(byDay.groups[0]!.value).toBe(65);

    const byDow = await query(app, { categoryId: catId, groupBy: "dayOfWeek" });
    // '2' = Tuesday (65 + 30), '3' = Wednesday (100).
    expect(byDow.groups).toEqual([
      { key: "2", value: 95, count: 3 },
      { key: "3", value: 100, count: 1 },
    ]);
  });

  it("groupBy:category buckets NULL categories as 'uncat' and orders by spend DESC", async () => {
    const ctx = await freshCtx();
    const app = await freshApp();
    const catId = ctx.categories.listByName().get("Food")!;
    seed(ctx, catId);

    const r = await query(app, { groupBy: "category" });
    expect(r.groups[0]!.key).toBe(String(catId));
    expect(r.groups[0]!.value).toBe(195); // 40+25+30+100
    expect(r.groups[1]).toEqual({ key: "uncat", value: 5, count: 1 });
  });

  it("groupBy:merchant orders by spend DESC and truncates with totalGroups intact", async () => {
    const ctx = await freshCtx();
    const app = await freshApp();
    const catId = ctx.categories.listByName().get("Food")!;
    seed(ctx, catId);

    const all = await query(app, { groupBy: "merchant" });
    expect(all.groups.map((g) => g.key)).toEqual(["whole foods", "trader joes", "corner store"]);
    expect(all.truncated).toBe(false);

    const capped = await query(app, { groupBy: "merchant", limit: 1 });
    expect(capped.groups).toHaveLength(1);
    expect(capped.groups[0]!.key).toBe("whole foods");
    expect(capped.totalGroups).toBe(3);
    expect(capped.truncated).toBe(true);
  });

  it("metric count/avg select the other columns; includeCredits nets the refund out", async () => {
    const ctx = await freshCtx();
    const app = await freshApp();
    const catId = ctx.categories.listByName().get("Food")!;
    seed(ctx, catId);

    const counted = await query(app, {
      categoryId: catId, dayOfWeek: 2, groupBy: "week", metric: "count",
    });
    expect(counted.groups.map((g) => g.value)).toEqual([2, 1]);

    const avg = await query(app, {
      categoryId: catId, dayOfWeek: 2, groupBy: "week", metric: "avg",
    });
    expect(avg.groups[0]!.value).toBe(32.5); // (40+25)/2

    // With credits the +10 refund on 2026-08-11 subtracts from that week.
    const net = await query(app, {
      categoryId: catId, dayOfWeek: 2, groupBy: "week", includeCredits: true,
    });
    expect(net.groups).toEqual([
      { key: "2026-08-02", value: 65, count: 2 },
      { key: "2026-08-09", value: 20, count: 2 },
    ]);
  });

  it("returns an empty group list (not an error) when nothing matches", async () => {
    const app = await freshApp();
    const r = await query(app, { groupBy: "week", from: "2030-01-01" });
    expect(r.groups).toEqual([]);
    expect(r.totalGroups).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it("rejects a groupBy outside the enum before any SQL is built", async () => {
    const app = await freshApp();
    const res = await app.request("/api/tools/query_transactions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ groupBy: "posted_date); DROP TABLE transactions;--" }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("custom page over REST — the mutation gate still applies", () => {
  const definition = {
    action: "set",
    title: "Tuesday food",
    queries: [{ id: "food", tool: "query_transactions", args: { groupBy: "week", dayOfWeek: 2 } }],
    render: 'bk.note(root, "hi");',
  };

  async function getPage(app: Hono, args: object = {}) {
    const res = await app.request("/api/tools/get_custom_page", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        exists: boolean;
        updatedAt: string | null;
        definition: { title: string } | null;
        hasPrevious: boolean;
        guide?: string;
      };
    };
    return body.result;
  }

  it("set_custom_page without confirm → 409; with confirm:true → saved and persisted", async () => {
    const app = await freshApp();
    const refused = await app.request("/api/tools/set_custom_page", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(definition),
    });
    expect(refused.status).toBe(409);
    expect((await getPage(app)).exists).toBe(false);

    const ok = await app.request("/api/tools/set_custom_page", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...definition, confirm: true }),
    });
    expect(ok.status).toBe(200);

    // Readable through a fresh router instance — the definition really is in
    // the DB, which is what makes a Stop mid-turn safe (addendum A2): the
    // write either committed or it didn't, never half.
    const page = await getPage(await freshApp());
    expect(page.exists).toBe(true);
    expect(page.definition!.title).toBe("Tuesday food");
    expect(page.updatedAt).toBeTruthy();
  });

  it("get_custom_page serves the authoring guide only on request", async () => {
    const app = await freshApp();
    expect((await getPage(app)).guide).toBeUndefined();
    const withGuide = await getPage(app, { includeGuide: true });
    expect(withGuide.guide).toMatch(/CUSTOM PAGE AUTHORING GUIDE/);
  });

  it("a query naming a non-allowlisted tool is rejected at write time", async () => {
    const app = await freshApp();
    const res = await app.request("/api/tools/set_custom_page", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...definition,
        queries: [{ id: "boom", tool: "delete_expense", args: { id: 1 } }],
        confirm: true,
      }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await getPage(app)).exists).toBe(false);
  });
});
