import { describe, it, expect } from "vitest";
import {
  bracketTax,
  federalTax,
  caTax,
  ficaForIndividual,
  caSdiForIndividual,
  takeHome,
} from "../src/tax_calculator.js";
import { round2 } from "../src/money.js";
import { TABLES_2025, DEFAULT_SETTINGS_SINGLE, DEFAULT_SETTINGS_MFJ } from "./fixtures.js";

const single = TABLES_2025.find(
  (t) => t.jurisdiction === "federal" && t.filing === "single",
)!;

describe("bracketTax", () => {
  it("returns 0 for zero/negative taxable", () => {
    expect(bracketTax(0, single.brackets)).toBe(0);
    expect(bracketTax(-1, single.brackets)).toBe(0);
  });

  it("computes within-first-bracket correctly", () => {
    // Federal single: first $11,925 @ 10%
    // Test: $10,000 taxable → $1,000.00
    expect(bracketTax(10_000, single.brackets)).toBe(1_000);
  });

  it("spans multiple brackets exactly", () => {
    // Hits cutoff $11,925 boundary: tax = 11925 * 0.10 = 1192.50
    expect(bracketTax(11_925, single.brackets)).toBe(1_192.5);
  });

  it("crosses bracket boundary", () => {
    // $20,000 taxable for single:
    //   first 11,925 @ 10% = 1,192.50
    //   next 8,075 (to 20,000) @ 12% = 969.00
    //   total = 2,161.50
    expect(bracketTax(20_000, single.brackets)).toBe(2_161.5);
  });

  it("hits the top bracket", () => {
    // $1,000,000 taxable, 2025 federal single brackets:
    //   11925 @ 10%        = 1,192.50
    //   (48475-11925)=36550 @ 12% = 4,386.00
    //   (103350-48475)=54875 @ 22% = 12,072.50
    //   (197300-103350)=93950 @ 24% = 22,548.00
    //   (250525-197300)=53225 @ 32% = 17,032.00
    //   (626350-250525)=375825 @ 35% = 131,538.75
    //   (1000000-626350)=373650 @ 37% = 138,250.50
    //   total = 327,020.25
    expect(bracketTax(1_000_000, single.brackets)).toBe(327_020.25);
  });
});

describe("federalTax", () => {
  it("$120k single, no pre-tax: matches manual bracket walk", () => {
    const fed = federalTax({
      primary: { grossAnnualDollars: 120_000, pretax401kDollars: 0, pretaxHealthDollars: 0 },
      settings: DEFAULT_SETTINGS_SINGLE,
      tables: TABLES_2025,
    });
    // taxable = 120,000 - 15,750 std ded (post-OBBBA) = 104,250
    // 11925 @ 10%             = 1,192.50
    // (48475-11925)=36550 @ 12% = 4,386.00
    // (103350-48475)=54875 @ 22% = 12,072.50
    // (104250-103350)=900 @ 24% = 216.00
    // total = 17,867.00
    expect(fed.taxableDollars).toBe(104_250);
    expect(fed.taxDollars).toBe(17_867);
  });

  it("pre-tax 401k drops federal taxable by the contribution amount", () => {
    const fed = federalTax({
      primary: {
        grossAnnualDollars: 120_000,
        pretax401kDollars: 12_000, // $12k pre-tax
        pretaxHealthDollars: 0,
      },
      settings: DEFAULT_SETTINGS_SINGLE,
      tables: TABLES_2025,
    });
    // taxable = 120k - 12k - 15.75k = 92,250
    expect(fed.taxableDollars).toBe(92_250);
    // 11925 @ 10%             = 1,192.50
    // (48475-11925)=36550 @ 12% = 4,386.00
    // (92250-48475)=43775 @ 22% = 9,630.50
    // total = 15,209
    expect(fed.taxDollars).toBe(15_209);
  });
});

describe("caTax", () => {
  it("$120k single CA: matches manual bracket walk", () => {
    const ca = caTax({
      primary: { grossAnnualDollars: 120_000, pretax401kDollars: 0, pretaxHealthDollars: 0 },
      settings: DEFAULT_SETTINGS_SINGLE,
      tables: TABLES_2025,
    });
    // taxable = 120,000 - 5,685 std ded = 114,315
    // CA single brackets walked:
    //   10756 @ 0.01 = 107.56
    //   14743 @ 0.02 = 294.86
    //   14746 @ 0.04 = 589.84
    //   15621 @ 0.06 = 937.26
    //   14740 @ 0.08 = 1179.20
    //   (114315-70606)=43709 @ 0.093 = 4064.937
    // sum = 107.56 + 294.86 + 589.84 + 937.26 + 1179.20 + 4064.937
    //     = 7,173.657 → round2 → 7,173.66
    expect(ca.taxableDollars).toBe(114_315);
    expect(ca.taxDollars).toBe(7_173.66);
  });
});

