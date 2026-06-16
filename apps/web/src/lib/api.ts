// Single API client. Every fetch in the UI routes through here so the
// transport layer is testable, instrumentable, and easy to mock.

// Re-export the canonical types from @budgetkit/core so the UI has a single
// source of truth. Previously these were duplicated as local string-literal
// unions; that left the web bundle to drift if the core enum grew. Import +
// export so both this module and downstream consumers can use the names.
import type { SavingsAccountType, EmployerMatchKind, TaxTreatment } from "@budgetkit/core";
export type { SavingsAccountType, EmployerMatchKind, TaxTreatment };
// Import the math helper from the subpath export (not the barrel) to avoid
// pulling statement_parser.ts → node:fs.readFileSync into the browser bundle.
// The barrel (@budgetkit/core) re-exports everything including server-only
// Node modules; the retirement_projector subpath is browser-safe.
export { effectiveMonthlyContributionDollars } from "@budgetkit/core/retirement_projector";
// account_tax is browser-safe (pure classification math); used by the savings
// UI to show/override how each account's contributions flow through pay.
export { accountTaxTreatment, resolveTreatment, TAX_TREATMENTS } from "@budgetkit/core/account_tax";

export type ToolName =
  | "list_workspaces"
  | "create_scenario"
  | "rename_workspace"
  | "clone_workspace"
  | "delete_workspace"
  | "list_statements_rich"
  | "compute_expense_trends"
  | "ignore_statement"
  | "list_expenses"
  | "add_expense"
  | "update_expense"
  | "delete_expense"
  | "list_incomes"
  | "add_income"
  | "update_income"
  | "delete_income"
  | "compute_take_home"
  | "list_savings"
  | "add_savings"
  | "update_savings"
  | "delete_savings"
  | "get_retirement_settings"
  | "set_retirement_settings"
  | "compute_retirement"
  | "compute_sensitivity"
  | "get_sensitivity_settings"
  | "set_sensitivity_settings"
  | "list_statements"
  | "catalogue_expenses"
  | "auto_categorize_expenses"
  | "dedupe_expenses"
  | "list_tax_tables"
  | "fetch_tax_source_by_year"
  | "import_tax_table";

export interface SavingsItem {
  id: number;
  workspaceId: number;
  label: string;
  currentBalanceDollars: number;
  targetBalanceDollars: number | null;
  monthlyContributionDollars: number;
  accountType: SavingsAccountType;
  /** 0..1 fraction of primary taxed gross treated as the employee contribution. */
  contributionPctOfSalary: number | null;
  employerMatchKind: EmployerMatchKind;
  /** Interpretation depends on employerMatchKind. */
  employerMatchValue: number | null;
  /** Per-account tax-treatment override; null → derive from accountType. */
  taxTreatment: TaxTreatment | null;
  /** Which filer owns this account ('primary' default). Spouse-owned rows feed
   *  the spouse leg of take-home and %-of-salary scales with the spouse salary. */
  filingRole: "primary" | "spouse";
}

export interface RetirementSettings {
  workspaceId: number;
  currentAge: number;
  retirementAge: number;
  initialBalanceDollars: number;
  growthRate: number;
  rothSplitPct: number;
}

export interface RetirementProjectionYear {
  age: number;
  yearsElapsed: number;
  traditionalDollars: number;
  rothDollars: number;
  totalDollars: number;
}

export interface RetirementProjection {
  years: RetirementProjectionYear[];
  preTaxAtRetirementDollars: number;
  afterTaxAtRetirementDollars: number;
  annualContributionDollars: number;
}

export interface SensitivityGrid {
  primaryAxisDollars: number[];
  spouseAxisDollars: number[];
  grid: number[][];
}

export interface SensitivitySettings {
  workspaceId: number;
  primaryLowDollars: number;
  primaryHighDollars: number;
  spouseLowDollars: number;
  spouseHighDollars: number;
}

export interface Workspace {
  id: number;
  name: string;
  kind: "current" | "scenario";
  createdAt: string;
}

