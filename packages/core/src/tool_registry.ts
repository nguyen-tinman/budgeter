// Tool registry contract — the single source of truth for what mutations
// and queries the app supports. All of:
//   - the in-app LLM chat (apps/api/src/routes/chat.ts),
//   - the direct REST surface (apps/api/src/routes/tools.ts), and
//   - the external MCP server (apps/mcp/src/index.ts)
// drive the SAME registry. One tool, three transports.
//
// The registry itself is transport-agnostic. Tool handlers receive a
// `ToolCtx` that exposes thin repository interfaces — implemented against
// SQLite in apps/api/src/db/repositories/, but easily mockable for tests.

// ---------------------------------------------------------------------------
// JSON Schema (minimal subset — we don't need to validate against a spec
// crawler at runtime, just describe shapes for the LLM and MCP clients).
// ---------------------------------------------------------------------------

// `nullable: true` on any variant means an explicit JSON `null` is a legal
// value for that field, distinct from omitting it — used by update_* tools
// where null CLEARS a column and undefined leaves it alone.
export type JsonSchema =
  | {
      type: "string";
      description?: string;
      enum?: string[];
      default?: string;
      minLength?: number;
      maxLength?: number;
      /** Anchored regex the value must match (see validateArgs). */
      pattern?: string;
      nullable?: boolean;
    }
  | {
      type: "integer" | "number";
      description?: string;
      minimum?: number;
      maximum?: number;
      default?: number;
      nullable?: boolean;
    }
  | { type: "boolean"; description?: string; default?: boolean; nullable?: boolean }
  | { type: "null"; description?: string }
  | {
      type: "array";
      items: JsonSchema;
      description?: string;
      minItems?: number;
      maxItems?: number;
      nullable?: boolean;
    }
  | {
      type: "object";
      properties: Record<string, JsonSchema>;
      required?: string[];
      additionalProperties?: boolean;
      description?: string;
      nullable?: boolean;
    };

// ---------------------------------------------------------------------------
// Tool definition + context
// ---------------------------------------------------------------------------

export type ToolSource = "in_app_llm" | "mcp_client" | "api_direct";

export interface ToolCallRecord {
  toolName: string;
  argsJson: string;
  resultJson: string;
  source: ToolSource;
  ts: string;
}

export interface AuditLogRepo {
  append(record: ToolCallRecord): void;
}

export interface WorkspaceRepo {
  list(): Array<{ id: number; name: string; kind: string; createdAt: string }>;
  get(
    id: number,
  ): { id: number; name: string; kind: string; createdAt: string } | null;
  create(args: {
    name: string;
    kind: "current" | "scenario";
    notes?: string;
  }): { id: number };
  /** Rename an existing workspace. Returns `{ updated: false }` if no row
   *  matched (e.g. the id was deleted between client-list and rename). The
   *  unique constraint on `name` is enforced by SQLite — duplicate names
   *  throw and the caller (rename_workspace tool) translates the error. */
  rename(id: number, newName: string): { updated: boolean };
  /** Clone a workspace into a new scenario, copying its incomes, expenses,
   *  savings, tax_settings, and retirement_settings rows. The clone is
   *  always kind='scenario' (cloning to a second 'current' would violate
   *  the single-baseline assumption). Returns the new workspace id. */
  clone(srcId: number, newName: string, notes?: string | null): { id: number };
  delete(id: number): { deleted: boolean };
}

export interface ExpenseRepo {
  list(workspaceId: number): Array<{
    id: number;
    workspaceId: number;
    label: string;
    amountDollars: number;
    frequency: string;
    /** For one_time rows: 'YYYY-MM-DD' the spend occurred; NULL for recurring
     *  rows and legacy one-time rows written before migration 010. */
    spendDate: string | null;
    categoryId: number | null;
    source: string;
    /** ISO timestamp from SQLite DEFAULT (datetime('now')) — driven from
     *  migration 001. Always present for new rows; rows written before the
     *  column existed (none currently, but guarded for safety) will also
     *  have a value via the column's DEFAULT clause. */
    createdAt: string;
    updatedAt: string;
  }>;
  add(args: {
    workspaceId: number;
    label: string;
    amountDollars: number;
    frequency: string;
    spendDate?: string | null;
    categoryId?: number | null;
    source?: string;
  }): { id: number };
  update(args: {
    id: number;
    label?: string;
    amountDollars?: number;
    frequency?: string;
    spendDate?: string | null;
    categoryId?: number | null;
  }): { updated: boolean };
  delete(id: number): { deleted: boolean };
}

