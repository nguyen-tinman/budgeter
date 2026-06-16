// Full ingest smoke test: parse all statements → detect recurring → roll baselines.
// Outputs counts and confidence histograms only. NO merchant strings, dollar amounts,
// or specific dates beyond month granularity.
//
// Usage: pnpm --filter @budgetkit/api exec tsx src/db/scripts/smoke-ingest.ts
import {
  parseAmexXlsx,
  parseChasePdf,
  detectRecurring,
  rollByCategory,
  seedCandidates,
  defaultMerchantCategorizer,
  type RawTxn,
  type RecurringCandidate,
} from "@budgetkit/core";
import { readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..", "..", "..", "..");
const STATEMENTS = resolve(ROOT, "statements");

function listFiles(dir: string, ext: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(ext))
      .map((f) => join(dir, f))
      .filter((p) => statSync(p).isFile());
  } catch {
    return [];
  }
}

const goldFiles = listFiles(join(STATEMENTS, "gold"), ".xlsx");
const platFiles = listFiles(join(STATEMENTS, "plat"), ".xlsx");
const chaseFiles = listFiles(join(STATEMENTS, "chase"), ".pdf");

const all: RawTxn[] = [];
let warningCount = 0;
let unparsedLineCount = 0;

const t0 = Date.now();

for (const f of goldFiles) {
  const r = parseAmexXlsx(f);
  all.push(...r.txns);
  warningCount += r.warnings.length;
}
for (const f of platFiles) {
  const r = parseAmexXlsx(f);
  all.push(...r.txns);
  warningCount += r.warnings.length;
}
for (const f of chaseFiles) {
  const r = await parseChasePdf(f);
  all.push(...r.txns);
  warningCount += r.warnings.length;
  unparsedLineCount += r.unparsedSamples.length;
}

const parseMs = Date.now() - t0;

const t1 = Date.now();
const recurring = detectRecurring(all);
const detectMs = Date.now() - t1;

const t2 = Date.now();
const baselines = rollByCategory(all, {
  windowMonths: 12,
  // M6e: Chase txns arrive with no categoryHint; the resolver routes known
  // merchants into the right baseline bucket instead of collapsing into
  // "Uncategorized".
  categoryResolver: defaultMerchantCategorizer,
});
const rollMs = Date.now() - t2;

// Report-only: how many Chase txns get categorized by the resolver. PII-safe
// (counts only, no merchant strings).
const chaseTxns = all.filter((t) => t.accountType === "chase");
let chaseCategorized = 0;
for (const t of chaseTxns) {
  if (defaultMerchantCategorizer(t)) chaseCategorized++;
}

const t3 = Date.now();
const seeds = seedCandidates(all, { attachDetectorSuggestion: true });
const seedMs = Date.now() - t3;
const seedReasonHist = { repeated: 0, high_value: 0, both: 0 };
for (const s of seeds) seedReasonHist[s.seedReason]++;
// Annual-fee surfacing check — count seeds with amount ≥ $300 absolute
// (covers Amex Gold $325 and Plat $695) regardless of cadence math.
const bigSingles = seeds.filter(
  (s) => Math.abs(s.amountDollars) >= 300,
).length;

// Confidence histogram
const conf = { high_0_8_plus: 0, mid_0_5_to_0_8: 0, low_under_0_5: 0 };
for (const c of recurring) {
  if (c.confidence >= 0.8) conf.high_0_8_plus++;
  else if (c.confidence >= 0.5) conf.mid_0_5_to_0_8++;
  else conf.low_under_0_5++;
}

// Cadence histogram
const cadence: Record<RecurringCandidate["cadenceLabel"], number> = {
  weekly: 0,
  monthly: 0,
  quarterly: 0,
  annually: 0,
  irregular: 0,
};
for (const c of recurring) cadence[c.cadenceLabel]++;

const dateMonths = new Set(all.map((t) => t.postedDate.slice(0, 7)));

console.log(
  JSON.stringify(
    {
      files: {
        gold: goldFiles.length,
        plat: platFiles.length,
        chase: chaseFiles.length,
      },
      txns: {
        total: all.length,
        charges: all.filter((t) => t.amountDollars < 0).length,
        credits: all.filter((t) => t.amountDollars >= 0).length,
        warningCount,
        unparsedLineCount,
        monthsCovered: dateMonths.size,
        monthSpan: { from: [...dateMonths].sort()[0], to: [...dateMonths].sort().at(-1) },
      },
      recurring: {
        candidateCount: recurring.length,
        confidenceHistogram: conf,
        cadenceHistogram: cadence,
      },
      seeds: {
        total: seeds.length,
        byReason: seedReasonHist,
        bigSinglesGte_300: bigSingles,
      },
      baselines: {
        categoryCount: baselines.length,
        categories: baselines.map((b) => ({
          name: b.category,
          months: b.monthsWithActivity,
          txnCount: b.txnCount,
          // No dollar values logged — only relative magnitude bucket
          spendBucket:
            Math.abs(b.monthlyMedianDollars) > 1000
              ? "high"
              : Math.abs(b.monthlyMedianDollars) > 200
                ? "mid"
                : "low",
        })),
      },
      chaseResolver: {
        chaseTxnCount: chaseTxns.length,
        chaseCategorized,
        coveragePct:
          chaseTxns.length === 0
            ? 0
            : Math.round((chaseCategorized / chaseTxns.length) * 1000) / 10,
      },
      timing: { parseMs, detectMs, rollMs, seedMs },
    },
    null,
    2,
  ),
);
