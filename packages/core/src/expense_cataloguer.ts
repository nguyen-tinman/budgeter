// Expense Cataloguer
// ===================
//
// Reproduces, programmatically, the ground-truth review I performed by hand
// on 2026-05-26 (output landed in `data/ground-truth-scan.json` +
// `data/seed_corrections.json`). The goal: when the LLM is asked to
// "catalogue my statements", it runs THIS function and gets the same set of
// expense candidates the human reviewer would have surfaced — recurring
// charges from `seedCandidates`, annual-fee-shaped one-offs, merchant
// aliases, and a best-guess category per candidate via the existing
// `defaultMerchantCategorizer`.
//
// This module is pure (no fs, no network). The tool handler in `tools.ts`
// owns I/O — it reads the statement files, parses them, and hands the
// resulting RawTxn[] in here.
//
// Output shape mirrors what the May 26 manual review produced so we can
// regression-test against the committed baseline file.

import type { RawTxn } from "./statement_parser.js";
import { normalizeMerchant } from "./statement_parser.js";
import {
  seedCandidates,
  detectRecurring,
  type Seed,
  type RecurringCandidate,
  type CadenceLabel,
} from "./recurring_detector.js";
import { defaultMerchantCategorizer } from "./category_resolver.js";

/** A single proposed expense row. The cataloguer never persists; it returns
 *  these for the LLM to summarize and the user (or `commit:true`) to accept. */
export interface ExpenseCandidate {
  /** Best human-readable label for the row — uses `merchantSample` so the
   *  user recognizes it on the budget table. */
  label: string;
  /** Median (or single) charge magnitude in dollars. Positive — charges are
   *  stored as negative in RawTxn; we flip the sign here to match the
   *  expenses-table convention of positive amounts. */
  amountDollars: number;
  /** Frequency mapped from the detector's cadence label (or inferred for
   *  high-value one-offs). */
  frequency: "weekly" | "biweekly" | "monthly" | "quarterly" | "annually" | "one_time";
  /** Auto-resolved category name from `defaultMerchantCategorizer`. ALWAYS
   *  non-null — unmatched merchants get the catch-all "Discretionary" so every
   *  candidate has a definite bucket and the user can change it on review. */
  category: string;
  /** Source account ("chase", "amex_gold", "amex_plat", or "multiple"). */
  sourceAccount: string;
  /** Number of transactions in the cluster (1 for high-value singletons). */
  occurrences: number;
  /** Why the cataloguer surfaced this row — drives the review-queue
   *  ordering and gives the user a one-word "why is this here?". */
  seedReason: "repeated" | "high_value" | "both";
  /** Most-recent posted date in this cluster (ISO). */
  lastSeen: string;
  /** 0..1 — present only when a recurring-detector suggestion attached. */
  cadenceConfidence?: number;
  /** Card-fee range bucket for annual fees — surfaced to the UI so the user
   *  can fast-filter "show me my card fees". */
  feeKind?: "amex_gold_range" | "amex_plat_range" | "other_high_value";
}

/** Alias detection — merchants that share the first few normalized tokens
 *  but render as separate clusters. Surfaced so the user can merge them. */
export interface AliasCandidate {
  /** The common prefix (first 3 normalized tokens). */
  normalizedPrefix: string;
  /** Each distinct normalized variant under that prefix + its occurrence
   *  count. Only prefixes with ≥ 2 variants are reported. */
  variants: Array<{ merchant: string; count: number }>;
}

export interface CatalogueSummary {
  /** All transactions handed in (charges + credits). */
  totalTxns: number;
  /** Distinct normalized-merchant strings across all CHARGES. */
  uniqueMerchants: number;
  /** Number of seed candidates surfaced (= candidates.length). */
  seedCount: number;
  /** Recurring-detector output count — for comparison with the seeder. */
  recurringCount: number;
  /** Count of candidates that fell into the Amex Gold/Plat fee ranges. */
  annualFeeCount: number;
  /** Count of alias clusters reported. */
  aliasCount: number;
  /** Fraction of candidates that got a category auto-assigned (0..1). */
  categorizedRate: number;
}

export interface CatalogueResult {
  summary: CatalogueSummary;
  candidates: ExpenseCandidate[];
  aliasCandidates: AliasCandidate[];
}

// ---------------------------------------------------------------------------

/** Map detector cadence → expenses-table frequency enum. */
function cadenceToFrequency(c: CadenceLabel): ExpenseCandidate["frequency"] {
  switch (c) {
    case "weekly":     return "weekly";
    case "monthly":    return "monthly";
    case "quarterly":  return "quarterly";
    case "annually":   return "annually";
    case "irregular":  return "one_time";
  }
}

/** Classify a high-value singleton into a card-fee range bucket. Numeric
 *  bands cover the current Amex Gold ($325, prev $250) and Platinum ($695,
 *  prev $550) annual fees plus a wider "other_high_value" catch-all. */
function classifyFeeRange(absDollars: number): ExpenseCandidate["feeKind"] {
  if (absDollars >= 200 && absDollars <= 400) return "amex_gold_range";
  if (absDollars >= 500 && absDollars <= 800) return "amex_plat_range";
  return "other_high_value";
}

/** Pick a sensible frequency when the detector didn't attach a suggestion.
 *  A single high-value charge in a card-fee range is almost certainly
 *  annual; everything else defaults to one_time. */
