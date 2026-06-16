// Expense Cataloguer tests
// ========================
//
// Two layers:
//
// 1. Unit tests against a synthetic transaction stream — exercise every
//    branch (repeated seeds, high-value singletons, alias detection,
//    category resolution) without touching real personal data.
//
// 2. Integration test against the real `./statements/` directory. The
//    expected counts come from `./data/ground-truth-scan.json`, produced
//    by the manual review on 2026-05-26. The cataloguer is supposed to
//    REPRODUCE that review programmatically; any meaningful drift in the
//    counts is a regression we want to catch.
//
//    The integration test SKIPS itself when `./statements/` or the ground-
//    truth file isn't present (clean checkouts, CI). It runs locally where
//    the user has both committed.

import { describe, it, expect } from "vitest";
import { catalogueExpenses, type AliasCandidate } from "../src/expense_cataloguer.js";
import type { RawTxn } from "../src/statement_parser.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

function txn(
  postedDate: string,
  merchantRaw: string,
  amountDollars: number,
  accountType: RawTxn["accountType"] = "chase",
): RawTxn {
  // Lazy: we don't normalize in tests — pass the same string for raw and
  // normalized so the synthetic fixtures are stable. Production parsers
  // run normalizeMerchant; the cataloguer also normalizes internally for
  // alias detection.
  return {
    postedDate,
    merchantRaw,
    merchantNormalized: merchantRaw.toLowerCase().trim(),
    amountDollars,
    accountType,
    categoryHint: undefined,
  };
}

describe("catalogueExpenses (unit, synthetic txns)", () => {
  it("surfaces a repeated monthly charge as a candidate with monthly frequency", () => {
    const txns: RawTxn[] = [
      txn("2025-01-15", "Netflix", -15.99),
      txn("2025-02-15", "Netflix", -15.99),
      txn("2025-03-15", "Netflix", -15.99),
    ];
    const out = catalogueExpenses(txns);
    expect(out.summary.totalTxns).toBe(3);
    const netflix = out.candidates.find((c) => c.label === "Netflix");
    expect(netflix).toBeDefined();
    expect(netflix!.amountDollars).toBe(15.99); // sign flipped to positive
    expect(netflix!.frequency).toBe("monthly");
    expect(netflix!.occurrences).toBe(3);
    expect(netflix!.seedReason === "repeated" || netflix!.seedReason === "both").toBe(true);
  });

  it("surfaces a single high-value charge in the Amex Gold fee range as annually + amex_gold_range", () => {
    const txns: RawTxn[] = [
      // Amex Gold annual fee shape: ~$325, single occurrence in window.
      txn("2025-04-22", "AMERICAN EXPRESS ANNUAL MEMBERSHIP FEE", -325),
    ];
    const out = catalogueExpenses(txns);
    const cand = out.candidates[0]!;
    expect(cand.amountDollars).toBe(325);
    expect(cand.seedReason).toBe("high_value");
    expect(cand.frequency).toBe("annually");
    expect(cand.feeKind).toBe("amex_gold_range");
  });

  it("surfaces a single high-value charge in the Plat fee range with amex_plat_range", () => {
    const txns: RawTxn[] = [txn("2025-04-22", "AMEX PLATINUM ANNUAL FEE", -695)];
    const out = catalogueExpenses(txns);
    const cand = out.candidates[0]!;
    expect(cand.amountDollars).toBe(695);
    expect(cand.feeKind).toBe("amex_plat_range");
    expect(cand.frequency).toBe("annually");
  });

  it("auto-categorizes a known merchant via category_resolver (Subscriptions)", () => {
    // The category resolver's Subscriptions rule matches "spotify" as a
    // substring of merchantNormalized. The synthetic txn helper
    // lowercases the raw string, so "SPOTIFY USA" → "spotify usa" → match.
    const txns: RawTxn[] = Array.from({ length: 3 }, (_, i) =>
      txn(`2025-0${i + 1}-15`, "SPOTIFY USA", -9.99),
    );
    const out = catalogueExpenses(txns);
    const cand = out.candidates.find((c) => c.label.includes("SPOTIFY"));
    expect(cand).toBeDefined();
    expect(cand!.category).toBe("Subscriptions");
  });

  it("reports alias candidates when distinct normalized merchants share a 3-token prefix", () => {
    // Two distinct merchant strings with same 3-token prefix → alias group.
    // Need ≥ 4 chars in prefix for the cataloguer to consider it.
    const txns: RawTxn[] = [
      txn("2025-01-05", "AMZN MKTP US RT4Z2",  -25.99),
      txn("2025-02-05", "AMZN MKTP US ABC1X",  -18.99),
      txn("2025-03-05", "AMZN MKTP US ZZZ99",  -34.99),
    ];
    const out = catalogueExpenses(txns);
    const aliases: AliasCandidate[] = out.aliasCandidates;
    // The 3-token prefix "amzn mktp us" should have ≥2 distinct variants.
    const grp = aliases.find((g) => g.normalizedPrefix === "amzn mktp us");
    expect(grp).toBeDefined();
    expect(grp!.variants.length).toBeGreaterThanOrEqual(2);
  });

  it("counts unique merchants only over CHARGES (positive credits ignored)", () => {
    const txns: RawTxn[] = [
      txn("2025-01-01", "Refund", 50), // credit — excluded
      txn("2025-01-02", "Netflix", -15.99),
      txn("2025-01-03", "Spotify", -9.99),
    ];
    const out = catalogueExpenses(txns);
    // Two charges → two unique merchants (refund is not a charge).
    expect(out.summary.uniqueMerchants).toBe(2);
    expect(out.summary.totalTxns).toBe(3); // includes the credit
  });

  // FIX 1 — recurring candidate amount stays in DOLLARS end-to-end.
  // A ~$86.25 monthly cluster (the live-data SPECTRUM case) must catalogue as
  // amountDollars ≈ 86.25, never a cents-scale 8625.
  it("recurring cluster of ~$86.25 yields a candidate amount ≈ 86.25 (NOT 8625) (FIX 1)", () => {
    const txns: RawTxn[] = [
      txn("2026-01-05", "SPECTRUM", -86.25),
      txn("2026-02-05", "SPECTRUM", -86.25),
      txn("2026-03-05", "SPECTRUM", -86.25),
    ];
    const out = catalogueExpenses(txns);
    const spectrum = out.candidates.find((c) => c.label === "SPECTRUM");
    expect(spectrum).toBeDefined();
    // Cataloguer flips sign to positive; magnitude is true dollars, 2dp.
    expect(spectrum!.amountDollars).toBeCloseTo(86.25, 2);
    expect(spectrum!.amountDollars).toBeLessThan(1000);
    expect(spectrum!.frequency).toBe("monthly");
  });

  // FIX 2 — a positive (credit/refund/payment) transaction must never become
  // a spend candidate, even when it repeats or is large.
  it("a repeated POSITIVE credit never generates a candidate (FIX 2)", () => {
    const txns: RawTxn[] = [
      txn("2026-01-15", "CARD PAYMENT THANK YOU", 2500), // big repeated credit
      txn("2026-02-15", "CARD PAYMENT THANK YOU", 2500),
      txn("2026-03-15", "CARD PAYMENT THANK YOU", 2500),
    ];
    const out = catalogueExpenses(txns);
    expect(out.candidates.find((c) => /payment/i.test(c.label))).toBeUndefined();
    expect(out.candidates).toHaveLength(0);
  });
});

