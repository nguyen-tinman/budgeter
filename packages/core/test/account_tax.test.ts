// account_tax — classification of savings accounts by how their contributions
// flow through pay, and the withholding resolver that feeds take-home.

import { describe, it, expect } from "vitest";
import {
  accountTaxTreatment,
  resolveTreatment,
  resolveWithholdings,
  resolveWithholdingsByOwner,
  type WithholdingInputRow,
} from "../src/account_tax.js";
import { resolveContributionSplit, takeHome } from "../src/index.js";
import type { SavingsContributionInputs } from "../src/retirement_projector.js";

const flat = (
  monthlyContributionDollars: number,
  extra: Partial<SavingsContributionInputs> = {},
): SavingsContributionInputs => ({
  monthlyContributionDollars,
  contributionPctOfSalary: null,
  employerMatchKind: "none",
  employerMatchValue: null,
  ...extra,
});

const row = (
  accountType: WithholdingInputRow["accountType"],
  contrib: Partial<WithholdingInputRow> = {},
): WithholdingInputRow => ({
  accountType,
  monthlyContributionDollars: 0,
  contributionPctOfSalary: null,
  employerMatchKind: "none",
  employerMatchValue: null,
  ...contrib,
});

describe("accountTaxTreatment", () => {
  it("classifies pre-tax payroll accounts", () => {
    expect(accountTaxTreatment("traditional_401k")).toBe("payroll_pretax");
    expect(accountTaxTreatment("hsa")).toBe("payroll_pretax");
  });
  it("classifies post-tax payroll (Roth 401k)", () => {
    expect(accountTaxTreatment("roth_401k")).toBe("payroll_posttax");
  });
  it("classifies from-cash accounts", () => {
    expect(accountTaxTreatment("roth_ira")).toBe("from_cash");
    expect(accountTaxTreatment("brokerage")).toBe("from_cash");
    expect(accountTaxTreatment("hysa")).toBe("from_cash");
    expect(accountTaxTreatment("other")).toBe("from_cash");
  });
  it("honors a per-account override via resolveTreatment", () => {
    expect(resolveTreatment({ accountType: "other", taxTreatment: "payroll_pretax" })).toBe("payroll_pretax");
    expect(resolveTreatment({ accountType: "traditional_401k", taxTreatment: null })).toBe("payroll_pretax");
  });
});

describe("resolveContributionSplit", () => {
  it("splits a flat employee contribution from a pct employer match", () => {
    const s = resolveContributionSplit(
      flat(1000, { employerMatchKind: "pct_of_salary", employerMatchValue: 0.05 }),
      120_000,
    );
    expect(s.employeeMonthly).toBe(1000);
    expect(s.employerMonthly).toBe(500); // 120k * 0.05 / 12
  });
  it("uses pct-of-salary for the employee side when set", () => {
    const s = resolveContributionSplit(
      flat(0, { contributionPctOfSalary: 0.1 }),
      120_000,
    );
    expect(s.employeeMonthly).toBe(1000); // 120k * 0.10 / 12
  });
});

describe("resolveWithholdings", () => {
  it("buckets employee contributions by treatment and EXCLUDES employer match", () => {
    const rows: WithholdingInputRow[] = [
      // traditional 401k: $1000/mo employee + 5% employer match (excluded).
      row("traditional_401k", { monthlyContributionDollars: 1000, employerMatchKind: "pct_of_salary", employerMatchValue: 0.05 }),
      // HSA: $300/mo → pre-tax.
      row("hsa", { monthlyContributionDollars: 300 }),
      // Roth 401k: $500/mo → post-tax payroll.
      row("roth_401k", { monthlyContributionDollars: 500 }),
      // Roth IRA: $500/mo → from-cash (does NOT touch take-home).
      row("roth_ira", { monthlyContributionDollars: 500 }),
      // Brokerage: $200/mo → from-cash.
      row("brokerage", { monthlyContributionDollars: 200 }),
    ];
    const wh = resolveWithholdings(rows, 120_000);
    expect(wh.pretaxAnnualDollars).toBe((1000 + 300) * 12); // 15,600 — employer match NOT included
    expect(wh.postTaxPayrollAnnualDollars).toBe(500 * 12); // 6,000
    expect(wh.fromCashAnnualDollars).toBe((500 + 200) * 12); // 8,400
  });

  it("resolves pct-of-salary against the provided gross", () => {
    const wh = resolveWithholdings(
      [row("traditional_401k", { contributionPctOfSalary: 0.1 })],
      150_000,
    );
    expect(wh.pretaxAnnualDollars).toBe(15_000); // 150k * 0.10
  });

  it("respects a per-account treatment override", () => {
    const wh = resolveWithholdings(
      [row("other", { monthlyContributionDollars: 100, taxTreatment: "payroll_pretax" })],
      120_000,
    );
    expect(wh.pretaxAnnualDollars).toBe(1200);
    expect(wh.fromCashAnnualDollars).toBe(0);
  });
});

