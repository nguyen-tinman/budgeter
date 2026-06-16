// csv_parser.ts — statement import for CSV exports.
//
// Two real-world shapes are recognized by header sniffing:
//
//  1. Chase card "Activity" export:
//       Transaction Date, Post Date, Description, Category, Type, Amount, Memo
//     Amounts arrive SIGNED (purchases negative, payments/credits positive),
//     which already matches RawTxn's convention — passed through unchanged.
//
//  2. Generic bank export with an explicit direction column:
//       Posting Date, Transaction Date, Amount, Credit Debit Indicator, …,
//       Description, Category, …
//     Amounts arrive as magnitudes; the sign comes from the indicator
//     (Debit → charge → negative, Credit → positive).
//
// Anything else returns no transactions plus a warning naming the headers, so
// an unrecognized export fails loudly in the preview instead of importing
// garbage. Dates accepted as MM/DD/YYYY (US bank convention) or ISO.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  normalizeMerchant,
  type AccountType,
  type RawTxn,
} from "./statement_parser.js";
import { round2 } from "./money.js";

export interface ParseCsvResult {
  txns: RawTxn[];
  warnings: string[];
}

/** Minimal RFC-4180 parser: quoted fields, doubled-quote escapes, embedded
 *  commas and newlines. Returns rows of raw cell strings. */
export function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** MM/DD/YYYY (US bank exports) or ISO YYYY-MM-DD → ISO, else null. */
function toIsoDate(raw: string): string | null {
  const t = raw.trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

/**
 * Parse a statement CSV. `opts.accountType` overrides the inferred source
 * account; without it, a filename containing "chase" maps to "chase" and
 * everything else to "unknown" (the detector clusters per-account, so
 * "unknown" only means "its own bucket", not a failure).
 */
export function parseStatementCsv(
  filePath: string,
  opts?: { accountType?: AccountType },
): ParseCsvResult {
  const warnings: string[] = [];
  const text = readFileSync(filePath, "utf8");
  const rows = parseCsvText(text).filter((r) => r.some((c) => c.trim() !== ""));
  if (rows.length < 2) {
    return { txns: [], warnings: ["No data rows in CSV"] };
  }

  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const col = (name: string): number => header.indexOf(name);

  const iIndicator = col("credit debit indicator");
  const iDesc = col("description");
  const iAmount = col("amount");
  // Chase activity says "Post Date"; the indicator shape says "Posting Date".
  const iPosted = iIndicator >= 0 ? col("posting date") : col("post date");
  const iTxnDate = col("transaction date");
  const iCategory = col("category");

  if (iDesc < 0 || iAmount < 0 || (iPosted < 0 && iTxnDate < 0)) {
    return {
      txns: [],
      warnings: [
        `Unrecognized CSV header (need Description + Amount + a date column): ${rows[0]!.join(", ")}`,
      ],
    };
  }

  const accountType: AccountType =
    opts?.accountType ??
    (basename(filePath).toLowerCase().includes("chase") ? "chase" : "unknown");

  const txns: RawTxn[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!;
    const dateRaw = String((iPosted >= 0 ? r[iPosted] : "") || (iTxnDate >= 0 ? r[iTxnDate] : "") || "");
    const iso = toIsoDate(dateRaw);
    const merchantRaw = String(r[iDesc] ?? "").trim();
    const amt = Number(String(r[iAmount] ?? "").replace(/[$,\s]/g, ""));
    if (!iso || !merchantRaw || !Number.isFinite(amt)) {
      warnings.push(`row ${i + 1}: skipped (unparseable date, description, or amount)`);
      continue;
    }
    let amountDollars = amt;
    if (iIndicator >= 0) {
      const ind = String(r[iIndicator] ?? "").trim().toLowerCase();
      amountDollars = ind === "debit" ? -Math.abs(amt) : Math.abs(amt);
    }
    const txn: RawTxn = {
      postedDate: iso,
      merchantRaw,
      merchantNormalized: normalizeMerchant(merchantRaw),
      amountDollars: round2(amountDollars),
      accountType,
    };
    const cat = iCategory >= 0 ? String(r[iCategory] ?? "").trim() : "";
    if (cat) txn.categoryHint = cat;
    txns.push(txn);
  }
  return { txns, warnings };
}
