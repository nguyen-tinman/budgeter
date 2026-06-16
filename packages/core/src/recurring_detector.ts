import type { RawTxn } from "./statement_parser.js";
import { round2 } from "./money.js";

// =====================================================================
// Two-layer design (per user direction 2026-05-26):
//
// 1) `seedCandidates` — DEFAULT path. Returns anything worth showing the user:
//      • a merchant occurring ≥ repeatThreshold (default 2) times, OR
//      • any single charge ≥ amountThreshold (default $100).
//    The user accepts/edits/rejects each seed in the review queue. The user
//    decides cadence; the detector only *suggests* it (optional).
//
// 2) `detectRecurring` — OPT-IN path. The user can ask "auto-suggest cadence"
//    for a Seed or run it across all charges. Returns suggested cadence label,
//    days, and confidence — never auto-applied.
//
// Both layers share clustering primitives below.
// =====================================================================

export type CadenceLabel =
  | "weekly"
  | "monthly"
  | "quarterly"
  | "annually"
  | "irregular";

/**
 * A candidate the seeder thinks the user should look at. The user has final
 * say — accept it as a recurring item, edit cadence/amount, or reject it.
 */
export interface Seed {
  /** Normalized merchant key. */
  merchantNormalized: string;
  /** Most-common raw merchant string in this cluster. */
  merchantSample: string;
  /** Why we surfaced this: repeated occurrences, a single big charge, or both. */
  seedReason: "repeated" | "high_value" | "both";
  /** Median amount across this cluster (or the single charge), in dollars. */
  amountDollars: number;
  /** Number of matching transactions. */
  occurrences: number;
  /** Most recent posted_date (ISO). */
  lastSeen: string;
  /** Detected account (or "multiple"). */
  sourceAccount: string;
  /**
   * Optional cadence guess from the detector — present only if
   * `attachDetectorSuggestion: true` was passed to `seedCandidates`.
   * Even when present this is just a SUGGESTION; the user decides.
   */
  detectorSuggestion?: {
    cadenceLabel: CadenceLabel;
    cadenceDays: number;
    confidence: number;
  };
}

/**
 * The detector's own output — for the opt-in path where the user asks
 * "guess what cadence this is".
 */
export interface RecurringCandidate {
  merchantNormalized: string;
  merchantSample: string;
  amountDollars: number;
  cadenceDays: number;
  cadenceLabel: CadenceLabel;
  occurrences: number;
  lastSeen: string;
  sourceAccount: string;
  /** 0..1 — DISPLAY HINT (used for sort order), not a gate. */
  confidence: number;
}

export interface DetectOptions {
  /** Amount tolerance for clustering as a fraction (default 0.05 = 5%). */
  amountTolerance?: number;
  /** Minimum occurrences for an item to be returned by `detectRecurring`. */
  minOccurrences?: number;
  /** Only consider charges (negative amounts). Default true. */
  chargesOnly?: boolean;
}

export interface SeedOptions {
  /** Surface a merchant once it has appeared this many times. Default 2. */
  repeatThreshold?: number;
  /** Surface any single charge whose absolute value is ≥ this many dollars. Default 100 ($100). */
  amountThreshold?: number;
  /** Only consider charges (negative amounts). Default true. */
  chargesOnly?: boolean;
  /** Attach the detector's cadence suggestion to each seed. Default false. */
  attachDetectorSuggestion?: boolean;
  /**
   * Amount tolerance for sub-clustering within a merchant (default 0.05 = 5%).
   * Applied with an absolute floor (50¢) and cap ($50) — see `tolerantSpan`.
   */
  amountTolerance?: number;
}

// =====================================================================
// Shared primitives
// =====================================================================

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
    : sorted[mid]!;
}

/** Median of dollar amounts: like `median` but stays in DOLLARS — it rounds
 *  to 2dp (nearest cent) rather than to a whole unit, so the typical-charge
 *  magnitude keeps its cents. round2 is applied to BOTH the averaged-pair case
 *  and the single-element case: the cents→dollars convention requires every
 *  monetary value returned from a calculator to be rounded at the boundary, so
 *  a candidate amount can never carry float drift (or, historically, a
 *  cents-scale value) downstream into the expenses table. */
function medianAmount(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? round2((sorted[mid - 1]! + sorted[mid]!) / 2)
    : round2(sorted[mid]!);
}

function daysBetween(isoA: string, isoB: string): number {
  const a = Date.parse(isoA);
  const b = Date.parse(isoB);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round(Math.abs(b - a) / 86_400_000);
}

