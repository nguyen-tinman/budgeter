// Smoke test against a real Chase PDF statement.
// Outputs counts and aggregate stats only — never merchant strings or amounts.
//
// Usage: pnpm --filter @budgetkit/api exec tsx src/db/scripts/smoke-chase.ts <path>
import { parseChasePdf } from "@budgetkit/core";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const argPath = process.argv[2];
if (!argPath) {
  console.error("usage: smoke-chase.ts <pdf path>");
  process.exit(2);
}
const path = resolve(argPath);
if (!existsSync(path)) {
  console.error(`file not found: ${path}`);
  process.exit(2);
}

const t0 = Date.now();
const r = await parseChasePdf(path);
const ms = Date.now() - t0;

const charges = r.txns.filter((x) => x.amountDollars < 0);
const credits = r.txns.filter((x) => x.amountDollars >= 0);
const uniqueMerchants = new Set(r.txns.map((x) => x.merchantNormalized)).size;
const minDate = r.txns
  .map((x) => x.postedDate)
  .sort()
  .at(0);
const maxDate = r.txns
  .map((x) => x.postedDate)
  .sort()
  .at(-1);

console.log(
  JSON.stringify(
    {
      durationMs: ms,
      txnCount: r.txns.length,
      chargeCount: charges.length,
      creditCount: credits.length,
      uniqueMerchantsAfterNormalize: uniqueMerchants,
      dateSpan: { from: minDate, to: maxDate },
      warningCount: r.warnings.length,
      warnings: r.warnings,
      unparsedLineCount: r.unparsedSamples.length,
      // Show line PATTERNS that failed to parse — replace digits/$ with X to avoid PII
      unparsedPatterns: r.unparsedSamples.slice(0, 8).map((s) =>
        s
          .replace(/\d/g, "#")
          .replace(/[A-Z][A-Z0-9 ]{4,}/g, "<MERCHANT>")
          .slice(0, 100),
      ),
    },
    null,
    2,
  ),
);
