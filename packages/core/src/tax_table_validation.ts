// Domain validation for a parsed tax_tables payload (Train F / F3a).
//
// This is the SAFETY GATE between the assistant's free-text parse of an
// IRS/FTB page and a write to tax_tables. The assistant reads a fetched
// page, extracts brackets + the standard deduction, and proposes a payload;
// before that payload reaches the DB it must pass every rule below. The
// rules encode what the tax_calculator (bracketTax in tax_calculator.ts) and
// the DB schema (migration 007: jurisdiction ∈ {federal,ca}, filing ∈
// {single,mfj}) actually require, so a malformed parse can never corrupt a
// take-home computation downstream.
//
// Design: PURE function, no I/O, no ctx. Returns a structured result so the
// caller can surface every problem at once (the assistant can then re-parse
// and fix all of them in one shot rather than playing whack-a-mole). The
// import tool (import_tax_table in tools.ts) runs this before delegating to
// ctx.tax.upsertTable; tests exercise it directly.

/** A single marginal bracket. `upTo` is the upper income cutoff in DOLLARS;
 *  `null` (or omitted by the caller, normalized to null upstream) marks the
 *  top, open-ended bracket. `rate` is a fraction in (0, 0.5). */
export interface TaxBracketInput {
  upTo: number | null;
  rate: number;
}

/** The shape the assistant proposes and we validate before writing. Mirrors
 *  the tax_tables row (year, jurisdiction, filing, standard_deduction_dollars,
 *  brackets_json) plus the request `year` we validate the payload against. */
export interface TaxTablePayload {
  year: number;
  jurisdiction: string;
  filing: string;
  standardDeductionDollars: number;
  brackets: TaxBracketInput[];
  sourceUrl?: string;
}

/** One validation failure. `field` is a dotted path into the payload
 *  (e.g. "brackets.2.rate") so the assistant can point its fix precisely;
 *  `message` is human-readable for relaying to the user. `code` is a stable
 *  machine token for tests + programmatic handling. */
export interface TaxTableValidationError {
  code: TaxTableValidationCode;
  field: string;
  message: string;
}

export type TaxTableValidationCode =
  | "year_mismatch"
  | "year_out_of_range"
  | "jurisdiction_invalid"
  | "filing_invalid"
  | "standard_deduction_not_positive"
  | "brackets_empty"
  | "rate_out_of_range"
  | "cutoff_not_positive"
  | "cutoffs_not_ascending"
  | "first_bracket_not_zero_based"
  | "top_bracket_not_open_ended"
  | "interior_bracket_open_ended";

export interface TaxTableValidationResult {
  ok: boolean;
  errors: TaxTableValidationError[];
  /** Echoed-back normalized payload when ok===true (brackets with upTo
   *  coerced to number|null). Undefined when validation failed. */
  normalized?: {
    year: number;
    jurisdiction: "federal" | "ca";
    filing: "single" | "mfj";
    standardDeductionDollars: number;
    brackets: Array<{ upTo: number | null; rate: number }>;
    sourceUrl?: string;
  };
}

/** Jurisdictions the DB CHECK constraint (migration 007) accepts. */
export const VALID_JURISDICTIONS = ["federal", "ca"] as const;
/** Filing statuses the engine + DB CHECK constraint accept. NOTE: the app
 *  does NOT model MFS / HoH — they are deliberately excluded so a parse that
 *  picks up those columns from a page fails loudly instead of writing a row
 *  the take-home engine can't use. */
export const VALID_FILINGS = ["single", "mfj"] as const;

/** A marginal rate above this is almost certainly a parse error (a percentage
 *  read as a whole number, e.g. 37 instead of 0.37, or two columns merged).
 *  US federal top rate is 0.37; CA top is ~0.133; 0.5 is a generous ceiling
 *  that still catches the common "37 not 0.37" mistake. */
export const MAX_MARGINAL_RATE = 0.5;

/**
 * Validate a parsed tax-table payload against the request `year` and the
 * domain rules the engine + schema require. Returns ALL failures (not just
 * the first) so the assistant can fix the parse in one pass.
 *
 * Rules enforced:
 *   1. payload.year === requestYear (the page must be for the year we asked
 *      for; a 2025 page parsed while requesting 2026 is rejected).
 *   2. year in a sane range [2000, 2100].
 *   3. jurisdiction ∈ {federal, ca}.
 *   4. filing ∈ {single, mfj}.
 *   5. standardDeductionDollars > 0.
 *   6. brackets non-empty.
 *   7. every rate ∈ (0, MAX_MARGINAL_RATE).
 *   8. cutoffs strictly ascending (each interior upTo > previous).
 *   9. first bracket starts at 0 — i.e. the implicit lower edge of the first
 *      bracket is 0 (the engine assumes this). We can't see a lower edge in
 *      the {upTo, rate} encoding, so we enforce it positionally: the first
 *      bracket's upTo must be > 0 (a first bracket with upTo<=0 or a leading
 *      open-ended bracket means the schedule doesn't start at zero income).
 *  10. last bracket is open-ended (upTo === null); no interior bracket is
 *      open-ended.
 */