function labelCadence(days: number): CadenceLabel {
  if (days >= 5 && days <= 9) return "weekly";
  if (days >= 25 && days <= 35) return "monthly";
  if (days >= 85 && days <= 95) return "quarterly";
  if (days >= 350 && days <= 380) return "annually";
  return "irregular";
}

/**
 * Penalty denominator for cadence-aware consistency scoring. A 10-day drift
 * is catastrophic for monthly but normal for annual billing.
 */
function cadenceDriftBudget(label: CadenceLabel): number {
  switch (label) {
    case "weekly":
      return 4;
    case "monthly":
      return 8;
    case "quarterly":
      return 15;
    case "annually":
      return 30;
    default:
      return 8;
  }
}

/**
 * Saturation denominator for occurrence weight. A 2-occurrence annual
 * IS a confident annual; it shouldn't be capped at 1/3 because we only
 * have 2 datapoints.
 */
function cadenceOccDenominator(label: CadenceLabel): number {
  switch (label) {
    case "weekly":
      return 12;
    case "monthly":
      return 6;
    case "quarterly":
      return 4;
    case "annually":
      return 2;
    default:
      return 6;
  }
}

/**
 * Cadence-aware consistency: 0..1 based on how tightly intervals cluster
 * around the median, scaled by what counts as "drift" for this cadence.
 */
function cadenceConsistency(intervals: number[], label: CadenceLabel): number {
  if (intervals.length === 0) return 1; // single-interval = trivially consistent
  const target = median(intervals);
  const deviations = intervals.map((i) => Math.abs(i - target));
  const meanDev = deviations.reduce((s, d) => s + d, 0) / deviations.length;
  const budget = cadenceDriftBudget(label);
  return Math.max(0, Math.min(1, 1 - meanDev / budget));
}

/**
 * Amount tolerance with both a floor (so sub-dollar subscriptions don't
 * fragment on rounding noise) and a ceiling (so a $1k charge doesn't
 * absorb unrelated $950–$1050 items).
 */
const AMOUNT_TOL_FLOOR_DOLLARS = 0.5; // 50 cents
const AMOUNT_TOL_CAP_DOLLARS = 50; // $50

function tolerantSpan(refAbsDollars: number, tolerance: number): number {
  const span = refAbsDollars * tolerance;
  return Math.max(AMOUNT_TOL_FLOOR_DOLLARS, Math.min(span, AMOUNT_TOL_CAP_DOLLARS));
}

/** Bucket transactions by normalized merchant. Empty-key txns dropped. */
function bucketByMerchant(txns: RawTxn[]): Map<string, RawTxn[]> {
  const out = new Map<string, RawTxn[]>();
  for (const t of txns) {
    const k = t.merchantNormalized;
    if (!k) continue;
    const arr = out.get(k) ?? [];
    arr.push(t);
    out.set(k, arr);
  }
  return out;
}

/**
 * Within a single merchant, sub-cluster by amount within tolerance. Greedy
 * first-fit, sorted by absolute amount, with the floor/cap tolerance above.
 */
function clusterByAmount(list: RawTxn[], tolerance: number): RawTxn[][] {
  const out: RawTxn[][] = [];
  const sorted = [...list].sort(
    (a, b) => Math.abs(a.amountDollars) - Math.abs(b.amountDollars),
  );
  for (const t of sorted) {
    let placed = false;
    for (const cluster of out) {
      const ref = Math.abs(cluster[0]!.amountDollars);
      if (Math.abs(Math.abs(t.amountDollars) - ref) <= tolerantSpan(ref, tolerance)) {
        cluster.push(t);
        placed = true;
        break;
      }
    }
    if (!placed) out.push([t]);
  }
  return out;
}

/**
 * Post-pass that splits a cluster whose intervals include BOTH short (<60d)
 * and long (>300d) gaps. Such a cluster mixes a frequent sub with an annual
 * fee — separate them so the cadence detector doesn't average them into
 * "irregular".
 */
function splitCrossCadenceCluster(cluster: RawTxn[]): RawTxn[][] {
  if (cluster.length < 3) return [cluster];
  const byDate = [...cluster].sort((a, b) =>
    a.postedDate < b.postedDate ? -1 : 1,
  );
  const intervals: number[] = [];
  for (let i = 1; i < byDate.length; i++) {
    intervals.push(daysBetween(byDate[i - 1]!.postedDate, byDate[i]!.postedDate));
  }
  const hasShort = intervals.some((d) => d < 60);
  const hasLong = intervals.some((d) => d > 300);
  if (!hasShort || !hasLong) return [cluster];

  // Split: any txn that has a "long" gap before it starts a new sub-cluster.
  const groups: RawTxn[][] = [[byDate[0]!]];
  for (let i = 1; i < byDate.length; i++) {
    if (intervals[i - 1]! > 300) {
      groups.push([byDate[i]!]);
    } else {
      groups[groups.length - 1]!.push(byDate[i]!);
    }
  }
  return groups;
}

