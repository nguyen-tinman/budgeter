// Ground-truth review pipeline.
//
// Writes a "scan report" to ./data/ground-truth-scan.json that contains the
// full data Claude needs to find items the detector missed. This file lives
// in ./data/ (git-ignored) so the merchant/amount data NEVER leaves the local
// machine. Stdout reports only counts/patterns.
//
// The user then runs:
//   pnpm --filter @budgetkit/api exec tsx src/db/scripts/ground-truth-scan.ts
// inspects ./data/ground-truth-scan.json, and produces seed_corrections.json
// in the same folder. Both files are git-ignored.

import {
  parseAmexXlsx,
  parseChasePdf,
  detectRecurring,
  round2,
  type RawTxn,
  type RecurringCandidate,
} from "@budgetkit/core";
import { readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..", "..", "..", "..");
const STATEMENTS = resolve(ROOT, "statements");
const DATA_DIR = resolve(ROOT, "data");
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

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

const all: RawTxn[] = [];
for (const f of listFiles(join(STATEMENTS, "gold"), ".xlsx"))
  all.push(...parseAmexXlsx(f).txns);
for (const f of listFiles(join(STATEMENTS, "plat"), ".xlsx"))
  all.push(...parseAmexXlsx(f).txns);
for (const f of listFiles(join(STATEMENTS, "chase"), ".pdf"))
  all.push(...(await parseChasePdf(f)).txns);

// Sort by date for chronological view
all.sort((a, b) => (a.postedDate < b.postedDate ? -1 : 1));

const detected = detectRecurring(all);
const detectedMerchants = new Set(detected.map((c) => c.merchantNormalized));

// ===== Aggregations Claude needs to find missed items =====

// 1) Per-merchant occurrence counts + amount range (catches sub-min-occurrence items)
const byMerchant = new Map<
  string,
  {
    raws: Set<string>;
    occurrences: number;
    amounts: number[];
    dates: string[];
    accounts: Set<string>;
    detected: boolean;
  }
>();
for (const t of all.filter((x) => x.amountDollars < 0)) {
  const k = t.merchantNormalized;
  if (!k) continue;
  const e = byMerchant.get(k) ?? {
    raws: new Set<string>(),
    occurrences: 0,
    amounts: [],
    dates: [],
    accounts: new Set<string>(),
    detected: false,
  };
  e.raws.add(t.merchantRaw);
  e.occurrences++;
  e.amounts.push(t.amountDollars);
  e.dates.push(t.postedDate);
  e.accounts.add(t.accountType);
  e.detected = detectedMerchants.has(k);
  byMerchant.set(k, e);
}

// 2) Candidate "annual fees" — merchants with low occurrence count but charges > $200,
//    spread across at least 2 different months across years (a yearly signal).
const annualFeeCandidates: Array<{
  merchantNormalized: string;
  sampleRaw: string;
  occurrences: number;
  amountDollars: number;
  dates: string[];
  accounts: string[];
}> = [];
for (const [m, e] of byMerchant) {
  if (e.detected) continue;
  if (e.occurrences > 4) continue;
  // Big charge ($200+ in dollars)
  const maxAbs = Math.max(...e.amounts.map((a) => Math.abs(a)));
  if (maxAbs < 200) continue;
  // Check spread across years
  const years = new Set(e.dates.map((d) => d.slice(0, 4)));
  if (years.size < 2 && e.occurrences < 2) continue;
  annualFeeCandidates.push({
    merchantNormalized: m,
    sampleRaw: [...e.raws][0]!,
    occurrences: e.occurrences,
    amountDollars: round2(
      e.amounts.reduce((s, a) => s + a, 0) / e.amounts.length,
    ),
    dates: e.dates,
    accounts: [...e.accounts],
  });
}

// 3) Possible merchant alias candidates: pairs of normalized merchants
//    that share a token AND have similar amounts and overlapping months.
const merchantList = [...byMerchant.entries()];
const aliasCandidates: Array<{
  a: string;
  b: string;
  aSample: string;
  bSample: string;
  commonTokens: string[];
  amountDelta: number;
  aOccurrences: number;
  bOccurrences: number;
}> = [];
for (let i = 0; i < merchantList.length; i++) {
  for (let j = i + 1; j < merchantList.length; j++) {
    const [ma, ea] = merchantList[i]!;
    const [mb, eb] = merchantList[j]!;
    const ta = new Set(ma.split(" ").filter((t) => t.length >= 4));
    const tb = new Set(mb.split(" ").filter((t) => t.length >= 4));
    const common = [...ta].filter((t) => tb.has(t));
    if (common.length === 0) continue;
    if (ma === mb) continue;
    const avgA = ea.amounts.reduce((s, a) => s + a, 0) / ea.amounts.length;
    const avgB = eb.amounts.reduce((s, a) => s + a, 0) / eb.amounts.length;
    const delta = Math.abs(avgA - avgB);
    // Only flag if amounts within 30% and share at least one ≥4-char token
    const refMax = Math.max(Math.abs(avgA), Math.abs(avgB));
    if (delta > refMax * 0.3) continue;
    aliasCandidates.push({
      a: ma,
      b: mb,
      aSample: [...ea.raws][0]!,
      bSample: [...eb.raws][0]!,
      commonTokens: common,
      amountDelta: Math.round(delta),
      aOccurrences: ea.occurrences,
      bOccurrences: eb.occurrences,
    });
  }
}

// 4) Already-detected recurring (for Claude to verify confidence ordering)
const reportPath = resolve(DATA_DIR, "ground-truth-scan.json");
writeFileSync(
  reportPath,
  JSON.stringify(
    {
      totalTxns: all.length,
      uniqueMerchants: byMerchant.size,
      detectedCount: detected.length,
      annualFeeCandidates: annualFeeCandidates
        .sort((a, b) => Math.abs(b.amountDollars) - Math.abs(a.amountDollars))
        .slice(0, 30),
      aliasCandidates: aliasCandidates.slice(0, 30),
      detected: detected.map((c) => ({
        merchant: c.merchantNormalized,
        sample: c.merchantSample,
        amount: c.amountDollars,
        cadence: c.cadenceLabel,
        cadenceDays: c.cadenceDays,
        occurrences: c.occurrences,
        confidence: c.confidence,
        source: c.sourceAccount,
      })),
    },
    null,
    2,
  ),
);

// Stdout: counts only (no PII)
console.log(
  JSON.stringify(
    {
      reportWrittenTo: "./data/ground-truth-scan.json",
      totalTxns: all.length,
      uniqueMerchantsBucket:
        byMerchant.size < 50
          ? "<50"
          : byMerchant.size < 200
            ? "50-200"
            : byMerchant.size < 500
              ? "200-500"
              : "500+",
      detectedCount: detected.length,
      annualFeeCandidateCount: annualFeeCandidates.length,
      merchantAliasCandidateCount: aliasCandidates.length,
    },
    null,
    2,
  ),
);
