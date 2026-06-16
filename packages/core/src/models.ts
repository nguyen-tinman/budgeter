// Shared type definitions for budgetkit business logic.
// Monetary values are floating-point DOLLARS throughout (see money.ts). Float drift
// is bounded by rounding to 2dp at every storage + computation boundary (round2).

export type Filing = "single" | "mfj";
export type Jurisdiction = "federal" | "ca";

export interface TaxBracket {
  /** Upper bound of this bracket in dollars, or null for the top bracket. */
  upTo: number | null;
  /** Marginal tax rate, e.g. 0.22 for 22%. */
  rate: number;
}

export interface TaxTable {
  year: number;
  jurisdiction: Jurisdiction;
  filing: Filing;
  /** Standard deduction in dollars. */
  standardDeductionDollars: number;
  brackets: TaxBracket[];
}

export interface TaxSettings {
  filing: Filing;
  taxYear: number;
  caSdiRate: number;          // e.g. 0.011
  ssWageBaseDollars: number;    // Social Security taxable wage base, e.g. 176100 ($176,100) for 2025
  ficaSsRate: number;         // 0.062
  ficaMedicareRate: number;   // 0.0145
  /** Effective income tax rate assumed at retirement for traditional withdrawals. */
  retirementEffectiveTaxRate: number;
}

export interface IndividualIncome {
  /** Gross annual income in dollars for this person. */
  grossAnnualDollars: number;
  /** Pre-tax 401k (+ HSA) contribution in dollars (annual). Reduces taxable income for federal and CA, AND reduces take-home cash. */
  pretax401kDollars: number;
  /** Annual employer-side health premium deducted pre-tax in dollars. */
  pretaxHealthDollars: number;
  /** Post-tax PAYROLL withholding in dollars (annual), e.g. Roth 401k. Reduces
   *  take-home CASH but NOT taxable income (it was already taxed). Optional;
   *  defaults to 0 for back-compat with callers that don't model it. */
  postTaxPayrollDollars?: number;
}

export interface TakeHomeInput {
  primary: IndividualIncome;
  spouse?: IndividualIncome; // present only when filing === 'mfj'
  settings: TaxSettings;
  tables: TaxTable[]; // must include the right (year, jurisdiction, filing) entries
}

export interface TakeHomeBreakdown {
  grossCombinedDollars: number;
  federalTaxDollars: number;
  caTaxDollars: number;
  ficaDollars: number;
  caSdiDollars: number;
  preTaxDeductionsDollars: number;
  /** Post-tax payroll withholdings (e.g. Roth 401k) netted out of take-home. */
  postTaxPayrollDollars: number;
  annualTakeHomeDollars: number;
  monthlyTakeHomeDollars: number;
  effectiveTaxRate: number;
}

export interface RetirementSettings {
  currentAge: number;
  retirementAge: number;
  initialBalanceDollars: number;
  growthRate: number;           // e.g. 0.07
  rothSplitPct: number;         // 0..1, fraction of new contributions going to Roth lane
}

export interface YearSnapshot {
  age: number;
  yearsElapsed: number;
  traditionalDollars: number;
  rothDollars: number;
  totalDollars: number;
}

export interface RetirementProjection {
  years: YearSnapshot[];
  preTaxAtRetirementDollars: number;
  afterTaxAtRetirementDollars: number;
}
