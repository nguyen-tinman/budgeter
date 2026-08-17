// Committed SQL coverage for packages/db/src/repositories.ts methods that
// previously had zero test coverage: taxRepo.setSettingsForWorkspace,
// transactionRepo.search, transactionRepo.topMerchants,
// transactionRepo.listChargeRowsInRange, and the backfillOneTimeSpendDates
// integration. Real SQLite (openDb + migrate + buildToolCtx), no fakes —
// same pattern as tools.test.ts's "C1 — import persistence" describe block.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "budgetkit-repositories-sql-test-"));
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
  return buildToolCtx(db, "api_direct");
}

/** Strip a workspace's tax_settings row. workspaceRepo.create() now seeds one
 *  (a workspace without it can't compute take-home at all), so exercising
 *  setSettingsForWorkspace's CREATE branch requires removing it first — the
 *  state a workspace created before that fix would be in. */
async function dropTaxSettings(workspaceId: number): Promise<void> {
  const { openDb } = await import("@budgetkit/db");
  openDb().prepare("DELETE FROM tax_settings WHERE workspace_id = ?").run(workspaceId);
}

/** Seed a statement_imports row and insert the given charge/credit rows via
 *  the real insertMany path, defaulting merchantNormalized/accountType/
 *  categoryId so call sites only spell out what the test cares about. */
function seedTxns(
  ctx: Awaited<ReturnType<typeof freshCtx>>,
  rows: Array<{
    postedDate: string;
    merchantRaw: string;
    merchantNormalized?: string;
    amountDollars: number;
    categoryId?: number | null;
    accountType?: string;
  }>,
): void {
  const rec = ctx.statementImports.record({
    sourceAccount: "chase",
    fileHash: `hash-${Math.random()}`,
    filePath: `statements/seed-${Math.random()}.csv`,
    txnCount: rows.length,
  });
  ctx.transactions.insertMany(
    rec.importId,
    rows.map((r) => ({
      postedDate: r.postedDate,
      merchantRaw: r.merchantRaw,
      merchantNormalized: r.merchantNormalized ?? r.merchantRaw.toLowerCase(),
      amountDollars: r.amountDollars,
      categoryId: r.categoryId ?? null,
      accountType: r.accountType ?? "chase",
    })),
  );
}