describe("ficaForIndividual", () => {
  it("$120k stays under SS wage base", () => {
    // SS: 120000 * 0.062 = 7440
    // Medicare: 120000 * 0.0145 = 1740
    // total = 9180
    const f = ficaForIndividual(
      { grossAnnualDollars: 120_000, pretax401kDollars: 0, pretaxHealthDollars: 0 },
      DEFAULT_SETTINGS_SINGLE.ssWageBaseDollars,
      DEFAULT_SETTINGS_SINGLE.ficaSsRate,
      DEFAULT_SETTINGS_SINGLE.ficaMedicareRate,
    );
    expect(f).toBe(9_180);
  });

  it("$300k caps SS portion at wage base", () => {
    // 2025 wage base $176,100:
    //   SS:       176,100 * 0.062 = 10,918.20
    //   Medicare: 300,000 * 0.0145 = 4,350.00
    //   total:                     15,268.20
    const f = ficaForIndividual(
      { grossAnnualDollars: 300_000, pretax401kDollars: 0, pretaxHealthDollars: 0 },
      DEFAULT_SETTINGS_SINGLE.ssWageBaseDollars,
      DEFAULT_SETTINGS_SINGLE.ficaSsRate,
      DEFAULT_SETTINGS_SINGLE.ficaMedicareRate,
    );
    expect(f).toBe(15_268.2);
  });
});

describe("caSdiForIndividual", () => {
  it("applies 1.1% with no cap", () => {
    expect(
      caSdiForIndividual(
        { grossAnnualDollars: 120_000, pretax401kDollars: 0, pretaxHealthDollars: 0 },
        0.011,
      ),
    ).toBe(1_320);
  });
});

describe("takeHome (the headline computation)", () => {
  it("$120k single CA: lands in the planned $82k-$85k annual range", () => {
    const t = takeHome({
      primary: { grossAnnualDollars: 120_000, pretax401kDollars: 0, pretaxHealthDollars: 0 },
      settings: DEFAULT_SETTINGS_SINGLE,
      tables: TABLES_2025,
    });
    // Components (all in dollars):
    //   federal: 17,867.00 (post-OBBBA std ded $15,750)
    //   ca:        7,173.66
    //   fica:      9,180.00 (SS wage base $176,100 — $120k below cap)
    //   sdi:       1,320.00
    //   total tax: 35,540.66
    // take-home: 120,000 - 35,540.66 = 84,459.34
    expect(t.federalTaxDollars).toBe(17_867);
    expect(t.caTaxDollars).toBe(7_173.66);
    expect(t.ficaDollars).toBe(9_180);
    expect(t.caSdiDollars).toBe(1_320);
    expect(t.annualTakeHomeDollars).toBe(84_459.34);
    expect(t.annualTakeHomeDollars).toBeGreaterThanOrEqual(82_000); // $82k floor
    expect(t.annualTakeHomeDollars).toBeLessThanOrEqual(85_000); // $85k ceiling
    expect(t.monthlyTakeHomeDollars).toBe(round2(t.annualTakeHomeDollars / 12));
  });

  it("$200k MFJ ($120k + $80k) CA: lands roughly $144k-$150k", () => {
    const t = takeHome({
      primary: { grossAnnualDollars: 120_000, pretax401kDollars: 0, pretaxHealthDollars: 0 },
      spouse: { grossAnnualDollars: 80_000, pretax401kDollars: 0, pretaxHealthDollars: 0 },
      settings: DEFAULT_SETTINGS_MFJ,
      tables: TABLES_2025,
    });
    expect(t.grossCombinedDollars).toBe(200_000);
    expect(t.annualTakeHomeDollars).toBeGreaterThanOrEqual(144_000);
    expect(t.annualTakeHomeDollars).toBeLessThanOrEqual(150_000);
  });

  it("$0 income yields $0 take-home and 0% rate", () => {
    const t = takeHome({
      primary: { grossAnnualDollars: 0, pretax401kDollars: 0, pretaxHealthDollars: 0 },
      settings: DEFAULT_SETTINGS_SINGLE,
      tables: TABLES_2025,
    });
    expect(t.annualTakeHomeDollars).toBe(0);
    expect(t.effectiveTaxRate).toBe(0);
  });

  it("10% pre-tax 401k of $120k reduces fed tax by roughly marginal_rate × contribution", () => {
    const baseline = takeHome({
      primary: { grossAnnualDollars: 120_000, pretax401kDollars: 0, pretaxHealthDollars: 0 },
      settings: DEFAULT_SETTINGS_SINGLE,
      tables: TABLES_2025,
    });
    const with401k = takeHome({
      primary: {
        grossAnnualDollars: 120_000,
        pretax401kDollars: 12_000, // 10% of 120k
        pretaxHealthDollars: 0,
      },
      settings: DEFAULT_SETTINGS_SINGLE,
      tables: TABLES_2025,
    });
    // Federal marginal rate at $105k is 22%. Pulling 12k out of taxable
    // should drop federal tax by ~22% * 12k = 2,640 (in dollars).
    const fedDelta = baseline.federalTaxDollars - with401k.federalTaxDollars;
    expect(fedDelta).toBeGreaterThanOrEqual(2_600); // ≥ $2,600
    expect(fedDelta).toBeLessThanOrEqual(2_800); // ≤ $2,800
  });

  it("$1M MFJ in CA exercises top brackets without overflow", () => {
    const t = takeHome({
      primary: { grossAnnualDollars: 600_000, pretax401kDollars: 0, pretaxHealthDollars: 0 },
      spouse: { grossAnnualDollars: 400_000, pretax401kDollars: 0, pretaxHealthDollars: 0 },
      settings: DEFAULT_SETTINGS_MFJ,
      tables: TABLES_2025,
    });
    expect(t.grossCombinedDollars).toBe(1_000_000);
    // Sanity: positive take-home, effective rate in a sensible range
    expect(t.annualTakeHomeDollars).toBeGreaterThan(0);
    expect(t.effectiveTaxRate).toBeGreaterThan(0.25);
    expect(t.effectiveTaxRate).toBeLessThan(0.55);
  });
});