export interface IncomeRepo {
  list(workspaceId: number): Array<{
    id: number;
    workspaceId: number;
    label: string;
    grossAnnualDollars: number;
    taxStatus: string;
    isFederalIncomeTax: boolean;
    filingRole: string;
  }>;
  add(args: {
    workspaceId: number;
    label: string;
    grossAnnualDollars: number;
    taxStatus: string;
    isFederalIncomeTax?: boolean;
    filingRole?: "primary" | "spouse";
  }): { id: number };
  update(args: {
    id: number;
    label?: string;
    grossAnnualDollars?: number;
    taxStatus?: string;
    isFederalIncomeTax?: boolean;
    filingRole?: "primary" | "spouse";
  }): { updated: boolean };
  delete(id: number): { deleted: boolean };
}

export interface TaxRepo {
  /** Load all tax_tables rows for a given year. */
  tables(
    year: number,
  ): Array<{
    year: number;
    jurisdiction: "federal" | "ca";
    filing: "single" | "mfj";
    standardDeductionDollars: number;
    brackets: Array<{ upTo: number | null; rate: number }>;
  }>;
  /** Upsert a single tax_tables row keyed on (year, jurisdiction, filing). */
  upsertTable(args: {
    year: number;
    jurisdiction: "federal" | "ca";
    filing: "single" | "mfj";
    standardDeductionDollars: number;
    brackets: Array<{ upTo: number | null; rate: number }>;
    sourceUrl?: string;
  }): { saved: boolean };
  /** Tax settings for a workspace (filing, ssWageBase, retirement rate, etc.). */
  settingsForWorkspace(workspaceId: number): {
    filing: "single" | "mfj";
    taxYear: number;
    caSdiRate: number;
    ssWageBaseDollars: number;
    ficaSsRate: number;
    ficaMedicareRate: number;
    retirementEffectiveTaxRate: number;
  };
  /** Partial upsert of a workspace's tax_settings row.
   *
   *  UPDATE branch (row exists): only the fields actually supplied are
   *  written; everything else keeps its stored value. Supplying nothing but
   *  the workspaceId is a no-op → `{ saved: false, created: false }`.
   *
   *  INSERT branch (no row): `filing` AND `taxYear` are required (both are
   *  NOT NULL with no schema default); omitted optional columns take their
   *  schema DEFAULTs. Implementations must NOT use ON CONFLICT here — an
   *  excluded.* upsert would clobber unspecified columns with defaults. */
  setSettingsForWorkspace(args: {
    workspaceId: number;
    filing?: "single" | "mfj";
    taxYear?: number;
    caSdiRate?: number;
    ssWageBaseDollars?: number;
    ficaSsRate?: number;
    ficaMedicareRate?: number;
    retirementEffectiveTaxRate?: number;
  }): { saved: boolean; created: boolean };
}

export type SavingsAccountType =
  | "hysa"
  | "brokerage"
  | "roth_ira"
  | "traditional_401k"
  | "roth_401k"
  | "hsa"
  | "other";

/** Discriminator for the employer_match_value column on savings_items. */
export type EmployerMatchKind = "none" | "pct_of_salary" | "flat_annual_dollars";

/** Optional per-account override of how a savings account's contributions flow
 *  through pay (see core/account_tax.ts). Null → derive from accountType. */
export type TaxTreatment = "payroll_pretax" | "payroll_posttax" | "from_cash";

/** Shape returned by `savings.list` — also the shape consumed by the
 *  effectiveMonthlyContributionDollars() helper in retirement_projector.ts. */
