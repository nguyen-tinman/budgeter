import { describe, it, expect } from "vitest";
import {
  detectRecurring,
  seedCandidates,
} from "../src/recurring_detector.js";
import type { RawTxn } from "../src/statement_parser.js";

function mkTxn(
  date: string,
  merchant: string,
  amountDollars: number,
  acct: RawTxn["accountType"] = "amex_gold",
): RawTxn {
  return {
    postedDate: date,
    merchantRaw: merchant,
    merchantNormalized: merchant.toLowerCase(),
    amountDollars,
    accountType: acct,
  };
}

// =====================================================================
// seedCandidates — the DEFAULT path (user has final say)
// =====================================================================

describe("seedCandidates — repeat threshold", () => {
  it("surfaces any merchant appearing >= 2 times by default", () => {
    const txns = [
      mkTxn("2025-01-15", "netflix", -15.99),
      mkTxn("2025-02-15", "netflix", -15.99),
      mkTxn("2025-01-20", "one off", -5),
    ];
    const seeds = seedCandidates(txns);
    expect(seeds.map((s) => s.merchantNormalized)).toContain("netflix");
    expect(seeds.map((s) => s.merchantNormalized)).not.toContain("one off");
  });

  it("respects a user-configured repeatThreshold", () => {
    const txns = [
      mkTxn("2025-01-15", "twice merchant", -5),
      mkTxn("2025-02-15", "twice merchant", -5),
    ];
    expect(seedCandidates(txns, { repeatThreshold: 3 })).toEqual([]);
    expect(seedCandidates(txns, { repeatThreshold: 2 }).length).toBe(1);
  });
});

describe("seedCandidates — amount threshold", () => {
  it("surfaces a single high-value charge even with 1 occurrence", () => {
    // Amex Gold annual fee — exactly the case the cadence-only detector
    // missed under the old design.
    const txns = [mkTxn("2024-08-15", "annual membership fee", -325)];
    const seeds = seedCandidates(txns);
    expect(seeds).toHaveLength(1);
    expect(seeds[0]!.seedReason).toBe("high_value");
    expect(seeds[0]!.amountDollars).toBe(-325);
    expect(seeds[0]!.occurrences).toBe(1);
  });

  it("respects a user-configured amountThreshold", () => {
    const txns = [mkTxn("2025-01-15", "big charge", -150)]; // $150
    expect(seedCandidates(txns, { amountThreshold: 200 })).toEqual([]);
    expect(seedCandidates(txns, { amountThreshold: 100 }).length).toBe(1);
  });

  it("does not double-seed: a repeated merchant whose charges exceed the amount threshold gets ONE seed marked 'both'", () => {
    const txns = [
      mkTxn("2024-08-15", "amex plat fee", -695),
      mkTxn("2025-08-15", "amex plat fee", -695),
    ];
    const seeds = seedCandidates(txns);
    expect(seeds).toHaveLength(1);
    expect(seeds[0]!.seedReason).toBe("both");
  });
});

describe("seedCandidates — optional detector suggestion", () => {
  it("attaches a cadence suggestion only when asked", () => {
    // 6 monthly hits → occWeight saturates at length/6 = 1.0
    const monthly = [
      mkTxn("2025-01-15", "disney plus", -16.2),
      mkTxn("2025-02-15", "disney plus", -16.2),
      mkTxn("2025-03-15", "disney plus", -16.2),
      mkTxn("2025-04-15", "disney plus", -16.2),
      mkTxn("2025-05-15", "disney plus", -16.2),
      mkTxn("2025-06-15", "disney plus", -16.2),
    ];
    const withoutHint = seedCandidates(monthly);
    expect(withoutHint[0]!.detectorSuggestion).toBeUndefined();

    const withHint = seedCandidates(monthly, { attachDetectorSuggestion: true });
    expect(withHint[0]!.detectorSuggestion?.cadenceLabel).toBe("monthly");
    expect(withHint[0]!.detectorSuggestion?.confidence).toBeGreaterThanOrEqual(0.8);
  });
});