// ---------------------------------------------------------------------------
// taxRepo.setSettingsForWorkspace
// ---------------------------------------------------------------------------
describe("taxRepo.setSettingsForWorkspace", () => {
  it("partial update on an existing row touches ONLY the supplied columns", async () => {
    const ctx = await freshCtx();
    // Workspace 1 ("Current") is seeded with a tax_settings row by migration
    // 001: filing_status='single', tax_year=2025, and schema defaults for the
    // rest.
    const before = ctx.tax.settingsForWorkspace(1);
    expect(before).toEqual({
      filing: "single",
      taxYear: 2025,
      caSdiRate: 0.011,
      ssWageBaseDollars: 176100,
      ficaSsRate: 0.062,
      ficaMedicareRate: 0.0145,
      retirementEffectiveTaxRate: 0.12,
    });

    const r = ctx.tax.setSettingsForWorkspace({ workspaceId: 1, ficaSsRate: 0.07 });
    expect(r).toEqual({ saved: true, created: false });

    const after = ctx.tax.settingsForWorkspace(1);
    expect(after.ficaSsRate).toBe(0.07);
    // Every other column preserved exactly.
    expect(after.filing).toBe(before.filing);
    expect(after.taxYear).toBe(before.taxYear);
    expect(after.caSdiRate).toBe(before.caSdiRate);
    expect(after.ssWageBaseDollars).toBe(before.ssWageBaseDollars);
    expect(after.ficaMedicareRate).toBe(before.ficaMedicareRate);
    expect(after.retirementEffectiveTaxRate).toBe(before.retirementEffectiveTaxRate);
  });

  it("empty args (workspaceId only) on an existing row is a no-op", async () => {
    const ctx = await freshCtx();
    const before = ctx.tax.settingsForWorkspace(1);
    const r = ctx.tax.setSettingsForWorkspace({ workspaceId: 1 });
    expect(r).toEqual({ saved: false, created: false });
    expect(ctx.tax.settingsForWorkspace(1)).toEqual(before);
  });

  it("create branch on a workspace with no tax_settings row rejects when filing/taxYear are missing", async () => {
    const ctx = await freshCtx();
    const ws = ctx.workspaces.create({ name: "No Tax Row", kind: "scenario" });
    await dropTaxSettings(ws.id);
    expect(() =>
      ctx.tax.setSettingsForWorkspace({ workspaceId: ws.id, caSdiRate: 0.02 }),
    ).toThrow(/filing.*taxYear|taxYear.*filing/i);
    // Nothing was written.
    expect(() => ctx.tax.settingsForWorkspace(ws.id)).toThrow();
  });

  it("create branch with only filing+taxYear supplied takes schema DEFAULTs for every omitted column", async () => {
    const ctx = await freshCtx();
    const ws = ctx.workspaces.create({ name: "New Tax Row", kind: "scenario" });
    await dropTaxSettings(ws.id);
    const r = ctx.tax.setSettingsForWorkspace({
      workspaceId: ws.id,
      filing: "mfj",
      taxYear: 2026,
    });
    expect(r).toEqual({ saved: true, created: true });

    const row = ctx.tax.settingsForWorkspace(ws.id);
    expect(row.filing).toBe("mfj");
    expect(row.taxYear).toBe(2026);
    expect(row.caSdiRate).toBe(0.011);
    expect(row.ficaSsRate).toBe(0.062);
    expect(row.ficaMedicareRate).toBe(0.0145);
    expect(row.retirementEffectiveTaxRate).toBe(0.12);
    expect(row.ssWageBaseDollars).toBe(176100);
  });

  it("create branch with every optional column supplied stores exactly those values (no ON CONFLICT clobbering)", async () => {
    const ctx = await freshCtx();
    const ws = ctx.workspaces.create({ name: "Full Tax Row", kind: "scenario" });
    await dropTaxSettings(ws.id);
    ctx.tax.setSettingsForWorkspace({
      workspaceId: ws.id,
      filing: "single",
      taxYear: 2027,
      caSdiRate: 0.02,
      ssWageBaseDollars: 200000,
      ficaSsRate: 0.05,
      ficaMedicareRate: 0.02,
      retirementEffectiveTaxRate: 0.15,
    });
    const row = ctx.tax.settingsForWorkspace(ws.id);
    expect(row).toEqual({
      filing: "single",
      taxYear: 2027,
      caSdiRate: 0.02,
      ssWageBaseDollars: 200000,
      ficaSsRate: 0.05,
      ficaMedicareRate: 0.02,
      retirementEffectiveTaxRate: 0.15,
    });
  });
});