export interface SavingsRow {
  id: number;
  workspaceId: number;
  label: string;
  currentBalanceDollars: number;
  targetBalanceDollars: number | null;
  monthlyContributionDollars: number;
  accountType: SavingsAccountType;
  /** 0..1 fraction of taxed primary gross. Null/0 → use monthly_contribution_dollars. */
  contributionPctOfSalary: number | null;
  employerMatchKind: EmployerMatchKind;
  /** Interpretation depends on employerMatchKind. Null when kind === 'none'. */
  employerMatchValue: number | null;
  /** Per-account tax-treatment override; null → derive from accountType. */
  taxTreatment: TaxTreatment | null;
  /** Which filer owns this account. Determines which salary a %-of-salary
   *  contribution resolves against and which leg of take-home it reduces.
   *  Defaults to 'primary' (behavior-preserving for single-earner households). */
  filingRole: "primary" | "spouse";
}

export interface SavingsRepo {
  list(workspaceId: number): SavingsRow[];
  add(args: {
    workspaceId: number;
    label: string;
    currentBalanceDollars?: number;
    targetBalanceDollars?: number | null;
    monthlyContributionDollars?: number;
    accountType: SavingsAccountType;
    contributionPctOfSalary?: number | null;
    employerMatchKind?: EmployerMatchKind;
    employerMatchValue?: number | null;
    taxTreatment?: TaxTreatment | null;
    filingRole?: "primary" | "spouse";
  }): { id: number };
  update(args: {
    id: number;
    label?: string;
    currentBalanceDollars?: number;
    targetBalanceDollars?: number | null;
    monthlyContributionDollars?: number;
    accountType?: SavingsAccountType;
    contributionPctOfSalary?: number | null;
    employerMatchKind?: EmployerMatchKind;
    employerMatchValue?: number | null;
    taxTreatment?: TaxTreatment | null;
    filingRole?: "primary" | "spouse";
  }): { updated: boolean };
  delete(id: number): { deleted: boolean };
}

export interface RetirementRepo {
  /** Returns null when no row exists yet for the workspace. */
  get(workspaceId: number): {
    workspaceId: number;
    currentAge: number;
    retirementAge: number;
    initialBalanceDollars: number;
    growthRate: number;
    rothSplitPct: number;
  } | null;
  /** Upserts the row. Validates retirementAge > currentAge and rothSplitPct in [0,1]. */
  set(args: {
    workspaceId: number;
    currentAge: number;
    retirementAge: number;
    initialBalanceDollars: number;
    growthRate: number;
    rothSplitPct: number;
  }): { saved: boolean };
}

/** Persisted axis ranges for the Planning page's sensitivity grid, one row
 *  per workspace. All bounds are floating-point DOLLARS. Mirrors RetirementRepo's
 *  get-returns-null / set-upserts shape. */
export interface SensitivityRepo {
  /** Returns null when no row exists yet for the workspace. */
  get(workspaceId: number): {
    workspaceId: number;
    primaryLowDollars: number;
    primaryHighDollars: number;
    spouseLowDollars: number;
    spouseHighDollars: number;
  } | null;
  /** Upserts the row. Validates primaryLow < primaryHigh and spouseLow <= spouseHigh. */
  set(args: {
    workspaceId: number;
    primaryLowDollars: number;
    primaryHighDollars: number;
    spouseLowDollars: number;
    spouseHighDollars: number;
  }): { saved: boolean };
}

/** Public-page fetcher for the LLM to "browse" authoritative tax sources.
 *  Implementations enforce a host allowlist + HTTPS + size cap so the LLM
 *  can't be coerced (via prompt injection from page content) into hitting
 *  arbitrary endpoints. */
export interface WebRepo {
  fetch(url: string): Promise<{
    /** HTTP status code from the final response (after allowed redirects). */
    status: number;
    /** Response body (truncated to maxBytes if larger). */
    body: string;
    /** True if the response was truncated by the size cap. */
    truncated: boolean;
    /** The URL that actually returned the body (may differ from the input
     *  if redirects fired). */
    finalUrl: string;
  }>;
}

/** Categories lookup — used by the expense cataloguer to map a resolved
 *  category name (e.g., "Subscriptions") into the FK id stored on the
 *  expenses table. Read-only by design; categories are seeded at install
 *  and edited only via direct SQL in this app's current scope. */
