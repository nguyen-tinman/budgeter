import type { RawTxn } from "./statement_parser.js";
import { round2 } from "./money.js";

export interface CategoryBaseline {
  /** Category bucket (from txn.categoryHint or a fallback). */
  category: string;
  /**
   * 12-month rolling MONTHLY average in dollars (sign preserved; usually negative).
   * Denominator is the FULL window length (not just months with activity), so
   * a category that only had spend in 3 of 12 months smooths to a lower monthly
   * carrying cost — appropriate for budgeting baselines.
   */
  monthlyAverageDollars: number;
  /**
   * MONTHLY MEDIAN across months *with activity* — more robust to one-off
   * splurges than the average. Use this when you want "what a typical active
   * month looks like" rather than "what to budget on average".
   */
  monthlyMedianDollars: number;
  /**
   * Total spend across the window (sign preserved). Useful for the "what does
   * this category cost me per year" question independent of window length.
   */
  annualizedDollars: number;
  /** Number of months in the window that had any activity. */
  monthsWithActivity: number;
  /** Number of distinct transactions feeding the baseline. */
  txnCount: number;
}

export interface RollOptions {
  /** Window length in months (default 12). */
  windowMonths?: number;
  /** Reference "now" date as ISO string. Defaults to the latest txn date. */
  asOf?: string;
  /** Only consider charges. */
  chargesOnly?: boolean;
  /** Fallback category for txns missing categoryHint. */
  uncategorizedLabel?: string;
  /**
   * Optional categorizer applied when `categoryHint` is empty. Lets Chase
   * transactions get a category from a merchant heuristic / rule engine /
   * LLM-derived mapping rather than collapsing into "Uncategorized".
   */
  categoryResolver?: (txn: RawTxn) => string | undefined;
}

function monthKey(iso: string): string {
  return iso.slice(0, 7); // "YYYY-MM"
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? round2((sorted[mid - 1]! + sorted[mid]!) / 2)
    : sorted[mid]!;
}

function shiftMonth(iso: string, deltaMonths: number): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const total = y * 12 + (m - 1) + deltaMonths;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}`;
}

/**
 * Compute per-category monthly rolling baselines.
 *
 * Average uses windowMonths as denominator (smooths sparse activity);
 * median uses months-with-activity (preserves the "typical active month"
 * intuition). Both are surfaced so the UI can pick which to show.
 */
export function rollByCategory(
  txns: RawTxn[],
  opts: RollOptions = {},
): CategoryBaseline[] {
  const windowMonths = opts.windowMonths ?? 12;
  const chargesOnly = opts.chargesOnly ?? true;
  const fallback = opts.uncategorizedLabel ?? "Uncategorized";
  const resolver = opts.categoryResolver;

  const filtered = chargesOnly ? txns.filter((t) => t.amountDollars < 0) : txns;
  if (filtered.length === 0) return [];

  const asOf =
    opts.asOf ??
    filtered.reduce(
      (latest, t) => (t.postedDate > latest ? t.postedDate : latest),
      filtered[0]!.postedDate,
    );

  const windowStart = shiftMonth(asOf, -(windowMonths - 1));
  const windowEnd = monthKey(asOf);

  const buckets = new Map<string, Map<string, number[]>>();
  for (const t of filtered) {
    const hinted = t.categoryHint?.trim();
    const resolved = !hinted && resolver ? resolver(t)?.trim() : undefined;
    const cat = hinted || resolved || fallback;
    const m = monthKey(t.postedDate);
    if (m < windowStart || m > windowEnd) continue;
    const byMonth = buckets.get(cat) ?? new Map<string, number[]>();
    const arr = byMonth.get(m) ?? [];
    arr.push(t.amountDollars);
    byMonth.set(m, arr);
    buckets.set(cat, byMonth);
  }

  const result: CategoryBaseline[] = [];
  for (const [cat, byMonth] of buckets) {
    const monthlyTotals: number[] = [];
    let txnCount = 0;
    for (const [, amounts] of byMonth) {
      monthlyTotals.push(round2(amounts.reduce((s, a) => s + a, 0)));
      txnCount += amounts.length;
    }
    if (monthlyTotals.length === 0) continue;
    const annualized = round2(monthlyTotals.reduce((s, v) => s + v, 0));
    // Divide by full window length, not active-month count: a category with
    // spend in only 3 of 12 months should baseline at total/12, not total/3.
    const avg = round2(annualized / windowMonths);
    result.push({
      category: cat,
      monthlyAverageDollars: avg,
      monthlyMedianDollars: median(monthlyTotals),
      annualizedDollars: annualized,
      monthsWithActivity: monthlyTotals.length,
      txnCount,
    });
  }

  return result.sort(
    (a, b) => Math.abs(b.monthlyAverageDollars) - Math.abs(a.monthlyAverageDollars),
  );
}
