// Chase credit-card PDF statement parser.
//
// Strategy: render the PDF via pdfjs-dist, concatenate per-page text items in
// reading order (with a heuristic to insert newlines based on Y-coordinate
// changes), then run a regex over each line.
//
// Chase transaction-line formats (observed across recent statements):
//   "MM/DD  MERCHANT DESCRIPTION  $AMOUNT"
//   "MM/DD MM/DD  MERCHANT DESCRIPTION  $AMOUNT"        (rare older fmt)
//   "MM/DD  PAYMENT THANK YOU - WEB  -$AMOUNT"
//
// Year inference: the statement period ("Opening/Closing Date") sits on the
// front page; we pull it out once and tag txns whose MM/DD falls inside the
// range. This handles Dec→Jan rollovers correctly.
//
// Unparsed lines (anything that looks like it could be a transaction but
// didn't match) go to `unparsedSamples` — the caller routes them to the
// review_queue table for user resolution. No silent drops.

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readFileSync } from "node:fs";
import type { RawTxn } from "./statement_parser.js";
import { normalizeMerchant } from "./statement_parser.js";
import { round2 } from "./money.js";

export interface ParseChaseResult {
  txns: RawTxn[];
  warnings: string[];
  /** Lines that resembled a transaction but failed to fully parse. */
  unparsedSamples: string[];
}

// MM/DD then maybe another MM/DD (post date), then some text, then an amount
// like "$1,234.56" or "-$1,234.56" or just "1,234.56" or "-1,234.56".
export const TXN_LINE_RE =
  /^(\d{1,2}\/\d{1,2})(?:\s+\d{1,2}\/\d{1,2})?\s+(.+?)\s+(-?\$?[\d,]+\.\d{2})\s*$/;

// Two header formats observed across Chase products:
//   Credit cards:  "Opening Date 03/08/2025" / "Closing Date 04/07/2025"
//   Checking:      "April 22, 2025 through May 21, 2025"
// Both must be supported; the prose form is the one real-world Chase checking
// PDFs use exclusively, and without it every txn was being tagged with the
// current year (silently breaking the Dec/Jan rollover machinery below).
const OPENING_RE = /opening\s+date[:\s]+(\d{1,2}\/\d{1,2}\/\d{2,4})/i;
const CLOSING_RE = /(?:closing|statement)\s+date[:\s]+(\d{1,2}\/\d{1,2}\/\d{2,4})/i;

// e.g. "April 22, 2025 through May 21, 2025"
// Captures: 1=open month, 2=open day, 3=open year, 4=close month, 5=close day, 6=close year.
const PROSE_PERIOD_RE =
  /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})\s+through\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})/i;

const MONTH_NAME_TO_NUM: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04",
  may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12",
};

function monthNameToIso(month: string, day: string, year: string): string | null {
  const mo = MONTH_NAME_TO_NUM[month.toLowerCase()];
  if (!mo) return null;
  const da = day.padStart(2, "0");
  return `${year}-${mo}-${da}`;
}

/**
 * Extract the statement open/close ISO dates from extracted PDF lines. Tries
 * the prose form first (real-world Chase checking PDFs) then the labeled form
 * (older Chase credit-card statements). Either field can be null if not found.
 *
 * Exported so tests can exercise period extraction without needing a real PDF.
 */
export function extractStatementPeriod(
  lines: readonly string[],
): { openIso: string | null; closeIso: string | null } {
  let openIso: string | null = null;
  let closeIso: string | null = null;

  for (const line of lines) {
    if (!openIso || !closeIso) {
      const pm = line.match(PROSE_PERIOD_RE);
      if (pm && pm[1] && pm[2] && pm[3] && pm[4] && pm[5] && pm[6]) {
        const o = monthNameToIso(pm[1], pm[2], pm[3]);
        const c = monthNameToIso(pm[4], pm[5], pm[6]);
        if (o && !openIso) openIso = o;
        if (c && !closeIso) closeIso = c;
      }
    }
    if (!openIso) {
      const om = line.match(OPENING_RE);
      if (om && om[1]) openIso = parseMmDdYyyy(om[1]);
    }
    if (!closeIso) {
      const cm = line.match(CLOSING_RE);
      if (cm && cm[1]) closeIso = parseMmDdYyyy(cm[1]);
    }
    if (openIso && closeIso) break;
  }
  return { openIso, closeIso };
}

function parseMmDdYyyy(s: string): string | null {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  const mo = m[1].padStart(2, "0");
  const da = m[2].padStart(2, "0");
  let y = m[3];
  if (y.length === 2) {
    const yn = Number(y);
    y = yn < 70 ? `20${y}` : `19${y}`;
  }
  return `${y}-${mo}-${da}`;
}

export function parseChaseDate(mmdd: string, fallbackYear: number): string {
  const [mo, da] = mmdd.split("/").map((s) => s.padStart(2, "0"));
  return `${fallbackYear}-${mo}-${da}`;
}

/**
 * Pick the right year for an MM/DD transaction date given a known
 * statement period. Handles Dec/Jan rollover.
 *
 * Strategy: try each year in [openYear..closeYear] and pick the one
 * that places the MM/DD inside [openIso, closeIso] inclusive. If none
 * fits, fall back to closeYear.
 */
