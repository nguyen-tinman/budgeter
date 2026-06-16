import type {
  TaxTable,
  TaxBracket,
  Filing,
  Jurisdiction,
  TakeHomeInput,
  TakeHomeBreakdown,
  IndividualIncome,
} from "./models.js";
import { round2 } from "./money.js";

/**
 * Walk a progressive bracket set on a taxable amount.
 * All amounts in dollars; rates 0..1.
 *
 * Brackets are an array of { upTo, rate } in ascending order.
 * The last bracket has upTo === null and applies to all income above the previous cutoff.
 */
export function bracketTax(
  taxableDollars: number,
  brackets: TaxBracket[],
): number {
  if (taxableDollars <= 0) return 0;
  let remaining = taxableDollars;
  let lastCutoff = 0;
  let total = 0;

  for (const b of brackets) {
    const span =
      b.upTo === null
        ? remaining
        : Math.max(0, Math.min(remaining, b.upTo - lastCutoff));
    if (span <= 0) {
      if (b.upTo !== null) lastCutoff = b.upTo;
      continue;
    }
    total += span * b.rate;
    remaining -= span;
    if (b.upTo === null) break;
    lastCutoff = b.upTo;
    if (remaining <= 0) break;
  }
  // Round to the nearest cent (2dp) to bound float drift.
  return round2(total);
}

function findTable(
  tables: TaxTable[],
  year: number,
  jurisdiction: Jurisdiction,
  filing: Filing,
): TaxTable {
  const t = tables.find(
    (x) =>
      x.year === year && x.jurisdiction === jurisdiction && x.filing === filing,
  );
  if (!t) {
    throw new Error(
      `Missing tax_table for year=${year} jurisdiction=${jurisdiction} filing=${filing}`,
    );
  }
  return t;
}

export interface JurisdictionResult {
  taxableDollars: number;
  taxDollars: number;
}

/**
 * Compute federal tax owed on (gross - pretax_deductions - standard_deduction).
 * Pre-tax deductions reduce federal taxable income.
 */
export function federalTax(
  input: TakeHomeInput,
): JurisdictionResult {
  const { settings, tables, primary, spouse } = input;
  const table = findTable(tables, settings.taxYear, "federal", settings.filing);

  const totalGross =
    primary.grossAnnualDollars + (spouse?.grossAnnualDollars ?? 0);
  const totalPretax =
    primary.pretax401kDollars +
    primary.pretaxHealthDollars +
    (spouse?.pretax401kDollars ?? 0) +
    (spouse?.pretaxHealthDollars ?? 0);
  const taxable = round2(Math.max(
    0,
    totalGross - totalPretax - table.standardDeductionDollars,
  ));
  return { taxableDollars: taxable, taxDollars: bracketTax(taxable, table.brackets) };
}

/**
 * California tax. CA allows pre-tax 401k deductions and uses its own
 * (lower) standard deduction. Health premiums are generally NOT pre-tax for
 * CA state income tax purposes when employer-sponsored — but for simplicity,
 * the workspace's HealthDollars value is treated identically to the federal
 * pre-tax bucket here. Document this caveat in doc/09-tax-math.md so the
 * user can adjust by entering 0 for the CA-side health deduction if needed.
 *
 * If the user needs separate fed/CA pre-tax handling later, this is the
 * single spot to split: introduce a second field on IndividualIncome.
 */
export function caTax(input: TakeHomeInput): JurisdictionResult {
  const { settings, tables, primary, spouse } = input;
  const table = findTable(tables, settings.taxYear, "ca", settings.filing);

  const totalGross =
    primary.grossAnnualDollars + (spouse?.grossAnnualDollars ?? 0);
  const totalPretax =
    primary.pretax401kDollars +
    primary.pretaxHealthDollars +
    (spouse?.pretax401kDollars ?? 0) +
    (spouse?.pretaxHealthDollars ?? 0);
  const taxable = round2(Math.max(
    0,
    totalGross - totalPretax - table.standardDeductionDollars,
  ));
  return { taxableDollars: taxable, taxDollars: bracketTax(taxable, table.brackets) };
}