export interface CategoriesRepo {
  /** Map of category name → id. Seeded categories live in `categories` table. */
  listByName(): Map<string, number>;
  /** Full list of categories with metadata. Used by the Trends page to
   *  render per-category color swatches and labels. Ordered by id so
   *  the rendering order is stable. */
  listAll(): Array<{ id: number; name: string; colorHex: string }>;
}

/** Raw transaction rows from imported statements, used by the Trends page
 *  to compute per-month-per-category rolling averages. Transactions are
 *  NOT workspace-scoped — they describe real-world history shared across
 *  scenarios. */
export interface TransactionRepo {
  /** Per-month per-category sums in dollars for the most recent `months`
   *  months. Months without transactions for a category are omitted from
   *  the result; the caller fills zeros. Charges are summed as positive
   *  dollars (the underlying column stores negatives for charges; the
   *  implementation negates before summing). */
  monthlySumsByCategory(months: number): Array<{
    monthKey: string;     // YYYY-MM
    categoryId: number | null;
    totalDollars: number;   // positive
  }>;
  /** Per-month per-MERCHANT charge sums (positive dollars) for the most recent
   *  `months` months, with each merchant's own (importer-assigned) category_id.
   *  The Trends page re-categorizes each merchant via the budget's
   *  merchant→category map and optionally collapses repeating merchants into a
   *  monthly average. Months/merchants without charges are omitted. */
  monthlySumsByMerchant(months: number): Array<{
    monthKey: string;            // YYYY-MM
    merchantRaw: string;
    merchantNormalized: string;
    categoryId: number | null;   // importer-assigned fallback category
    totalDollars: number;        // positive
  }>;
  /** Every charge transaction (amount_dollars < 0), with merchant + posted
   *  date + amount. Used to recover the real spend date for one-time budget
   *  expenses that were catalogued before the spend_date column existed. */
  listChargeRows(): Array<{
    merchantRaw: string;
    merchantNormalized: string;
    postedDate: string;     // YYYY-MM-DD
    amountDollars: number;  // signed; charges are negative
  }>;
  /** listChargeRows restricted to a posted_date window (both bounds inclusive,
   *  both optional) and widened with the importer-assigned category + source
   *  account. Feeds compute_category_baselines, which needs the category to
   *  bucket a charge and the account type to build a RawTxn. Charges only
   *  (amount_dollars < 0), same as listChargeRows. */
  listChargeRowsInRange(
    from?: string,
    to?: string,
  ): Array<{
    merchantRaw: string;
    merchantNormalized: string;
    postedDate: string;     // YYYY-MM-DD
    amountDollars: number;  // signed; charges are negative
    categoryId: number | null;
    accountType: string;
  }>;
  /** Filtered transaction search backing the search_transactions tool. All
   *  filters are optional and AND-ed. `merchant` is a case-insensitive
   *  SUBSTRING match against both the normalized and raw merchant forms;
   *  `from`/`to` bound posted_date inclusively; `minAmountDollars` /
   *  `maxAmountDollars` compare against |amount_dollars| so callers reason in
   *  positive magnitudes regardless of sign; `includeCredits` (default false)
   *  admits positive rows. `totalMatched` counts every matching row, not just
   *  the returned page, so callers can report truncation. Rows come back
   *  newest-first. */
  search(args: {
    merchant?: string;
    from?: string;
    to?: string;
    categoryId?: number;
    minAmountDollars?: number;
    maxAmountDollars?: number;
    includeCredits?: boolean;
    limit: number;
    offset: number;
  }): {
    rows: Array<{
      postedDate: string;
      merchantRaw: string;
      merchantNormalized: string;
      amountDollars: number;   // signed, as stored
      categoryId: number | null;
      accountType: string;
    }>;
    totalMatched: number;
  };
  /** Charge totals grouped by normalized merchant, biggest spend first.
   *  Charges only; `totalDollars` is returned POSITIVE (the stored negatives
   *  are negated). Optional posted_date window + category filter. */
  topMerchants(args: {
    from?: string;
    to?: string;
    categoryId?: number;
    limit: number;
  }): Array<{
    merchantNormalized: string;
    merchantRawSample: string;
    txnCount: number;
    totalDollars: number;   // positive
    firstSeen: string;
    lastSeen: string;
  }>;
  /** Grouped aggregation over the same filter surface as `search`, backing the
   *  query_transactions tool (and through it the /custom page's charts). The
   *  `groupBy` key selects a fixed SQL expression — day / week (Sunday-start
   *  date) / month / dayOfWeek ('0'..'6') / category ('uncat' when null) /
   *  merchant. `dayOfWeek` additionally FILTERS to one weekday. Sums are
   *  `-amount_dollars`, so charges come back as positive spend and
   *  `includeCredits: true` yields NET spend. `totalGroups` counts every group
   *  the filter produced, not just the `limit` returned, so callers can report
   *  truncation. Time keys sort ascending; category/merchant sort by sum
   *  descending. */
  aggregate(args: {
    merchant?: string;
    from?: string;
    to?: string;
    categoryId?: number;
    minAmountDollars?: number;
    maxAmountDollars?: number;
    includeCredits?: boolean;
    dayOfWeek?: number;
    groupBy: "day" | "week" | "month" | "dayOfWeek" | "category" | "merchant";
    metric: "sum" | "count" | "avg";
    limit: number;
  }): {
    rows: Array<{ key: string; value: number; count: number }>;
    totalGroups: number;
  };
  /** Total transaction count across the whole table, used by the Library
   *  stats strip. */
  totalCount(): number;
  /** Bulk-insert parsed transactions for one import. `categoryId` is the
   *  resolved category FK (null when the merchant didn't map). Inserted in
   *  a single prepared-statement loop; the caller wraps the whole commit in
   *  one DB transaction. */
  insertMany(
    importId: number,
    rows: Array<{
      postedDate: string;
      merchantRaw: string;
      merchantNormalized: string;
      amountDollars: number;
      categoryId: number | null;
      accountType: string;
    }>,
  ): { inserted: number };
}