describe("seedCandidates — empty merchant + threshold clamping", () => {
  it("skips empty-merchant high-value charges (matches the repeated path)", () => {
    // The repeated path silently drops empty-merchant txns via
    // bucketByMerchant. The high-value path used to surface them anyway,
    // producing useless "$N at <blank>" review-queue entries.
    const txns: RawTxn[] = [
      {
        postedDate: "2025-01-15",
        merchantRaw: "",
        merchantNormalized: "",
        amountDollars: -500, // $500 — well above $100 threshold
        accountType: "amex_gold",
      },
      {
        postedDate: "2025-01-20",
        merchantRaw: "real merchant",
        merchantNormalized: "real merchant",
        amountDollars: -500,
        accountType: "amex_gold",
      },
    ];
    const seeds = seedCandidates(txns);
    // The empty-merchant txn must NOT surface; the real one must.
    expect(seeds).toHaveLength(1);
    expect(seeds[0]!.merchantNormalized).toBe("real merchant");
  });

  it("clamps repeatThreshold to 2 (cannot surface 1-occurrence merchants as 'repeated')", () => {
    // A single-occurrence merchant by definition isn't repeated. Allowing
    // repeatThreshold = 1 would emit it with seedReason: "repeated", which
    // is semantically wrong. The clamp guarantees that can never happen.
    const txns = [
      mkTxn("2025-01-15", "single visit", -5),
      mkTxn("2025-01-15", "another single", -5),
    ];
    // Below floor → silently clamped to 2 → no repeated seeds (both are
    // single occurrences, and amounts are below the high-value threshold).
    const seeds = seedCandidates(txns, { repeatThreshold: 1 });
    expect(seeds).toEqual([]);
    // And with the floor honored, a real 2-occurrence merchant still surfaces.
    const repeated = seedCandidates(
      [...txns, mkTxn("2025-02-15", "single visit", -5)],
      { repeatThreshold: 1 },
    );
    expect(repeated.some(
      (s) => s.merchantNormalized === "single visit" && s.seedReason === "repeated",
    )).toBe(true);
  });
});

describe("seedCandidates — boundary + dedup edge cases", () => {
  it("includes the default $100 exact boundary (>= threshold, not >)", () => {
    const txns = [mkTxn("2025-01-15", "exact", -100)]; // exactly $100
    const seeds = seedCandidates(txns);
    expect(seeds).toHaveLength(1);
    expect(seeds[0]!.seedReason).toBe("high_value");
    // $99.99 just under — should NOT surface
    const txnsUnder = [mkTxn("2025-01-15", "exact", -99.99)];
    expect(seedCandidates(txnsUnder)).toEqual([]);
  });

  it("does not collapse two distinct same-day same-amount same-merchant txns", () => {
    // Two real McDonald's visits on the same day at the same combo price.
    // Each is below $100, each is the only occurrence of "mcdonald's"
    // in the data set — so the only seed pathway is high_value, gated
    // by the $200 amountThreshold we set here.
    const a: RawTxn = {
      postedDate: "2025-01-15",
      merchantRaw: "MCDONALD'S #4521",
      merchantNormalized: "mcdonald s 4521",
      amountDollars: -150,
      accountType: "amex_gold",
    };
    const b: RawTxn = { ...a }; // identical shape — a different physical txn
    const seeds = seedCandidates([a, b], {
      repeatThreshold: 99, // disable repeated path
      amountThreshold: 100, // $100, both qualify
    });
    expect(seeds.length).toBe(2); // both must surface, not collapse
  });
});

describe("detectRecurring — Feb 29 anniversary drift", () => {
  it("treats Feb 28 → Feb 29 (366d via leap year) as annually", () => {
    const txns = [
      mkTxn("2023-02-28", "annual", -100),
      mkTxn("2024-02-29", "annual", -100), // 366 days
    ];
    const cands = detectRecurring(txns);
    expect(cands).toHaveLength(1);
    expect(cands[0]!.cadenceLabel).toBe("annually");
  });

  it("treats Feb 29 → Feb 28 next year (365d) as annually", () => {
    const txns = [
      mkTxn("2024-02-29", "annual", -100),
      mkTxn("2025-02-28", "annual", -100), // 365 days
    ];
    const cands = detectRecurring(txns);
    expect(cands).toHaveLength(1);
    expect(cands[0]!.cadenceLabel).toBe("annually");
  });
});

