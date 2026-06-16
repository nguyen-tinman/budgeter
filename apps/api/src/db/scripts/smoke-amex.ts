// Smoke test against a real Amex statement.
// Outputs counts and aggregate stats only — never merchant strings, amounts, dates.
//
// Usage: pnpm --filter @budgetkit/api exec tsx src/db/scripts/smoke-amex.ts <path>
import { parseAmexXlsx } from "@budgetkit/core";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const argPath = process.argv[2];
if (!argPath) {
  console.error("usage: smoke-amex.ts <xlsx path>");
  process.exit(2);
}
const path = resolve(argPath);
if (!existsSync(path)) {
  console.error(`file not found: ${path}`);
  process.exit(2);
}

const t0 = Date.now();
const r = parseAmexXlsx(path);
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
const accountType = r.txns.at(0)?.accountType ?? "unknown";

console.log(
  JSON.stringify(
    {
      durationMs: ms,
      accountType,
      txnCount: r.txns.length,
      chargeCount: charges.length,
      creditCount: credits.length,
      uniqueMerchantsAfterNormalize: uniqueMerchants,
      dateSpan: { from: minDate, to: maxDate },
      warningCount: r.warnings.length,
      // No actual amounts logged. Just check totals are non-empty:
      hasNonZeroCharges: charges.some((x) => x.amountDollars !== 0),
    },
    null,
    2,
  ),
);