function inferFrequencyForSeed(seed: Seed): ExpenseCandidate["frequency"] {
  if (seed.detectorSuggestion) return cadenceToFrequency(seed.detectorSuggestion.cadenceLabel);
  if (seed.seedReason === "high_value" && seed.occurrences === 1) {
    const abs = Math.abs(seed.amountDollars);
    if (abs >= 200 && abs <= 800) return "annually";
  }
  // Multiple-occurrence repeats with no cadence guess: default to monthly —
  // it's the most common cadence for recurring household charges. The user
  // can change it during review.
  if (seed.occurrences >= 2) return "monthly";
  return "one_time";
}

/** Pick a representative RawTxn for category-resolver lookup. We materialize
 *  a synthetic txn carrying the seed's normalized merchant + sample so the
 *  resolver — which keys off `merchantNormalized` — can match the same way
 *  it does on individual transactions. */
function categorizeSeed(seed: Seed): string {
  const synthetic: RawTxn = {
    postedDate: seed.lastSeen,
    merchantRaw: seed.merchantSample,
    merchantNormalized: seed.merchantNormalized,
    amountDollars: seed.amountDollars,
    accountType: "unknown",
    categoryHint: undefined,
  };
  return defaultMerchantCategorizer(synthetic);
}

// ---------------------------------------------------------------------------

/** Build alias candidates by grouping normalized merchants on their first
 *  3 tokens. Only groups with ≥ 2 distinct variants are reported — single
 *  variants are not aliases, they're just merchants. */
function findAliasCandidates(txns: RawTxn[]): AliasCandidate[] {
  const charges = txns.filter((t) => t.amountDollars < 0);
  const byPrefix = new Map<string, Map<string, number>>();
  for (const t of charges) {
    const norm = normalizeMerchant(t.merchantRaw);
    const tokens = norm.split(/\s+/);
    if (tokens.length === 0) continue;
    // Take up to first 3 tokens; require a minimum length so we don't
    // collapse on a one-letter prefix like " a ".
    const prefix = tokens.slice(0, Math.min(3, tokens.length)).join(" ");
    if (prefix.length < 4) continue;
    let variants = byPrefix.get(prefix);
    if (!variants) {
      variants = new Map();
      byPrefix.set(prefix, variants);
    }
    variants.set(norm, (variants.get(norm) ?? 0) + 1);
  }
  const out: AliasCandidate[] = [];
  for (const [prefix, variants] of byPrefix.entries()) {
    if (variants.size >= 2) {
      out.push({
        normalizedPrefix: prefix,
        variants: Array.from(variants.entries()).map(([merchant, count]) => ({
          merchant,
          count,
        })),
      });
    }
  }
  // Sort: most-variant clusters first, then by total occurrences. Stable
  // ordering matters for the regression test.
  out.sort((a, b) => {
    if (a.variants.length !== b.variants.length) return b.variants.length - a.variants.length;
    const aSum = a.variants.reduce((s, v) => s + v.count, 0);
    const bSum = b.variants.reduce((s, v) => s + v.count, 0);
    return bSum - aSum;
  });
  return out;
}

// ---------------------------------------------------------------------------

/**
 * Run the full ground-truth-style review on a transaction stream. Pure
 * function — call from a tool handler that owns the file I/O.
 */
export function catalogueExpenses(txns: RawTxn[]): CatalogueResult {
  const charges = txns.filter((t) => t.amountDollars < 0);

  // Unique merchants by normalized name (charges only).
  const uniqueMerchantSet = new Set<string>();
  for (const t of charges) uniqueMerchantSet.add(normalizeMerchant(t.merchantRaw));

  // Seeds — the "what would a human catch" path. Attach cadence
  // suggestions so we can pick a sensible default frequency per candidate.
  const seeds = seedCandidates(charges, { attachDetectorSuggestion: true });

  // Cadence-detector output — for the summary comparison only. Candidates
  // come from seeds; this is the "auto" baseline the cataloguer is
  // supposed to match (or exceed).
  const recurring: RecurringCandidate[] = detectRecurring(charges);

  const candidates: ExpenseCandidate[] = seeds.map((seed) => {
    const absDollars = Math.abs(seed.amountDollars);
    const frequency = inferFrequencyForSeed(seed);
    const category = categorizeSeed(seed);
    const cand: ExpenseCandidate = {
      label: seed.merchantSample,
      amountDollars: absDollars,
      frequency,
      category,
      sourceAccount: seed.sourceAccount,
      occurrences: seed.occurrences,
      seedReason: seed.seedReason,
      lastSeen: seed.lastSeen,
    };
    if (seed.detectorSuggestion) {
      cand.cadenceConfidence = seed.detectorSuggestion.confidence;
    }
    if (seed.seedReason === "high_value" || seed.seedReason === "both") {
      cand.feeKind = classifyFeeRange(absDollars);
    }
    return cand;
  });

  const aliasCandidates = findAliasCandidates(txns);

  const annualFeeCount = candidates.filter(
    (c) =>
      c.feeKind === "amex_gold_range" || c.feeKind === "amex_plat_range",
  ).length;
  // Every candidate now carries a category (either rule-matched or the
  // "Discretionary" catch-all). categorizedRate measures what fraction
  // actually got a *rule match* — i.e. were not the "Discretionary" fallback
  // — so the LLM can tell the user how confident the auto-categorization was.
  const categorizedCount = candidates.filter((c) => c.category !== "Discretionary").length;

  return {
    summary: {
      totalTxns: txns.length,
      uniqueMerchants: uniqueMerchantSet.size,
      seedCount: candidates.length,
      recurringCount: recurring.length,
      annualFeeCount,
      aliasCount: aliasCandidates.length,
      categorizedRate:
        candidates.length === 0 ? 0 : categorizedCount / candidates.length,
    },
    candidates,
    aliasCandidates,
  };
}
