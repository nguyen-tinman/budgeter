// Real-DB repository tests for the round2 write boundary (money.ts contract):
// every monetary value WRITTEN to the DB is rounded to the cent. Verify
// expense/income/savings repo add+update round *.005-style inputs before
// storing them. (Credit-exclusion regression lives in credit_exclusion.test.ts.)

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "budgetkit-money-test-"));
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
  // Fresh DB per test for isolation (same pattern as tools.test.ts).
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

// The migration seeds a 'Current' workspace at id 1.
const WS = 1;

describe("A3 — round2 at DB write boundaries", () => {
  it("expense add+update round amountDollars to the cent (incl. negative charges)", async () => {
    const { ctx } = await freshCtx();
    // 10.005 ties up → 10.01; a negative charge -10.005 ties away from zero → -10.01.
    const { id: posId } = ctx.expenses.add({
      workspaceId: WS,
      label: "round-up",
      amountDollars: 10.005,
      frequency: "monthly",
    });
    const { id: negId } = ctx.expenses.add({
      workspaceId: WS,
      label: "neg-charge",
      amountDollars: -10.005,
      frequency: "monthly",
    });
    const afterAdd = ctx.expenses.list(WS);
    expect(afterAdd.find((e) => e.id === posId)!.amountDollars).toBe(10.01);
    expect(afterAdd.find((e) => e.id === negId)!.amountDollars).toBe(-10.01);

    // update also rounds.
    ctx.expenses.update({ id: posId, amountDollars: 1.005 });
    expect(ctx.expenses.list(WS).find((e) => e.id === posId)!.amountDollars).toBe(1.01);
  });

  it("income add+update round grossAnnualDollars to the cent", async () => {
    const { ctx } = await freshCtx();
    const { id } = ctx.incomes.add({
      workspaceId: WS,
      label: "Salary",
      grossAnnualDollars: 120000.005,
      taxStatus: "taxed",
    });
    expect(ctx.incomes.list(WS).find((i) => i.id === id)!.grossAnnualDollars).toBe(120000.01);

    ctx.incomes.update({ id, grossAnnualDollars: 99999.995 });
    expect(ctx.incomes.list(WS).find((i) => i.id === id)!.grossAnnualDollars).toBe(100000.0);
  });

  it("savings add+update round the monetary columns to the cent", async () => {
    const { ctx } = await freshCtx();
    const { id } = ctx.savings.add({
      workspaceId: WS,
      label: "HYSA",
      accountType: "hysa",
      currentBalanceDollars: 50000.005,
      targetBalanceDollars: 75000.005,
      monthlyContributionDollars: 500.005,
    });
    const row = ctx.savings.list(WS).find((s) => s.id === id)!;
    expect(row.currentBalanceDollars).toBe(50000.01);
    expect(row.targetBalanceDollars).toBe(75000.01);
    expect(row.monthlyContributionDollars).toBe(500.01);

    ctx.savings.update({ id, currentBalanceDollars: 1.005, targetBalanceDollars: null });
    const updated = ctx.savings.list(WS).find((s) => s.id === id)!;
    expect(updated.currentBalanceDollars).toBe(1.01);
    expect(updated.targetBalanceDollars).toBeNull();
  });
});
