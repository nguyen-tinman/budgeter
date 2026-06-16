import { read, utils } from "xlsx";
import { readFileSync } from "node:fs";
import { round2 } from "./money.js";

export type AccountType = "chase" | "amex_gold" | "amex_plat" | "unknown";

export interface RawTxn {
  /** ISO date string YYYY-MM-DD. */
  postedDate: string;
  /** Original merchant string from the statement. */
  merchantRaw: string;
  /** Whitespace-collapsed, lowercased, suffix-stripped merchant key. */
  merchantNormalized: string;
  /** Dollars, signed. Negative = charge, positive = credit/refund. */
  amountDollars: number;
  /** Source account so the detector can cluster per-card. */
  accountType: AccountType;
  /** Statement category string when present (Amex provides this). */
  categoryHint?: string;
}

export interface ParseAmexResult {
  txns: RawTxn[];
  warnings: string[];
}

/**
 * Normalize a merchant string for clustering:
 *   - lowercase
 *   - strip trailing store numbers / IDs (e.g. " #1234", "*4521", " 0123")
 *   - strip URL-like suffixes (".com", "www.")
 *   - collapse internal whitespace
 *   - strip trailing state abbreviations and zip codes
 */
// US state postal codes (50 + DC). Used to distinguish real state suffixes
// from common 2-letter tokens like "US" or "JR" that should be kept.
const US_STATES = new Set([
  "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga",
  "hi", "id", "il", "in", "ia", "ks", "ky", "la", "me", "md",
  "ma", "mi", "mn", "ms", "mo", "mt", "ne", "nv", "nh", "nj",
  "nm", "ny", "nc", "nd", "oh", "ok", "or", "pa", "ri", "sc",
  "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv", "wi", "wy", "dc",
]);