/** Pick the most-common raw merchant string in the cluster. */
function representativeRaw(cluster: RawTxn[]): string {
  const counts = new Map<string, number>();
  for (const t of cluster) counts.set(t.merchantRaw, (counts.get(t.merchantRaw) ?? 0) + 1);
  let best = cluster[0]!.merchantRaw;
  let max = 0;
  for (const [raw, n] of counts) if (n > max) { max = n; best = raw; }
  return best;
}

function sourceLabel(cluster: RawTxn[]): string {
  const accts = new Set(cluster.map((t) => t.accountType));
  return accts.size === 1 ? [...accts][0]! : "multiple";
}

// =====================================================================
// Layer 1 — threshold-based seeder (DEFAULT)
// =====================================================================

/**
 * Returns anything the user should look at:
 *   • merchants occurring ≥ repeatThreshold times (default 2)
 *   • any single charge whose absolute value ≥ amountThreshold (default $100)
 *
 * Cadence is never decided — only optionally *suggested* when
 * `attachDetectorSuggestion: true`. The user makes the final call.
 */
export function seedCandidates(txns: RawTxn[], opts: SeedOptions = {}): Seed[] {
  // Clamp repeatThreshold to a floor of 2 — a 1-occurrence merchant is by
  // definition not "repeated", so allowing repeatThreshold = 1 would emit
  // single-occurrence merchants with seedReason: "repeated", which is
  // semantically wrong and confuses downstream review-queue logic. If the
  // caller wants to surface every charge they can lower amountThreshold or
  // pass chargesOnly: false; the repeated path stays its own thing.
  const repeatThreshold = Math.max(2, opts.repeatThreshold ?? 2);
  const amountThreshold = opts.amountThreshold ?? 100; // $100
  const chargesOnly = opts.chargesOnly ?? true;
  const attachSuggestion = opts.attachDetectorSuggestion ?? false;
  const tolerance = opts.amountTolerance ?? 0.05;

  const filtered = chargesOnly ? txns.filter((t) => t.amountDollars < 0) : txns;
  const buckets = bucketByMerchant(filtered);

  const seeds: Seed[] = [];
  // Track which txn references are already represented by a repeated-merchant
  // seed so we don't double-emit them as high-value seeds too. We use object
  // identity (RawTxn reference) rather than a synthesized string key — two
  // legitimately-distinct rows can share the same date+amount+merchant
  // (e.g., two separate McDonald's visits at the same combo price on the
  // same day) and must not collapse.
  const seenInRepeated = new Set<RawTxn>();

  // --- Layer 1a: repeated merchants ---
  for (const [merchant, list] of buckets) {
    if (list.length < repeatThreshold) continue;
    // Sub-cluster by amount so a merchant with multiple distinct sub tiers
    // surfaces as multiple seeds rather than one fuzzy lump.
    const rawClusters = clusterByAmount(list, tolerance);
    const clusters = rawClusters.flatMap(splitCrossCadenceCluster);
    for (const cluster of clusters) {
      if (cluster.length < repeatThreshold) continue;
      const byDate = [...cluster].sort((a, b) =>
        a.postedDate < b.postedDate ? -1 : a.postedDate > b.postedDate ? 1 : 0,
      );
      const lastSeen = byDate[byDate.length - 1]!.postedDate;
      const amount = medianAmount(cluster.map((t) => t.amountDollars));
      const hitsAmount = cluster.some((t) => Math.abs(t.amountDollars) >= amountThreshold);
      const seed: Seed = {
        merchantNormalized: merchant,
        merchantSample: representativeRaw(cluster),
        seedReason: hitsAmount ? "both" : "repeated",
        amountDollars: amount,
        occurrences: cluster.length,
        lastSeen,
        sourceAccount: sourceLabel(cluster),
      };
      if (attachSuggestion) {
        seed.detectorSuggestion = suggestCadenceForCluster(cluster);
      }
      seeds.push(seed);
      for (const t of cluster) seenInRepeated.add(t);
    }
  }

  // --- Layer 1b: high-value single charges (not already in a repeated seed) ---
  for (const t of filtered) {
    if (Math.abs(t.amountDollars) < amountThreshold) continue;
    if (seenInRepeated.has(t)) continue;
    // Skip empty merchant names — these come from malformed parser output
    // (e.g. a fee line that didn't capture a description) and emitting them
    // as seeds produces useless "$N at <blank>" entries in the review queue.
    // The repeated path already drops empty merchants via bucketByMerchant.
    if (!t.merchantNormalized) continue;
    const seed: Seed = {
      merchantNormalized: t.merchantNormalized,
      merchantSample: t.merchantRaw,
      seedReason: "high_value",
      // round2 at the candidate boundary — keep the high-value path identical
      // in dollar-discipline to the repeated path (medianAmount).
      amountDollars: round2(t.amountDollars),
      occurrences: 1,
      lastSeen: t.postedDate,
      sourceAccount: t.accountType,
    };
    // No cadence suggestion for a single charge.
    seeds.push(seed);
  }

  // Sort: highest-occurrence repeated seeds first, then highest-amount singles.
  return seeds.sort((a, b) => {
    if (a.seedReason !== "high_value" && b.seedReason === "high_value") return -1;
    if (a.seedReason === "high_value" && b.seedReason !== "high_value") return 1;
    if (a.seedReason !== "high_value") return b.occurrences - a.occurrences;
    return Math.abs(b.amountDollars) - Math.abs(a.amountDollars);
  });
}