// ---------------------------------------------------------------------------
// workspaceRepo.create — tax_settings seeding
// ---------------------------------------------------------------------------
describe("workspaceRepo.create seeds tax_settings", () => {
  it("copies the 'Current' workspace's row so a new scenario can compute take-home", async () => {
    const ctx = await freshCtx();
    // Move Current off every default so a copy is distinguishable from the
    // DDL fallback.
    ctx.tax.setSettingsForWorkspace({
      workspaceId: 1,
      filing: "mfj",
      taxYear: 2031,
      caSdiRate: 0.021,
      ssWageBaseDollars: 190000,
      ficaSsRate: 0.061,
      ficaMedicareRate: 0.0155,
      retirementEffectiveTaxRate: 0.19,
    });
    const current = ctx.tax.settingsForWorkspace(1);

    const ws = ctx.workspaces.create({ name: "Scenario A", kind: "scenario" });
    // Previously this threw: the scenario had no tax_settings row at all.
    expect(ctx.tax.settingsForWorkspace(ws.id)).toEqual(current);
  });

  it("compute_take_home works on a freshly created scenario", async () => {
    const { ToolRegistry, ALL_TOOLS } = await import("@budgetkit/core");
    const ctx = await freshCtx();
    const registry = new ToolRegistry(ALL_TOOLS);
    const ws = ctx.workspaces.create({ name: "Scenario B", kind: "scenario" });
    ctx.incomes.add({
      workspaceId: ws.id,
      label: "Salary",
      grossAnnualDollars: 120000,
      taxStatus: "taxed",
      filingRole: "primary",
    });
    const res = (await registry.invoke("compute_take_home", { workspaceId: ws.id }, ctx)) as {
      monthlyTakeHomeDollars: number;
    };
    expect(res.monthlyTakeHomeDollars).toBeGreaterThan(0);
  });

  it("falls back to DDL defaults (single, current year) when there is no 'Current' workspace", async () => {
    const ctx = await freshCtx();
    const { openDb } = await import("@budgetkit/db");
    // Re-kind the seeded workspace so no 'current' row remains to copy from.
    openDb().prepare("UPDATE workspaces SET kind = 'scenario' WHERE id = 1").run();

    const ws = ctx.workspaces.create({ name: "Orphan", kind: "scenario" });
    expect(ctx.tax.settingsForWorkspace(ws.id)).toEqual({
      filing: "single",
      taxYear: new Date().getFullYear(),
      caSdiRate: 0.011,
      ssWageBaseDollars: 176100,
      ficaSsRate: 0.062,
      ficaMedicareRate: 0.0145,
      retirementEffectiveTaxRate: 0.12,
    });
  });
});