function stripTrailingState(s: string): string {
  // Match optional " <state> [zip]" at end. Only strip if the 2-letter
  // token is a real US state code.
  const m = s.match(/^(.*?)\s+([a-z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*$/i);
  if (m && m[2] && US_STATES.has(m[2].toLowerCase())) {
    return m[1] ?? "";
  }
  return s;
}

export function normalizeMerchant(raw: string): string {
  let s = raw.toLowerCase();
  // Strip suffix IDs FIRST so any trailing state+zip is still terminal.
  s = s.replace(/[*#][a-z0-9]+/g, "");
  s = s.replace(/\s+\d{4,}\b/g, "");
  // Strip URL fragments
  s = s.replace(/\s+(?:https?:\/\/|www\.)\S+/g, "");
  s = s.replace(/\.(?:com|net|org|io|co)\b/g, "");
  // Strip trailing US state + optional zip. Run twice in case stripping
  // surfaces another trailing state ("City, CA" → "City").
  s = stripTrailingState(s);
  s = stripTrailingState(s);
  // Strip punctuation, collapse whitespace
  s = s.replace(/[^a-z0-9 ]+/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function rawDateToISO(value: unknown): string | null {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof value === "number") {
    // Excel serial date (days since 1900-01-01 with the historical leap-year bug)
    const utcDays = Math.floor(value - 25569);
    const ms = utcDays * 86400 * 1000;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    const y = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
    const da = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${mo}-${da}`;
  }
  if (typeof value === "string") {
    // Common Amex format: "MM/DD/YY" or "MM/DD/YYYY"
    const m = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m && m[1] && m[2] && m[3]) {
      const mo = m[1].padStart(2, "0");
      const d = m[2].padStart(2, "0");
      let y = m[3];
      if (y.length === 2) {
        const yn = Number(y);
        y = yn < 70 ? `20${y}` : `19${y}`;
      }
      return `${y}-${mo}-${d}`;
    }
    // ISO already
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  }
  return null;
}

function parseAmount(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    // SIGN CONVENTION:
    // Amex personal export uses positive for CHARGES, negative for credits/payments.
    // We store charges as negative dollars (your spend) so totals across accounts sum cleanly.
    return round2(-value);
  }
  if (typeof value === "string") {
    const cleaned = value.replace(/[$,\s]/g, "");
    const n = Number(cleaned);
    if (!Number.isFinite(n)) return null;
    return round2(-n);
  }
  return null;
}

function inferAmexFlavor(filename: string): AccountType {
  const f = filename.toLowerCase();
  if (f.includes("gold")) return "amex_gold";
  if (f.includes("plat")) return "amex_plat";
  return "unknown";
}

/**
 * Parse an Amex Gold or Platinum activity .xlsx export.
 * Format (verified for current exports):
 *   - Rows 1-6: cardholder name, account number, statement period, etc. (skipped)
 *   - Row 7: column headers — Date, Description, Card Member, Account #, Amount,
 *           Extended Details, Appears On Your Statement As, Address, City/State,
 *           Zip Code, Country, Reference, Category
 *   - Rows 8+: transaction rows
 *
 * Defensive against minor variations: locates the header row by searching for "Date"
 * + "Amount" in the same row, rather than hard-coding row index 7.
 */
export function parseAmexXlsx(
  filePath: string,
  opts?: { accountType?: AccountType },
): ParseAmexResult {
  const buf = readFileSync(filePath);
  const wb = read(buf, { cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) {
    return { txns: [], warnings: ["No sheets in workbook"] };
  }
  const sheet = wb.Sheets[sheetName]!;
  const rows = utils.sheet_to_json<Record<string, unknown>>(sheet, {
    header: 1,
    raw: true,
    defval: null,
  }) as unknown as unknown[][];

  const warnings: string[] = [];

  // Header row: any row containing a date-like header AND an amount-like header.
  // Tolerates case differences, "Transaction Date" variants, " Amount ($)" suffixes,
  // and non-breaking spaces. Scans the first 30 rows.
  const norm = (v: unknown): string =>
    typeof v === "string"
      ? v.replace(/ /g, " ").trim().toLowerCase()
      : "";
  const isDateHeader = (v: unknown) => {
    const s = norm(v);
    return s === "date" || s === "transaction date" || s === "posted date";
  };
  const isAmountHeader = (v: unknown) => {
    const s = norm(v);
    return s === "amount" || s.startsWith("amount ");
  };
  const isDescHeader = (v: unknown) => {
    const s = norm(v);
    return s === "description" || s === "details" || s === "merchant";
  };
  const isCategoryHeader = (v: unknown) => norm(v) === "category";

  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const r = rows[i] ?? [];
    if (r.some(isDateHeader) && r.some(isAmountHeader)) {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx === -1) {
    return {
      txns: [],
      warnings: ["Header row (with date and amount columns) not found"],
    };
  }

  const header = rows[headerRowIdx] ?? [];
  const cDate = header.findIndex(isDateHeader);
  const cDesc = header.findIndex(isDescHeader);
  const cAmount = header.findIndex(isAmountHeader);
  const cCategory = header.findIndex(isCategoryHeader);

  if (cDate < 0 || cDesc < 0 || cAmount < 0) {
    return {
      txns: [],
      warnings: [
        `Required columns missing (Date=${cDate}, Description=${cDesc}, Amount=${cAmount})`,
      ],
    };
  }

  const accountType = opts?.accountType ?? inferAmexFlavor(filePath);
  const txns: RawTxn[] = [];

  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const dateRaw = r[cDate];
    const descRaw = r[cDesc];
    const amountRaw = r[cAmount];
    if (dateRaw === null && descRaw === null && amountRaw === null) continue; // blank row

    const date = rawDateToISO(dateRaw);
    const amount = parseAmount(amountRaw);
    const desc =
      typeof descRaw === "string"
        ? descRaw.trim()
        : descRaw === null
          ? ""
          : String(descRaw);

    if (!date || amount === null || !desc) {
      // PII-safe: report only WHICH field was bad, not the raw value.
      warnings.push(
        `Row ${i + 1} skipped (date=${date ? "ok" : "bad"}, amount=${amount === null ? "bad" : "ok"}, desc=${desc ? "ok" : "missing"})`,
      );
      continue;
    }

    const category =
      cCategory >= 0 && typeof r[cCategory] === "string"
        ? (r[cCategory] as string).trim() || undefined
        : undefined;

    txns.push({
      postedDate: date,
      merchantRaw: desc,
      merchantNormalized: normalizeMerchant(desc),
      amountDollars: amount,
      accountType,
      categoryHint: category,
    });
  }

  return { txns, warnings };
}
