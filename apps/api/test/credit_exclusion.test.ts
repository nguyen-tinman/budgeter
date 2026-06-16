// A5 — credit-exclusion regression (preserves the intent of a deleted FIX-2 test).
//
// transactionRepo.listChargeRows() filters `WHERE amount_dollars < 0`, so it
// must return ONLY charges and never positive credits / payments / refunds.
// Spend = charges only (negative amount_dollars); a positive payment line must
// not leak into the charge list (or it would net against real spend).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "budgetkit-credit-test-"));
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

describe("listChargeRows excludes credits (FIX-2 regression)", () => {
  it("returns ONLY negative (charge) rows, never positive credits/payments", async () => {
    const { db, ctx } = await freshCtx();
    // A statement_imports row is required (transactions.import_id is NOT NULL FK).
    const { importId } = ctx.statementImports.record({
      sourceAccount: "chase",
      fileHash: "hash-credit-exclusion",
      filePath: "/tmp/stmt.csv",
      txnCount: 4,
    });
    expect(importId).toBeGreaterThan(0);

    // Insert a mix of charges (negative) and credits/payments (positive) via the
    // real repo write path.
    ctx.transactions.insertMany(importId, [
      { postedDate: "2026-01-05", merchantRaw: "GROCERY", merchantNormalized: "grocery", amountDollars: -42.5, categoryId: null, accountType: "chase" },
      { postedDate: "2026-01-06", merchantRaw: "PAYMENT THANK YOU", merchantNormalized: "payment", amountDollars: 500.0, categoryId: null, accountType: "chase" },
      { postedDate: "2026-01-07", merchantRaw: "GAS", merchantNormalized: "gas", amountDollars: -30.0, categoryId: null, accountType: "chase" },
      { postedDate: "2026-01-08", merchantRaw: "REFUND", merchantNormalized: "refund", amountDollars: 12.34, categoryId: null, accountType: "chase" },
    ]);

    const charges = ctx.transactions.listChargeRows();
    // Only the two negative charges come back.
    expect(charges).toHaveLength(2);
    for (const c of charges) {
      expect(c.amountDollars).toBeLessThan(0);
    }
    expect(charges.map((c) => c.merchantNormalized).sort()).toEqual(["gas", "grocery"]);
    // The positive credit/refund are never present.
    expect(charges.some((c) => c.merchantNormalized === "payment")).toBe(false);
    expect(charges.some((c) => c.merchantNormalized === "refund")).toBe(false);

    // Sanity: all four rows really were inserted, so the WHERE filter (not a
    // missing insert) is what excludes the credits.
    expect(db.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 4 });
  });
});
