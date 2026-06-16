import { describe, it, expect } from "vitest";
import { expenseMonthlyDollars } from "../src/budget_math.js";

describe("expenseMonthlyDollars", () => {
  it("normalizes each frequency to a monthly figure", () => {
    expect(expenseMonthlyDollars(10, "weekly")).toBeCloseTo(10 * 52 / 12, 6);
    expect(expenseMonthlyDollars(10, "biweekly")).toBeCloseTo(10 * 26 / 12, 6);
    expect(expenseMonthlyDollars(1850, "monthly")).toBe(1850);
    expect(expenseMonthlyDollars(300, "quarterly")).toBeCloseTo(100, 6);
    expect(expenseMonthlyDollars(1200, "annually")).toBeCloseTo(100, 6);
    expect(expenseMonthlyDollars(450, "one_time")).toBe(0);
  });

  it("treats unknown frequency as monthly (pass-through)", () => {
    expect(expenseMonthlyDollars(42, "fortnightly")).toBe(42);
  });
});
