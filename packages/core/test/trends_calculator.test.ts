// trends_calculator — budget-driven series: recurring as flat monthly-equivalents,
// one-time as dated spikes, plus the per-month topOneTime list.

import { describe, it, expect } from "vitest";
import { computeTrends } from "../src/trends_calculator.js";
import type { CategoriesRepo, IncomeRepo, SavingsRepo, ExpenseRepo } from "../src/tool_registry.js";

function buildArgs(expenses: Array<{
  label: string; amountDollars: number; frequency: string;
  categoryId: number | null; spendDate?: string | null; createdAt?: string;
}>) {
  const categories: CategoriesRepo = {
    listByName: () => new Map([["Food", 4], ["Discretionary", 8]]),
    listAll: () => [
      { id: 4, name: "Food", colorHex: "#f00" },
      { id: 8, name: "Discretionary", colorHex: "#0f0" },
    ],
  };
  const incomes = { list: () => [] } as unknown as IncomeRepo;
  const savings = { list: () => [] } as unknown as SavingsRepo;
  const expenseRepo = {
    list: () =>
      expenses.map((e, i) => ({
        id: i + 1, workspaceId: 1, label: e.label, amountDollars: e.amountDollars,
        frequency: e.frequency, spendDate: e.spendDate ?? null, categoryId: e.categoryId,
        source: "manual", createdAt: e.createdAt ?? "2026-05-15 00:00:00", updatedAt: "",
      })),
  } as unknown as ExpenseRepo;
  // 24-month axis ending 2026-05 (idx 23 = "2026-05", idx 22 = "2026-04").
  return { months: 24, workspaceId: 1, categories, incomes, savings, expenses: expenseRepo, now: new Date(2026, 4, 15) };
}

describe("computeTrends — recurring expenses (flat monthly-equivalent)", () => {
  it("draws a monthly expense flat at its amount across every month", () => {
    const r = computeTrends(buildArgs([{ label: "Rent", amountDollars: 1850, frequency: "monthly", categoryId: 4 }]));
    const food = r.categories["4"]!;
    expect(food.series).toHaveLength(24);
    expect(food.series.every((v) => v === 1850)).toBe(true);
  });

  it("normalizes weekly and annually to a flat monthly-equivalent", () => {
    const r = computeTrends(buildArgs([
      { label: "Coffee", amountDollars: 10, frequency: "weekly", categoryId: 8 },
      { label: "Insurance", amountDollars: 1200, frequency: "annually", categoryId: 8 },
    ]));
    const disc = r.categories["8"]!;
    // 10*52/12 + 1200/12 = 43.333… + 100 = 143.33 (round2 per add)
    expect(disc.series[0]).toBeCloseTo(143.33, 2);
    expect(disc.series[23]).toBeCloseTo(143.33, 2);
  });
});

describe("computeTrends — one-time expenses (dated spikes)", () => {
  it("places a one-time expense as a single spike in its spend_date month", () => {
    const r = computeTrends(buildArgs([
      { label: "Flights", amountDollars: 500, frequency: "one_time", categoryId: 4, spendDate: "2026-05-10" },
    ]));
    const food = r.categories["4"]!;
    expect(food.series[23]).toBe(500);
    expect(food.series[22]).toBe(0);
    expect(food.series.filter((v) => v > 0)).toHaveLength(1);
    expect(r.topOneTime[23]).toEqual([{ label: "Flights", amount: 500, category: "Food", color: "#f00" }]);
  });

  it("does NOT place a one-time row that has no spend_date (never uses the import date)", () => {
    const r = computeTrends(buildArgs([
      { label: "Sofa", amountDollars: 800, frequency: "one_time", categoryId: 8, spendDate: null, createdAt: "2026-04-20 00:00:00" },
    ]));
    expect(r.categories["8"]!.series.every((v) => v === 0)).toBe(true); // skipped, not placed at created_at
    expect(r.topOneTime.every((m) => m.length === 0)).toBe(true);
  });

  it("omits a one-time expense dated outside the window", () => {
    const r = computeTrends(buildArgs([
      { label: "OldThing", amountDollars: 999, frequency: "one_time", categoryId: 8, spendDate: "2023-01-01" },
    ]));
    expect(r.categories["8"]!.series.every((v) => v === 0)).toBe(true);
    expect(r.topOneTime.every((m) => m.length === 0)).toBe(true);
  });

  it("returns the month's one-time items sorted desc, capped at 5", () => {
    const items = [100, 200, 300, 400, 500, 600].map((amt, i) => ({
      label: `Buy ${i}`, amountDollars: amt, frequency: "one_time", categoryId: 8, spendDate: "2026-05-03",
    }));
    const r = computeTrends(buildArgs(items));
    const may = r.topOneTime[23]!;
    expect(may.map((it) => it.amount)).toEqual([600, 500, 400, 300, 200]); // 100 dropped
  });
});

