import { describe, it, expect } from "vitest";
import {
  project,
  effectiveMonthlyContributionDollars,
} from "../src/retirement_projector.js";
import { round2 } from "../src/money.js";

describe("retirement projector", () => {
  it("rejects retirement age <= current age", () => {
    expect(() =>
      project({
        settings: {
          currentAge: 65,
          retirementAge: 65,
          initialBalanceDollars: 0,
          growthRate: 0.07,
          rothSplitPct: 0.5,
        },
        annualContributionDollars: 0,
        retirementEffectiveTaxRate: 0.12,
      }),
    ).toThrow();
  });

  it("zero everything → all zero snapshots", () => {
    const r = project({
      settings: {
        currentAge: 30,
        retirementAge: 35,
        initialBalanceDollars: 0,
        growthRate: 0.0,
        rothSplitPct: 0.5,
      },
      annualContributionDollars: 0,
      retirementEffectiveTaxRate: 0.0,
    });
    expect(r.years).toHaveLength(6); // year 0..5
    for (const y of r.years) {
      expect(y.totalDollars).toBe(0);
    }
    expect(r.preTaxAtRetirementDollars).toBe(0);
    expect(r.afterTaxAtRetirementDollars).toBe(0);
  });

  it("single year, only initial balance grows at growth rate", () => {
    const r = project({
      settings: {
        currentAge: 30,
        retirementAge: 31,
        initialBalanceDollars: 100_000, // $100,000
        growthRate: 0.10,
        rothSplitPct: 0.5,
      },
      annualContributionDollars: 0,
      retirementEffectiveTaxRate: 0.20,
    });
    expect(r.years).toHaveLength(2);
    // initial: trad=50k, roth=50k, total=100k
    expect(r.years[0]!.traditionalDollars).toBe(50_000);
    expect(r.years[0]!.rothDollars).toBe(50_000);
    // After 1 year at 10%: each side becomes 55k
    expect(r.years[1]!.traditionalDollars).toBe(55_000);
    expect(r.years[1]!.rothDollars).toBe(55_000);
    expect(r.years[1]!.totalDollars).toBe(110_000);
    expect(r.preTaxAtRetirementDollars).toBe(110_000);
    // After-tax: traditional 55k * 0.8 + roth 55k = 44k + 55k = 99k
    expect(r.afterTaxAtRetirementDollars).toBe(99_000);
  });

  it("30→65 with $20k/yr at 7%, 50/50 split, $0 start: matches FV", () => {
    const r = project({
      settings: {
        currentAge: 30,
        retirementAge: 65,
        initialBalanceDollars: 0,
        growthRate: 0.07,
        rothSplitPct: 0.5,
      },
      annualContributionDollars: 20_000, // $20k/yr
      retirementEffectiveTaxRate: 0.12,
    });
    // 36 snapshots (ages 30..65 inclusive)
    expect(r.years).toHaveLength(36);

    // Future value of an annuity (end-of-year deposits, no initial):
    //   FV = PMT * ((1+r)^n - 1) / r
    //   PMT = 20000, r = 0.07, n = 35
    //   (1.07)^35 ≈ 10.676581
    //   FV ≈ 20000 * (10.676581 - 1) / 0.07
    //   FV ≈ 20000 * 138.236866 ≈ 2,764,737
    // Our 2dp-dollar math will be within $1k of this.
    const expectedTotal = 2_764_737; // ~$2,764,737
    expect(r.preTaxAtRetirementDollars).toBeGreaterThanOrEqual(expectedTotal - 1_000);
    expect(r.preTaxAtRetirementDollars).toBeLessThanOrEqual(expectedTotal + 1_000);

    // Roth and Traditional should be equal (50/50 split, all contributions, no init)
    const last = r.years[r.years.length - 1]!;
    expect(Math.abs(last.traditionalDollars - last.rothDollars)).toBeLessThan(0.02); // ≤ rounding
  });

  it("after-tax < pre-tax for any positive retirement tax rate", () => {
    const r = project({
      settings: {
        currentAge: 30,
        retirementAge: 65,
        initialBalanceDollars: 50_000,
        growthRate: 0.07,
        rothSplitPct: 0.5,
      },
      annualContributionDollars: 15_000,
      retirementEffectiveTaxRate: 0.15,
    });
    expect(r.afterTaxAtRetirementDollars).toBeLessThan(r.preTaxAtRetirementDollars);
    // With 50% Roth, the after-tax penalty applies to only the traditional half.
    // Penalty = traditional * 0.15
    const last = r.years[r.years.length - 1]!;
    const expectedPenalty = round2(last.traditionalDollars * 0.15);
    expect(round2(r.preTaxAtRetirementDollars - r.afterTaxAtRetirementDollars)).toBe(
      expectedPenalty,
    );
  });

  it("100% Roth split → after-tax === pre-tax", () => {
    const r = project({
      settings: {
        currentAge: 30,
        retirementAge: 65,
        initialBalanceDollars: 0,
        growthRate: 0.07,
        rothSplitPct: 1.0,
      },
      annualContributionDollars: 20_000,
      retirementEffectiveTaxRate: 0.25,
    });
    expect(r.afterTaxAtRetirementDollars).toBe(r.preTaxAtRetirementDollars);
  });

  it("100% Traditional split → after-tax = pre-tax × (1 - rate)", () => {
    const r = project({
      settings: {
        currentAge: 30,
        retirementAge: 65,
        initialBalanceDollars: 0,
        growthRate: 0.07,
        rothSplitPct: 0.0,
      },
      annualContributionDollars: 20_000,
      retirementEffectiveTaxRate: 0.25,
    });
    const last = r.years[r.years.length - 1]!;
    expect(last.rothDollars).toBe(0);
    expect(r.afterTaxAtRetirementDollars).toBe(
      round2(last.traditionalDollars * 0.75),
    );
  });
});