// ---------------------------------------------------------------------------
// transactionRepo.search
// ---------------------------------------------------------------------------
describe("transactionRepo.search", () => {
  it("merchant substring match is case-insensitive against merchant_raw and merchant_normalized", async () => {
    const ctx = await freshCtx();
    seedTxns(ctx, [
      { postedDate: "2026-01-05", merchantRaw: "WHOLE FOODS MKT", merchantNormalized: "whole foods mkt", amountDollars: -42.5 },
      { postedDate: "2026-01-06", merchantRaw: "Trader Joes", merchantNormalized: "trader joes", amountDollars: -18 },
    ]);
    const byRawCase = ctx.transactions.search({ merchant: "WHOLE", limit: 10, offset: 0 });
    expect(byRawCase.totalMatched).toBe(1);
    expect(byRawCase.rows[0]!.merchantRaw).toBe("WHOLE FOODS MKT");

    const byMixedCase = ctx.transactions.search({ merchant: "whole foods", limit: 10, offset: 0 });
    expect(byMixedCase.totalMatched).toBe(1);
    expect(byMixedCase.rows[0]!.merchantNormalized).toBe("whole foods mkt");
  });

  it("LIKE-wildcard characters in the search term are treated literally, not as SQL wildcards", async () => {
    const ctx = await freshCtx();
    seedTxns(ctx, [
      { postedDate: "2026-01-01", merchantRaw: "100% Off Deal", merchantNormalized: "100% off deal", amountDollars: -10 },
      { postedDate: "2026-01-02", merchantRaw: "Under_Score Shop", merchantNormalized: "under_score shop", amountDollars: -12 },
      { postedDate: "2026-01-03", merchantRaw: "Plain Store", merchantNormalized: "plain store", amountDollars: -14 },
    ]);

    // A literal "%" search must match ONLY the row containing a literal '%',
    // not every row (which an unescaped LIKE '%%%' would do).
    const pct = ctx.transactions.search({ merchant: "%", limit: 10, offset: 0 });
    expect(pct.totalMatched).toBe(1);
    expect(pct.rows[0]!.merchantRaw).toBe("100% Off Deal");

    // A literal "_" search must match ONLY the row containing a literal '_',
    // not every row (an unescaped '_' matches any single character).
    const underscore = ctx.transactions.search({ merchant: "_", limit: 10, offset: 0 });
    expect(underscore.totalMatched).toBe(1);
    expect(underscore.rows[0]!.merchantRaw).toBe("Under_Score Shop");
  });

  it("a literal backslash in the search term matches only backslash rows and never errors", async () => {
    const ctx = await freshCtx();
    seedTxns(ctx, [
      { postedDate: "2026-01-01", merchantRaw: "ACME\\Sub Unit", merchantNormalized: "acme\\sub unit", amountDollars: -20 },
      { postedDate: "2026-01-02", merchantRaw: "Plain Store", merchantNormalized: "plain store", amountDollars: -25 },
    ]);
    // Backslash is the ESCAPE character, so an unescaped one would either
    // swallow the following character or raise "ESCAPE expression must be a
    // single character".
    const hit = ctx.transactions.search({ merchant: "\\", limit: 10, offset: 0 });
    expect(hit.totalMatched).toBe(1);
    expect(hit.rows[0]!.merchantRaw).toBe("ACME\\Sub Unit");
  });

  it("a backslash search against data with no backslashes returns 0 rows, not an error", async () => {
    const ctx = await freshCtx();
    seedTxns(ctx, [
      { postedDate: "2026-01-01", merchantRaw: "Plain Store", merchantNormalized: "plain store", amountDollars: -25 },
      { postedDate: "2026-01-02", merchantRaw: "Other Store", merchantNormalized: "other store", amountDollars: -30 },
    ]);
    const miss = ctx.transactions.search({ merchant: "\\", limit: 10, offset: 0 });
    expect(miss.totalMatched).toBe(0);
    expect(miss.rows).toEqual([]);
  });

  it("posted_date bounds are inclusive on both ends", async () => {
    const ctx = await freshCtx();
    seedTxns(ctx, [
      { postedDate: "2026-02-01", merchantRaw: "Edge Low", amountDollars: -10 },
      { postedDate: "2026-02-15", merchantRaw: "Middle", amountDollars: -10 },
      { postedDate: "2026-02-28", merchantRaw: "Edge High", amountDollars: -10 },
      { postedDate: "2026-01-31", merchantRaw: "Before Window", amountDollars: -10 },
      { postedDate: "2026-03-01", merchantRaw: "After Window", amountDollars: -10 },
    ]);
    const res = ctx.transactions.search({ from: "2026-02-01", to: "2026-02-28", limit: 10, offset: 0 });
    expect(res.totalMatched).toBe(3);
    const merchants = res.rows.map((r) => r.merchantRaw).sort();
    expect(merchants).toEqual(["Edge High", "Edge Low", "Middle"]);
  });

  it("min/max amount filters compare against |amount_dollars|", async () => {
    const ctx = await freshCtx();
    seedTxns(ctx, [
      { postedDate: "2026-01-01", merchantRaw: "Small Charge", amountDollars: -5 },
      { postedDate: "2026-01-02", merchantRaw: "Mid Charge", amountDollars: -50 },
      { postedDate: "2026-01-03", merchantRaw: "Big Charge", amountDollars: -500 },
    ]);
    const res = ctx.transactions.search({ minAmountDollars: 10, maxAmountDollars: 100, limit: 10, offset: 0 });
    expect(res.totalMatched).toBe(1);
    expect(res.rows[0]!.merchantRaw).toBe("Mid Charge");
  });

  it("defaults to excluding credits; includeCredits:true admits them", async () => {
    const ctx = await freshCtx();
    seedTxns(ctx, [
      { postedDate: "2026-01-01", merchantRaw: "A Charge", amountDollars: -20 },
      { postedDate: "2026-01-02", merchantRaw: "A Refund", amountDollars: 20 },
    ]);
    const excluding = ctx.transactions.search({ limit: 10, offset: 0 });
    expect(excluding.totalMatched).toBe(1);
    expect(excluding.rows[0]!.merchantRaw).toBe("A Charge");

    const including = ctx.transactions.search({ includeCredits: true, limit: 10, offset: 0 });
    expect(including.totalMatched).toBe(2);
  });

  it("limit/offset paging: pages don't overlap and totalMatched stays constant across pages", async () => {
    const ctx = await freshCtx();
    seedTxns(
      ctx,
      Array.from({ length: 5 }, (_, i) => ({
        postedDate: `2026-01-${String(i + 1).padStart(2, "0")}`,
        merchantRaw: `Store ${i}`,
        amountDollars: -(i + 1),
      })),
    );
    const page1 = ctx.transactions.search({ limit: 2, offset: 0 });
    const page2 = ctx.transactions.search({ limit: 2, offset: 2 });
    const page3 = ctx.transactions.search({ limit: 2, offset: 4 });
    expect(page1.totalMatched).toBe(5);
    expect(page2.totalMatched).toBe(5);
    expect(page3.totalMatched).toBe(5);
    const allIds = [...page1.rows, ...page2.rows, ...page3.rows].map((r) => r.merchantRaw);
    expect(new Set(allIds).size).toBe(5); // no overlap
    expect(page3.rows).toHaveLength(1); // tail page
  });

  it("orders by posted_date DESC, then id DESC as a tiebreak on equal dates", async () => {
    const ctx = await freshCtx();
    // Same posted_date for all three — insertion order determines id order,
    // so the expected result is the REVERSE of insertion order.
    seedTxns(ctx, [
      { postedDate: "2026-04-01", merchantRaw: "First In", amountDollars: -1 },
      { postedDate: "2026-04-01", merchantRaw: "Second In", amountDollars: -2 },
      { postedDate: "2026-04-01", merchantRaw: "Third In", amountDollars: -3 },
    ]);
    const res = ctx.transactions.search({ limit: 10, offset: 0 });
    expect(res.rows.map((r) => r.merchantRaw)).toEqual(["Third In", "Second In", "First In"]);
  });
});

