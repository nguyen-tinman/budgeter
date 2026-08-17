// spend_date_backfill — recovers the real spend date for one-time expenses by
// matching them back to the originating statement transaction (by normalized
// merchant + nearest amount), since legacy rows were catalogued before the
// spend_date column existed and would otherwise fall back to the import date.

import { describe, it, expect } from "vitest";
import { resolveOneTimeSpendDates, backfillOneTimeSpendDates } from "../src/spend_date_backfill.js";

describe("resolveOneTimeSpendDates", () => {
  const txns = [
    { merchantRaw: "UNITED AIRLINES HOUSTON TX", merchantNormalized: "united airlines", postedDate: "2025-09-14", amountDollars: -660.82 },
    { merchantRaw: "COSTCO WHSE #123", merchantNormalized: "costco whse", postedDate: "2025-11-02", amountDollars: -88.10 },
    { merchantRaw: "COSTCO WHSE #123", merchantNormalized: "costco whse", postedDate: "2026-01-20", amountDollars: -512.44 },
  ];

  it("matches by normalized merchant and picks the nearest amount", () => {
    const out = resolveOneTimeSpendDates(
      [
        { id: 1, label: "UNITED AIRLINES HOUSTON TX", amountDollars: 660.82 },
        { id: 2, label: "COSTCO WHSE #123", amountDollars: 512.44 },
      ],
      txns,
    );
    expect(out).toEqual([
      { id: 1, spendDate: "2025-09-14" },
      { id: 2, spendDate: "2026-01-20" }, // the $512.44 charge, not the $88.10 one
    ]);
  });

  it("ignores merchants with no matching transaction", () => {
    const out = resolveOneTimeSpendDates([{ id: 9, label: "MANUAL ENTRY", amountDollars: 50 }], txns);
    expect(out).toEqual([]);
  });

  it("matches on the raw merchant when the normalized form differs", () => {
    const out = resolveOneTimeSpendDates(
      [{ id: 5, label: "UNITED AIRLINES HOUSTON TX", amountDollars: 660.82 }],
      [{ merchantRaw: "UNITED AIRLINES HOUSTON TX", merchantNormalized: "ua", postedDate: "2025-09-14", amountDollars: -660.82 }],
    );
    expect(out).toEqual([{ id: 5, spendDate: "2025-09-14" }]);
  });

  it("trims a datetime posted_date to YYYY-MM-DD", () => {
    const out = resolveOneTimeSpendDates(
      [{ id: 7, label: "SHOP", amountDollars: 10 }],
      [{ merchantRaw: "SHOP", merchantNormalized: "shop", postedDate: "2025-07-03 00:00:00", amountDollars: -10 }],
    );
    expect(out).toEqual([{ id: 7, spendDate: "2025-07-03" }]);
  });

  it("leaves the date NULL when no same-merchant charge is within amount tolerance", () => {
    // A $512 one-off at Costco, but the only Costco charges are routine $88
    // grocery runs — the nearest amount is way off, so do NOT mis-date it.
    const out = resolveOneTimeSpendDates(
      [{ id: 3, label: "COSTCO WHSE #123", amountDollars: 512.44 }],
      [
        { merchantRaw: "COSTCO WHSE #123", merchantNormalized: "costco whse", postedDate: "2025-11-02", amountDollars: -88.10 },
        { merchantRaw: "COSTCO WHSE #123", merchantNormalized: "costco whse", postedDate: "2025-12-15", amountDollars: -91.30 },
      ],
    );
    expect(out).toEqual([]); // merchant matched, but amount out of tolerance → unmatched
  });

  it("accepts a match within the half-cent tolerance but rejects one just beyond it", () => {
    const inTol = resolveOneTimeSpendDates(
      [{ id: 1, label: "SHOP", amountDollars: 100.004 }], // 0.004 off → within 0.005
      [{ merchantRaw: "SHOP", merchantNormalized: "shop", postedDate: "2025-07-03", amountDollars: -100 }],
    );
    expect(inTol).toEqual([{ id: 1, spendDate: "2025-07-03" }]);

    const outTol = resolveOneTimeSpendDates(
      [{ id: 2, label: "SHOP", amountDollars: 100.02 }], // 0.02 off → beyond 0.005
      [{ merchantRaw: "SHOP", merchantNormalized: "shop", postedDate: "2025-07-03", amountDollars: -100 }],
    );
    expect(outTol).toEqual([]);
  });

  it("exact match still wins over a near (but out-of-tolerance) same-merchant charge", () => {
    const out = resolveOneTimeSpendDates(
      [{ id: 1, label: "COSTCO WHSE #123", amountDollars: 512.44 }],
      [
        { merchantRaw: "COSTCO WHSE #123", merchantNormalized: "costco whse", postedDate: "2025-11-02", amountDollars: -88.10 },
        { merchantRaw: "COSTCO WHSE #123", merchantNormalized: "costco whse", postedDate: "2026-01-20", amountDollars: -512.44 },
      ],
    );
    expect(out).toEqual([{ id: 1, spendDate: "2026-01-20" }]); // exact charge chosen
  });

  it("tie-break (equal exact amount) still picks the most recent date", () => {
    const out = resolveOneTimeSpendDates(
      [{ id: 1, label: "GYM", amountDollars: 40 }],
      [
        { merchantRaw: "GYM", merchantNormalized: "gym", postedDate: "2025-03-01", amountDollars: -40 },
        { merchantRaw: "GYM", merchantNormalized: "gym", postedDate: "2025-09-01", amountDollars: -40 },
      ],
    );
    expect(out).toEqual([{ id: 1, spendDate: "2025-09-01" }]); // newest of the two exact matches
  });
});