describe("resolveWithholdingsByOwner", () => {
  it("attributes each row to its owning filer's bucket", () => {
    const rows: WithholdingInputRow[] = [
      row("traditional_401k", { monthlyContributionDollars: 1000, filingRole: "primary" }),
      row("roth_401k", { monthlyContributionDollars: 500, filingRole: "spouse" }),
      row("roth_ira", { monthlyContributionDollars: 200, filingRole: "spouse" }),
    ];
    const wh = resolveWithholdingsByOwner(rows, 120_000, 90_000);
    expect(wh.primary.pretaxAnnualDollars).toBe(12_000); // primary's 401k only
    expect(wh.primary.postTaxPayrollAnnualDollars).toBe(0);
    expect(wh.spouse.postTaxPayrollAnnualDollars).toBe(6_000); // spouse Roth 401k
    expect(wh.spouse.fromCashAnnualDollars).toBe(2_400); // spouse Roth IRA
    expect(wh.spouse.pretaxAnnualDollars).toBe(0);
  });

  it("resolves each owner's pct-of-salary against THAT owner's salary", () => {
    // Both filers contribute 10% of salary to a traditional 401k. The %-of-
    // salary must scale against the correct salary per filer.
    const rows: WithholdingInputRow[] = [
      row("traditional_401k", { contributionPctOfSalary: 0.1, filingRole: "primary" }),
      row("traditional_401k", { contributionPctOfSalary: 0.1, filingRole: "spouse" }),
    ];
    const wh = resolveWithholdingsByOwner(rows, 150_000, 80_000);
    expect(wh.primary.pretaxAnnualDollars).toBe(15_000); // 150k * 0.10
    expect(wh.spouse.pretaxAnnualDollars).toBe(8_000); // 80k * 0.10 (NOT 15k)
  });

  it("treats a missing filingRole as 'primary' (single-earner back-compat)", () => {
    // Identical to the legacy single-salary resolveWithholdings call: every row
    // is primary, spouse salary is 0, so the spouse bucket is empty.
    const rows: WithholdingInputRow[] = [
      row("traditional_401k", { monthlyContributionDollars: 1000 }),
      row("roth_401k", { monthlyContributionDollars: 500 }),
    ];
    const byOwner = resolveWithholdingsByOwner(rows, 120_000, 0);
    const legacy = resolveWithholdings(rows, 120_000);
    expect(byOwner.primary).toEqual(legacy);
    expect(byOwner.spouse.pretaxAnnualDollars).toBe(0);
    expect(byOwner.spouse.postTaxPayrollAnnualDollars).toBe(0);
    expect(byOwner.spouse.fromCashAnnualDollars).toBe(0);
  });
});

describe("takeHome — postTaxPayroll (Roth 401k)", () => {
  const settings = {
    filing: "single" as const,
    taxYear: 2025,
    caSdiRate: 0,
    ssWageBaseDollars: 168_600,
    ficaSsRate: 0,
    ficaMedicareRate: 0,
    retirementEffectiveTaxRate: 0.2,
  };
  const tables = [
    { year: 2025, jurisdiction: "federal" as const, filing: "single" as const, standardDeductionDollars: 0, brackets: [{ upTo: null, rate: 0.2 }] },
    { year: 2025, jurisdiction: "ca" as const, filing: "single" as const, standardDeductionDollars: 0, brackets: [{ upTo: null, rate: 0 }] },
  ];

  it("reduces take-home cash but NOT taxable income", () => {
    const base = takeHome({ primary: { grossAnnualDollars: 100_000, pretax401kDollars: 0, pretaxHealthDollars: 0, postTaxPayrollDollars: 0 }, settings, tables });
    const roth = takeHome({ primary: { grossAnnualDollars: 100_000, pretax401kDollars: 0, pretaxHealthDollars: 0, postTaxPayrollDollars: 10_000 }, settings, tables });
    // Federal tax unchanged (Roth doesn't reduce taxable income).
    expect(roth.federalTaxDollars).toBe(base.federalTaxDollars);
    // Take-home is exactly $10k lower (the withheld Roth amount).
    expect(roth.annualTakeHomeDollars).toBe(base.annualTakeHomeDollars - 10_000);
    expect(roth.postTaxPayrollDollars).toBe(10_000);
  });

  it("pre-tax 401k reduces BOTH taxable income and take-home", () => {
    const base = takeHome({ primary: { grossAnnualDollars: 100_000, pretax401kDollars: 0, pretaxHealthDollars: 0 }, settings, tables });
    const pre = takeHome({ primary: { grossAnnualDollars: 100_000, pretax401kDollars: 10_000, pretaxHealthDollars: 0 }, settings, tables });
    // Federal tax drops by marginal rate * contribution (20% * 10k = 2k).
    expect(base.federalTaxDollars - pre.federalTaxDollars).toBe(2_000);
    // Take-home drops by contribution minus the tax saved: 10k - 2k = 8k.
    expect(base.annualTakeHomeDollars - pre.annualTakeHomeDollars).toBe(8_000);
  });
});
