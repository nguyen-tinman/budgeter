// trends_calculator.ts — builds the 24-month series for the /trends page from
// the workspace BUDGET (not imported transactions): recurring expenses as flat
// monthly-equivalent baselines, one-time expenses as spikes on their spend
// date. One-time rows with no spend_date can't be placed (we never fall back to
// the import/created date) and are SURFACED via undatedOneTimeCount/Labels so
// the UI can prompt the user to assign a month. Splits the SQL-touching work
// (repos) from the pure series math (here) so the math is unit-testable
// without a DB.

import type { CategoriesRepo, IncomeRepo, SavingsRepo, ExpenseRepo } from "./tool_registry.js";
import { resolveContributionSplit } from "./retirement_projector.js";
import { expenseMonthlyDollars } from "./budget_math.js";
import { round2 } from "./money.js";

/** Normalize a merchant / expense-label string. Lowercase, collapse any run of
 *  non-alphanumerics to a single space, trim. Kept exported because other
 *  modules and tests import it. */
export function normMerchant(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export interface TrendsMonth {
  /** YYYY-MM identifier. */
  key: string;
  /** Three-letter month name, e.g. "Jun". */
  short: string;
  /** Mon-YY label, e.g. "Jun 26". */
  label: string;
  year: number;
  /** 0..11 calendar month index. */
  monthIdx: number;
  /** Unix epoch milliseconds for the first day of the month at UTC. */
  ts: number;
}

export interface TrendsCategorySeries {
  name: string;
  /** Hex color from the categories table. */
  color: string;
  /** Per-month budget amount for this category: recurring expenses as flat
   *  monthly-equivalents across the window, plus one-time expenses added as a
   *  spike in the month they're dated. One entry per month in TrendsResult.x. */
  series: number[];
}

export interface TrendsOverlaySeries {
  name: string;
  color: string;
  kind: "income" | "savings" | "retirement";
  series: number[];
}

/** One of a month's largest one-time budget expenses, for the Trends tooltip. */
export interface TrendsOneTimeItem {
  /** The expense label. */
  label: string;
  /** This month's amount for this one-time expense. */
  amount: number;
  /** Resolved category name (for the tooltip label). */
  category: string;
  /** Resolved category hex (for the tooltip color dot). */
  color: string;
}

export interface TrendsResult {
  x: TrendsMonth[];
  /** Keyed by category id stringified. The "uncategorized" bucket uses
   *  the literal key "uncategorized". */
  categories: Record<string, TrendsCategorySeries>;
  overlays: {
    takeHome: TrendsOverlaySeries;
    savings: TrendsOverlaySeries;
    retirement: TrendsOverlaySeries;
  };
  /** Parallel to `x` (index i = month i): the up-to-5 largest one-time expenses
   *  dated in that month, sorted descending by amount. */
  topOneTime: TrendsOneTimeItem[][];
  /** How many one-time expenses are window-eligible (frequency === "one_time")
   *  but carry no spend_date, so they could not be placed on the chart. These
   *  are SURFACED (not silently dropped) so the UI can prompt the user to set a
   *  spend month. */
  undatedOneTimeCount: number;
  /** Labels of the undated one-time expenses (above), most-recent-first by the
   *  row's createdAt, capped at 10. Drives a UI footnote listing what needs a
   *  month assigned. */
  undatedOneTimeLabels: string[];
}

/** Build the X-axis labels for the chart. The newest month is always last;
 *  index 0 is `months - 1` months ago. */
export function buildTrendsX(months: number, now: Date = new Date()): TrendsMonth[] {
  const out: TrendsMonth[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth() - i, 1));
    const short = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
    const yr = d.getUTCFullYear();
    out.push({
      key: `${yr}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
      short,
      label: `${short} ${String(yr % 100).padStart(2, "0")}`,
      year: yr,
      monthIdx: d.getUTCMonth(),
      ts: d.getTime(),
    });
  }
  return out;
}

/** Pure orchestrator. The caller wires in the repos so this stays
 *  testable with in-memory fakes. */
export function computeTrends(args: {
  months: number;
  workspaceId: number;
  categories: CategoriesRepo;
  incomes: IncomeRepo;
  savings: SavingsRepo;
  expenses: ExpenseRepo;
  /** Real monthly take-home (net of taxes + payroll 401k/HSA/Roth), supplied by
   *  the tool which has the tax tables. When omitted, a flat 30% estimate is
   *  used (unit tests / no tax context). */
  takeHomeMonthlyDollars?: number;
  now?: Date;
}): TrendsResult {
  const { months, workspaceId } = args;
  const x = buildTrendsX(months, args.now);
  const keyToIdx = new Map(x.map((m, i) => [m.key, i]));

  // ── Categories: seed an empty series for every category (+ uncategorized) ──
  const categories: Record<string, TrendsCategorySeries> = {};
  for (const c of args.categories.listAll()) {
    categories[String(c.id)] = { name: c.name, color: c.colorHex, series: new Array(months).fill(0) };
  }
  categories["uncategorized"] = { name: "Uncategorized", color: "#888888", series: new Array(months).fill(0) };

  // 'YYYY-MM' of an ISO date/datetime ('2026-05-10' or '2026-05-10 12:00:00').
  const monthKeyOf = (iso: string | null | undefined): string | null => {
    if (!iso || iso.length < 7) return null;
    return iso.slice(0, 7);
  };

  // Collect each month's one-time items for the tooltip.
  const oneTimeByMonth: Array<Array<{ label: string; amount: number; catKey: string }>> =
    Array.from({ length: months }, () => []);

  // One-time rows that have no spend_date and so can't be placed. Surfaced (not
  // dropped) so the UI can prompt the user to assign a month. We keep the row's
  // createdAt to order the footnote most-recent-first.
  const undatedOneTime: Array<{ label: string; createdAt: string }> = [];

  // ── Build series straight from the BUDGET ──────────────────────────
  // Recurring expenses → flat monthly-equivalent across the window.
  // One-time expenses → a spike in the month of their spend_date (the real date
  // the money was spent, recovered from the statement transaction). A one-time
  // row with no spend_date has no known month, so it is not placed — we never
  // fall back to the import/created date; instead we record it as undated so the
  // caller can surface it for the user to date manually.
  for (const e of args.expenses.list(workspaceId)) {
    const catKey =
      e.categoryId != null && categories[String(e.categoryId)] ? String(e.categoryId) : "uncategorized";
    const target = categories[catKey]!;
    if (e.frequency === "one_time") {
      const mk = monthKeyOf(e.spendDate);
      const idx = mk != null ? keyToIdx.get(mk) : undefined;
      if (idx != null) {
        target.series[idx] = round2(target.series[idx]! + e.amountDollars);
        oneTimeByMonth[idx]!.push({ label: e.label, amount: round2(e.amountDollars), catKey });
      } else if (mk == null) {
        // No spend_date at all (vs. dated-but-outside-window): can't be placed.
        undatedOneTime.push({ label: e.label, createdAt: e.createdAt });
      }
    } else {
      const m = expenseMonthlyDollars(e.amountDollars, e.frequency);
      if (m !== 0) {
        for (let i = 0; i < months; i++) target.series[i] = round2(target.series[i]! + m);
      }
    }
  }

  // ── Top-5 one-time expenses per month (for the hover tooltip) ──────
  const topOneTime: TrendsOneTimeItem[][] = oneTimeByMonth.map((items) =>
    items
      .filter((it) => it.amount > 0)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5)
      .map((it) => {
        const cat = categories[it.catKey];
        return {
          label: it.label,
          amount: it.amount,
          category: cat?.name ?? "Uncategorized",
          color: cat?.color ?? "#888888",
        };
      }),
  );

  // ── Overlays: derive from current workspace state, held constant ───
  // True historical take-home requires snapshotting tax tables per month
  // and re-running the tax calculator; that's a future enhancement. We use the
  // CURRENT real monthly take-home (passed in) held flat across the window.
  const incomeRows = args.incomes.list(workspaceId);
  const grossMonthly = incomeRows.reduce((s, i) => s + i.grossAnnualDollars / 12, 0);
  const takeHomeMonthly = args.takeHomeMonthlyDollars ?? round2(grossMonthly * 0.7);

  // Employee-side monthly contributions (pct-of-salary aware; employer match
  // excluded), split into retirement vs other-savings overlays.
  const primaryTaxedGross = incomeRows
    .filter((i) => i.filingRole === "primary" && i.taxStatus === "taxed")
    .reduce((s, i) => s + i.grossAnnualDollars, 0);
  const savingsRows = args.savings.list(workspaceId);
  let savingsMonthly = 0;
  let retirementMonthly = 0;
  for (const s of savingsRows) {
    const retire = s.accountType === "traditional_401k" ||
                   s.accountType === "roth_401k" ||
                   s.accountType === "roth_ira" ||
                   s.accountType === "hsa";
    const m = resolveContributionSplit(s, primaryTaxedGross).employeeMonthly;
    if (retire) retirementMonthly = round2(retirementMonthly + m);
    else savingsMonthly = round2(savingsMonthly + m);
  }

  function constantSeries(value: number): number[] {
    return new Array(months).fill(value);
  }

  const overlays = {
    takeHome: {
      name: "Take-home",
      color: "#f0c674",
      kind: "income" as const,
      series: constantSeries(takeHomeMonthly),
    },
    savings: {
      name: "Brokerage + HYSA",
      color: "#5db8b8",
      kind: "savings" as const,
      series: constantSeries(savingsMonthly),
    },
    retirement: {
      name: "401k + IRA + HSA",
      color: "#7ec98a",
      kind: "retirement" as const,
      series: constantSeries(retirementMonthly),
    },
  };

  // Undated one-time rows, surfaced for the UI: most-recent-first by createdAt,
  // capped at 10 labels (the full count is reported separately).
  const undatedOneTimeLabels = undatedOneTime
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, 10)
    .map((u) => u.label);

  return {
    x,
    categories,
    overlays,
    topOneTime,
    undatedOneTimeCount: undatedOneTime.length,
    undatedOneTimeLabels,
  };
}
