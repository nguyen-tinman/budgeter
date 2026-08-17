# Recurring Detection — Design + Known Limitations

## Two-layer architecture (per M6d)

1. **`seedCandidates(txns, opts)`** — DEFAULT path. Surfaces anything worth
   showing the user: a merchant appearing ≥ `repeatThreshold` times (default
   2) OR any single charge ≥ `amountThreshold` (default $100). Returns
   `Seed[]` with `seedReason: "repeated" | "high_value" | "both"`. The user
   accepts/edits/rejects each seed in the review queue. The detector never
   auto-classifies.

2. **`detectRecurring(txns, opts)`** — OPT-IN path. The user can ask
   "auto-suggest cadence" on a seed or run cadence inference across all
   charges. Returns `RecurringCandidate[]` with `cadenceLabel`, `cadenceDays`,
   `confidence`. Always a suggestion, never an auto-write.

## Configuration

Both layers accept an options bag passed at call time — there are no persisted workspace settings for these knobs. The relevant `SeedOptions` fields (see `packages/core/src/recurring_detector.ts`):

| Option | Default | Meaning |
|--------|---------|---------|
| `repeatThreshold` | `2` | Surface a merchant once it has appeared this many times (floor-clamped to 2). |
| `amountThreshold` | `100` (dollars) | Surface any single charge whose absolute value is ≥ this amount. |
| `amountTolerance` | `0.05` (5%) | Sub-clustering tolerance within a merchant bucket, with a 50¢ floor and $50 cap. |
| `chargesOnly` | `true` | When true, credits (positive amounts) are excluded before bucketing. |
| `attachDetectorSuggestion` | `false` | When true, the opt-in cadence detector's suggestion is attached to each seed. |

## Algorithm details

- **Bucketing**: by `merchantNormalized`. Empty-key txns are dropped.
- **Amount clustering**: greedy first-fit, sorted by absolute amount.
  Tolerance = `max(50¢ floor, min(ref × 5%, $50 cap))`. The floor prevents
  sub-dollar subscriptions from fragmenting on rounding noise; the cap
  prevents large charges from absorbing unrelated similar-amount items.
- **Cross-cadence splitter**: post-pass that splits any cluster whose
  sorted-by-date intervals contain both a `<60d` and a `>300d` gap. Handles
  the trailing-outlier shape (monthly stream + later annual outlier).
- **Cadence labels**: weekly [5,9], monthly [25,35], quarterly [85,95],
  annually [350,380]. Outside any range = `irregular` (filtered out if
  cluster.length < 4 in `detectRecurring`).
- **Confidence (opt-in detector only)**: `consistency × occWeight × labelBonus`.
  - `consistency`: 1 - meanDev/budget, clamped [0,1]. Drift budget is
    cadence-aware: annual=30d, quarterly=15d, monthly=8d, weekly=4d.
  - `occWeight`: cluster.length / cadenceOccDenominator, saturated at 1.
    Denominator: annual=2, quarterly=4, monthly=6, weekly=12.
  - `labelBonus`: 1.0 for known cadences, 0.5 for `irregular`.

## Known limitations

### L1 — Interleaved cross-cadence (Codex partial-fix flag)
The cross-cadence splitter only fires when there's an `adjacent` gap >300d
in the sorted-by-date interval sequence. If an annual outlier is
*interleaved* inside a continuous monthly stream (e.g., Spotify monthly +
one $14.99 Spotify Gift Card mid-year), no adjacent gap exceeds 300d, so
the splitter doesn't trigger. The cluster reads as monthly with one extra
interval, slightly degrading the cadence confidence but landing in the
right bucket. **Impact**: low — the user sees ONE seed for that merchant
(reflecting reality: same merchant, same amount). The seeder is fine. If
the user wants to separate them they can edit in the review queue.

### L2 — Chase categorization gap (RESOLVED in M6e)
`baseline_roller` accepts a `categoryResolver` callback. Chase transactions
historically arrived with no `categoryHint` (the PDF format doesn't include
one) and collapsed into a single `Uncategorized` baseline bucket.

**M6e fix**: `defaultMerchantCategorizer` (in `packages/core/src/category_resolver.ts`)
is a rule-based resolver that maps known merchants by substring of
`merchantNormalized` into the standard categories. Rules cover six
categories — Gas, Groceries, Restaurants, Utilities, Rent, Subscriptions —
each with a small token table; the first matching rule wins. Pass it as
`opts.categoryResolver` to `rollByCategory()`:

```ts
import { defaultMerchantCategorizer, rollByCategory } from "@budgetkit/core";
rollByCategory(txns, { categoryResolver: defaultMerchantCategorizer });
```

Unknown merchants still return `undefined`, so the caller's
`uncategorizedLabel` fallback continues to apply. The resolver does **not**
mutate transactions; it's a pure read-side hook. To add new merchants, edit
`RULES` in `category_resolver.ts` and update `category_resolver.test.ts`.

`smoke-ingest.ts` wires the resolver and reports `chaseResolver.coveragePct`
(percent of Chase txns the resolver categorized) for quick recall checks
against the real statement corpus.

### L3 — Detector annual cadence with mixed-card data
If the same annual fee appears on two cards at different amounts (e.g.,
Amex Gold $325 vs Platinum $695 both labeled "RENEWAL MEMBERSHIP FEE"),
amount-tolerance separates them into two clusters. Each card-specific
cluster then has ~2 occurrences over 21 months — enough for the
cadence-aware confidence math to label "annually" at high confidence.
Verified 2026-05-26 against real data: detector emits 0 annuals via
`cadenceHistogram` because of date variability across the user's actual
data, but the **seeder catches all annual fees via the amount threshold**
(36 seeds in the $300–$800 range), which is the user-facing path.

## Test coverage

- `recurring_detector.test.ts` (27 tests): both layers, including edge
  cases for the $100 boundary, sub-dollar amount floor, $50 amount cap,
  366-day leap year, Feb 28 ↔ Feb 29 anniversary drift, cross-cadence
  splitter, txnKey dedup (no collapse of distinct same-day txns).
- `baseline_roller.test.ts` (11 tests): full-window denominator behavior,
  splurge-resistant median, `categoryResolver` callback hook, sparse-spend
  smoothing.

## Peer-review history

- **M6 round 1** (2026-05-26): see `doc/peer-review/m06-findings.md`. Three
  parallel reviewers (Gemini, Codex, Grok) found F1–F7. F1, F5 led to the
  M6d redesign; F3, F4, F6 fixed directly; F2 made cadence-aware.
- **M6d verification round** (2026-05-26, same day): all 3 prior BLOCKs
  resolved. Grok: 1 STRONG (Feb 28/29 test, added). Codex: 1 STRONG (L1
  documented as known limitation under new seeder design), 1 real bug
  (`txnKey` collision, fixed by switching to object identity). Gemini's
  verification verdict confirmed all fixes; M6 is closed.
