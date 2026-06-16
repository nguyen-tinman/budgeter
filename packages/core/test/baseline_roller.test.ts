import { describe, it, expect } from "vitest";
import { rollByCategory } from "../src/baseline_roller.js";
import type { RawTxn } from "../src/statement_parser.js";

function mkTxn(
  date: string,
  category: string,
  amountDollars: number,
): RawTxn {
  return {
    postedDate: date,
    merchantRaw: "X",
    merchantNormalized: "x",
    amountDollars,
    accountType: "amex_gold",
    categoryHint: category,
  };
}

function mkUncategorized(
  date: string,
  amountDollars: number,
  merchantRaw = "X",
): RawTxn {
  return {
    postedDate: date,
    merchantRaw,
    merchantNormalized: merchantRaw.toLowerCase(),
    amountDollars,
    accountType: "chase",
  };
}

describe("rollByCategory — average uses window length, median uses active months", () => {
  it("divides total by windowMonths (not active months) for the budgeting average", () => {
    // Food spend: 3 active months of $400 each = $1200 total over a 12-month window.
    // Budgeting baseline (average) = $1200 / 12 = $100/mo, NOT $400/mo.
    // Median across the 3 active months stays at $400 (the "typical active month").
    const txns: RawTxn[] = [
      mkTxn("2025-01-15", "Food", -200),
      mkTxn("2025-01-20", "Food", -200),
      mkTxn("2025-02-10", "Food", -400),
      mkTxn("2025-03-12", "Food", -400),
    ];
    const b = rollByCategory(txns, { asOf: "2025-03-30", windowMonths: 12 });
    expect(b).toHaveLength(1);
    expect(b[0]!.category).toBe("Food");
    expect(b[0]!.monthlyAverageDollars).toBe(-100); // $1200 / 12
    expect(b[0]!.monthlyMedianDollars).toBe(-400); // median of active months
    expect(b[0]!.annualizedDollars).toBe(-1200);
    expect(b[0]!.monthsWithActivity).toBe(3);
    expect(b[0]!.txnCount).toBe(4);
  });

  it("for a fully-active window, average and median may both equal the per-month total", () => {
    // 6 active months in a 6-month window → avg = total / 6 = median of identical values.
    const txns: RawTxn[] = [];
    for (let i = 1; i <= 6; i++) {
      const m = String(i).padStart(2, "0");
      txns.push(mkTxn(`2025-${m}-10`, "Rent", -1800));
    }
    const b = rollByCategory(txns, { asOf: "2025-06-30", windowMonths: 6 });
    expect(b[0]!.monthlyAverageDollars).toBe(-1800);
    expect(b[0]!.monthlyMedianDollars).toBe(-1800);
  });

  it("median resists a one-off splurge (active-month median is splurge-resistant)", () => {
    // 5 normal months at $200, 1 splurge month at $2000 — over 12-month window.
    const txns: RawTxn[] = [
      mkTxn("2025-01-10", "Travel", -200),
      mkTxn("2025-02-10", "Travel", -200),
      mkTxn("2025-03-10", "Travel", -200),
      mkTxn("2025-04-10", "Travel", -200),
      mkTxn("2025-05-10", "Travel", -200),
      mkTxn("2025-06-10", "Travel", -2000),
    ];
    const b = rollByCategory(txns, { asOf: "2025-06-30", windowMonths: 12 });
    // Median of active months = -20000 (5 normal of 6 active)
    expect(b[0]!.monthlyMedianDollars).toBe(-200);
    // Average over full 12-month window = total / 12 = $300000 / 12 = $25000
    expect(b[0]!.monthlyAverageDollars).toBe(-250);
    expect(b[0]!.annualizedDollars).toBe(-3000);
  });

  it("groups by category", () => {
    const txns: RawTxn[] = [
      mkTxn("2025-01-15", "Food", -100),
      mkTxn("2025-01-20", "Gas", -50),
      mkTxn("2025-02-15", "Food", -100),
      mkTxn("2025-02-20", "Gas", -50),
    ];
    const b = rollByCategory(txns, { asOf: "2025-02-28", windowMonths: 2 });
    expect(b).toHaveLength(2);
    const food = b.find((x) => x.category === "Food")!;
    const gas = b.find((x) => x.category === "Gas")!;
    // 2-month window: 2 active months of $100 each → avg = $200/2 = $100.
    expect(food.monthlyAverageDollars).toBe(-100);
    expect(gas.monthlyAverageDollars).toBe(-50);
  });

  it("uses fallback for missing category hint", () => {
    const txns: RawTxn[] = [
      mkUncategorized("2025-01-15", -15),
      mkUncategorized("2025-02-15", -15),
    ];
    const b = rollByCategory(txns, { asOf: "2025-02-28", windowMonths: 2 });
    expect(b[0]!.category).toBe("Uncategorized");
  });

  it("applies categoryResolver when hint is missing", () => {
    const txns: RawTxn[] = [
      mkUncategorized("2025-01-15", -50, "shell oil"),
      mkUncategorized("2025-02-15", -50, "chevron"),
    ];
    const resolver = (t: RawTxn): string | undefined => {
      if (/shell|chevron|76|exxon/i.test(t.merchantRaw)) return "Gas";
      return undefined;
    };
    const b = rollByCategory(txns, {
      asOf: "2025-02-28",
      windowMonths: 2,
      categoryResolver: resolver,
    });
    expect(b).toHaveLength(1);
    expect(b[0]!.category).toBe("Gas");
  });

  it("respects the windowMonths cutoff", () => {
    const txns: RawTxn[] = [
      mkTxn("2024-09-15", "Food", -100),
      mkTxn("2024-10-15", "Food", -100),
      mkTxn("2024-11-15", "Food", -100),
      mkTxn("2024-12-15", "Food", -100),
      mkTxn("2025-01-15", "Food", -100),
      mkTxn("2025-02-15", "Food", -100),
    ];
    const b = rollByCategory(txns, { asOf: "2025-02-15", windowMonths: 3 });
    expect(b[0]!.monthsWithActivity).toBe(3); // Dec, Jan, Feb only
    // 3 active months of $100 in a 3-month window → avg = $300/3 = $100.
    expect(b[0]!.monthlyAverageDollars).toBe(-100);
  });

  it("ignores credits when chargesOnly=true (default)", () => {
    const txns: RawTxn[] = [
      mkTxn("2025-01-15", "Food", -100),
      mkTxn("2025-01-20", "Refund", 50),
      mkTxn("2025-02-15", "Food", -100),
    ];
    const b = rollByCategory(txns, { asOf: "2025-02-28", windowMonths: 2 });
    expect(b.find((x) => x.category === "Refund")).toBeUndefined();
    expect(b.find((x) => x.category === "Food")).toBeDefined();
  });

  it("sorts results by largest absolute monthly average first", () => {
    const txns: RawTxn[] = [
      mkTxn("2025-01-15", "Small", -10),
      mkTxn("2025-02-15", "Small", -10),
      mkTxn("2025-01-15", "Big", -500),
      mkTxn("2025-02-15", "Big", -500),
    ];
    const b = rollByCategory(txns, { asOf: "2025-02-28", windowMonths: 2 });
    expect(b[0]!.category).toBe("Big");
    expect(b[1]!.category).toBe("Small");
  });

  it("returns empty when no input", () => {
    expect(rollByCategory([], { asOf: "2025-01-01" })).toEqual([]);
  });

  it("sparse spend over a long window smooths to a low monthly baseline", () => {
    // One $1200 annual charge in a 12-month window. Without the windowMonths
    // denominator fix, this would baseline at $1200/mo (the AHS bug).
    const txns: RawTxn[] = [mkTxn("2025-06-15", "Insurance", -1200)];
    const b = rollByCategory(txns, { asOf: "2025-12-31", windowMonths: 12 });
    expect(b[0]!.monthlyAverageDollars).toBe(-100); // $1200/12 = $100/mo
    expect(b[0]!.monthsWithActivity).toBe(1);
    expect(b[0]!.annualizedDollars).toBe(-1200);
  });
});
