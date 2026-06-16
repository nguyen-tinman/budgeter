// Unit tests for validateTaxTablePayload (Train F / F3a + F4).
//
// The validator is the safety gate between the assistant's free-text parse of
// an IRS/FTB page and a write to tax_tables. These tests pin the contract:
// a well-formed payload passes; each malformed variant is rejected with the
// SPECIFIC error code so a regression that loosens one rule is caught.

import { describe, it, expect } from "vitest";
import {
  validateTaxTablePayload,
  MAX_MARGINAL_RATE,
  type TaxTablePayload,
} from "../src/tax_table_validation.js";

/** A valid 2025 federal-single payload (post-OBBBA-shaped, abbreviated). The
 *  exact numbers don't matter for the structural tests — only that they
 *  satisfy every rule. */
function goodPayload(overrides: Partial<TaxTablePayload> = {}): TaxTablePayload {
  return {
    year: 2025,
    jurisdiction: "federal",
    filing: "single",
    standardDeductionDollars: 15000,
    brackets: [
      { upTo: 11925, rate: 0.1 },
      { upTo: 48475, rate: 0.12 },
      { upTo: 103350, rate: 0.22 },
      { upTo: 197300, rate: 0.24 },
      { upTo: 250525, rate: 0.32 },
      { upTo: 626350, rate: 0.35 },
      { upTo: null, rate: 0.37 },
    ],
    sourceUrl: "https://www.irs.gov/newsroom/irs-provides-tax-inflation-adjustments-for-tax-year-2025",
    ...overrides,
  };
}

const codes = (p: TaxTablePayload, year = p.year) =>
  validateTaxTablePayload(p, year).errors.map((e) => e.code);

describe("validateTaxTablePayload — happy path", () => {
  it("accepts a well-formed federal/single payload and echoes the normalized form", () => {
    const res = validateTaxTablePayload(goodPayload(), 2025);
    expect(res.ok).toBe(true);
    expect(res.errors).toHaveLength(0);
    expect(res.normalized).toBeDefined();
    expect(res.normalized!.brackets).toHaveLength(7);
    expect(res.normalized!.brackets[6]!.upTo).toBeNull();
    expect(res.normalized!.sourceUrl).toMatch(/irs\.gov/);
  });

  it("accepts a valid CA/mfj payload", () => {
    const res = validateTaxTablePayload(
      goodPayload({
        jurisdiction: "ca",
        filing: "mfj",
        brackets: [
          { upTo: 20000, rate: 0.01 },
          { upTo: 100000, rate: 0.06 },
          { upTo: null, rate: 0.123 },
        ],
      }),
      2025,
    );
    expect(res.ok).toBe(true);
  });

  it("treats an omitted sourceUrl as valid (sourceUrl is optional)", () => {
    const p = goodPayload();
    delete p.sourceUrl;
    const res = validateTaxTablePayload(p, 2025);
    expect(res.ok).toBe(true);
    expect(res.normalized!.sourceUrl).toBeUndefined();
  });
});

describe("validateTaxTablePayload — year", () => {
  it("rejects a parsed year that does not match the requested year", () => {
    const res = validateTaxTablePayload(goodPayload({ year: 2025 }), 2026);
    expect(res.ok).toBe(false);
    expect(res.errors.map((e) => e.code)).toContain("year_mismatch");
  });

  it("rejects an out-of-range year", () => {
    expect(codes(goodPayload({ year: 1999 }), 1999)).toContain("year_out_of_range");
  });
});

describe("validateTaxTablePayload — jurisdiction & filing", () => {
  it("rejects an unknown jurisdiction", () => {
    expect(codes(goodPayload({ jurisdiction: "ny" }))).toContain("jurisdiction_invalid");
  });

  it("rejects MFS / HoH filing (not modeled by the app)", () => {
    expect(codes(goodPayload({ filing: "mfs" }))).toContain("filing_invalid");
    expect(codes(goodPayload({ filing: "hoh" }))).toContain("filing_invalid");
  });
});

describe("validateTaxTablePayload — standard deduction", () => {
  it("rejects a negative standard deduction", () => {
    expect(codes(goodPayload({ standardDeductionDollars: -100 }))).toContain(
      "standard_deduction_not_positive",
    );
  });

  it("rejects a zero standard deduction", () => {
    expect(codes(goodPayload({ standardDeductionDollars: 0 }))).toContain(
      "standard_deduction_not_positive",
    );
  });
});

