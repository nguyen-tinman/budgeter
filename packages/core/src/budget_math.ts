// budget_math.ts — the single definition of how an expense's per-occurrence
// amount + cadence becomes a per-calendar-month figure. Shared by computeTrends
// (core) and the budget UI (web re-exports via freqToMonthlyDollars) so both
// agree. one_time → 0 (one-time spend is placed by date, not amortized here).

export function expenseMonthlyDollars(amountDollars: number, frequency: string): number {
  switch (frequency) {
    case "weekly":    return amountDollars * 52 / 12;
    case "biweekly":  return amountDollars * 26 / 12;
    case "monthly":   return amountDollars;
    case "quarterly": return amountDollars / 3;
    case "annually":  return amountDollars / 12;
    case "one_time":  return 0;
    default:          return amountDollars;
  }
}