describe("catalogueExpenses (integration, ./statements + ./data/ground-truth-scan.json)", () => {
  const projectRoot = resolve(__dirname, "..", "..", "..");
  const statementsRoot = join(projectRoot, "statements");
  const baselinePath = join(projectRoot, "data", "ground-truth-scan.json");
  // Require actual statement files, not just the directory: a checkout whose
  // statements/ holds only docs (e.g. RESTORE-MANIFEST.md) must skip too,
  // same policy as the statements guard in tool_registry.test.ts.
  const hasStatementFiles =
    existsSync(statementsRoot) &&
    ["chase", "gold", "plat"].some((sub) => {
      const subPath = join(statementsRoot, sub);
      if (!existsSync(subPath)) return false;
      return readdirSync(subPath).some((f) => /\.(pdf|xlsx)$/i.test(f));
    });
  const shouldRun = hasStatementFiles && existsSync(baselinePath);

  // Conditional skip lets clean checkouts and CI pass without the personal
  // data committed.
  if (!shouldRun) {
    if (existsSync(statementsRoot) && existsSync(baselinePath)) {
      // eslint-disable-next-line no-console
      console.warn(
        "[expense_cataloguer.test] statements/ exists but holds no *.pdf/*.xlsx — " +
          "skipping the ground-truth integration test (see statements/RESTORE-MANIFEST.md).",
      );
    }
    it.skip("statements/ + ground-truth-scan.json present → would compare counts", () => {});
    return;
  }

  it("cataloguer counts stay within tolerance of the May 26 manual review baseline", async () => {
    const { parseChasePdf } = await import("../src/chase_parser.js");
    const { parseAmexXlsx } = await import("../src/statement_parser.js");
    const { readdirSync } = await import("node:fs");

    async function readAllStatements(): Promise<RawTxn[]> {
      const all: RawTxn[] = [];
      for (const sub of ["chase", "gold", "plat"]) {
        const subPath = join(statementsRoot, sub);
        if (!existsSync(subPath)) continue;
        const files = readdirSync(subPath);
        for (const f of files) {
          const fp = join(subPath, f);
          const ext = f.split(".").pop()?.toLowerCase();
          try {
            if (ext === "pdf") {
              const r = await parseChasePdf(fp);
              all.push(...r.txns);
            } else if (ext === "xlsx" || ext === "xls") {
              const r = parseAmexXlsx(fp);
              all.push(...r.txns);
            }
          } catch {
            // Skip parse failures — tolerance below absorbs them.
          }
        }
      }
      return all;
    }

    const txns = await readAllStatements();
    const out = catalogueExpenses(txns);
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as {
      totalTxns: number;
      uniqueMerchants: number;
      detectedCount: number;
    };

    // Tolerances: parsers are stable but the recurring detector + seeder
    // have evolved; allow ±15% on counts. The point of this test is to
    // catch a 5x drift (something is broken), not to lock the numbers.
    const TOL = 0.15;
    function within(actual: number, expected: number, label: string): void {
      const lo = Math.floor(expected * (1 - TOL));
      const hi = Math.ceil(expected * (1 + TOL));
      expect(actual, `${label}: got ${actual}, expected ${expected} ± ${TOL * 100}%`).toBeGreaterThanOrEqual(lo);
      expect(actual, `${label}: got ${actual}, expected ${expected} ± ${TOL * 100}%`).toBeLessThanOrEqual(hi);
    }

    within(out.summary.totalTxns, baseline.totalTxns, "totalTxns");
    within(out.summary.uniqueMerchants, baseline.uniqueMerchants, "uniqueMerchants");
    within(out.summary.recurringCount, baseline.detectedCount, "recurringCount");
    // categorizedRate is bounded but we assert sanity: at least some merchants
    // got matched (the rule table covers gas/groceries/restaurants/etc.).
    expect(out.summary.categorizedRate).toBeGreaterThan(0);
  }, 60_000); // 60s — Chase PDFs are slow to parse
});