// ---------------------------------------------------------------------------
// transactionRepo.topMerchants
// ---------------------------------------------------------------------------
describe("transactionRepo.topMerchants", () => {
  it("never counts credits, regardless of args", async () => {
    const ctx = await freshCtx();
    seedTxns(ctx, [
      { postedDate: "2026-01-01", merchantRaw: "Costco", merchantNormalized: "costco", amountDollars: -100 },
      { postedDate: "2026-01-02", merchantRaw: "Costco", merchantNormalized: "costco", amountDollars: 100 }, // refund
    ]);
    const rows = ctx.transactions.topMerchants({ limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.merchantNormalized).toBe("costco");
    expect(rows[0]!.txnCount).toBe(1); // only the charge counted
    expect(rows[0]!.totalDollars).toBe(100);
  });

  it("totalDollars is positive and equals the negated sum of charges; sample/count/dates are correct", async () => {
    const ctx = await freshCtx();
    seedTxns(ctx, [
      { postedDate: "2026-01-05", merchantRaw: "COSTCO WHSE #123", merchantNormalized: "costco", amountDollars: -60 },
      { postedDate: "2026-01-20", merchantRaw: "costco.com", merchantNormalized: "costco", amountDollars: -40 },
    ]);
    const rows = ctx.transactions.topMerchants({ limit: 10 });
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.totalDollars).toBe(100); // -(-60 + -40)
    expect(r.txnCount).toBe(2);
    // MIN(merchant_raw) — lexicographically smallest raw string sample.
    expect(r.merchantRawSample).toBe("COSTCO WHSE #123");
    expect(r.firstSeen).toBe("2026-01-05");
    expect(r.lastSeen).toBe("2026-01-20");
  });

  it("orders by totalDollars DESC and respects limit", async () => {
    const ctx = await freshCtx();
    seedTxns(ctx, [
      { postedDate: "2026-01-01", merchantRaw: "Small Spender", merchantNormalized: "small", amountDollars: -10 },
      { postedDate: "2026-01-01", merchantRaw: "Mid Spender", merchantNormalized: "mid", amountDollars: -50 },
      { postedDate: "2026-01-01", merchantRaw: "Big Spender", merchantNormalized: "big", amountDollars: -500 },
    ]);
    const all = ctx.transactions.topMerchants({ limit: 10 });
    expect(all.map((r) => r.merchantNormalized)).toEqual(["big", "mid", "small"]);

    const limited = ctx.transactions.topMerchants({ limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited.map((r) => r.merchantNormalized)).toEqual(["big", "mid"]);
  });
});

// ---------------------------------------------------------------------------
// transactionRepo.listChargeRowsInRange
// ---------------------------------------------------------------------------
describe("transactionRepo.listChargeRowsInRange", () => {
  it("returns categoryId + accountType (the columns listChargeRows lacks) and only charges", async () => {
    const ctx = await freshCtx();
    const catId = ctx.categories.listByName().get("Food") ?? null;
    expect(catId).not.toBeNull();
    seedTxns(ctx, [
      { postedDate: "2026-01-10", merchantRaw: "Grocery Run", amountDollars: -30, categoryId: catId, accountType: "amex_gold" },
      { postedDate: "2026-01-11", merchantRaw: "A Refund", amountDollars: 30, categoryId: catId, accountType: "amex_gold" },
    ]);
    const rows = ctx.transactions.listChargeRowsInRange();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.merchantRaw).toBe("Grocery Run");
    expect(rows[0]!.categoryId).toBe(catId);
    expect(rows[0]!.accountType).toBe("amex_gold");
  });

  it("filters by an optional posted_date window (both bounds inclusive)", async () => {
    const ctx = await freshCtx();
    seedTxns(ctx, [
      { postedDate: "2026-03-01", merchantRaw: "Before", amountDollars: -1 },
      { postedDate: "2026-03-10", merchantRaw: "In Range Low", amountDollars: -1 },
      { postedDate: "2026-03-20", merchantRaw: "In Range High", amountDollars: -1 },
      { postedDate: "2026-03-31", merchantRaw: "After", amountDollars: -1 },
    ]);
    const rows = ctx.transactions.listChargeRowsInRange("2026-03-10", "2026-03-20");
    expect(rows.map((r) => r.merchantRaw).sort()).toEqual(["In Range High", "In Range Low"]);
  });
});