function suggestCadenceForCluster(cluster: RawTxn[]): Seed["detectorSuggestion"] {
  if (cluster.length < 2) return undefined;
  const byDate = [...cluster].sort((a, b) => (a.postedDate < b.postedDate ? -1 : 1));
  const intervals: number[] = [];
  for (let i = 1; i < byDate.length; i++) {
    intervals.push(daysBetween(byDate[i - 1]!.postedDate, byDate[i]!.postedDate));
  }
  const cadenceDays = median(intervals);
  const label = labelCadence(cadenceDays);
  const consistency = cadenceConsistency(intervals, label);
  const occWeight = Math.min(1, cluster.length / cadenceOccDenominator(label));
  const labelBonus = label === "irregular" ? 0.5 : 1.0;
  const confidence = Math.min(1, consistency * occWeight * labelBonus);
  return { cadenceLabel: label, cadenceDays, confidence };
}

// =====================================================================
// Layer 2 — cadence detector (OPT-IN, kept and improved)
// =====================================================================

/**
 * Cluster by merchant + amount, infer cadence, score confidence. The user
 * can opt into this from the review queue ("auto-suggest cadence") or run
 * it across all charges; the result is always a suggestion, never an auto
 * write.
 */
export function detectRecurring(
  txns: RawTxn[],
  opts: DetectOptions = {},
): RecurringCandidate[] {
  const tolerance = opts.amountTolerance ?? 0.05;
  const minOccurrences = opts.minOccurrences ?? 2;
  const chargesOnly = opts.chargesOnly ?? true;

  const filtered = chargesOnly ? txns.filter((t) => t.amountDollars < 0) : txns;
  const buckets = bucketByMerchant(filtered);

  const candidates: RecurringCandidate[] = [];

  for (const [merchant, list] of buckets) {
    if (list.length < minOccurrences) continue;

    const rawClusters = clusterByAmount(list, tolerance);
    const clusters = rawClusters.flatMap(splitCrossCadenceCluster);

    for (const cluster of clusters) {
      if (cluster.length < minOccurrences) continue;

      const byDate = [...cluster].sort((a, b) => (a.postedDate < b.postedDate ? -1 : 1));
      const intervals: number[] = [];
      for (let i = 1; i < byDate.length; i++) {
        intervals.push(daysBetween(byDate[i - 1]!.postedDate, byDate[i]!.postedDate));
      }

      const medianInterval = median(intervals);
      const label = labelCadence(medianInterval);
      // Irregular short-streak filter — but DON'T drop annuals: 2 occurrences
      // is the annual minimum and is informative for the user.
      if (label === "irregular" && cluster.length < 4) continue;

      const consistency = cadenceConsistency(intervals, label);
      const occWeight = Math.min(1, cluster.length / cadenceOccDenominator(label));
      const labelBonus = label === "irregular" ? 0.5 : 1.0;
      const confidence = Math.min(1, consistency * occWeight * labelBonus);

      candidates.push({
        merchantNormalized: merchant,
        merchantSample: representativeRaw(cluster),
        amountDollars: medianAmount(cluster.map((t) => t.amountDollars)),
        cadenceDays: medianInterval,
        cadenceLabel: label,
        occurrences: cluster.length,
        lastSeen: byDate[byDate.length - 1]!.postedDate,
        sourceAccount: sourceLabel(cluster),
        confidence,
      });
    }
  }

  return candidates.sort((a, b) => b.confidence - a.confidence);
}