export function validateTaxTablePayload(
  payload: TaxTablePayload,
  requestYear: number,
): TaxTableValidationResult {
  const errors: TaxTableValidationError[] = [];
  const push = (code: TaxTableValidationCode, field: string, message: string) =>
    errors.push({ code, field, message });

  // --- year ---
  if (!Number.isInteger(payload.year) || payload.year < 2000 || payload.year > 2100) {
    push(
      "year_out_of_range",
      "year",
      `year ${payload.year} is outside the supported range [2000, 2100]`,
    );
  }
  if (payload.year !== requestYear) {
    push(
      "year_mismatch",
      "year",
      `parsed year ${payload.year} does not match the requested year ${requestYear}`,
    );
  }

  // --- jurisdiction ---
  if (!VALID_JURISDICTIONS.includes(payload.jurisdiction as (typeof VALID_JURISDICTIONS)[number])) {
    push(
      "jurisdiction_invalid",
      "jurisdiction",
      `jurisdiction "${payload.jurisdiction}" must be one of ${VALID_JURISDICTIONS.join(", ")}`,
    );
  }

  // --- filing ---
  if (!VALID_FILINGS.includes(payload.filing as (typeof VALID_FILINGS)[number])) {
    push(
      "filing_invalid",
      "filing",
      `filing "${payload.filing}" must be one of ${VALID_FILINGS.join(", ")} (the app does not model MFS/HoH)`,
    );
  }

  // --- standard deduction ---
  if (
    typeof payload.standardDeductionDollars !== "number" ||
    !Number.isFinite(payload.standardDeductionDollars) ||
    payload.standardDeductionDollars <= 0
  ) {
    push(
      "standard_deduction_not_positive",
      "standardDeductionDollars",
      `standardDeductionDollars must be a positive dollar amount (got ${payload.standardDeductionDollars})`,
    );
  }

  // --- brackets ---
  const brackets = payload.brackets;
  if (!Array.isArray(brackets) || brackets.length === 0) {
    push("brackets_empty", "brackets", "brackets must be a non-empty array");
    // Without any brackets the structural checks below are meaningless.
    return { ok: false, errors };
  }

  // Rate range: every rate strictly in (0, MAX_MARGINAL_RATE).
  for (let i = 0; i < brackets.length; i++) {
    const r = brackets[i]!.rate;
    if (typeof r !== "number" || !Number.isFinite(r) || r <= 0 || r >= MAX_MARGINAL_RATE) {
      push(
        "rate_out_of_range",
        `brackets.${i}.rate`,
        `rate ${r} must be in the open interval (0, ${MAX_MARGINAL_RATE}) — a value like 37 instead of 0.37 is a parse error`,
      );
    }
  }

  // Open-endedness: exactly the LAST bracket may have upTo === null.
  for (let i = 0; i < brackets.length - 1; i++) {
    if (brackets[i]!.upTo === null) {
      push(
        "interior_bracket_open_ended",
        `brackets.${i}.upTo`,
        `only the last bracket may be open-ended (upTo=null); bracket ${i} is interior`,
      );
    }
  }
  const last = brackets[brackets.length - 1]!;
  if (last.upTo !== null) {
    push(
      "top_bracket_not_open_ended",
      `brackets.${brackets.length - 1}.upTo`,
      "the last (top) bracket must be open-ended — set upTo to null / omit it",
    );
  }

  // First bracket must be zero-based: its cutoff must be a positive number
  // (the income span [0, upTo] is taxed at the first rate). A leading
  // open-ended bracket (the whole schedule is one rate) or upTo<=0 both mean
  // the schedule doesn't start at zero income the way the engine assumes.
  const first = brackets[0]!;
  if (first.upTo === null) {
    // A single open-ended bracket is structurally "starts at 0 and never
    // ends" — that's a degenerate flat tax, not a real bracket schedule.
    // Flag it under first_bracket_not_zero_based so the assistant re-parses.
    push(
      "first_bracket_not_zero_based",
      "brackets.0.upTo",
      "the first bracket must have a positive upper cutoff (the lowest bracket spans $0..upTo); a single open-ended bracket is not a valid schedule",
    );
  } else if (typeof first.upTo !== "number" || !Number.isFinite(first.upTo) || first.upTo <= 0) {
    push(
      "first_bracket_not_zero_based",
      "brackets.0.upTo",
      `the first bracket's upper cutoff must be > 0 (it spans $0..upTo); got ${first.upTo}`,
    );
  }

  // Ascending cutoffs: each interior upTo strictly greater than the previous.
  // Also flags any non-positive interior cutoff. Skip the final open-ended
  // bracket (upTo===null by the rule above).
  let prevCutoff = -Infinity;
  for (let i = 0; i < brackets.length; i++) {
    const upTo = brackets[i]!.upTo;
    if (upTo === null) continue; // open-ended top bracket; handled above
    if (typeof upTo !== "number" || !Number.isFinite(upTo) || upTo <= 0) {
      // Non-positive / non-finite interior cutoff. (first bracket also caught
      // above, but flag others too.)
      if (i !== 0) {
        push(
          "cutoff_not_positive",
          `brackets.${i}.upTo`,
          `bracket cutoff must be a positive dollar amount (got ${upTo})`,
        );
      }
      prevCutoff = typeof upTo === "number" ? upTo : prevCutoff;
      continue;
    }
    if (upTo <= prevCutoff) {
      push(
        "cutoffs_not_ascending",
        `brackets.${i}.upTo`,
        `bracket cutoffs must be strictly ascending; ${upTo} is not greater than the previous cutoff ${prevCutoff}`,
      );
    }
    prevCutoff = upTo;
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    errors: [],
    normalized: {
      year: payload.year,
      jurisdiction: payload.jurisdiction as "federal" | "ca",
      filing: payload.filing as "single" | "mfj",
      standardDeductionDollars: payload.standardDeductionDollars,
      brackets: brackets.map((b) => ({ upTo: b.upTo ?? null, rate: b.rate })),
      ...(payload.sourceUrl !== undefined ? { sourceUrl: payload.sourceUrl } : {}),
    },
  };
}