describe("seedCandidates — credits handling", () => {
  it("ignores credits by default", () => {
    const txns = [
      mkTxn("2025-01-15", "refund", 500),
      mkTxn("2025-02-15", "refund", 500),
    ];
    expect(seedCandidates(txns)).toEqual([]);
  });

  it("includes credits when chargesOnly: false", () => {
    const txns = [
      mkTxn("2025-01-15", "refund", 500),
      mkTxn("2025-02-15", "refund", 500),
    ];
    expect(seedCandidates(txns, { chargesOnly: false }).length).toBe(1);
  });
});

// =====================================================================
// detectRecurring — OPT-IN cadence inference
// =====================================================================

describe("detectRecurring — monthly cadence", () => {
  it("detects a clean monthly $16.20 sub at high confidence", () => {
    const txns = [
      mkTxn("2025-01-15", "disney plus", -16.2),
      mkTxn("2025-02-15", "disney plus", -16.2),
      mkTxn("2025-03-15", "disney plus", -16.2),
      mkTxn("2025-04-15", "disney plus", -16.2),
      mkTxn("2025-05-15", "disney plus", -16.2),
      mkTxn("2025-06-15", "disney plus", -16.2),
    ];
    const cands = detectRecurring(txns);
    expect(cands).toHaveLength(1);
    const c = cands[0]!;
    expect(c.cadenceLabel).toBe("monthly");
    expect(c.amountDollars).toBe(-16.2);
    expect(c.occurrences).toBe(6);
    expect(c.cadenceDays).toBeGreaterThanOrEqual(28);
    expect(c.cadenceDays).toBeLessThanOrEqual(31);
    expect(c.confidence).toBeGreaterThanOrEqual(0.9);
    expect(c.lastSeen).toBe("2025-06-15");
  });

  it("tolerates small amount drift (price hike within 5%)", () => {
    const txns = [
      mkTxn("2025-01-10", "youtube", -9.99),
      mkTxn("2025-02-10", "youtube", -9.99),
      mkTxn("2025-03-10", "youtube", -9.99),
      mkTxn("2025-04-10", "youtube", -10.4),
      mkTxn("2025-05-10", "youtube", -10.4),
    ];
    const cands = detectRecurring(txns);
    expect(cands).toHaveLength(1);
    expect(cands[0]!.occurrences).toBe(5);
    expect(cands[0]!.cadenceLabel).toBe("monthly");
  });

  it("does NOT merge amounts beyond tolerance (price jump above 5%)", () => {
    // Use amounts large enough that the absolute floor (50¢) doesn't kick in.
    const txns = [
      mkTxn("2025-01-10", "service", -99.9),
      mkTxn("2025-02-10", "service", -99.9),
      mkTxn("2025-03-10", "service", -109.9),
      mkTxn("2025-04-10", "service", -109.9),
    ];
    const cands = detectRecurring(txns);
    expect(cands).toHaveLength(2);
  });
});