describe("validateTaxTablePayload — brackets structure", () => {
  it("rejects an empty brackets array", () => {
    expect(codes(goodPayload({ brackets: [] }))).toContain("brackets_empty");
  });

  it("rejects non-monotone (non-ascending) cutoffs", () => {
    const res = validateTaxTablePayload(
      goodPayload({
        brackets: [
          { upTo: 48475, rate: 0.1 },
          { upTo: 11925, rate: 0.12 }, // goes DOWN
          { upTo: null, rate: 0.37 },
        ],
      }),
      2025,
    );
    expect(res.ok).toBe(false);
    expect(res.errors.map((e) => e.code)).toContain("cutoffs_not_ascending");
  });

  it("rejects a duplicate (equal) cutoff — strictly ascending required", () => {
    expect(
      codes(
        goodPayload({
          brackets: [
            { upTo: 11925, rate: 0.1 },
            { upTo: 11925, rate: 0.12 }, // equal, not strictly greater
            { upTo: null, rate: 0.37 },
          ],
        }),
      ),
    ).toContain("cutoffs_not_ascending");
  });

  it("rejects a rate > MAX_MARGINAL_RATE (the '37 instead of 0.37' parse error)", () => {
    const res = validateTaxTablePayload(
      goodPayload({
        brackets: [
          { upTo: 11925, rate: 10 },
          { upTo: 48475, rate: 12 },
          { upTo: null, rate: 37 }, // whole-number percentages
        ],
      }),
      2025,
    );
    expect(res.ok).toBe(false);
    expect(res.errors.map((e) => e.code)).toContain("rate_out_of_range");
  });

  it(`rejects a rate of exactly ${MAX_MARGINAL_RATE} (open interval upper bound)`, () => {
    expect(
      codes(
        goodPayload({
          brackets: [
            { upTo: 11925, rate: 0.1 },
            { upTo: null, rate: MAX_MARGINAL_RATE },
          ],
        }),
      ),
    ).toContain("rate_out_of_range");
  });

  it("rejects a zero or negative rate (open interval lower bound)", () => {
    expect(
      codes(
        goodPayload({
          brackets: [
            { upTo: 11925, rate: 0 },
            { upTo: null, rate: 0.37 },
          ],
        }),
      ),
    ).toContain("rate_out_of_range");
  });

  it("rejects a top bracket that is NOT open-ended", () => {
    expect(
      codes(
        goodPayload({
          brackets: [
            { upTo: 11925, rate: 0.1 },
            { upTo: 48475, rate: 0.12 }, // last bracket has a finite cutoff
          ],
        }),
      ),
    ).toContain("top_bracket_not_open_ended");
  });

  it("rejects an interior open-ended bracket", () => {
    expect(
      codes(
        goodPayload({
          brackets: [
            { upTo: null, rate: 0.1 }, // open-ended in the middle
            { upTo: 48475, rate: 0.12 },
            { upTo: null, rate: 0.37 },
          ],
        }),
      ),
    ).toContain("interior_bracket_open_ended");
  });

  it("rejects a first bracket that does not start at zero (upTo <= 0)", () => {
    expect(
      codes(
        goodPayload({
          brackets: [
            { upTo: 0, rate: 0.1 }, // zero-width first bracket
            { upTo: 48475, rate: 0.12 },
            { upTo: null, rate: 0.37 },
          ],
        }),
      ),
    ).toContain("first_bracket_not_zero_based");
  });

  it("rejects a single open-ended bracket (degenerate flat schedule)", () => {
    const res = validateTaxTablePayload(
      goodPayload({ brackets: [{ upTo: null, rate: 0.2 }] }),
      2025,
    );
    expect(res.ok).toBe(false);
    expect(res.errors.map((e) => e.code)).toContain("first_bracket_not_zero_based");
  });
});

describe("validateTaxTablePayload — multiple errors at once", () => {
  it("reports every failure in one pass (not just the first)", () => {
    const res = validateTaxTablePayload(
      {
        year: 2025,
        jurisdiction: "ny", // invalid
        filing: "hoh", // invalid
        standardDeductionDollars: -5, // invalid
        brackets: [
          { upTo: 50000, rate: 0.1 },
          { upTo: 10000, rate: 0.99 }, // non-ascending + rate out of range
          { upTo: 80000, rate: 0.12 }, // top not open-ended
        ],
      },
      2026, // year mismatch
    );
    expect(res.ok).toBe(false);
    const got = res.errors.map((e) => e.code);
    expect(got).toContain("year_mismatch");
    expect(got).toContain("jurisdiction_invalid");
    expect(got).toContain("filing_invalid");
    expect(got).toContain("standard_deduction_not_positive");
    expect(got).toContain("cutoffs_not_ascending");
    expect(got).toContain("rate_out_of_range");
    expect(got).toContain("top_bracket_not_open_ended");
  });
});