/** Statement-import metadata used by the Library page (counts, last-import
 *  timestamp, per-file txn count, ignored flag). Operates on the
 *  `statement_imports` table. */
export interface StatementImportsRepo {
  /** All statement_imports rows with their txn_count and ignored flag.
   *  Keyed by file_path so the Library page can join against the file
   *  list returned by list_statements_rich. */
  list(): Array<{
    filePath: string;
    importedAt: string;     // ISO timestamp
    txnCount: number;
    sourceAccount: string;
    ignored: boolean;
  }>;
  /** Set the `ignored` flag on the row(s) matching the given relative
   *  file path. Returns { updated: true } when at least one row matched. */
  setIgnored(filePath: string, ignored: boolean): { updated: boolean };
  /** Record one statement import. Idempotent on the `file_hash` UNIQUE
   *  constraint: if a row with this hash already exists, no new row is
   *  created and `{ alreadyImported: true }` is returned with the existing
   *  id. Otherwise inserts and returns the new id. The caller uses
   *  `alreadyImported` to skip re-inserting that file's transactions. */
  record(args: {
    sourceAccount: string;
    fileHash: string;
    filePath: string;
    txnCount: number;
  }): { importId: number; alreadyImported: boolean };
}

/** The assistant-authored /custom page definition, stored as two rows in the
 *  `app_settings` KV table (`customPage.def` current, `customPage.prev` the
 *  one-step undo). A purpose-scoped repo rather than the generic
 *  AppSettingsRepo so the tool surface can write EXACTLY this document and
 *  nothing else in that table — the write target is narrowed by construction,
 *  with no key or path argument anywhere in the tool schema.
 *
 *  "Blank page" is the absence of `customPage.def`, not an empty document.
 *  Callers run write/reset/revert inside `ctx.tx()` so the current→prev
 *  snapshot and the new value land atomically (a user Stop mid-turn can never
 *  leave a torn definition). */
export interface CustomPageRepo {
  /** Current definition, or null when the page is blank. */
  read(): { definitionJson: string; updatedAt: string } | null;
  /** The undo snapshot, or null when there is nothing to revert to. */
  readPrev(): { definitionJson: string } | null;
  /** prev ← current, def ← the new document. */
  write(definitionJson: string): { updatedAt: string };
  /** prev ← current, then DELETE def (back to blank). */
  reset(): { hadDefinition: boolean };
  /** Swap def ↔ prev, so pressing undo twice toggles between the last two
   *  versions. `reverted: false` when no snapshot exists. */
  revert(): { reverted: boolean; updatedAt: string | null };
}

