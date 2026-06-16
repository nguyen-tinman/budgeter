// account_tax.ts — how a savings/investment account's contributions flow
// through the paycheck, which determines what they reduce.
//
//   payroll_pretax  — withheld from pay BEFORE tax (traditional 401k, HSA).
//                     Reduces taxable income AND take-home cash.
//   payroll_posttax — withheld from pay AFTER tax (Roth 401k). Reduces take-home
//                     cash but NOT taxable income (already taxed).
//   from_cash       — funded from money you've already received (Roth IRA,
//                     brokerage, HYSA, other). Does NOT reduce take-home; it is a
//                     USE of take-home, subtracted from "remaining" like an
//                     expense.
//
// Employer match is NEVER a take-home reduction (it isn't withheld from your
// paycheck) — it only feeds the retirement projection's growth. So withholding
// resolution uses the EMPLOYEE side of resolveContributionSplit only.

import type { SavingsAccountType, TaxTreatment } from "./tool_registry.js";
import { resolveContributionSplit, type SavingsContributionInputs } from "./retirement_projector.js";
import { round2 } from "./money.js";

export type { TaxTreatment };

/** All valid treatment strings — for validation at the tool / DB boundary. */
export const TAX_TREATMENTS: readonly TaxTreatment[] = [
  "payroll_pretax",
  "payroll_posttax",
  "from_cash",
];

/**
 * Default tax treatment per account type. A per-account override
 * (savings_items.tax_treatment) takes precedence when set — see
 * resolveTreatment — so unusual or future "other" investments can be
 * reclassified by the user without a code change.
 */
const DEFAULT_TREATMENT: Record<SavingsAccountType, TaxTreatment> = {
  traditional_401k: "payroll_pretax",
  hsa: "payroll_pretax",
  roth_401k: "payroll_posttax",
  roth_ira: "from_cash",
  brokerage: "from_cash",
  hysa: "from_cash",
  // Unknown/other investments default to from_cash (the safe choice: it never
  // silently reduces take-home). Users can override per-account.
  other: "from_cash",
};

/** Default treatment for an account type (ignores any per-row override). */
export function accountTaxTreatment(accountType: SavingsAccountType): TaxTreatment {
  return DEFAULT_TREATMENT[accountType] ?? "from_cash";
}

/** Effective treatment for a row: explicit per-account override, else the
 *  account-type default. */
export function resolveTreatment(row: {
  accountType: SavingsAccountType;
  taxTreatment?: TaxTreatment | null;
}): TaxTreatment {
  return row.taxTreatment ?? accountTaxTreatment(row.accountType);
}

/** A savings row as far as withholding resolution is concerned. */
export interface WithholdingInputRow extends SavingsContributionInputs {
  accountType: SavingsAccountType;
  /** Optional per-account override of the account-type default treatment. */
  taxTreatment?: TaxTreatment | null;
  /** Which filer owns this account. Used by resolveWithholdingsByOwner to
   *  attribute the contribution to the correct filer; defaults to 'primary'
   *  when absent. Ignored by the single-salary resolveWithholdings(). */
  filingRole?: "primary" | "spouse";
}

/**
 * The annual employee-side contributions, bucketed by how they affect pay.
 * Employer match is excluded from all three (it isn't withheld).
 */
export interface Withholdings {
  /** Pre-tax payroll (traditional 401k + HSA). Reduces taxable + take-home. */
  pretaxAnnualDollars: number;
  /** Post-tax payroll (Roth 401k). Reduces take-home, NOT taxable. */
  postTaxPayrollAnnualDollars: number;
  /** From-cash (Roth IRA, brokerage, HYSA, other). A use of take-home, not a
   *  reduction of it. */
  fromCashAnnualDollars: number;
}

/**
 * Bucket every savings row's EMPLOYEE annual contribution by tax treatment.
 * `pct_of_salary` contributions resolve against `primaryTaxedGrossAnnualDollars`
 * (same base the retirement projector uses).
 */
export function resolveWithholdings(
  rows: WithholdingInputRow[],
  primaryTaxedGrossAnnualDollars: number,
): Withholdings {
  let pretax = 0;
  let postTaxPayroll = 0;
  let fromCash = 0;
  for (const row of rows) {
    const { employeeMonthly } = resolveContributionSplit(row, primaryTaxedGrossAnnualDollars);
    const employeeAnnual = employeeMonthly * 12;
    switch (resolveTreatment(row)) {
      case "payroll_pretax":
        pretax += employeeAnnual;
        break;
      case "payroll_posttax":
        postTaxPayroll += employeeAnnual;
        break;
      case "from_cash":
        fromCash += employeeAnnual;
        break;
    }
  }
  return {
    pretaxAnnualDollars: round2(pretax),
    postTaxPayrollAnnualDollars: round2(postTaxPayroll),
    fromCashAnnualDollars: round2(fromCash),
  };
}

/** Withholdings split by the filer who owns each account. */
export interface OwnerWithholdings {
  primary: Withholdings;
  spouse: Withholdings;
}

/**
 * Bucket savings rows by tax treatment AND by owning filer, resolving each
 * owner's `pct_of_salary` contributions against THAT owner's taxed gross.
 *
 * This is the dual-earner-correct counterpart to resolveWithholdings: a
 * spouse-owned Roth/traditional 401k feeds the spouse leg of takeHome() (and
 * its %-of-salary scales with the spouse's salary, not the primary's). Rows
 * with no filingRole default to 'primary', so a single-earner workspace (every
 * row 'primary', spouseTaxedGross 0) produces the exact same primary bucket as
 * the legacy resolveWithholdings(rows, primaryTaxedGross) call — behavior is
 * preserved.
 */
export function resolveWithholdingsByOwner(
  rows: WithholdingInputRow[],
  primaryTaxedGrossAnnualDollars: number,
  spouseTaxedGrossAnnualDollars: number,
): OwnerWithholdings {
  const primaryRows = rows.filter((r) => (r.filingRole ?? "primary") === "primary");
  const spouseRows = rows.filter((r) => r.filingRole === "spouse");
  return {
    primary: resolveWithholdings(primaryRows, primaryTaxedGrossAnnualDollars),
    spouse: resolveWithholdings(spouseRows, spouseTaxedGrossAnnualDollars),
  };
}