/**
 * Per-individual FICA: Social Security (capped at wage base) + Medicare.
 * Note: Additional Medicare 0.9% on wages > $200k single / $250k MFJ is not
 * applied here for v1; document in doc/09-tax-math.md.
 */
export function ficaForIndividual(
  income: IndividualIncome,
  ssWageBaseDollars: number,
  ssRate: number,
  medicareRate: number,
): number {
  const ss = Math.min(income.grossAnnualDollars, ssWageBaseDollars) * ssRate;
  const med = income.grossAnnualDollars * medicareRate;
  return round2(ss + med);
}

/** CA SDI is per-individual, no wage cap as of 2024+. */
export function caSdiForIndividual(
  income: IndividualIncome,
  sdiRate: number,
): number {
  return round2(income.grossAnnualDollars * sdiRate);
}

export function takeHome(input: TakeHomeInput): TakeHomeBreakdown {
  const { primary, spouse, settings } = input;
  const totalGross =
    primary.grossAnnualDollars + (spouse?.grossAnnualDollars ?? 0);
  const totalPretax =
    primary.pretax401kDollars +
    primary.pretaxHealthDollars +
    (spouse?.pretax401kDollars ?? 0) +
    (spouse?.pretaxHealthDollars ?? 0);
  // Post-tax payroll withholdings (Roth 401k): subtracted from take-home cash
  // but NOT from taxable income (federalTax/caTax don't see it).
  const totalPostTaxPayroll =
    (primary.postTaxPayrollDollars ?? 0) + (spouse?.postTaxPayrollDollars ?? 0);

  const fed = federalTax(input).taxDollars;
  const ca = caTax(input).taxDollars;
  const ficaP = ficaForIndividual(
    primary,
    settings.ssWageBaseDollars,
    settings.ficaSsRate,
    settings.ficaMedicareRate,
  );
  const ficaS = spouse
    ? ficaForIndividual(
        spouse,
        settings.ssWageBaseDollars,
        settings.ficaSsRate,
        settings.ficaMedicareRate,
      )
    : 0;
  const sdiP = caSdiForIndividual(primary, settings.caSdiRate);
  const sdiS = spouse ? caSdiForIndividual(spouse, settings.caSdiRate) : 0;

  const fica = ficaP + ficaS;
  const sdi = sdiP + sdiS;

  // Take-home = gross - taxes - pre-tax - post-tax-payroll. Pre-tax (401k/HSA)
  // and post-tax payroll (Roth 401k) both leave your paycheck before you see
  // the cash; the difference is only whether they reduced taxable income.
  const annual = round2(totalGross - fed - ca - fica - sdi - totalPretax - totalPostTaxPayroll);
  const monthly = round2(annual / 12);
  // Effective tax rate = (income + payroll taxes) / gross. This is a fraction
  // in [0, 1): the numerator is the sum of non-negative tax components and is
  // structurally always strictly less than gross (the highest marginal rates —
  // 37% federal + 13.3% CA + FICA + SDI — sum well under 100%, and brackets are
  // marginal so the EFFECTIVE rate is lower still). It does NOT subtract pre-tax
  // or post-tax-payroll deductions, so it is purely the tax burden, not 1 minus
  // the take-home ratio. We clamp the lower bound at 0 defensively (taxes are
  // never negative) and return 0 for the gross===0 edge to avoid 0/0 = NaN.
  const effectiveTaxRate =
    totalGross === 0 ? 0 : Math.max(0, (fed + ca + fica + sdi) / totalGross);

  return {
    grossCombinedDollars: round2(totalGross),
    federalTaxDollars: fed,
    caTaxDollars: ca,
    ficaDollars: fica,
    caSdiDollars: sdi,
    preTaxDeductionsDollars: round2(totalPretax),
    postTaxPayrollDollars: round2(totalPostTaxPayroll),
    annualTakeHomeDollars: annual,
    monthlyTakeHomeDollars: monthly,
    effectiveTaxRate,
  };
}
