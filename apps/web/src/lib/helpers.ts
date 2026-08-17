// Shared helpers for the editorial UI.
// Pure functions only — no I/O.

import { round2 } from "@budgetkit/core/money";
import { expenseMonthlyDollars } from "@budgetkit/core/budget_math";

export type Frequency =
  | "weekly"
  | "biweekly"
  | "monthly"
  | "quarterly"
  | "annually"
  | "one_time";

// Single source of frequency→monthly lives in @budgetkit/core/budget_math so
// the Trends chart (core) and the budget UI agree. This thin wrapper keeps the
// existing typed call sites.
export function freqToMonthlyDollars(dollars: number, freq: Frequency): number {
  return expenseMonthlyDollars(dollars, freq);
}

export function monthlyExpenseTotal(items: Array<{ amountDollars: number; frequency: Frequency }>): number {
  let total = 0;
  for (const e of items) {
    total += freqToMonthlyDollars(e.amountDollars, e.frequency);
  }
  return round2(total);
}

export function formatDollarsWhole(dollars: number, opts: { withSign?: boolean } = {}): string {
  if (dollars == null || !Number.isFinite(dollars)) return "—";
  const abs = Math.abs(dollars);
  const whole = Math.round(abs).toLocaleString();
  const sign = dollars < 0 ? "−" : (opts.withSign && dollars > 0 ? "+" : "");
  return `${sign}$${whole}`;
}

export function formatDollars(dollars: number, opts: { whole?: boolean; withSign?: boolean } = {}): string {
  if (dollars == null || !Number.isFinite(dollars)) return "—";
  const { whole = false, withSign = false } = opts;
  const abs = Math.abs(dollars);
  const out = whole
    ? Math.round(abs).toLocaleString()
    : abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = dollars < 0 ? "−" : (withSign && dollars > 0 ? "+" : "");
  return `${sign}$${out}`;
}