export function pickStatementYear(
  mmdd: string,
  openIso: string | null,
  closeIso: string | null,
  fallbackYear: number,
): number {
  const [moStr, daStr] = mmdd.split("/");
  if (!moStr || !daStr) return fallbackYear;
  const mo = moStr.padStart(2, "0");
  const da = daStr.padStart(2, "0");

  const tryYears: number[] = [];
  if (closeIso) tryYears.push(Number(closeIso.slice(0, 4)));
  if (openIso) {
    const oy = Number(openIso.slice(0, 4));
    if (!tryYears.includes(oy)) tryYears.push(oy);
  }
  if (tryYears.length === 0) return fallbackYear;

  const lower = openIso ?? "0000-00-00";
  const upper = closeIso ?? "9999-12-31";
  for (const y of tryYears) {
    const candidate = `${y}-${mo}-${da}`;
    if (candidate >= lower && candidate <= upper) return y;
  }
  // No year placed the date in range — prefer the closing year (more recent).
  return closeIso ? Number(closeIso.slice(0, 4)) : fallbackYear;
}

export function parseChaseAmount(s: string): number | null {
  const cleaned = s.replace(/[$,\s]/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  // Chase convention: positive = charge, negative = payment/credit.
  // We store charges as negative, credits as positive (same as Amex parser).
  return round2(-n);
}

/** Parse a single line of Chase statement text. Returns null if it isn't a transaction. */
export function parseChaseLine(
  line: string,
  statementYear: number,
): RawTxn | null {
  if (!/^\d{1,2}\/\d{1,2}\b/.test(line)) return null;
  const m = line.match(TXN_LINE_RE);
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  const desc = m[2].trim();
  if (desc.length < 3) return null;
  const amt = parseChaseAmount(m[3]);
  if (amt === null) return null;
  return {
    postedDate: parseChaseDate(m[1], statementYear),
    merchantRaw: desc,
    merchantNormalized: normalizeMerchant(desc),
    amountDollars: amt,
    accountType: "chase",
  };
}

interface PdfTextItem {
  str: string;
  transform: number[]; // 6-element affine
}

async function extractTextLines(filePath: string): Promise<string[]> {
  const buf = readFileSync(filePath);
  // pdfjs needs a Uint8Array sized to its data, not a Node Buffer share.
  const data = new Uint8Array(buf.byteLength);
  buf.copy(data);
  const doc = await getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

  const lines: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const items = tc.items as PdfTextItem[];

    // Group items into lines by their y-coordinate (transform[5]).
    const byLine = new Map<number, PdfTextItem[]>();
    for (const it of items) {
      const y = Math.round(it.transform[5] ?? 0);
      const arr = byLine.get(y) ?? [];
      arr.push(it);
      byLine.set(y, arr);
    }
    // y decreases as we go down the page in PDF coords; sort high-to-low
    const ys = [...byLine.keys()].sort((a, b) => b - a);
    for (const y of ys) {
      const lineItems = (byLine.get(y) ?? []).sort(
        (a, b) => (a.transform[4] ?? 0) - (b.transform[4] ?? 0),
      );
      // Insert a space between items whose horizontal gap is large enough
      const parts: string[] = [];
      let lastEnd = -Infinity;
      for (const it of lineItems) {
        const x = it.transform[4] ?? 0;
        if (x - lastEnd > 4 && parts.length > 0) parts.push(" ");
        parts.push(it.str);
        // approximate width: PDFs don't expose per-glyph widths cheaply via this path
        lastEnd = x + it.str.length * 5;
      }
      const text = parts.join("").replace(/\s+/g, " ").trim();
      if (text) lines.push(text);
    }
  }
  return lines;
}

/**
 * Parse already-extracted text lines from a Chase statement. Pulled out of
 * `parseChasePdf` so tests can exercise the full extraction pipeline (period
 * detection + year inference + txn line parsing) without needing a real PDF.
 */
export function parseChaseLines(lines: readonly string[]): ParseChaseResult {
  const warnings: string[] = [];
  const unparsedSamples: string[] = [];
  const txns: RawTxn[] = [];

  const { openIso, closeIso } = extractStatementPeriod(lines);
  const fallbackYear = closeIso
    ? Number(closeIso.slice(0, 4))
    : new Date().getFullYear();

  for (const line of lines) {
    if (!/^\d{1,2}\/\d{1,2}\b/.test(line)) continue;
    // Pick the year for THIS line (handles Dec→Jan rollover).
    const mmddMatch = line.match(/^(\d{1,2}\/\d{1,2})/);
    const year = mmddMatch
      ? pickStatementYear(mmddMatch[1]!, openIso, closeIso, fallbackYear)
      : fallbackYear;
    const txn = parseChaseLine(line, year);
    if (txn) {
      txns.push(txn);
    } else {
      // PII scrub: keep digits/amounts out of the surfaced sample.
      unparsedSamples.push(
        line.replace(/\$?[\d,]+\.\d{2}/g, "$AMT").slice(0, 80),
      );
    }
  }

  if (txns.length === 0) {
    warnings.push("No transactions extracted — verify statement format");
  }

  return { txns, warnings, unparsedSamples };
}

export async function parseChasePdf(filePath: string): Promise<ParseChaseResult> {
  let lines: string[];
  try {
    lines = await extractTextLines(filePath);
  } catch (e) {
    return {
      txns: [],
      warnings: [`PDF read failed: ${(e as Error).message}`],
      unparsedSamples: [],
    };
  }
  return parseChaseLines(lines);
}