export interface Expense {
  id: number;
  workspaceId: number;
  label: string;
  amountDollars: number;
  frequency: "weekly" | "biweekly" | "monthly" | "quarterly" | "annually" | "one_time";
  /** For one_time expenses: YYYY-MM-DD the spend occurred; null for recurring/legacy. */
  spendDate: string | null;
  categoryId: number | null;
  source: string;
  /** SQLite datetime('now') timestamp — surfaced so the Budget page's
   *  "added between" date-range filter can compare against the user's
   *  picked from/to dates. */
  createdAt: string;
  updatedAt: string;
}

export interface Income {
  id: number;
  workspaceId: number;
  label: string;
  grossAnnualDollars: number;
  taxStatus: "pretax" | "posttax" | "taxed" | "untaxable";
  isFederalIncomeTax: boolean;
  filingRole: "primary" | "spouse";
}

export interface TakeHome {
  grossCombinedDollars: number;
  federalTaxDollars: number;
  caTaxDollars: number;
  ficaDollars: number;
  caSdiDollars: number;
  preTaxDeductionsDollars: number;
  /** Post-tax payroll withholdings (e.g. Roth 401k) netted out of take-home. */
  postTaxPayrollDollars: number;
  annualTakeHomeDollars: number;
  monthlyTakeHomeDollars: number;
  effectiveTaxRate: number;
  /** Withholding breakdown sourced from savings accounts (annual, employee side):
   *  pre-tax payroll (401k/HSA), post-tax payroll (Roth 401k), and from-cash
   *  (Roth IRA/brokerage/HYSA) which is a USE of take-home, not a reduction. */
  payrollPretaxDollars: number;
  payrollPostTaxDollars: number;
  fromCashContribDollars: number;
}

/** One marginal bracket as returned by list_tax_tables. `upTo` is the upper
 *  income cutoff in dollars; null marks the open-ended top bracket. */
export interface TaxBracketRow {
  upTo: number | null;
  rate: number;
}

/** One (year, jurisdiction, filing) tax-table row actually present in the DB,
 *  as returned by list_tax_tables. This is the HONEST source for the Setup
 *  tax-table dropdowns — they enumerate ONLY these combinations and render
 *  brackets from these rows (no hardcoded copies). */
export interface TaxTable {
  year: number;
  jurisdiction: "federal" | "ca";
  filing: "single" | "mfj";
  standardDeductionDollars: number;
  /** Null today: the read accessor doesn't surface the stored source_url. */
  sourceUrl: string | null;
  brackets: TaxBracketRow[];
}

export interface TaxTablesResult {
  tables: TaxTable[];
  /** Distinct years present, ascending. */
  years: number[];
}

export interface LlamaStatus {
  status: "stopped" | "starting" | "ready" | "error" | "external";
  url: string;
  pid: number | null;
  external: boolean;
  error: string | null;
  backendMode: "vulkan" | "cpu" | "cpu-fallback" | "unknown";
  backendWarning: string | null;
}

/** One selectable local model, with whether its GGUF is present on disk. */
export interface LlamaModelInfo {
  id: string;
  label: string;
  fileName: string;
  blurb: string;
  /** Smaller number = smaller model; larger = "smarter". */
  sizeRank: number;
  present: boolean;
}

/** Response from GET /api/llama/models — the registry + on-disk presence,
 *  the persisted last-used id, and the id that would launch by default. */
export interface LlamaModelsResponse {
  models: LlamaModelInfo[];
  lastUsed: string | null;
  selected: string | null;
}

export interface SetupStep {
  name: string;
  status: "pending" | "running" | "done" | "error";
  percent: number;
  bytesDone: number;
  bytesTotal: number;
  message?: string;
}