/** Context passed to every tool handler. Source identifies the caller. */
export interface ToolCtx {
  audit: AuditLogRepo;
  workspaces: WorkspaceRepo;
  expenses: ExpenseRepo;
  incomes: IncomeRepo;
  tax: TaxRepo;
  savings: SavingsRepo;
  retirement: RetirementRepo;
  sensitivity: SensitivityRepo;
  categories: CategoriesRepo;
  transactions: TransactionRepo;
  statementImports: StatementImportsRepo;
  customPage: CustomPageRepo;
  web: WebRepo;
  source: ToolSource;
  /** Run `fn` inside a single DB transaction (BEGIN/COMMIT, ROLLBACK on
   *  throw). Used by multi-write tools (e.g. catalogue_expenses commit) to
   *  make statement_imports + transactions + expenses atomic. The callback
   *  must be synchronous — do all async parsing before calling. Mock
   *  implementations may run `fn` directly with no real transaction. */
  tx<T>(fn: () => T): T;
}

export interface ToolDef<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  /**
   * Set true for read-only tools (list_*, compute_*, get_*). The registry
   * SKIPS audit-log writes for read-only tools — auditing every query
   * pollutes the log with no compliance value AND embeds the full result
   * (e.g. all savings balances) into a long-lived table, which is a
   * privacy regression for a local-first finance app.
   *
   * Mutations (add_*, update_*, delete_*, set_*) leave this false so every
   * write produces a tools_call_log row.
   */
  readOnly?: boolean;
  handler: (args: TInput, ctx: ToolCtx) => Promise<TOutput> | TOutput;
}

// ---------------------------------------------------------------------------
// Lightweight runtime arg validation — checks "required" keys and primitive
// types so the LLM / MCP can't crash a handler with malformed input. Not a
// full JSON Schema validator; that would be overkill for our 20-tool registry.
// ---------------------------------------------------------------------------

export class ToolArgError extends Error {
  constructor(message: string, readonly path: string[] = []) {
    super(message);
    this.name = "ToolArgError";
  }
}

// Compiled `pattern` regexes, keyed by source. Patterns come ONLY from the
// ToolDefs in this repo (never from caller input), so there is no ReDoS
// surface here — keep it that way by writing anchored, backtracking-free
// patterns when adding new ones.
const RE_CACHE = new Map<string, RegExp>();

export function validateArgs(schema: JsonSchema, value: unknown, path: string[] = []): void {
  // Explicit-null gate, ahead of the type dispatch: a `nullable` field accepts
  // JSON null as a real value (update_* tools use it to CLEAR a column).
  if (value === null && (schema as { nullable?: boolean }).nullable === true) return;
  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ToolArgError(`expected object at ${path.join(".") || "<root>"}`, path);
    }
    const v = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (!(req in v) || v[req] === undefined) {
        throw new ToolArgError(`missing required field "${req}"`, [...path, req]);
      }
    }
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (v[k] !== undefined) validateArgs(sub, v[k], [...path, k]);
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(v)) {
        if (!(k in schema.properties)) {
          throw new ToolArgError(`unknown field "${k}"`, [...path, k]);
        }
      }
    }
  } else if (schema.type === "string") {
    if (typeof value !== "string") {
      throw new ToolArgError(
        `expected string at ${path.join(".") || "<root>"}`,
        path,
      );
    }
    if (schema.enum && !schema.enum.includes(value)) {
      throw new ToolArgError(
        `value "${value}" not in enum [${schema.enum.join(", ")}] at ${path.join(".")}`,
        path,
      );
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      throw new ToolArgError(
        `string length ${value.length} < minLength ${schema.minLength} at ${path.join(".")}`,
        path,
      );
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      throw new ToolArgError(
        `string length ${value.length} > maxLength ${schema.maxLength} at ${path.join(".")}`,
        path,
      );
    }
    if (schema.pattern !== undefined) {
      let re = RE_CACHE.get(schema.pattern);
      if (!re) { re = new RegExp(schema.pattern); RE_CACHE.set(schema.pattern, re); }
      if (!re.test(value)) {
        throw new ToolArgError(
          `string "${value}" does not match pattern ${schema.pattern} at ${path.join(".")}`,
          path,
        );
      }
    }
  } else if (schema.type === "integer" || schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new ToolArgError(`expected number at ${path.join(".")}`, path);
    }
    if (schema.type === "integer" && !Number.isInteger(value)) {
      throw new ToolArgError(`expected integer at ${path.join(".")}`, path);
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      throw new ToolArgError(
        `value ${value} < minimum ${schema.minimum} at ${path.join(".")}`,
        path,
      );
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      throw new ToolArgError(
        `value ${value} > maximum ${schema.maximum} at ${path.join(".")}`,
        path,
      );
    }
  } else if (schema.type === "boolean") {
    if (typeof value !== "boolean") {
      throw new ToolArgError(`expected boolean at ${path.join(".")}`, path);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) {
      throw new ToolArgError(`expected array at ${path.join(".")}`, path);
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      throw new ToolArgError(
        `array length ${value.length} < ${schema.minItems} at ${path.join(".")}`,
        path,
      );
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      throw new ToolArgError(
        `array length ${value.length} > maxItems ${schema.maxItems} at ${path.join(".")}`,
        path,
      );
    }
    for (let i = 0; i < value.length; i++) {
      validateArgs(schema.items, value[i], [...path, String(i)]);
    }
  } else if (schema.type === "null") {
    if (value !== null) {
      throw new ToolArgError(`expected null at ${path.join(".")}`, path);
    }
  }
}