describe("effectiveMonthlyContributionDollars", () => {
  const grossAnnual = 120_000; // $120k taxed gross

  it("flat monthly + no match → just the flat amount", () => {
    expect(
      effectiveMonthlyContributionDollars(
        {
          monthlyContributionDollars: 1000,
          contributionPctOfSalary: null,
          employerMatchKind: "none",
          employerMatchValue: null,
        },
        grossAnnual,
      ),
    ).toBe(1000);
  });

  it("pct of salary overrides flat monthly; adds employer pct match on top", () => {
    // 10% of $120k = $12k/yr employee = $1000/mo
    // 4% of $120k = $4.8k/yr employer = $400/mo
    // Combined: $1400/mo
    expect(
      effectiveMonthlyContributionDollars(
        {
          monthlyContributionDollars: 9999, // ignored when pct is set
          contributionPctOfSalary: 0.1,
          employerMatchKind: "pct_of_salary",
          employerMatchValue: 0.04,
        },
        grossAnnual,
      ),
    ).toBe(1400);
  });

  it("flat monthly + flat-annual employer match → employee monthly + match/12", () => {
    // $500/mo employee + $6000/yr employer = $500 + $500 = $1000/mo
    expect(
      effectiveMonthlyContributionDollars(
        {
          monthlyContributionDollars: 500,
          contributionPctOfSalary: null,
          employerMatchKind: "flat_annual_dollars",
          employerMatchValue: 6000,
        },
        grossAnnual,
      ),
    ).toBe(1000);
  });

  it("contributionPctOfSalary=0 is treated as 'not set' (falls back to flat monthly)", () => {
    // The pct=0 case should NOT zero out the contribution — that's the role
    // of contributionPctOfSalary=null. A user setting 0% on the UI explicitly
    // means "use the flat dollar amount instead", a common toggle pattern.
    expect(
      effectiveMonthlyContributionDollars(
        {
          monthlyContributionDollars: 750,
          contributionPctOfSalary: 0,
          employerMatchKind: "none",
          employerMatchValue: null,
        },
        grossAnnual,
      ),
    ).toBe(750);
  });
});
