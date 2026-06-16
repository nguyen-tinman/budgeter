// Focused check: does the new seedCandidates() surface Amex annual fees?
// Reports counts and amount buckets only. No PII.
import { parseAmexXlsx, seedCandidates, type RawTxn } from "@budgetkit/core";
import { readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..", "..", "..", "..");
const STATEMENTS = resolve(ROOT, "statements");

function listXlsx(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".xlsx"))
      .map((f) => join(dir, f))
      .filter((p) => statSync(p).isFile());
  } catch {
    return [];
  }
}

const all: RawTxn[] = [];
for (const f of listXlsx(join(STATEMENTS, "gold"))) all.push(...parseAmexXlsx(f).txns);
for (const f of listXlsx(join(STATEMENTS, "plat"))) all.push(...parseAmexXlsx(f).txns);

const seeds = seedCandidates(all);

const annualish = seeds.filter(
  (s) =>
    /renewal|membership|annual/i.test(s.merchantSample) ||
    (Math.abs(s.amountDollars) >= 300 && Math.abs(s.amountDollars) <= 800),
);

const reasonHist: Record<string, number> = { repeated: 0, high_value: 0, both: 0 };
for (const s of annualish) reasonHist[s.seedReason]!++;

const amountBuckets: Record<string, number> = {};
for (const s of annualish) {
  const a = Math.abs(s.amountDollars);
  const k = a >= 60_000 ? "gte_600" : a >= 300 ? "300_to_600" : "lt_300";
  amountBuckets[k] = (amountBuckets[k] ?? 0) + 1;
}

console.log(
  JSON.stringify(
    {
      amexTxnsTotal: all.length,
      totalSeeds: seeds.length,
      annualishSeedCount: annualish.length,
      annualishByReason: reasonHist,
      annualishAmountBuckets: amountBuckets,
    },
    null,
    2,
  ),
);