// ---------------------------------------------------------------------------
// backfillOneTimeSpendDates integration (real ctx)
// ---------------------------------------------------------------------------
describe("backfillOneTimeSpendDates integration", () => {
  it("dryRun:true leaves spend_date NULL in the DB; a live run writes the resolved date", async () => {
    const { backfillOneTimeSpendDates } = await import("@budgetkit/core");
    const ctx = await freshCtx();
    seedTxns(ctx, [
      { postedDate: "2026-02-14", merchantRaw: "Fancy Restaurant", merchantNormalized: "fancy restaurant", amountDollars: -123.45 },
    ]);
    const { id } = ctx.expenses.add({
      workspaceId: 1,
      label: "Fancy Restaurant",
      amountDollars: 123.45,
      frequency: "one_time",
      source: "manual",
    });
    expect(ctx.expenses.list(1).find((e) => e.id === id)!.spendDate).toBeNull();

    const dry = backfillOneTimeSpendDates(ctx, { dryRun: true });
    expect(dry.scanned).toBe(1);
    expect(dry.matched).toBe(1);
    expect(dry.changed[0]!.spendDate).toBe("2026-02-14");
    // dryRun must not have written anything.
    expect(ctx.expenses.list(1).find((e) => e.id === id)!.spendDate).toBeNull();

    const live = backfillOneTimeSpendDates(ctx);
    expect(live.matched).toBe(1);
    expect(ctx.expenses.list(1).find((e) => e.id === id)!.spendDate).toBe("2026-02-14");
  });
});