export interface SetupStatus {
  overall: "idle" | "running" | "done" | "error";
  step1: SetupStep;
  step2: SetupStep;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export interface StatementFile {
  /** Path relative to project root, forward-slashed (e.g. "statements/chase/jan.pdf"). */
  relativePath: string;
  sizeBytes: number;
  kind: "chase_pdf" | "amex_xlsx" | "unknown";
}

/** Richer per-file shape returned by list_statements_rich, used by the
 *  Library page. Adds parse status, issuer detection, period parse, and
 *  the ignored flag. */
export interface StatementFileRich {
  id: string;
  relativePath: string;
  fileName: string;
  sizeBytes: number;
  issuer: "chase" | "amex_gold" | "amex_plat" | "unknown";
  issuerLabel: string;
  periodStart: string | null;
  periodEnd: string | null;
  periodLabel: string | null;
  status: "parsed" | "unparsed" | "error";
  txnCount: number;
  hasErrors: boolean;
  ignored: boolean;
  parsedAt: string | null;
}

export interface TrendsMonth {
  key: string;
  short: string;
  label: string;
  year: number;
  monthIdx: number;
  ts: number;
}

export interface TrendsCategorySeries {
  name: string;
  color: string;
  /** Per-month budget amount (recurring flat monthly-equivalent + one-time spikes). */
  series: number[];
}

export interface TrendsOverlaySeries {
  name: string;
  color: string;
  kind: "income" | "savings" | "retirement";
  series: number[];
}

/** One of a month's largest one-time budget expenses. Drives the Trends tooltip. */
export interface TrendsOneTimeItem {
  label: string;
  amount: number;
  category: string;
  color: string;
}

export interface TrendsResult {
  x: TrendsMonth[];
  categories: Record<string, TrendsCategorySeries>;
  overlays: {
    takeHome: TrendsOverlaySeries;
    savings: TrendsOverlaySeries;
    retirement: TrendsOverlaySeries;
  };
  /** Parallel to `x`: up-to-5 largest one-time expenses dated in each month. */
  topOneTime: TrendsOneTimeItem[][];
  /** Count of one_time expenses that have no spendDate and were therefore
   *  excluded from the monthly series. Always returned by core (0 when none). */
  undatedOneTimeCount: number;
  /** Labels of the undated one-time rows (most recent first, capped at 10) —
   *  lets the footnote name which rows need a spend month set in Budget. */
  undatedOneTimeLabels: string[];
}

/** One candidate row from the Expense Cataloguer. Mirrors ExpenseCandidate in
 *  packages/core/src/expense_cataloguer.ts; the wire format is duck-typed so
 *  the UI doesn't pull the full core type. */
export interface CatalogueCandidate {
  /** Stable per-candidate identity emitted by catalogue_expenses. Use this for
   *  selection sets, {#each} keys, and bulk actions — NOT candidateKey(), which
   *  is now only kept for backward-compat. */
  candidateId: string;
  label: string;
  amountDollars: number;
  frequency: "weekly" | "biweekly" | "monthly" | "quarterly" | "annually" | "one_time";
  category: string;
  sourceAccount: string;
  occurrences: number;
  seedReason: "repeated" | "high_value" | "both";
  lastSeen: string;
  cadenceConfidence?: number;
  feeKind?: "amex_gold_range" | "amex_plat_range" | "other_high_value";
}

export interface CatalogueResult {
  summary: {
    totalTxns: number;
    uniqueMerchants: number;
    seedCount: number;
    recurringCount: number;
    annualFeeCount: number;
    aliasCount: number;
    categorizedRate: number;
  };
  candidates: CatalogueCandidate[];
  aliasCandidates: Array<{
    normalizedPrefix: string;
    variants: Array<{ merchant: string; count: number }>;
  }>;
  parsedFiles: number;
  parseErrors: Array<{ path: string; error: string }>;
  committedIds?: number[];
  /** Accepted candidates NOT written because an identical budget item
   *  (label/amount/frequency/spend date) already exists. */
  skippedDuplicates?: Array<{
    label: string;
    amountDollars: number;
    frequency: string;
    spendDate: string | null;
  }>;
}

export interface DedupeResult {
  dryRun: boolean;
  groupCount: number;
  duplicateCount: number;
  removed: number;
  groups: Array<{
    label: string;
    amountDollars: number;
    frequency: string;
    spendDate: string | null;
    keepId: number;
    removeIds: number[];
  }>;
}

export interface AutoCategorizeResult {
  examined: number;
  changed: number;
  skipped: number;
  changes: Array<{
    id: number;
    label: string;
    categoryName: string;
  }>;
}

/** Build the same candidate key the catalogue_expenses server tool uses. The
 *  UI uses this to translate per-row checkbox state into the acceptedKeys
 *  filter on commit. Must stay in sync with packages/core/src/tools.ts.
 *
 *  NOTE (H5): no longer used for in-UI identity — see `candidateId`. Kept
 *  exported for backward-compat with the commit `acceptedKeys` wire format. */
export function candidateKey(c: CatalogueCandidate): string {
  return `${c.label}|${c.sourceAccount}|${c.amountDollars}|${c.frequency}`;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function invoke<T = unknown>(toolName: ToolName, args: unknown = {}): Promise<T> {
  // The registry's confirm-before-mutation gate requires explicit consent for
  // mutating tools (409 needs_confirmation otherwise). In this first-party UI
  // the user's click IS the consent — every mutation is triggered by a direct
  // interaction with a labeled control — so the client asserts it on every
  // call. The route strips `confirm` before schema validation, and read-only
  // tools ignore it. (Third-party callers of /api/tools still must opt in
  // explicitly; this does not weaken the MCP or chat paths.)
  const res = await fetch(`/api/tools/${toolName}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: true, ...(args as Record<string, unknown>) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || (body as { ok?: boolean }).ok === false) {
    throw new ApiError(
      (body as { message?: string }).message ?? `HTTP ${res.status}`,
      res.status,
      body,
    );
  }
  return (body as { result: T }).result;
}

/**
 * Drain a `text/event-stream` Response, invoking `dispatch(eventName, data)`
 * once per complete SSE event. Shared by the chat stream and the classify
 * stream so the byte-buffering/framing logic lives in one place. Events are
 * delimited by a blank line; an event may carry multiple `data:` lines which
 * are concatenated. Resolves when the stream closes; the caller's AbortSignal
 * (passed to the originating fetch) is what cancels the underlying read.
 */
async function consumeSse(
  res: Response,
  dispatch: (event: string, data: string) => void,
): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const rawEvent = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let evName = "message";
      const dataLines: string[] = [];
      for (const line of rawEvent.split("\n")) {
        if (line.startsWith("event:")) evName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      if (dataLines.length > 0) dispatch(evName, dataLines.join("\n"));
    }
  }
}

export const api = {
  async health(): Promise<{ ok: boolean; schemaVersion: number }> {
    const r = await fetch("/api/health");
    if (!r.ok) throw new ApiError("health failed", r.status, null);
    return r.json();
  },

  listWorkspaces: () => invoke<Workspace[]>("list_workspaces"),
  createScenario: (name: string, notes?: string) =>
    invoke<{ id: number }>("create_scenario", { name, notes }),
  renameWorkspace: (id: number, name: string) =>
    invoke<{ updated: boolean }>("rename_workspace", { id, name }),
  cloneWorkspace: (id: number, name: string, notes?: string) =>
    invoke<{ id: number }>("clone_workspace", { id, name, notes }),
  deleteWorkspace: (id: number) => invoke<{ deleted: boolean }>("delete_workspace", { id }),

  listExpenses: (workspaceId: number) => invoke<Expense[]>("list_expenses", { workspaceId }),
  addExpense: (input: {
    workspaceId: number;
    label: string;
    amountDollars: number;
    frequency: Expense["frequency"];
    categoryId?: number | null;
    /** ISO date YYYY-MM-DD for one_time expenses. Stored as given; Trends
     *  buckets by month (slices to YYYY-MM), so the day is preserved but only
     *  the month affects chart placement. */
    spendDate?: string | null;
  }) => invoke<{ id: number }>("add_expense", input),
  updateExpense: (input: {
    id: number;
    label?: string;
    amountDollars?: number;
    frequency?: Expense["frequency"];
    categoryId?: number | null;
    /** ISO date YYYY-MM-DD for one_time expenses; null clears the date. */
    spendDate?: string | null;
  }) => invoke<{ updated: boolean }>("update_expense", input),
  deleteExpense: (id: number) => invoke<{ deleted: boolean }>("delete_expense", { id }),

  listIncomes: (workspaceId: number) => invoke<Income[]>("list_incomes", { workspaceId }),
  addIncome: (input: {
    workspaceId: number;
    label: string;
    grossAnnualDollars: number;
    taxStatus: Income["taxStatus"];
    isFederalIncomeTax?: boolean;
    filingRole?: Income["filingRole"];
  }) => invoke<{ id: number }>("add_income", input),
  updateIncome: (input: { id: number; label?: string; grossAnnualDollars?: number; taxStatus?: Income["taxStatus"]; isFederalIncomeTax?: boolean; filingRole?: "primary" | "spouse" }) =>
    invoke<{ updated: boolean }>("update_income", input),
  deleteIncome: (id: number) => invoke<{ deleted: boolean }>("delete_income", { id }),

  computeTakeHome: (workspaceId: number, args?: { pretax401kDollars?: number; pretaxHealthDollars?: number }) =>
    invoke<TakeHome>("compute_take_home", { workspaceId, ...args }),

  listSavings: (workspaceId: number) => invoke<SavingsItem[]>("list_savings", { workspaceId }),
  addSavings: (input: {
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
  }) => invoke<{ id: number }>("add_savings", input),
  updateSavings: (input: {
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
  }) => invoke<{ updated: boolean }>("update_savings", input),
  deleteSavings: (id: number) => invoke<{ deleted: boolean }>("delete_savings", { id }),

  getRetirementSettings: (workspaceId: number) =>
    invoke<RetirementSettings | null>("get_retirement_settings", { workspaceId }),
  setRetirementSettings: (input: {
    workspaceId: number;
    currentAge: number;
    retirementAge: number;
    initialBalanceDollars: number;
    growthRate: number;
    rothSplitPct: number;
  }) => invoke<{ saved: boolean }>("set_retirement_settings", input),
  computeRetirement: (workspaceId: number, annualContributionDollarsOverride?: number) =>
    invoke<RetirementProjection>(
      "compute_retirement",
      annualContributionDollarsOverride === undefined
        ? { workspaceId }
        : { workspaceId, annualContributionDollarsOverride },
    ),
  computeSensitivity: (input: {
    workspaceId: number;
    primaryRangeDollars: [number, number];
    spouseRangeDollars: [number, number];
    gridSize?: number;
  }) => invoke<SensitivityGrid>("compute_sensitivity", input),
  getSensitivitySettings: (workspaceId: number) =>
    invoke<SensitivitySettings | null>("get_sensitivity_settings", { workspaceId }),
  setSensitivitySettings: (input: {
    workspaceId: number;
    primaryLowDollars: number;
    primaryHighDollars: number;
    spouseLowDollars: number;
    spouseHighDollars: number;
  }) => invoke<{ saved: boolean }>("set_sensitivity_settings", input),

  listStatements: () =>
    invoke<{ files: StatementFile[] }>("list_statements"),
  listStatementsRich: () =>
    invoke<{ files: StatementFileRich[] }>("list_statements_rich"),
  computeExpenseTrends: (input: { workspaceId: number; months?: number }) =>
    invoke<TrendsResult>("compute_expense_trends", input),
  ignoreStatement: (relativePath: string, ignored: boolean) =>
    invoke<{ updated: boolean }>("ignore_statement", { relativePath, ignored }),
  catalogueExpenses: (input: {
    statementPaths: string[];
    workspaceId?: number;
    commit?: boolean;
    acceptedKeys?: string[];
  }) => invoke<CatalogueResult>("catalogue_expenses", input),
  autoCategorizeExpenses: (input: { workspaceId: number; overwrite?: boolean }) =>
    invoke<AutoCategorizeResult>("auto_categorize_expenses", input),
  /** Find (dryRun) or remove identical budget items, keeping the oldest of
   *  each duplicate group. */
  dedupeExpenses: (input: { workspaceId: number; dryRun?: boolean }) =>
    invoke<DedupeResult>("dedupe_expenses", input),

  /** List the tax brackets actually present in the DB. Drives the Setup
   *  tax-table dropdowns (year / jurisdiction / filing) and the bracket
   *  table — there is no hardcoded bracket copy in the UI. */
  listTaxTables: () => invoke<TaxTablesResult>("list_tax_tables"),

  llama: {
    status: () => fetch("/api/llama/status").then((r) => r.json() as Promise<LlamaStatus>),
    /** Registry + on-disk presence + selected/last-used model ids. */
    models: () =>
      fetch("/api/llama/models").then((r) => r.json() as Promise<LlamaModelsResponse>),
    start: (profile?: object) =>
      fetch("/api/llama/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(profile ?? {}),
      }).then((r) => r.json()),
    stop: () => fetch("/api/llama/stop", { method: "POST" }).then((r) => r.json()),
    restart: () => fetch("/api/llama/restart", { method: "POST" }).then((r) => r.json()),
    /** Pick which model inference runs on; persists it + restarts onto it. */
    select: (model: string) =>
      fetch("/api/llama/select", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model }),
      }).then((r) => r.json()),
    update: (opts?: { dryRun?: boolean }) =>
      fetch("/api/llama/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(opts ?? {}),
      }).then((r) => r.json()),
    /** Kick off the download pipeline. `model` is a registry id (e.g.
     *  "qwen3.5-4b"); the server resolves it to a trusted URL. */
    setupStart: (opts?: { model?: string }) =>
      fetch("/api/llama/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(opts ?? {}),
      }).then((r) => r.json()),
    setupStatus: () =>
      fetch("/api/llama/setup/status").then(
        (r) => r.json() as Promise<SetupStatus>,
      ),
    /** Reset a finished/wedged setup pipeline back to idle so it can be
     *  retried. Refused with 409 while a run is genuinely active unless
     *  `force` is set (escape hatch for a stuck "running" state). */
    setupReset: (opts?: { force?: boolean }) =>
      fetch("/api/llama/setup/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(opts ?? {}),
      }).then((r) => r.json()),
  },

  chat: {
    status: () => fetch("/api/chat/status").then((r) => r.json()),
    /**
     * Send a message and (optionally) prior conversation context.
     *
     * `opts.history` should be the filtered user+assistant turns in order;
     * the server prepends the system prompt + workspace summary itself.
     * `opts.priorSummary` is the dense paragraph the server returned in a
     * previous response's `compaction.summary` field — passing it back
     * lets the model continue the conversation after older turns were
     * folded into the summary. The client persists priorSummary across
     * turns; if a new compaction fires, the response will contain a fresh
     * `compaction.summary` that supersedes it.
     *
     * Backwards-compatible: an undefined second arg means "no workspace,
     * no history, no summary" — same wire-shape as the old single-arg call.
     */
    send: (
      message: string,
      opts: {
        workspaceId?: number;
        history?: Array<{ role: "user" | "assistant"; text: string }>;
        priorSummary?: string;
        /** Feature A: actions the user approved on a follow-up turn. The
         *  server executes ONLY these (re-validated as mutating tools), feeds
         *  their results to the model, and continues. */
        approvedActions?: Array<{ id?: string; toolName: string; args?: unknown }>;
      } = {},
      /** Optional caller-owned signal. When the caller aborts it (Stop button),
       *  the fetch is cancelled and this promise rejects with an AbortError —
       *  which the caller distinguishes from a real network failure. */
      signal?: AbortSignal,
    ): Promise<ChatSendResponse> =>
      fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message,
          workspaceId: opts.workspaceId,
          history: opts.history,
          priorSummary: opts.priorSummary,
          approvedActions: opts.approvedActions,
        }),
        signal,
      }).then((r) => r.json() as Promise<ChatSendResponse>),

    /**
     * Streaming variant of `send` (Feature B). Opens an SSE connection to
     * POST /api/chat/stream and invokes `handlers` as events arrive:
     *   - onDelta(text)         — incremental assistant tokens
     *   - onTool(name)          — a tool call was detected/executed
     *   - onDone(final)         — terminal summary (same shape as send())
     *   - onError(err)          — fatal error event
     * Resolves when the stream closes. Throws (so the caller can fall back to
     * the non-streaming `send`) if the connection itself fails before any
     * event is received.
     */
    sendStream: async (
      message: string,
      opts: {
        workspaceId?: number;
        history?: Array<{ role: "user" | "assistant"; text: string }>;
        priorSummary?: string;
        approvedActions?: Array<{ id?: string; toolName: string; args?: unknown }>;
      },
      handlers: {
        onDelta?: (text: string) => void;
        onTool?: (name: string) => void;
        /** The model is reasoning (chain-of-thought is hidden). `active` is true
         *  when reasoning starts; the next delta/tool/done implicitly ends it. */
        onThinking?: (active: boolean) => void;
        onPending?: (actions: ChatPendingAction[]) => void;
        onDone?: (final: ChatSendResponse) => void;
        onError?: (err: ChatSendResponse) => void;
      },
      /** Optional caller-owned signal. Passing the AbortController's signal lets
       *  a Stop button close the SSE connection: the underlying fetch and the
       *  reader.read() loop both reject with an AbortError, which the caller
       *  treats as a clean user cancel (keeping any partial text already
       *  streamed) rather than a fatal stream error. Aborting also propagates
       *  to the server via the dropped connection, stopping generation. */
      signal?: AbortSignal,
    ): Promise<void> => {
      const res = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({
          message,
          workspaceId: opts.workspaceId,
          history: opts.history,
          priorSummary: opts.priorSummary,
          approvedActions: opts.approvedActions,
        }),
        signal,
      });
      if (!res.ok || !res.body) {
        throw new ApiError(`chat stream failed: ${res.status}`, res.status, null);
      }
      await consumeSse(res, (event, data) => {
        let parsed: unknown = {};
        try {
          parsed = JSON.parse(data);
        } catch {
          return;
        }
        if (event === "delta") handlers.onDelta?.((parsed as { text: string }).text ?? "");
        else if (event === "thinking")
          handlers.onThinking?.((parsed as { active?: boolean }).active ?? true);
        else if (event === "tool") handlers.onTool?.((parsed as { name: string }).name ?? "");
        else if (event === "pending")
          handlers.onPending?.((parsed as { pendingActions: ChatPendingAction[] }).pendingActions ?? []);
        else if (event === "done") handlers.onDone?.(parsed as ChatSendResponse);
        else if (event === "error") handlers.onError?.(parsed as ChatSendResponse);
      });
    },

    /**
     * The `/classify` command. Opens an SSE connection to POST
     * /api/chat/classify, which categorizes every expense in the workspace with
     * the LLM one row at a time and streams each decision. Handlers mirror a
     * subset of `sendStream`:
     *   - onDelta(text)  — a header line, then one "label → category" line per
     *                      expense as it's classified, then a final summary
     *   - onDone(final)  — { ok, examined, changed, total, affectedResources }
     *   - onError(err)   — validation or LLM-unreachable error
     * Throws if the connection itself fails before any event (caller surfaces it).
     */
    classifyStream: async (
      opts: { workspaceId: number },
      handlers: {
        onDelta?: (text: string) => void;
        onDone?: (final: ChatClassifyResponse) => void;
        onError?: (err: ChatClassifyResponse) => void;
      },
      signal?: AbortSignal,
    ): Promise<void> => {
      const res = await fetch("/api/chat/classify", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ workspaceId: opts.workspaceId }),
        signal,
      });
      if (!res.ok || !res.body) {
        throw new ApiError(`chat classify failed: ${res.status}`, res.status, null);
      }
      await consumeSse(res, (event, data) => {
        let parsed: unknown = {};
        try {
          parsed = JSON.parse(data);
        } catch {
          return;
        }
        if (event === "delta") handlers.onDelta?.((parsed as { text: string }).text ?? "");
        else if (event === "done") handlers.onDone?.(parsed as ChatClassifyResponse);
        else if (event === "error") handlers.onError?.(parsed as ChatClassifyResponse);
      });
    },

    /** Commit the recommendations the user accepted in the /classify review
     *  list. Only the passed `changes` are written (one transaction server-side).
     *  Returns how many rows were updated + which resources to invalidate. */
    classifyApply: (body: {
      changes: Array<{ id: number; categoryId: number | null }>;
    }): Promise<{ ok: boolean; updated?: number; affectedResources?: string[]; message?: string }> =>
      fetch("/api/chat/classify/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json()),
    /** Reset any server-side chat state. The server has none today; this
     *  exists so the UI's "New chat" button + /clear slash command have a
     *  single endpoint to call as the API grows. */
    clear: () =>
      fetch("/api/chat/clear", {
        method: "POST",
        headers: { "content-type": "application/json" },
      }).then((r) => r.json()),
  },
};

/** One proposed category change from `/classify`, reviewed before any write. */
export interface ClassifyRecommendation {
  id: number;
  label: string;
  currentCategoryId: number | null;
  currentCategoryName: string | null;
  recommendedCategoryId: number | null;
  recommendedCategoryName: string;
}

/** Terminal `done`/`error` payload from the `/classify` SSE stream. The stream
 *  only RECOMMENDS — nothing is written until classifyApply() commits the rows
 *  the user accepted. */
export interface ChatClassifyResponse {
  ok: boolean;
  /** Rows the model reviewed (== total unless the user hit Stop mid-loop). */
  examined?: number;
  /** Total expenses in the workspace at the start of the run. */
  total?: number;
  /** How many rows the model would change (== recommendations.length). */
  changedCount?: number;
  /** The proposed changes for the user to accept/deny (only changed rows). */
  recommendations?: ClassifyRecommendation[];
  workspaceId?: number;
  /** Present on `error`. */
  error?: string;
  message?: string;
}

/** Compaction notice the server emits when it summarized the older portion
 *  of history during the request. Clients should persist `summary` as
 *  `priorSummary` on future calls so the model retains the folded context. */
export interface ChatCompactionInfo {
  summary: string;
  droppedCount: number;
  keptRecentCount: number;
}

/** One mutating action the assistant proposed that the server PAUSED on,
 *  awaiting the user's explicit Approve/Reject (Feature A). `summary` is a
 *  human-readable description of the effect; `args` are echoed back so the
 *  client can re-submit them in `approvedActions` on approval. */
export interface ChatPendingAction {
  id: string;
  toolName: string;
  summary: string;
  args: unknown;
}

/** Response shape from POST /api/chat. `compaction` is only present when
 *  the server compacted history during this turn. `affectedResources` is
 *  only present when at least one successful tool call mutated server
 *  state — the client should call `invalidateResources(affectedResources)`
 *  so subscribed pages refetch only the changed sections.
 *  `pendingActions` is present when the assistant wants to run a mutating
 *  tool and is awaiting confirmation; `assistantText` is empty in that case. */
export interface ChatSendResponse {
  ok: boolean;
  error?: string;
  message?: string;
  assistantText?: string;
  toolCalls?: Array<{ name: string; args?: unknown; result?: unknown; error?: string }>;
  turnsUsed?: number;
  workspaceId?: number;
  compaction?: ChatCompactionInfo;
  affectedResources?: string[];
  pendingActions?: ChatPendingAction[];
}

// formatDollars and parseDollars moved to `$lib/helpers.ts` to remove a
// duplicate implementation. Import them from there (the helpers.ts version
// supports an `opts` bag for whole-dollar + sign rendering).