describe("computeTrends — undated one-time surfacing", () => {
  it("reports zero undated when every one-time row is dated", () => {
    const r = computeTrends(buildArgs([
      { label: "Flights", amountDollars: 500, frequency: "one_time", categoryId: 4, spendDate: "2026-05-10" },
      { label: "Rent", amountDollars: 1850, frequency: "monthly", categoryId: 4 },
    ]));
    expect(r.undatedOneTimeCount).toBe(0);
    expect(r.undatedOneTimeLabels).toEqual([]);
  });

  it("counts and labels one-time rows with no spend_date", () => {
    const r = computeTrends(buildArgs([
      { label: "Sofa", amountDollars: 800, frequency: "one_time", categoryId: 8, spendDate: null },
      { label: "Mattress", amountDollars: 600, frequency: "one_time", categoryId: 8, spendDate: null },
    ]));
    expect(r.undatedOneTimeCount).toBe(2);
    expect(r.undatedOneTimeLabels).toContain("Sofa");
    expect(r.undatedOneTimeLabels).toContain("Mattress");
    // undated rows are not placed on any series
    expect(r.categories["8"]!.series.every((v) => v === 0)).toBe(true);
  });

  it("does NOT count dated one-time rows or recurring rows as undated", () => {
    const r = computeTrends(buildArgs([
      { label: "Flights", amountDollars: 500, frequency: "one_time", categoryId: 4, spendDate: "2026-05-10" },
      { label: "OldThing", amountDollars: 999, frequency: "one_time", categoryId: 8, spendDate: "2023-01-01" }, // dated but out-of-window
      { label: "Rent", amountDollars: 1850, frequency: "monthly", categoryId: 4, spendDate: null },
    ]));
    // Only rows with spendDate == null AND one_time count; a dated-but-out-of-window
    // row is dated (not undated), and recurring rows never carry a spend_date.
    expect(r.undatedOneTimeCount).toBe(0);
    expect(r.undatedOneTimeLabels).toEqual([]);
  });

  it("orders undated labels most-recent-first by createdAt and caps at 10", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      label: `Item ${i}`, amountDollars: 10, frequency: "one_time", categoryId: 8,
      spendDate: null,
      // Item 11 newest … Item 0 oldest.
      createdAt: `2026-05-${String(i + 1).padStart(2, "0")} 00:00:00`,
    }));
    const r = computeTrends(buildArgs(rows));
    expect(r.undatedOneTimeCount).toBe(12);            // full count, not capped
    expect(r.undatedOneTimeLabels).toHaveLength(10);   // labels capped at 10
    expect(r.undatedOneTimeLabels[0]).toBe("Item 11"); // newest first
    expect(r.undatedOneTimeLabels).not.toContain("Item 0"); // two oldest dropped
    expect(r.undatedOneTimeLabels).not.toContain("Item 1");
  });
});

