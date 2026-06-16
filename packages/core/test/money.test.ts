// money.round2 — rounding convention, especially the negative-amount tie-break.
//
// round2 must break ties HALF-AWAY-FROM-ZERO and be symmetric in sign, because
// charges are stored as negative dollars: a charge and its equal-and-opposite
// credit have to round to mirror values, and aggregating signed amounts must
// not drift toward zero. Plain Math.round breaks ties toward +Infinity, which
// rounds negative halves the WRONG way (-1.005 → -1.00 instead of -1.01).

import { describe, it, expect } from "vitest";
import { round2 } from "../src/money.js";

describe("round2 — positive amounts (regression: behavior preserved)", () => {
  it("rounds positive *.xx5 halves up despite binary representation", () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(1.015)).toBe(1.02);
    expect(round2(1.025)).toBe(1.03);
    expect(round2(0.125)).toBe(0.13);
    expect(round2(2.675)).toBe(2.68);
    expect(round2(10.005)).toBe(10.01);
  });

  it("rounds ordinary positives to the nearest cent", () => {
    expect(round2(1.004)).toBe(1.0);
    expect(round2(1.006)).toBe(1.01);
    expect(round2(143.3333)).toBe(143.33);
  });
});

describe("round2 — negative amounts (half-away-from-zero)", () => {
  it("rounds negative *.xx5 halves AWAY from zero (toward larger magnitude)", () => {
    // The bug: the old `+ EPSILON`/Math.round formula rounded these toward zero
    // (-0.005 → 0, -1.005 → -1.00). They must round to the larger magnitude.
    expect(round2(-0.005)).toBe(-0.01);
    expect(round2(-0.125)).toBe(-0.13);
    expect(round2(-1.005)).toBe(-1.01);
    expect(round2(-1.015)).toBe(-1.02);
    expect(round2(-2.005)).toBe(-2.01);
    expect(round2(-10.005)).toBe(-10.01);
    expect(round2(-2.675)).toBe(-2.68);
  });

  it("rounds ordinary negatives to the nearest cent", () => {
    expect(round2(-1.004)).toBe(-1.0);
    expect(round2(-1.006)).toBe(-1.01);
    expect(round2(-49.995)).toBe(-50.0);
  });

  it("does not produce -0 for a value that rounds to zero", () => {
    // -0.001 rounds to 0; assert it is +0 (Object.is distinguishes -0).
    expect(Object.is(round2(-0.001), 0)).toBe(true);
  });
});

describe("round2 — sign symmetry property", () => {
  it("round2(-n) === -round2(n) over a sweep of cent and half-cent values", () => {
    for (let cents = 1; cents <= 5000; cents++) {
      const n = cents / 100; // exact-ish multiples of a cent
      expect(round2(-n)).toBe(-round2(n));
      const half = cents / 100 + 0.005; // a *.xx5 tie at this magnitude
      expect(round2(-half)).toBe(-round2(half));
    }
  });
});

describe("round2 — non-finite inputs pass through unchanged", () => {
  it("returns NaN / ±Infinity untouched", () => {
    expect(Number.isNaN(round2(NaN))).toBe(true);
    expect(round2(Infinity)).toBe(Infinity);
    expect(round2(-Infinity)).toBe(-Infinity);
  });
});