describe("backfillOneTimeSpendDates", () => {
  function fakeCtx(expenses: Array<{ id: number; frequency: string; spendDate: string | null; label: string; amountDollars: number }>, txns: any[]) {
    const updates: Array<{ id: number; spendDate?: string | null }> = [];
    return {
      ctx: {
        workspaces: { list: () => [{ id: 1 }] },
        expenses: {
          list: () => expenses,
          update: (args: { id: number; spendDate?: string | null }) => { updates.push(args); return { updated: true }; },
        },
        transactions: { listChargeRows: () => txns },
      },
      updates,
    };
  }

  it("only touches one-time expenses missing a spend date, and sets the matched date", () => {
    const { ctx, updates } = fakeCtx(
      [
        { id: 1, frequency: "one_time", spendDate: null, label: "UNITED AIRLINES", amountDollars: 660.82 },
        { id: 2, frequency: "one_time", spendDate: "2025-01-01", label: "ALREADY DATED", amountDollars: 5 }, // skip: already dated
        { id: 3, frequency: "monthly", spendDate: null, label: "RENT", amountDollars: 1800 },                // skip: recurring
        { id: 4, frequency: "one_time", spendDate: null, label: "NO MATCH", amountDollars: 99 },             // no txn
      ],
      [{ merchantRaw: "UNITED AIRLINES", merchantNormalized: "united airlines", postedDate: "2025-09-14", amountDollars: -660.82 }],
    );
    const res = backfillOneTimeSpendDates(ctx);
    expect(res.scanned).toBe(2); // ids 1 & 4 scanned; only 1 matched
    expect(res.matched).toBe(1);
    expect(updates).toEqual([{ id: 1, spendDate: "2025-09-14" }]);
    // Auditability: the changed-row details carry id, label, and the new date.
    expect(res.changed).toEqual([{ id: 1, label: "UNITED AIRLINES", spendDate: "2025-09-14" }]);
  });

  it("dryRun computes the same matches but writes nothing", () => {
    const rows = [
      { id: 1, frequency: "one_time", spendDate: null, label: "UNITED AIRLINES", amountDollars: 660.82 },
    ];
    const txns = [
      { merchantRaw: "UNITED AIRLINES", merchantNormalized: "united airlines", postedDate: "2025-09-14", amountDollars: -660.82 },
    ];
    const dry = fakeCtx(rows, txns);
    const dryRes = backfillOneTimeSpendDates(dry.ctx, { dryRun: true });
    const live = fakeCtx(rows, txns);
    const liveRes = backfillOneTimeSpendDates(live.ctx);

    // Identical report either way — only the write differs.
    expect(dryRes).toEqual(liveRes);
    expect(dryRes.changed).toEqual([{ id: 1, label: "UNITED AIRLINES", spendDate: "2025-09-14" }]);
    expect(dry.updates).toEqual([]);
    expect(live.updates).toEqual([{ id: 1, spendDate: "2025-09-14" }]);
  });

  it("skips the transaction fetch entirely when nothing needs backfilling", () => {
    let fetched = false;
    const ctx = {
      workspaces: { list: () => [{ id: 1 }] },
      expenses: { list: () => [{ id: 1, frequency: "monthly", spendDate: null, label: "Rent", amountDollars: 1800 }], update: () => ({ updated: true }) },
      transactions: { listChargeRows: () => { fetched = true; return []; } },
    };
    const res = backfillOneTimeSpendDates(ctx);
    expect(res).toEqual({ scanned: 0, matched: 0, changed: [] });
    expect(fetched).toBe(false);
  });

  it("reports an empty changed list when scanned rows find no match within tolerance", () => {
    const { ctx, updates } = fakeCtx(
      [{ id: 1, frequency: "one_time", spendDate: null, label: "COSTCO", amountDollars: 512.44 }],
      [{ merchantRaw: "COSTCO", merchantNormalized: "costco", postedDate: "2025-11-02", amountDollars: -88.10 }],
    );
    const res = backfillOneTimeSpendDates(ctx);
    expect(res.scanned).toBe(1);
    expect(res.matched).toBe(0);
    expect(res.changed).toEqual([]); // amount out of tolerance → nothing written
    expect(updates).toEqual([]);     // no DB write attempted
  });
});