export function parseDollars(input: string): number | null {
  const cleaned = String(input).replace(/[$,\s]/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return round2(n);
}

// Help topics shown in HelpPopover modal.
// Each entry carries a plain-language body plus two provenance fields so the
// reader can trace any number both one level up (the formula) and all the way
// back to its raw inputs (the table column).
export interface HelpTopic {
  title: string;
  body: string;
  /** Direct/immediate computation — the formula that produced this number. */
  immediate?: string;
  /** Lowest-level source — the user-entered table or seed value that flows in. */
  final?: string;
}

export const HELP_TOPICS: Record<string, HelpTopic> = {
  // ── Taxes ────────────────────────────────────────────────────────────
  "effective-rate": {
    title: "Effective tax rate",
    body: "Total tax burden as a fraction of your gross taxed income. Lower than your marginal bracket because brackets stack and pretax buckets shrink the base.",
    immediate: "(federalTax + caTax + fica + caSdi) ÷ grossTaxedIncome",
    final: "incomes.taxStatus='taxed' summed × tax_tables (2025 federal + CA brackets at the active filing status)",
  },
  "fica": {
    title: "FICA",
    body: "Federal Insurance Contributions Act — payroll tax that funds Social Security (6.2%) and Medicare (1.45%). Applied to taxed‑W2 income, not pretax 401k or HSA contributions.",
    immediate: "grossTaxedIncome × (0.062 + 0.0145) = grossTaxedIncome × 0.0765",
    final: "incomes.taxStatus='taxed' grossAnnualDollars",
  },
  "pretax": {
    title: "Pretax income lines",
    body: "Money diverted before federal/state tax: 401k Traditional, HSA, transit FSA, dependent care. Reduces taxable base; the dollars still leave your paycheck so they're subtracted from take-home too.",
    immediate: "Σ income.grossAnnualDollars (taxStatus='pretax')",
    final: "incomes table — rows tagged 'pretax'",
  },

  // ── Income / take-home ──────────────────────────────────────────────
  "take-home": {
    title: "Monthly take-home",
    body: "Cash landing in your account after taxes AND payroll withholdings (pre-tax 401k/HSA and Roth 401k) have been removed. Employer match is excluded — it never touches your paycheck.",
    immediate: "(taxedGross − federalTax − caTax − fica − caSdi − preTaxPayroll − postTaxPayroll) ÷ 12",
    final: "incomes table (taxed rows) × tax_tables (federal + CA) − savings_items payroll contributions (employee side)",
  },
  "gross-paycheck": {
    title: "Gross paycheck (monthly)",
    body: "Pre-tax wages before any deductions, expressed per calendar month.",
    immediate: "Σ income.grossAnnualDollars (taxStatus='taxed') ÷ 12",
    final: "incomes table — every row tagged 'taxed'",
  },
  "tax-monthly": {
    title: "Monthly taxes withheld",
    body: "Federal + state + payroll tax combined, on a per-month basis.",
    immediate: "(federalTax + caTax + fica + caSdi) ÷ 12",
    final: "incomes (taxed minus pretax) × tax_tables (federal + CA brackets at workspace filing status)",
  },
  "pretax-monthly": {
    title: "Payroll retirement (monthly)",
    body: "Money withheld from your paycheck into retirement accounts. Pre-tax (Traditional 401k, HSA) reduces your taxable income; Roth 401k is withheld post-tax. Either way it leaves your paycheck. Employer match is NOT shown — it isn't withheld from your pay.",
    immediate: "Σ employee contributions to payroll accounts (traditional_401k, hsa, roth_401k) ÷ 12",
    final: "savings_items — employee contribution (monthly $ or %-of-salary), excluding employer match",
  },
  "income-total": {
    title: "Total annual gross",
    body: "Pre-tax, pre-pretax wages summed across all income lines (used as the headline figure in Section I).",
    immediate: "Σ income.grossAnnualDollars",
    final: "incomes table — every row's grossAnnualDollars column",
  },
  "gross-taxed-annual": {
    title: "Annual gross (taxed)",
    body: "Annual W‑2 / 1099 wages before any deductions — the base the bracket math is applied to.",
    immediate: "Σ income.grossAnnualDollars where taxStatus='taxed'",
    final: "incomes table — rows tagged 'taxed' for this workspace",
  },
  "federal-tax": {
    title: "Federal income tax (annual)",
    body: "Tax owed under the federal progressive brackets at the workspace's filing status, applied to the taxable base (gross minus pretax buckets).",
    immediate: "bracketMath(taxableBase, tax_tables.federal[year][filing])",
    final: "incomes (taxed − pretax) + tax_tables.federal (2025 brackets seeded; editable in Setup with M11)",
  },
  "ca-tax": {
    title: "California state tax (annual)",
    body: "Combined CA progressive income tax + CA SDI surcharge, computed on the same taxable base as federal.",
    immediate: "bracketMath(taxableBase, tax_tables.ca[year][filing]) + grossTaxed × ca_sdi_rate",
    final: "incomes (taxed − pretax) + tax_tables.ca + tax_settings.ca_sdi_rate",
  },

  // ── Expenses ────────────────────────────────────────────────────────
  "monthly-expenses": {
    title: "Monthly expenses (recurring)",
    body: "All expense lines normalized to a per-calendar-month figure.",
    immediate: "Σ freqToMonthly(expense.amountDollars, expense.frequency)",
    final: "expenses table — every row's amountDollars + frequency",
  },
  "freq-conversion": {
    title: "Frequency → monthly",
    body: "How non-monthly cadences are normalized to a monthly figure.",
    immediate: "weekly × 52/12 · biweekly × 26/12 · monthly × 1 · quarterly ÷ 3 · annually ÷ 12 · one_time = 0",
    final: "expense.frequency field on each row",
  },
  "category-pct": {
    title: "Category share",
    body: "What fraction of monthly spend goes to this category.",
    immediate: "categoryMonthly ÷ Σ categoryMonthly",
    final: "expenses table grouped by categoryId, with each amount frequency-converted to monthly",
  },
  "pro-rated": {
    title: "Pro-rated monthly",
    body: "Annual fees spread evenly across the calendar year for comparison with monthly lines.",
    immediate: "annualFee.amountDollars ÷ 12",
    final: "expenses table — rows where frequency='annually'",
  },
  "annual-fees-total": {
    title: "Total annual fees",
    body: "Headline figure shown in Section III deck; sum of every annually-recurring line.",
    immediate: "Σ expense.amountDollars where frequency='annually'",
    final: "expenses table — rows tagged 'annually'",
  },

  // ── Savings / net worth ─────────────────────────────────────────────
  "net-worth": {
    title: "Net worth (savings)",
    body: "Snapshot sum across every account where money accumulates (HYSA, brokerage, 401k, Roth, HSA).",
    immediate: "Σ savings.currentBalanceDollars",
    final: "savings table — each row's currentBalanceDollars you entered",
  },
  "savings-balance-total": {
    title: "Total savings balance",
    body: "Footer-row sum of every account's current balance.",
    immediate: "Σ savings.currentBalanceDollars",
    final: "savings table — each row's currentBalanceDollars",
  },
  "savings-monthly-total": {
    title: "Total monthly contribution",
    body: "What you're putting in each month across all savings accounts combined.",
    immediate: "Σ savings.monthlyContributionDollars",
    final: "savings table — every row's monthlyContributionDollars",
  },
  "savings-contrib-monthly": {
    title: "Savings from take-home (monthly)",
    body: "Money you move into savings out of cash you've already received — Roth IRA, brokerage, HYSA, etc. Payroll retirement (401k/HSA, Roth 401k) is NOT counted here; it left your paycheck before take-home, so counting it again would double-subtract.",
    immediate: "Σ employee contributions to from-cash accounts (roth_ira, brokerage, hysa, other) ÷ 12",
    final: "savings_items — from-cash rows' employee contribution (monthly $ or %-of-salary)",
  },
  "annualized-savings": {
    title: "Annualized contribution",
    body: "What you'd put in over 12 months at the current monthly rate.",
    immediate: "savings.monthlyContributionDollars × 12",
    final: "savings table — the monthlyContributionDollars you entered",
  },
  "savings-annualized-total": {
    title: "Total annualized contribution",
    body: "Combined yearly inflow across every savings account.",
    immediate: "Σ savings.monthlyContributionDollars × 12",
    final: "savings table — every row's monthlyContributionDollars",
  },
  "goal-pct": {
    title: "Goal progress",
    body: "Fraction of the way from $0 to the savings target.",
    immediate: "savings.currentBalanceDollars ÷ savings.targetBalanceDollars",
    final: "savings table — rows where targetBalanceDollars is set",
  },
  "goal-remaining": {
    title: "Remaining to goal",
    body: "How much more to set aside before hitting the target.",
    immediate: "savings.targetBalanceDollars − savings.currentBalanceDollars",
    final: "savings table — currentBalanceDollars + targetBalanceDollars",
  },

  // ── Cash-flow / remainder ───────────────────────────────────────────
  "monthly-remaining": {
    title: "Monthly remaining",
    body: "What's left to direct each month after recurring expenses.",
    immediate: "monthlyTakeHome − monthlyExpenses",
    final: "incomes + tax_tables (for take-home); expenses table (for monthly spend)",
  },
  "remaining-share": {
    title: "Share of take-home",
    body: "Fraction of every dollar landing in your account that survives recurring expenses.",
    immediate: "monthlyRemaining ÷ monthlyTakeHome",
    final: "incomes + tax_tables + expenses table",
  },
  "discretionary": {
    title: "Discretionary remainder",
    body: "What's left after taxes, payroll retirement, recurring expenses, and from-cash savings — money you actively decide on each month. (Payroll retirement is already out of take-home, so only from-cash savings is subtracted here.)",
    immediate: "monthlyTakeHome − monthlyExpenses − fromCashSavings",
    final: "incomes + tax_tables + expenses + savings — i.e., every other row in this river",
  },

  // ── Planning / scenarios ────────────────────────────────────────────
  "delta-vs-base": {
    title: "Δ vs base",
    body: "Difference in monthly remaining between this workspace and the base (Current) workspace.",
    immediate: "thisWorkspace.monthlyRemaining − baseWorkspace.monthlyRemaining",
    final: "Each side independently recomputes from its own incomes + expenses + tax_tables",
  },
  "compounded-30": {
    title: "30-year compounded delta",
    body: "Rough projection of what a recurring monthly savings delta grows to over 30 years at a 7% growth rate.",
    immediate: "Δ_monthly × 12 × 30 × 1.07",
    final: "scenario monthly_remaining delta (itself derived from incomes + expenses + tax_tables)",
  },
  "sensitivity": {
    title: "Sensitivity grid",
    body: "Monthly remaining across a 5×5 sweep of primary × spouse annual gross. Red cells mean expenses outpace take-home at that mix.",
    immediate: "For each (primaryGross, spouseGross): computeTakeHome([primary, spouse, …pretax]) − monthlyExpenseTotal",
    final: "expenses + pretax incomes + tax_tables for the active workspace; W‑2 incomes are swapped at each grid point",
  },

  // ── Retirement ──────────────────────────────────────────────────────
  "roth-split": {
    title: "Roth split",
    body: "Fraction of new retirement contributions routed to Roth (post-tax) buckets vs Traditional (pre-tax). 0 = all Traditional, 1 = all Roth. Existing balances aren't reshuffled.",
    immediate: "retirement_settings.rothSplitPct ∈ [0, 1]",
    final: "retirement_settings.rothSplitPct (one row per workspace)",
  },
  "retirement-annual": {
    title: "Annual retirement contribution",
    body: "Total going into retirement-tagged accounts each year.",
    immediate: "Σ savings.monthlyContributionDollars (accountType ∈ {traditional_401k, roth_401k, roth_ira}) × 12",
    final: "savings table — only rows with retirement account types",
  },
  "retirement-pretax": {
    title: "Pre-tax balance at retirement",
    body: "Total projected balance at retirement age before any withdrawal tax.",
    immediate: "initialBalanceDollars grown for (retirementAge − currentAge) years at growthRate, plus the annualContribution each year (split traditional/roth by rothSplitPct)",
    final: "retirement_settings (age + growth + roth split + initial) + savings table (for annual contribution)",
  },
  "retirement-aftertax": {
    title: "After-tax balance at retirement",
    body: "What's actually spendable: Traditional balance is taxed on withdrawal, Roth is not.",
    immediate: "preTaxAtRetirement − (traditionalAtRetirement × ~0.22 effective-rate proxy)",
    final: "retirement_settings + savings + a flat 22% withdrawal-rate proxy (replaceable when bracket math at retirement ships)",
  },
};

// Default category palette (mirrors design data.jsx).
export interface CategoryDef { id: number; name: string; color: string }
export const CATEGORIES: CategoryDef[] = [
  { id: 1, name: "Housing",        color: "#c97a4a" },
  { id: 2, name: "Utilities",      color: "#7a9ec9" },
  { id: 3, name: "Communications", color: "#a07cc9" },
  { id: 4, name: "Food",           color: "#c9a14a" },
  { id: 5, name: "Transport",      color: "#7ec98a" },
  { id: 6, name: "Subscriptions",  color: "#c97a98" },
  { id: 7, name: "Insurance",      color: "#5db8b8" },
  { id: 8, name: "Discretionary",  color: "#9a9a9a" },
  { id: 9, name: "Annual fees",    color: "#b89a4a" },
];

export function categoryById(id: number | null | undefined): CategoryDef | null {
  if (id == null) return null;
  return CATEGORIES.find((c) => c.id === id) ?? null;
}
