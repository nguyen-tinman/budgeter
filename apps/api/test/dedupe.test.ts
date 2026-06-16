// Duplicate handling for budget items: the catalogue commit guard (identical
// label/amount/frequency/spend-date candidates are skipped + reported) and
// the dedupe_expenses cleanup tool. Real DB through the REST surface.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "budgetkit-dedupe-test-"));
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

async function freshApp(): Promise<Hono> {
  const { openDb, migrate } = await import("@budgetkit/db");
  const { toolsRouter } = await import("../src/routes/tools.js");
  const db = openDb();
  migrate(db);
  const app = new Hono();
  app.route("/api/tools", toolsRouter());
  return app;
}

async function call<T>(app: Hono, tool: string, body: Record<string, unknown>): Promise<T> {
  const res = await app.request(`/api/tools/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: true, ...body }),
  });
  const json = (await res.json()) as { ok: boolean; result: T; message?: string };
  expect(res.status, json.message).toBe(200);
  return json.result;
}

const ITEM = {
  workspaceId: 1,
  label: "Big Couch Purchase",
  amountDollars: 899.99,
  frequency: "one_time",
  spendDate: "2026-04-10",
};

describe("dedupe_expenses tool", () => {
  it("dryRun previews duplicate groups without deleting; commit keeps the oldest", async () => {
    const app = await freshApp();
    const a = await call<{ id: number }>(app, "add_expense", ITEM);
    const b = await call<{ id: number }>(app, "add_expense", ITEM);
    // Same label different DATE — not a duplicate.
    await call(app, "add_expense", { ...ITEM, spendDate: "2026-05-10" });
    // Case/whitespace variant — still a duplicate of the first two.
    const c = await call<{ id: number }>(app, "add_expense", {
      ...ITEM,
      label: "  big couch   purchase ",
    });

    const dry = await call<{
      dryRun: boolean;
      groupCount: number;
      duplicateCount: number;
      removed: number;
      groups: Array<{ keepId: number; removeIds: number[] }>;
    }>(app, "dedupe_expenses", { workspaceId: 1, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.groupCount).toBe(1);
    expect(dry.duplicateCount).toBe(2);
    expect(dry.removed).toBe(0);
    expect(dry.groups[0]!.keepId).toBe(a.id); // oldest survives
    expect(dry.groups[0]!.removeIds.sort()).toEqual([b.id, c.id].sort());

    // dryRun deleted nothing: a + b + different-date + case-variant = 4 rows.
    const before = await call<Array<{ id: number }>>(app, "list_expenses", { workspaceId: 1 });
    expect(before).toHaveLength(4);

    const run = await call<{ removed: number }>(app, "dedupe_expenses", { workspaceId: 1 });
    expect(run.removed).toBe(2);
    const after = await call<Array<{ id: number; spendDate: string | null }>>(
      app,
      "list_expenses",
      { workspaceId: 1 },
    );
    expect(after).toHaveLength(1 + 1); // kept original + the different-date item
    expect(after.map((e) => e.id)).toContain(a.id);
  });

  it("reports nothing on a clean workspace", async () => {
    const app = await freshApp();
    await call(app, "add_expense", ITEM);
    const dry = await call<{ groupCount: number; duplicateCount: number }>(
      app,
      "dedupe_expenses",
      { workspaceId: 1, dryRun: true },
    );
    expect(dry.groupCount).toBe(0);
    expect(dry.duplicateCount).toBe(0);
  });
});

describe("catalogue_expenses commit duplicate guard (import twice end-to-end)", () => {
  it("second commit of the same statement writes nothing and reports the duplicates", async () => {
    const { existsSync, writeFileSync, rmSync: rm } = await import("node:fs");
    const { resolve } = await import("node:path");
    const projectRoot = resolve(__dirname, "..", "..", "..");
    const statementsRoot = resolve(projectRoot, "statements");
    if (!existsSync(statementsRoot)) return; // fresh checkout — covered by unit tests
    const fixture = resolve(statementsRoot, "zz-dedupe-test-fixture-chase.csv");
    const prevCwd = process.cwd();
    process.chdir(projectRoot);
    try {
      writeFileSync(
        fixture,
        "Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n" +
          "06/01/2026,06/02/2026,ZZ DEDUPE TEST SOFA,Home,Sale,-450.00,\n",
        "utf8",
      );
      const app = await freshApp();
      const args = {
        statementPaths: ["statements/zz-dedupe-test-fixture-chase.csv"],
        workspaceId: 1,
        commit: true,
      };
      type CommitResult = {
        committedIds?: number[];
        skippedDuplicates?: Array<{ label: string; amountDollars: number }>;
      };
      const first = await call<CommitResult>(app, "catalogue_expenses", args);
      expect(first.committedIds?.length).toBe(1);
      expect(first.skippedDuplicates ?? []).toHaveLength(0);

      const second = await call<CommitResult>(app, "catalogue_expenses", args);
      expect(second.committedIds ?? []).toHaveLength(0); // nothing written
      expect(second.skippedDuplicates).toHaveLength(1); // and the user is told why
      expect(second.skippedDuplicates![0]!.label).toMatch(/ZZ DEDUPE TEST SOFA/i);

      const rows = await call<Array<{ label: string }>>(app, "list_expenses", { workspaceId: 1 });
      expect(rows.filter((r) => /ZZ DEDUPE TEST SOFA/i.test(r.label))).toHaveLength(1);
    } finally {
      rm(fixture, { force: true });
      process.chdir(prevCwd);
    }
  });
});

describe("expenseDupKey semantics", () => {
  // Build a statements/ fixture inside the test cwd? No — catalogue resolves
  // ./statements relative to the API cwd, which is the repo. Instead exercise
  // the guard through the SAME code path it protects by seeding an identical
  // expense first and re-using a real candidate-shaped flow: add the expense
  // via add_expense, then verify a second identical add through the import
  // guard helper key matches. The end-to-end statement-file path is covered
  // by the existing tools.test.ts import round-trip; here we assert the key
  // semantics that drive both the guard and the tool.
  it("expenseDupKey treats case/whitespace label variants and equal amounts as identical, distinct dates as distinct", async () => {
    const { expenseDupKey } = await import("@budgetkit/core");
    const base = { label: "Netflix", amountDollars: 15.49, frequency: "monthly", spendDate: null };
    expect(expenseDupKey(base)).toBe(
      expenseDupKey({ ...base, label: "  netflix " }),
    );
    expect(expenseDupKey(base)).not.toBe(
      expenseDupKey({ ...base, amountDollars: 15.5 }),
    );
    expect(
      expenseDupKey({ ...base, frequency: "one_time", spendDate: "2026-01-01" }),
    ).not.toBe(expenseDupKey({ ...base, frequency: "one_time", spendDate: "2026-02-01" }));
  });
});