describe("computeTrends — category attribution", () => {
  it("buckets an expense with an unknown/null category into uncategorized", () => {
    const r = computeTrends(buildArgs([{ label: "Misc", amountDollars: 50, frequency: "monthly", categoryId: null }]));
    expect(r.categories["uncategorized"]!.series[0]).toBe(50);
    expect(r.categories["4"]!.series[0]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Overlays — %-of-salary contributions resolve per owning filer
// ---------------------------------------------------------------------------

/** buildArgs with real incomes + savings so the overlay math is exercised.
 *  Expenses stay empty; only the savings/retirement overlays are asserted. */
function overlayArgs(
  incomeRows: Array<{ grossAnnualDollars: number; taxStatus: string; filingRole: string }>,
  savingsRows: Array<{
    label: string;
    accountType: string;
    monthlyContributionDollars?: number;
    contributionPctOfSalary?: number | null;
    filingRole?: string;
  }>,
) {
  const base = buildArgs([]);
  const incomes = {
    list: () =>
      incomeRows.map((i, n) => ({
        id: n + 1, workspaceId: 1, label: `Income ${n}`,
        grossAnnualDollars: i.grossAnnualDollars, taxStatus: i.taxStatus,
        isFederalIncomeTax: true, filingRole: i.filingRole,
      })),
  } as unknown as IncomeRepo;
  const savings = {
    list: () =>
      savingsRows.map((s, n) => ({
        id: n + 1, workspaceId: 1, label: s.label,
        currentBalanceDollars: 0, targetBalanceDollars: null,
        monthlyContributionDollars: s.monthlyContributionDollars ?? 0,
        accountType: s.accountType,
        contributionPctOfSalary: s.contributionPctOfSalary ?? null,
        employerMatchKind: "none", employerMatchValue: null,
        taxTreatment: null, filingRole: s.filingRole ?? "primary",
      })),
  } as unknown as SavingsRepo;
  return { ...base, incomes, savings };
}

describe("computeTrends — savings overlays scale with the OWNING filer's salary", () => {
  it("a spouse-owned %-of-salary 401k derives from the spouse's taxed gross", () => {
    // Unequal salaries so the two bases can't be confused: primary $100k,
    // spouse $200k. 10% of the spouse's salary = $1,666.67/mo; keying off the
    // primary would give $833.33/mo.
    const r = computeTrends(
      overlayArgs(
        [
          { grossAnnualDollars: 100_000, taxStatus: "taxed", filingRole: "primary" },
          { grossAnnualDollars: 200_000, taxStatus: "taxed", filingRole: "spouse" },
        ],
        [
          {
            label: "Spouse 401k",
            accountType: "traditional_401k",
            contributionPctOfSalary: 0.1,
            filingRole: "spouse",
          },
        ],
      ),
    );
    expect(r.overlays.retirement.series.every((v) => v === 1666.67)).toBe(true);
    expect(r.overlays.savings.series.every((v) => v === 0)).toBe(true);
  });

  it("primary-owned rows are unchanged and both filers' rows sum correctly", () => {
    const r = computeTrends(
      overlayArgs(
        [
          { grossAnnualDollars: 100_000, taxStatus: "taxed", filingRole: "primary" },
          { grossAnnualDollars: 200_000, taxStatus: "taxed", filingRole: "spouse" },
        ],
        [
          { label: "Spouse 401k", accountType: "traditional_401k", contributionPctOfSalary: 0.1, filingRole: "spouse" },
          { label: "Primary 401k", accountType: "traditional_401k", contributionPctOfSalary: 0.1, filingRole: "primary" },
          // A non-retirement row lands in the other overlay, still per-owner.
          { label: "Spouse Brokerage", accountType: "brokerage", contributionPctOfSalary: 0.01, filingRole: "spouse" },
        ],
      ),
    );
    // $1,666.67 (spouse 10% of $200k) + $833.33 (primary 10% of $100k).
    expect(r.overlays.retirement.series[0]).toBe(2500);
    // 1% of the spouse's $200k = $166.67/mo, not 1% of the primary's $100k.
    expect(r.overlays.savings.series[0]).toBe(166.67);
  });
});