// ---------------------------------------------------------------------------
// Registry runner — looks up a tool by name, validates args, calls the
// handler, appends to the audit log.
// ---------------------------------------------------------------------------

// Audit redaction (CWE-200). The tools_call_log is a long-lived table in a
// local-first finance app; persisting raw args/results would bank merchant
// names, amounts, balances, and incomes there indefinitely. We store only
// structural metadata: which fields were present, array lengths (counts),
// and a small allowlist of non-sensitive scalars (workspace/id/flags/counts).
// String and amount values are reduced to a type tag, never their content.
const AUDIT_SCALAR_ALLOW = new Set([
  "workspaceId", "id", "srcId", "commit", "overwrite", "months", "ignored",
  "dryRun", "updated", "deleted", "saved", "committed", "changed", "examined",
  "skipped", "importedFiles", "importedTxns", "alreadyImported", "parsedFiles",
]);

function auditSummary(v: unknown): unknown {
  if (v === null) return null;
  if (Array.isArray(v)) return { _count: v.length };
  if (typeof v !== "object") return `[${typeof v}]`;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (Array.isArray(val)) out[k] = { _count: val.length };
    else if (
      AUDIT_SCALAR_ALLOW.has(k) &&
      (typeof val === "number" || typeof val === "boolean")
    ) {
      out[k] = val;
    } else if (val !== null && typeof val === "object") {
      out[k] = "[obj]";
    } else {
      // Record presence + type only — never the raw value (drops merchant
      // labels, amounts, balances, names, notes).
      out[k] = val === null ? null : `[${typeof val}]`;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mutation gate (audit findings MCP-1 / API-3 / API-4, one root cause: the
// confirm-before-mutation policy used to live only in chat.ts's
// model-proposal flow, leaving POST /api/tools and the MCP server able to
// run every mutating tool with zero gating). The policy now lives HERE, at
// the registry boundary, so every transport inherits it:
//   - chat.ts collects user approval via its Approve/Reject UX and passes
//     `mutationConsent: true` only for client-approved actions;
//   - routes/tools.ts maps a `"confirm": true` body field to consent and
//     surfaces a refusal as HTTP 409 `needs_confirmation`;
//   - the MCP server advertises a `confirm` boolean on every mutating tool's
//     inputSchema, maps it to consent, and surfaces a refusal as a JSON-RPC
//     error.
// Enforcement is opt-in PER REGISTRY INSTANCE via `requireMutationConsent`
// (all three production transports enable it). The default stays off so the
// registry remains a plain library for embedders/tests that bring their own
// confirmation flow — if you build a NEW transport, construct the registry
// with `{ requireMutationConsent: true }`.
// ---------------------------------------------------------------------------

/**
 * Thrown by ToolRegistry.invoke when a consent-gated registry is asked to run
 * a mutating tool (readOnly !== true) without `mutationConsent: true`.
 * Transports map this to their own wire shape (HTTP 409 / JSON-RPC error);
 * `code` is the stable discriminator, `toolName` identifies the refused tool.
 */
export class NeedsConfirmationError extends Error {
  readonly code = "needs_confirmation" as const;
  constructor(readonly toolName: string) {
    super(
      `Tool "${toolName}" modifies data and requires explicit confirmation. ` +
        `Re-invoke it with mutation consent (HTTP: "confirm": true in the request body; ` +
        `MCP: "confirm": true in arguments) after the user has approved this exact action.`,
    );
    this.name = "NeedsConfirmationError";
  }
}

export interface ToolRegistryOptions {
  /**
   * When true, invoke() refuses to run any mutating tool (no `readOnly` flag)
   * unless the caller passes `{ mutationConsent: true }`, throwing
   * NeedsConfirmationError instead. Read-only tools are never gated.
   * Blocked attempts still produce a (redacted) audit row, so refused
   * mutation attempts remain visible in tools_call_log.
   */
  requireMutationConsent?: boolean;
}

export interface InvokeOptions {
  /**
   * Caller-asserted proof that an explicit confirmation was collected for
   * this specific call (user clicked Approve, sent `confirm: true`, etc.).
   * Only meaningful on registries constructed with `requireMutationConsent`.
   */
  mutationConsent?: boolean;
}

export class ToolRegistry {
  constructor(
    private readonly tools: ToolDef[],
    private readonly opts: ToolRegistryOptions = {},
  ) {}

  list(): ToolDef[] {
    return this.tools;
  }

  get(name: string): ToolDef | undefined {
    return this.tools.find((t) => t.name === name);
  }

  /** True when the named tool would require mutation consent on a gated
   *  registry: it exists and is not flagged readOnly. Unknown tools return
   *  true (fail safe) — invoke() will reject the name anyway. */
  isMutating(name: string): boolean {
    const tool = this.get(name);
    return tool ? tool.readOnly !== true : true;
  }

  async invoke(
    name: string,
    args: unknown,
    ctx: ToolCtx,
    invokeOpts?: InvokeOptions,
  ): Promise<unknown> {
    const tool = this.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    // Arg validation runs before the consent gate so malformed input fails
    // fast as ToolArgError (HTTP 400) regardless of confirmation state —
    // consent shouldn't change what counts as a well-formed request.
    validateArgs(tool.inputSchema, args);
    if (tool.readOnly) {
      // Skip audit logging for queries — no compliance value, and embedding
      // full query results in a long-lived table is a privacy regression.
      return tool.handler(args, ctx);
    }
    // Mutation path. Wrap handler in try/finally so failed attempts still
    // generate an audit row — audit completeness requires recording
    // attempted-but-failed mutations as well as successful ones.
    const ts = new Date().toISOString();
    // Redacted: field-presence + counts + safe scalars only (CWE-200).
    const argsJson = JSON.stringify(auditSummary(args));
    // Consent gate: a gated registry refuses unconsented mutations BEFORE the
    // handler runs. The refusal itself is audit-logged (it is an attempted
    // mutation that was blocked — exactly what an audit trail must show).
    if (this.opts.requireMutationConsent && invokeOpts?.mutationConsent !== true) {
      const err = new NeedsConfirmationError(name);
      ctx.audit.append({
        toolName: name,
        argsJson,
        resultJson: JSON.stringify({ ok: false, error: err.code }),
        source: ctx.source,
        ts,
      });
      throw err;
    }
    try {
      const result = await tool.handler(args, ctx);
      ctx.audit.append({
        toolName: name,
        argsJson,
        resultJson: JSON.stringify({ ok: true, ...((auditSummary(result) as object) ?? {}) }),
        source: ctx.source,
        ts,
      });
      return result;
    } catch (err) {
      ctx.audit.append({
        toolName: name,
        argsJson,
        resultJson: JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
        source: ctx.source,
        ts,
      });
      throw err;
    }
  }
}