describe("detectRecurring — annual / quarterly", () => {
  it("detects quarterly cadence (~91 days)", () => {
    const txns = [
      mkTxn("2025-01-01", "lawshield", -33),
      mkTxn("2025-04-01", "lawshield", -33),
      mkTxn("2025-07-01", "lawshield", -33),
      mkTxn("2025-10-01", "lawshield", -33),
    ];
    const cands = detectRecurring(txns);
    expect(cands).toHaveLength(1);
    expect(cands[0]!.cadenceLabel).toBe("quarterly");
    expect(cands[0]!.confidence).toBeGreaterThan(0.5);
  });

  it("surfaces a 2-occurrence annual at meaningful confidence", () => {
    // Under the OLD design (occWeight = length/6) a 2-occurrence annual
    // could not exceed ~0.33. Under cadence-aware weighting (annual → /2)
    // a perfect 2-occurrence annual should reach 1.0.
    const txns = [
      mkTxn("2024-08-15", "annual membership fee", -325),
      mkTxn("2025-08-15", "annual membership fee", -325),
    ];
    const cands = detectRecurring(txns);
    expect(cands).toHaveLength(1);
    expect(cands[0]!.cadenceLabel).toBe("annually");
    expect(cands[0]!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("handles 366-day leap-year interval as annually", () => {
    const txns = [
      mkTxn("2023-08-15", "annual fee", -325),
      mkTxn("2024-08-15", "annual fee", -325), // 366 days (2024 leap)
    ];
    const cands = detectRecurring(txns);
    expect(cands).toHaveLength(1);
    expect(cands[0]!.cadenceLabel).toBe("annually");
  });

  it("labels 350-day interval (low edge) as annually", () => {
    // Inclusive low boundary.
    const txns = [
      mkTxn("2024-08-15", "fee", -100),
      mkTxn("2025-07-31", "fee", -100), // 350 days exactly
    ];
    const cands = detectRecurring(txns);
    expect(cands.find((c) => c.cadenceLabel === "annually")).toBeDefined();
  });
});

describe("detectRecurring — cross-cadence split", () => {
  it("splits a cluster mixing short + long intervals into separate sub-clusters", () => {
    // Same merchant + nearly-same amount, but one stream is monthly and
    // another payment is annual. The old greedy clusterer would merge them
    // and produce an "irregular" reading. The split post-pass should
    // separate them.
    const txns = [
      mkTxn("2024-01-15", "gym", -10),
      mkTxn("2024-02-15", "gym", -10),
      mkTxn("2024-03-15", "gym", -10),
      mkTxn("2024-04-15", "gym", -10),
      mkTxn("2025-04-20", "gym", -10), // > 300 days later
    ];
    const cands = detectRecurring(txns);
    // We expect either two candidates OR at least one monthly candidate that
    // didn't get demoted to "irregular" by the annual outlier.
    const monthly = cands.find((c) => c.cadenceLabel === "monthly");
    expect(monthly).toBeDefined();
    expect(monthly!.occurrences).toBe(4);
  });
});

describe("detectRecurring — amount tolerance floor / cap", () => {
  it("uses an absolute 50¢ floor for sub-dollar charges (so a $0.50 sub doesn't fragment)", () => {
    // 5% of 50¢ = 2.5¢ — without a floor, two charges 5¢ apart would split.
    const txns = [
      mkTxn("2025-01-15", "micro", -0.5),
      mkTxn("2025-02-15", "micro", -0.55), // 5 cent drift
      mkTxn("2025-03-15", "micro", -0.52),
    ];
    const cands = detectRecurring(txns);
    expect(cands).toHaveLength(1);
    expect(cands[0]!.occurrences).toBe(3);
  });

  it("uses an absolute $50 cap so large charges can't absorb unrelated items", () => {
    // 5% of $5000 = $250 — without a cap, $5000 and $5100 would cluster.
    // With a $50 cap, they should split. Use 3 hits per tier so each cluster
    // surfaces (single-txn clusters are filtered as "irregular").
    const txns = [
      mkTxn("2025-01-15", "merchant", -5000),
      mkTxn("2025-02-15", "merchant", -5000),
      mkTxn("2025-03-15", "merchant", -5000),
      mkTxn("2025-01-20", "merchant", -5100),
      mkTxn("2025-02-20", "merchant", -5100),
      mkTxn("2025-03-20", "merchant", -5100),
    ];
    const cands = detectRecurring(txns);
    expect(cands.length).toBeGreaterThanOrEqual(2);
  });
});

describe("detectRecurring — negative cases preserved", () => {
  it("does not surface single-occurrence merchants by default", () => {
    const txns = [
      mkTxn("2025-01-15", "one-off store", -25),
      mkTxn("2025-02-15", "another store", -15),
    ];
    expect(detectRecurring(txns)).toEqual([]);
  });

  it("ignores credits when chargesOnly (default)", () => {
    const txns = [
      mkTxn("2025-01-15", "thank you payment", 500),
      mkTxn("2025-02-15", "thank you payment", 500),
      mkTxn("2025-03-15", "thank you payment", 500),
    ];
    expect(detectRecurring(txns)).toEqual([]);
    const cands = detectRecurring(txns, { chargesOnly: false });
    expect(cands.length).toBeGreaterThan(0);
  });

  it("treats different normalized merchants as separate clusters", () => {
    const txns = [
      mkTxn("2025-01-10", "starbucks 1234", -5),
      mkTxn("2025-02-10", "starbucks 1234", -5),
      mkTxn("2025-01-15", "starbucks 5678", -5),
      mkTxn("2025-02-15", "starbucks 5678", -5),
    ];
    const cands = detectRecurring(txns);
    expect(cands.length).toBe(2);
  });

  it("treats different amounts beyond tolerance as separate clusters", () => {
    const txns = [
      mkTxn("2025-01-15", "gym", -20),
      mkTxn("2025-02-15", "gym", -20),
      mkTxn("2025-01-15", "gym", -80),
      mkTxn("2025-02-15", "gym", -80),
    ];
    const cands = detectRecurring(txns);
    expect(cands.length).toBe(2);
  });

  it("marks sourceAccount=multiple when cluster spans accounts", () => {
    const txns = [
      mkTxn("2025-01-15", "amazon prime", -15, "amex_gold"),
      mkTxn("2025-02-15", "amazon prime", -15, "amex_plat"),
      mkTxn("2025-03-15", "amazon prime", -15, "amex_gold"),
    ];
    const cands = detectRecurring(txns);
    expect(cands).toHaveLength(1);
    expect(cands[0]!.sourceAccount).toBe("multiple");
  });
});

// =====================================================================
// FIX 1 regression — recurring candidate amounts stay in DOLLARS.
//
// A pre-conversion bug let recurring-candidate amounts leak in at cents
// scale (e.g. SPECTRUM surfacing as 8625 instead of $86.25). The dollar
// path uses medianAmount, which must return a true-dollar, 2dp value — NOT
// a cents-scale or unrounded one. Guard both the seeder and the detector.
// =====================================================================
describe("recurring candidate amount is dollars, not cents (FIX 1)", () => {
  it("seedCandidates: a ~$86.25 monthly cluster yields amountDollars ≈ -86.25 (NOT -8625)", () => {
    const txns = [
      mkTxn("2026-01-05", "spectrum", -86.25),
      mkTxn("2026-02-05", "spectrum", -86.25),
      mkTxn("2026-03-05", "spectrum", -86.25),
    ];
    const seeds = seedCandidates(txns);
    const spectrum = seeds.find((s) => s.merchantNormalized === "spectrum");
    expect(spectrum).toBeDefined();
    // Sign preserved (charge = negative); magnitude is true dollars.
    expect(spectrum!.amountDollars).toBeCloseTo(-86.25, 2);
    expect(Math.abs(spectrum!.amountDollars)).toBeLessThan(1000);
  });

  it("seedCandidates: even-count cluster medians to a 2dp dollar amount", () => {
    // 4 charges (even count) → median of the middle pair, rounded to cents.
    const txns = [
      mkTxn("2026-01-05", "spectrum mobile", -80.55),
      mkTxn("2026-02-05", "spectrum mobile", -80.55),
      mkTxn("2026-03-05", "spectrum mobile", -80.55),
      mkTxn("2026-04-05", "spectrum mobile", -80.55),
    ];
    const seeds = seedCandidates(txns);
    const sm = seeds.find((s) => s.merchantNormalized === "spectrum mobile");
    expect(sm).toBeDefined();
    expect(sm!.amountDollars).toBeCloseTo(-80.55, 2);
    // 2dp discipline: value rounds to itself at the cent.
    expect(sm!.amountDollars).toBe(Math.round(sm!.amountDollars * 100) / 100);
  });

  it("detectRecurring: monthly cluster amountDollars stays dollar-scale", () => {
    const txns = [
      mkTxn("2026-01-05", "spectrum", -86.25),
      mkTxn("2026-02-05", "spectrum", -86.25),
      mkTxn("2026-03-05", "spectrum", -86.25),
    ];
    const cands = detectRecurring(txns);
    const spectrum = cands.find((c) => c.merchantNormalized === "spectrum");
    expect(spectrum).toBeDefined();
    expect(spectrum!.amountDollars).toBeCloseTo(-86.25, 2);
    expect(Math.abs(spectrum!.amountDollars)).toBeLessThan(1000);
  });
});
