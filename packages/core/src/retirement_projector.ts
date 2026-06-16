import type {
  RetirementSettings,
  YearSnapshot,
  RetirementProjection,
} from "./models.js";
import type { EmployerMatchKind } from "./tool_registry.js";
import { round2 } from "./money.js";

export interface ProjectInput {
  settings: RetirementSettings;
  /** Annual combined contribution in dollars (personal + employer + Roth IRA). */
  annualContributionDollars: number;
  /** Effective income tax rate applied to traditional withdrawals at retirement (0..1). */
  retirementEffectiveTaxRate: number;
}

/** Minimal shape consumed by effectiveMonthlyContributionDollars — kept
 *  structural (not a `SavingsRow` reference) so this helper stays usable
 *  by any caller that has the relevant fields, including light-weight
 *  test fakes. */
export interface SavingsContributionInputs {
  monthlyContributionDollars: number;
  contributionPctOfSalary: number | null;
  employerMatchKind: EmployerMatchKind;
  employerMatchValue: number | null;
}

/**
 * Combined (employee + employer) effective monthly contribution in dollars for
 * a savings row.
 *
 * Employee side:
 *   - If contributionPctOfSalary is non-null AND non-zero, the row's
 *     employee contribution is `(taxedGrossAnnualDollars * pct) / 12`. This
 *     is the "% of salary" 401k knob.
 *   - Otherwise, fall back to the stored monthlyContributionDollars flat
 *     dollar amount.
 *
 * Employer side (always added on top of the employee side):
 *   - 'pct_of_salary'    : `(taxedGrossAnnualDollars * value) / 12`
 *   - 'flat_annual_dollars': `value / 12`
 *   - 'none'             : 0
 *
 * Returns a 2dp dollar amount (rounded once at the end).
 */
/** The employee vs employer split of a row's monthly contribution. The
 *  employee side is what's withheld from the paycheck (relevant to take-home);
 *  the employer match is extra money that never touches the paycheck (relevant
 *  only to retirement growth). Neither side is rounded here — callers round at
 *  their own aggregation boundary. */
export interface ContributionSplit {
  employeeMonthly: number;
  employerMonthly: number;
}

/**
 * Resolve a savings row into its employee and employer monthly contributions,
 * WITHOUT summing them — so take-home (employee-only) and retirement growth
 * (employee + employer) can each take what they need.
 *
 * Employee side:
 *   - contributionPctOfSalary (non-null, non-zero) → (gross * pct) / 12.
 *   - else the stored monthlyContributionDollars.
 * Employer side:
 *   - 'pct_of_salary'      → (gross * value) / 12
 *   - 'flat_annual_dollars'→ value / 12
 *   - 'none'               → 0
 */
export function resolveContributionSplit(
  row: SavingsContributionInputs,
  taxedGrossAnnualDollars: number,
): ContributionSplit {
  let employeeMonthly: number;
  const pct = row.contributionPctOfSalary;
  if (pct !== null && pct !== 0) {
    employeeMonthly = (taxedGrossAnnualDollars * pct) / 12;
  } else {
    employeeMonthly = row.monthlyContributionDollars;
  }

  let employerMonthly = 0;
  const v = row.employerMatchValue;
  if (row.employerMatchKind === "pct_of_salary" && v !== null) {
    employerMonthly = (taxedGrossAnnualDollars * v) / 12;
  } else if (row.employerMatchKind === "flat_annual_dollars" && v !== null) {
    employerMonthly = v / 12;
  }

  return { employeeMonthly, employerMonthly };
}

/**
 * Combined (employee + employer) effective monthly contribution in dollars.
 * Thin wrapper over resolveContributionSplit — used by the retirement projector
 * (which grows the total pot). Returns a 2dp dollar amount.
 */
export function effectiveMonthlyContributionDollars(
  row: SavingsContributionInputs,
  taxedGrossAnnualDollars: number,
): number {
  const { employeeMonthly, employerMonthly } = resolveContributionSplit(
    row,
    taxedGrossAnnualDollars,
  );
  return round2(employeeMonthly + employerMonthly);
}

/**
 * Year-by-year compounding from currentAge → retirementAge.
 *
 * Contribution timing: end-of-year (deposit AFTER that year's growth).
 * This matches the convention used by FV(rate, n, pmt) when type=0 in Excel.
 *
 * The Roth/Traditional split applies to NEW contributions only. The initial
 * balance is split by the same ratio at year 0 — the model treats the initial
 * pot as if it were accumulated with the same lane policy. If the user knows
 * the actual split of their existing pot, they can adjust initial_balance_dollars
 * after looking at the projection, or we can extend the schema later to track
 * initial_traditional and initial_roth separately.
 */
export function project(input: ProjectInput): RetirementProjection {
  const { settings, annualContributionDollars, retirementEffectiveTaxRate } =
    input;
  const { currentAge, retirementAge, initialBalanceDollars, growthRate, rothSplitPct } =
    settings;

  if (retirementAge <= currentAge) {
    throw new Error(
      `retirementAge (${retirementAge}) must be greater than currentAge (${currentAge})`,
    );
  }
  if (rothSplitPct < 0 || rothSplitPct > 1) {
    throw new Error(`rothSplitPct must be 0..1, got ${rothSplitPct}`);
  }
  if (growthRate < -1) {
    throw new Error(`growthRate must be > -1, got ${growthRate}`);
  }
  if (retirementEffectiveTaxRate < 0 || retirementEffectiveTaxRate > 1) {
    throw new Error(
      `retirementEffectiveTaxRate must be 0..1, got ${retirementEffectiveTaxRate}`,
    );
  }

  const tradPct = 1 - rothSplitPct;
  const yearsToRetire = retirementAge - currentAge;

  // Year 0: split initial balance by the lane ratio. Round only one lane
  // and assign the residual to the other to preserve totalDollars exactly.
  let traditional = round2(initialBalanceDollars * tradPct);
  let roth = round2(initialBalanceDollars - traditional);

  // Per-year contribution split — also residual-based to avoid cent drift.
  const contribTrad = round2(annualContributionDollars * tradPct);
  const contribRoth = round2(annualContributionDollars - contribTrad);

  const years: YearSnapshot[] = [
    {
      age: currentAge,
      yearsElapsed: 0,
      traditionalDollars: traditional,
      rothDollars: roth,
      totalDollars: round2(traditional + roth),
    },
  ];

  for (let i = 1; i <= yearsToRetire; i++) {
    // Grow, then contribute (end-of-year deposit). Round each lane's running
    // balance to 2dp every iteration so decades of compounding don't drift.
    traditional = round2(round2(traditional * (1 + growthRate)) + contribTrad);
    roth = round2(round2(roth * (1 + growthRate)) + contribRoth);
    years.push({
      age: currentAge + i,
      yearsElapsed: i,
      traditionalDollars: traditional,
      rothDollars: roth,
      totalDollars: round2(traditional + roth),
    });
  }

  const last = years[years.length - 1]!;
  const preTax = round2(last.traditionalDollars + last.rothDollars);
  const afterTax =
    round2(
      round2(last.traditionalDollars * (1 - retirementEffectiveTaxRate)) +
        last.rothDollars,
    );

  return {
    years,
    preTaxAtRetirementDollars: preTax,
    afterTaxAtRetirementDollars: afterTax,
  };
}
