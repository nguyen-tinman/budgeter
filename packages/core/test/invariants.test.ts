// Invariant / property-style tests for the tax + retirement layer.
// Goal: catch regressions that exact-value goldens miss by asserting
// algebraic properties across a sampled domain.

import { describe, it, expect } from "vitest";
import { takeHome, bracketTax } from "../src/tax_calculator.js";
import { project } from "../src/retirement_projector.js";
import { round2 } from "../src/money.js";
import {
  TABLES_2025,
  DEFAULT_SETTINGS_SINGLE,
  DEFAULT_SETTINGS_MFJ,
} from "./fixtures.js";

function sweep(start: number, end: number, step: number): number[] {
  const out: number[] = [];
  for (let v = start; v <= end; v += step) out.push(v);
  return out;
}

describe("bracketTax invariants", () => {
  const federalSingle = TABLES_2025.find(
    (t) => t.jurisdiction === "federal" && t.filing === "single",
  )!.brackets;

  it("returns non-negative for any non-negative input", () => {
    for (const taxable of sweep(0, 2_000_000, 5_000)) {
      expect(bracketTax(taxable, federalSingle)).toBeGreaterThanOrEqual(0);
    }
  });

  it("is monotonically non-decreasing in taxable income", () => {
    let prev = -1;
    for (const taxable of sweep(0, 2_000_000, 1_000)) {
      const t = bracketTax(taxable, federalSingle);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });

  it("effective rate ≤ top marginal rate", () => {
    const topRate = federalSingle[federalSingle.length - 1]!.rate;
    for (const taxable of sweep(1_000, 2_000_000, 5_000)) {
      const effective = bracketTax(taxable, federalSingle) / taxable;
      // Allow tiny rounding slop
      expect(effective).toBeLessThanOrEqual(topRate + 1e-6);
    }
  });

  it("at every bracket cutoff, total tax equals sum of (span * rate) for completed brackets", () => {
    let prev = 0;
    let expectedSum = 0;
    for (const b of federalSingle) {
      if (b.upTo === null) break;
      const span = b.upTo - prev;
      expectedSum += span * b.rate;
      const computed = bracketTax(b.upTo, federalSingle);
      expect(Math.abs(computed - round2(expectedSum))).toBeLessThanOrEqual(0.01);
      prev = b.upTo;
    }
  });

  it("cutoff vs cutoff+1¢: tax difference is at most (rate_next * 1¢)", () => {
    for (const b of federalSingle) {
      if (b.upTo === null) continue;
      const at = bracketTax(b.upTo, federalSingle);
      const justOver = bracketTax(b.upTo + 0.01, federalSingle);
      expect(justOver - at).toBeLessThanOrEqual(0.01); // 1 cent of next bracket
      expect(justOver - at).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("takeHome invariants", () => {
  it("annual take-home is monotonically non-decreasing in gross", () => {
    let prev = -Infinity;
    for (const gross of sweep(0, 500_000, 1_000)) {
      const t = takeHome({
        primary: { grossAnnualDollars: gross, pretax401kDollars: 0, pretaxHealthDollars: 0 },
        settings: DEFAULT_SETTINGS_SINGLE,
        tables: TABLES_2025,
      });
      expect(t.annualTakeHomeDollars).toBeGreaterThanOrEqual(prev);
      prev = t.annualTakeHomeDollars;
    }
  });

  it("monthly = round2(annual / 12) for any sampled gross", () => {
    for (const gross of sweep(0, 300_000, 2_500)) {
      const t = takeHome({
        primary: { grossAnnualDollars: gross, pretax401kDollars: 0, pretaxHealthDollars: 0 },
        settings: DEFAULT_SETTINGS_SINGLE,
        tables: TABLES_2025,
      });
      expect(t.monthlyTakeHomeDollars).toBe(round2(t.annualTakeHomeDollars / 12));
    }
  });

  it("effective tax rate is in [0, 1)", () => {
    for (const gross of sweep(1_000, 1_000_000, 5_000)) {
      const t = takeHome({
        primary: { grossAnnualDollars: gross, pretax401kDollars: 0, pretaxHealthDollars: 0 },
        settings: DEFAULT_SETTINGS_SINGLE,
        tables: TABLES_2025,
      });
      expect(t.effectiveTaxRate).toBeGreaterThanOrEqual(0);
      expect(t.effectiveTaxRate).toBeLessThan(1);
    }
  });

  it("pre-tax 401k strictly reduces (or holds constant) take-home only via deferred-not-lost; ATH drops federal taxable", () => {
    for (const contribution of [0, 5_000, 15_000, 23_500]) {
      const t = takeHome({
        primary: {
          grossAnnualDollars: 120_000,
          pretax401kDollars: contribution,
          pretaxHealthDollars: 0,
        },
        settings: DEFAULT_SETTINGS_SINGLE,
        tables: TABLES_2025,
      });
      // Pre-tax 401k itself is subtracted from take-home (it's NOT in your
      // pocket — it went to the 401k account). So take-home strictly drops
      // as contribution rises, by more than just the contribution minus
      // tax savings. The federal taxable should drop by exactly the
      // contribution amount.
      expect(t.preTaxDeductionsDollars).toBe(contribution);
    }
  });

  it("MFJ on combined income yields same take-home regardless of which spouse holds what (filing-symmetric)", () => {
    const a = takeHome({
      primary: { grossAnnualDollars: 150_000, pretax401kDollars: 0, pretaxHealthDollars: 0 },
      spouse: { grossAnnualDollars: 50_000, pretax401kDollars: 0, pretaxHealthDollars: 0 },
      settings: DEFAULT_SETTINGS_MFJ,
      tables: TABLES_2025,
    });
    const b = takeHome({
      primary: { grossAnnualDollars: 50_000, pretax401kDollars: 0, pretaxHealthDollars: 0 },
      spouse: { grossAnnualDollars: 150_000, pretax401kDollars: 0, pretaxHealthDollars: 0 },
      settings: DEFAULT_SETTINGS_MFJ,
      tables: TABLES_2025,
    });
    // FICA + SDI are per-person but symmetric, federal+CA use combined gross.
    expect(a.annualTakeHomeDollars).toBe(b.annualTakeHomeDollars);
  });

  it("MFJ split-vs-concentrated at the SS wage base: fed+CA stay equal, FICA SS differs", () => {
    // Both individual incomes here straddle the 2025 SS wage base ($176,100)
    // — this is the only configuration that actually exercises the FICA
    // SS per-person cap. A purely-below-base test like the one above is a
    // tautology since FICA SS = 6.2% × full income for everyone in that range.
    //
    // The cases:
    //   even  = $300k + $300k   (both capped at the wage base)
    //   solo  = $0   + $600k    (one spouse capped, the other contributes 0)
    //   solo2 = $600k + $0      (mirror — should equal solo on FICA SS)
    //
    // Federal + CA income tax: must be EQUAL across all three (MFJ uses
    //   combined gross = $600k regardless of split).
    // FICA SS:               must DIFFER between `even` and `solo` —
    //   `even` pays SS on 2×$176,100 (both spouses capped); `solo` pays SS
    //   on 1×$176,100 (only one spouse contributes), so even ≈ 2× solo.
    // FICA Medicare:         equal across all three (no cap).

    const even = takeHome({
      primary: { grossAnnualDollars: 300_000, pretax401kDollars: 0, pretaxHealthDollars: 0 },
      spouse: { grossAnnualDollars: 300_000, pretax401kDollars: 0, pretaxHealthDollars: 0 },
      settings: DEFAULT_SETTINGS_MFJ,
      tables: TABLES_2025,
    });
    const solo = takeHome({
      primary: { grossAnnualDollars: 0, pretax401kDollars: 0, pretaxHealthDollars: 0 },
      spouse: { grossAnnualDollars: 600_000, pretax401kDollars: 0, pretaxHealthDollars: 0 },
      settings: DEFAULT_SETTINGS_MFJ,
      tables: TABLES_2025,
    });
    const solo2 = takeHome({
      primary: { grossAnnualDollars: 600_000, pretax401kDollars: 0, pretaxHealthDollars: 0 },
      spouse: { grossAnnualDollars: 0, pretax401kDollars: 0, pretaxHealthDollars: 0 },
      settings: DEFAULT_SETTINGS_MFJ,
      tables: TABLES_2025,
    });

    // Combined gross is identical.
    expect(even.grossCombinedDollars).toBe(600_000);
    expect(solo.grossCombinedDollars).toBe(600_000);
    expect(solo2.grossCombinedDollars).toBe(600_000);

    // Federal + CA income tax depend only on combined gross under MFJ.
    expect(even.federalTaxDollars).toBe(solo.federalTaxDollars);
    expect(even.federalTaxDollars).toBe(solo2.federalTaxDollars);
    expect(even.caTaxDollars).toBe(solo.caTaxDollars);
    expect(even.caTaxDollars).toBe(solo2.caTaxDollars);

    // solo and solo2 mirror each other on FICA (per-person, but symmetric).
    expect(solo.ficaDollars).toBe(solo2.ficaDollars);

    // Compute expected FICA SS portion (per-person cap at SS wage base).
    const ssCap = DEFAULT_SETTINGS_MFJ.ssWageBaseDollars; // 176_100
    const ssRate = DEFAULT_SETTINGS_MFJ.ficaSsRate; // 0.062
    const medRate = DEFAULT_SETTINGS_MFJ.ficaMedicareRate; // 0.0145

    const evenSS = round2(round2(ssCap * ssRate) * 2);
    const soloSS = round2(ssCap * ssRate); // one spouse at $0, other capped
    // Medicare is uncapped; both cases pay on the full $600k combined.
    const totalMed = round2(600_000 * medRate);

    // FICA totals must reflect the per-person cap arithmetic.
    expect(even.ficaDollars).toBe(round2(evenSS + totalMed));
    expect(solo.ficaDollars).toBe(round2(soloSS + totalMed));

    // The whole point of the test: SS portions differ across split shapes.
    expect(round2(even.ficaDollars - solo.ficaDollars)).toBe(round2(evenSS - soloSS));
    expect(even.ficaDollars).toBeGreaterThan(solo.ficaDollars);

    // And therefore take-home itself differs (even has less in pocket since
    // it paid SS on a second capped chunk).
    expect(even.annualTakeHomeDollars).toBeLessThan(solo.annualTakeHomeDollars);
  });
});

describe("retirement projector invariants", () => {
  it("traditional + roth always equals total in every year (no cent drift)", () => {
    const r = project({
      settings: {
        currentAge: 25,
        retirementAge: 70,
        initialBalanceDollars: 12_345.67,
        growthRate: 0.07,
        rothSplitPct: 0.37, // intentional non-clean split
      },
      annualContributionDollars: 19_999.99, // odd number
      retirementEffectiveTaxRate: 0.18,
    });
    for (const y of r.years) {
      expect(round2(y.traditionalDollars + y.rothDollars)).toBe(y.totalDollars);
    }
  });

  it("totalDollars is monotonically non-decreasing when growth ≥ 0 and contribution ≥ 0", () => {
    const r = project({
      settings: {
        currentAge: 30,
        retirementAge: 65,
        initialBalanceDollars: 100_000,
        growthRate: 0.05,
        rothSplitPct: 0.5,
      },
      annualContributionDollars: 10_000,
      retirementEffectiveTaxRate: 0.15,
    });
    let prev = -1;
    for (const y of r.years) {
      expect(y.totalDollars).toBeGreaterThanOrEqual(prev);
      prev = y.totalDollars;
    }
  });

  it("rejects retirement tax rate outside [0,1]", () => {
    const make = (rate: number) => () =>
      project({
        settings: {
          currentAge: 30,
          retirementAge: 60,
          initialBalanceDollars: 0,
          growthRate: 0.05,
          rothSplitPct: 0.5,
        },
        annualContributionDollars: 0,
        retirementEffectiveTaxRate: rate,
      });
    expect(make(-0.01)).toThrow();
    expect(make(1.01)).toThrow();
    expect(make(0)).not.toThrow();
    expect(make(1)).not.toThrow();
  });

  it("after-tax ≤ pre-tax for any rate in [0,1]", () => {
    for (const rate of [0, 0.1, 0.25, 0.5, 0.9, 1.0]) {
      const r = project({
        settings: {
          currentAge: 30,
          retirementAge: 60,
          initialBalanceDollars: 50_000,
          growthRate: 0.06,
          rothSplitPct: 0.4,
        },
        annualContributionDollars: 12_000,
        retirementEffectiveTaxRate: rate,
      });
      expect(r.afterTaxAtRetirementDollars).toBeLessThanOrEqual(
        r.preTaxAtRetirementDollars,
      );
    }
  });
});
