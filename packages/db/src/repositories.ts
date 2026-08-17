// SQLite-backed repository implementations of the tool registry contracts.
// One file because each repo is small; if any grows past ~50 lines, split it.

import type {
  AuditLogRepo,
  CustomPageRepo,
  ExpenseRepo,
  IncomeRepo,
  RetirementRepo,
  SavingsRepo,
  SensitivityRepo,
  TaxRepo,
  ToolCallRecord,
  ToolCtx,
  ToolSource,
  WebRepo,
  WorkspaceRepo,
} from "@budgetkit/core";
import { round2 } from "@budgetkit/core";
import type { DatabaseSync } from "./database.js";
import { defaultWebFetcher } from "./web_fetcher.js";

function workspaceRepo(db: DatabaseSync): WorkspaceRepo {
  return {
    list: () =>
      db
        .prepare(
          "SELECT id, name, kind, created_at AS createdAt FROM workspaces ORDER BY id",
        )
        .all() as ReturnType<WorkspaceRepo["list"]>,
    get: (id) =>
      (db
        .prepare(
          "SELECT id, name, kind, created_at AS createdAt FROM workspaces WHERE id = ?",
        )
        .get(id) as ReturnType<WorkspaceRepo["get"]>) ?? null,
    create: ({ name, kind, notes }) => {
      // A workspace with no tax_settings row is unusable: compute_take_home,
      // compute_sensitivity and compute_retirement all read it and throw when
      // it's missing. Seed one in the same transaction as the workspace insert,
      // copying the 'Current' workspace's row when there is one so a new
      // scenario inherits the household's filing status / year / rates, else
      // falling back to the DDL defaults. BEGIN/COMMIT run as prepared
      // statements (node:sqlite's DatabaseSync has no `transaction(fn)`),
      // following clone() below.
      db.prepare("BEGIN").run();
      try {
        const r = db
          .prepare("INSERT INTO workspaces (name, kind, notes) VALUES (?, ?, ?)")
          .run(name, kind, notes ?? null);
        const id = Number(r.lastInsertRowid);

        const copied = db
          .prepare(
            `INSERT INTO tax_settings
               (workspace_id, filing_status, tax_year, ca_sdi_rate,
                ss_wage_base_dollars, fica_ss_rate, fica_medicare_rate,
                retirement_effective_tax_rate)
             SELECT ?, t.filing_status, t.tax_year, t.ca_sdi_rate,
                    t.ss_wage_base_dollars, t.fica_ss_rate, t.fica_medicare_rate,
                    t.retirement_effective_tax_rate
               FROM tax_settings t
               JOIN workspaces w ON w.id = t.workspace_id
              WHERE w.kind = 'current'
              ORDER BY w.id
              LIMIT 1`,
          )
          .run(id);

        if (Number(copied.changes) === 0) {
          // No 'Current' workspace to inherit from — DDL defaults for the rate
          // columns, single filer, this calendar year.
          db.prepare(
            `INSERT INTO tax_settings (workspace_id, filing_status, tax_year)
               VALUES (?, 'single', ?)`,
          ).run(id, new Date().getFullYear());
        }

        db.prepare("COMMIT").run();
        return { id };
      } catch (e) {
        db.prepare("ROLLBACK").run();
        throw e;
      }
    },
    rename: (id, newName) => {
      const r = db
        .prepare("UPDATE workspaces SET name = ? WHERE id = ?")
        .run(newName, id);
      return { updated: Number(r.changes) > 0 };
    },
    clone: (srcId, newName, notes) => {
      // Wrap the whole copy in a transaction so a failure mid-way (e.g. an
      // FK violation on a malformed row) doesn't leave a half-populated
      // scenario sitting around for the user to wonder about. node:sqlite's
      // DatabaseSync has no `transaction(fn)` helper, so we run BEGIN/
      // COMMIT/ROLLBACK as prepared statements following migrate.ts.
      db.prepare("BEGIN").run();
      try {
        const ins = db
          .prepare("INSERT INTO workspaces (name, kind, notes) VALUES (?, 'scenario', ?)")
          .run(newName, notes ?? null);
        const newId = Number(ins.lastInsertRowid);

        // Copy incomes — every column except id and workspace_id and the
        // created_at/updated_at defaults (let SQLite fill those for the clone
        // so the new workspace's rows reflect when the copy happened).
        db.prepare(
          `INSERT INTO incomes
             (workspace_id, label, gross_annual_dollars, tax_status,
              is_federal_income_tax, filing_role)
           SELECT ?, label, gross_annual_dollars, tax_status,
                  is_federal_income_tax, filing_role
             FROM incomes WHERE workspace_id = ?`,
        ).run(newId, srcId);

        // Copy expenses. linked_recurring_id points to a global recurring
        // subscription record, not workspace-scoped, so it's safe to carry
        // through unchanged.
        db.prepare(
          `INSERT INTO expenses
             (workspace_id, label, amount_dollars, frequency, spend_date, category_id,
              source, linked_recurring_id)
           SELECT ?, label, amount_dollars, frequency, spend_date, category_id,
                  source, linked_recurring_id
             FROM expenses WHERE workspace_id = ?`,
        ).run(newId, srcId);

        // Copy savings_items — including the migration-003 pct/employer
        // match columns. Use an explicit column list so future column
        // additions surface as test failures here rather than silently
        // dropping on clone.
        db.prepare(
          `INSERT INTO savings_items
             (workspace_id, label, current_balance_dollars, target_balance_dollars,
              monthly_contribution_dollars, account_type,
              contribution_pct_of_salary, employer_match_kind,
              employer_match_value, tax_treatment, filing_role)
           SELECT ?, label, current_balance_dollars, target_balance_dollars,
                  monthly_contribution_dollars, account_type,
                  contribution_pct_of_salary, employer_match_kind,
                  employer_match_value, tax_treatment, filing_role
             FROM savings_items WHERE workspace_id = ?`,
        ).run(newId, srcId);

        // tax_settings is 1:1 with workspace; copy the source's row.
        db.prepare(
          `INSERT INTO tax_settings
             (workspace_id, filing_status, tax_year, ca_sdi_rate,
              ss_wage_base_dollars, fica_ss_rate, fica_medicare_rate,
              retirement_effective_tax_rate)
           SELECT ?, filing_status, tax_year, ca_sdi_rate,
                  ss_wage_base_dollars, fica_ss_rate, fica_medicare_rate,
                  retirement_effective_tax_rate
             FROM tax_settings WHERE workspace_id = ?`,
        ).run(newId, srcId);

        // retirement_settings is optional — only copy if the source has one.
        db.prepare(
          `INSERT INTO retirement_settings
             (workspace_id, current_age, retirement_age, initial_balance_dollars,
              growth_rate, roth_split_pct)
           SELECT ?, current_age, retirement_age, initial_balance_dollars,
                  growth_rate, roth_split_pct
             FROM retirement_settings WHERE workspace_id = ?`,
        ).run(newId, srcId);

        // sensitivity_settings is optional — only copy if the source has one,
        // so a cloned scenario opens the Planning grid on the same ranges.
        db.prepare(
          `INSERT INTO sensitivity_settings
             (workspace_id, primary_low_dollars, primary_high_dollars,
              spouse_low_dollars, spouse_high_dollars)
           SELECT ?, primary_low_dollars, primary_high_dollars,
                  spouse_low_dollars, spouse_high_dollars
             FROM sensitivity_settings WHERE workspace_id = ?`,
        ).run(newId, srcId);

        db.prepare("COMMIT").run();
        return { id: newId };
      } catch (e) {
        db.prepare("ROLLBACK").run();
        throw e;
      }
    },
    delete: (id) => {
      const r = db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
      return { deleted: Number(r.changes) > 0 };
    },
  };
}

function expenseRepo(db: DatabaseSync): ExpenseRepo {
  return {
    list: (workspaceId) =>
      db
        .prepare(
          `SELECT id, workspace_id AS workspaceId, label, amount_dollars AS amountDollars,
                  frequency, spend_date AS spendDate, category_id AS categoryId, source,
                  created_at AS createdAt, updated_at AS updatedAt
             FROM expenses WHERE workspace_id = ? ORDER BY id`,
        )
        .all(workspaceId) as ReturnType<ExpenseRepo["list"]>,
    add: (args) => {
      const r = db
        .prepare(
          `INSERT INTO expenses (workspace_id, label, amount_dollars, frequency, spend_date, category_id, source)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          args.workspaceId,
          args.label,
          // round2 at the DB write boundary (money.ts contract): every monetary
          // value written to the DB is rounded to the cent. Charges are stored
          // negative, so round2's half-away-from-zero convention applies here.
          round2(args.amountDollars),
          args.frequency,
          args.spendDate ?? null,
          args.categoryId ?? null,
          args.source ?? "manual",
        );
      return { id: Number(r.lastInsertRowid) };
    },
    update: (args) => {
      // Build SET clause dynamically — skip undefined fields.
      const sets: string[] = [];
      const vals: Array<string | number | null> = [];
      if (args.label !== undefined) { sets.push("label = ?"); vals.push(args.label); }
      if (args.amountDollars !== undefined) { sets.push("amount_dollars = ?"); vals.push(round2(args.amountDollars)); }
      if (args.frequency !== undefined) { sets.push("frequency = ?"); vals.push(args.frequency); }
      if (args.spendDate !== undefined) { sets.push("spend_date = ?"); vals.push(args.spendDate); }
      if (args.categoryId !== undefined) { sets.push("category_id = ?"); vals.push(args.categoryId); }
      if (sets.length === 0) return { updated: false };
      sets.push("updated_at = datetime('now')");
      vals.push(args.id);
      const r = db
        .prepare(`UPDATE expenses SET ${sets.join(", ")} WHERE id = ?`)
        .run(...vals);
      return { updated: Number(r.changes) > 0 };
    },
    delete: (id) => {
      const r = db.prepare("DELETE FROM expenses WHERE id = ?").run(id);
      return { deleted: Number(r.changes) > 0 };
    },
  };
}

function incomeRepo(db: DatabaseSync): IncomeRepo {
  return {
    list: (workspaceId) =>
      db
        .prepare(
          `SELECT id, workspace_id AS workspaceId, label,
                  gross_annual_dollars AS grossAnnualDollars,
                  tax_status AS taxStatus,
                  is_federal_income_tax AS isFederalIncomeTax,
                  filing_role AS filingRole
             FROM incomes WHERE workspace_id = ? ORDER BY id`,
        )
        .all(workspaceId)
        .map((row: unknown) => {
          const r = row as Record<string, unknown>;
          return {
            ...r,
            isFederalIncomeTax: Boolean(r.isFederalIncomeTax),
          };
        }) as ReturnType<IncomeRepo["list"]>,
    add: (args) => {
      const r = db
        .prepare(
          `INSERT INTO incomes
             (workspace_id, label, gross_annual_dollars, tax_status, is_federal_income_tax, filing_role)
            VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          args.workspaceId,
          args.label,
          round2(args.grossAnnualDollars),
          args.taxStatus,
          (args.isFederalIncomeTax ?? true) ? 1 : 0,
          args.filingRole ?? "primary",
        );
      return { id: Number(r.lastInsertRowid) };
    },
    update: (args) => {
      // Build SET clause dynamically — skip undefined fields.
      const sets: string[] = [];
      const vals: Array<string | number | null> = [];
      if (args.label !== undefined) { sets.push("label = ?"); vals.push(args.label); }
      if (args.grossAnnualDollars !== undefined) { sets.push("gross_annual_dollars = ?"); vals.push(round2(args.grossAnnualDollars)); }
      if (args.taxStatus !== undefined) { sets.push("tax_status = ?"); vals.push(args.taxStatus); }
      if (args.isFederalIncomeTax !== undefined) { sets.push("is_federal_income_tax = ?"); vals.push(args.isFederalIncomeTax ? 1 : 0); }
      if (args.filingRole !== undefined) { sets.push("filing_role = ?"); vals.push(args.filingRole); }
      if (sets.length === 0) return { updated: false };
      vals.push(args.id);
      const r = db
        .prepare(`UPDATE incomes SET ${sets.join(", ")} WHERE id = ?`)
        .run(...vals);
      return { updated: Number(r.changes) > 0 };
    },
    delete: (id) => {
      const r = db.prepare("DELETE FROM incomes WHERE id = ?").run(id);
      return { deleted: Number(r.changes) > 0 };
    },
  };
}

function taxRepo(db: DatabaseSync): TaxRepo {
  return {
    tables: (year) =>
      (db
        .prepare(
          `SELECT year, jurisdiction, filing,
                  standard_deduction_dollars AS standardDeductionDollars,
                  brackets_json AS bracketsJson
             FROM tax_tables WHERE year = ?`,
        )
        .all(year) as Array<{
        year: number;
        jurisdiction: "federal" | "ca";
        filing: "single" | "mfj";
        standardDeductionDollars: number;
        bracketsJson: string;
      }>).map((r) => ({
        year: r.year,
        jurisdiction: r.jurisdiction,
        filing: r.filing,
        standardDeductionDollars: r.standardDeductionDollars,
        brackets: JSON.parse(r.bracketsJson),
      })),
    upsertTable: (args) => {
      const r = db
        .prepare(
          `INSERT INTO tax_tables
             (year, jurisdiction, filing, standard_deduction_dollars, brackets_json, source_url)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(year, jurisdiction, filing) DO UPDATE SET
              standard_deduction_dollars = excluded.standard_deduction_dollars,
              brackets_json = excluded.brackets_json,
              source_url = excluded.source_url`,
        )
        .run(
          args.year,
          args.jurisdiction,
          args.filing,
          args.standardDeductionDollars,
          JSON.stringify(args.brackets),
          args.sourceUrl ?? null,
        );
      return { saved: Number(r.changes) > 0 };
    },
    settingsForWorkspace: (workspaceId) => {
      const row = db
        .prepare(
          `SELECT filing_status AS filing, tax_year AS taxYear,
                  ca_sdi_rate AS caSdiRate, ss_wage_base_dollars AS ssWageBaseDollars,
                  fica_ss_rate AS ficaSsRate, fica_medicare_rate AS ficaMedicareRate,
                  retirement_effective_tax_rate AS retirementEffectiveTaxRate
             FROM tax_settings WHERE workspace_id = ?`,
        )
        .get(workspaceId) as
        | {
            filing: "single" | "mfj";
            taxYear: number;
            caSdiRate: number;
            ssWageBaseDollars: number;
            ficaSsRate: number;
            ficaMedicareRate: number;
            retirementEffectiveTaxRate: number;
          }
        | undefined;
      if (!row) {
        throw new Error(
          `No tax_settings row for workspace ${workspaceId}. Create one with the update_tax_settings tool or the Setup page.`,
        );
      }
      return row;
    },
    setSettingsForWorkspace: (args) => {
      const exists = db
        .prepare("SELECT 1 AS one FROM tax_settings WHERE workspace_id = ?")
        .get(args.workspaceId) as { one: number } | undefined;

      // Column ⇄ arg pairing, shared by both branches so the two stay in sync.
      const cols: Array<[string, string | number | undefined]> = [
        ["filing_status", args.filing],
        ["tax_year", args.taxYear],
        ["ca_sdi_rate", args.caSdiRate],
        ["ss_wage_base_dollars", args.ssWageBaseDollars],
        ["fica_ss_rate", args.ficaSsRate],
        ["fica_medicare_rate", args.ficaMedicareRate],
        ["retirement_effective_tax_rate", args.retirementEffectiveTaxRate],
      ];
      const supplied = cols.filter(([, v]) => v !== undefined) as Array<
        [string, string | number]
      >;

      if (exists) {
        // Partial update: touch ONLY the supplied columns.
        if (supplied.length === 0) return { saved: false, created: false };
        const sets = supplied.map(([c]) => `${c} = ?`);
        const vals: Array<string | number> = supplied.map(([, v]) => v);
        vals.push(args.workspaceId);
        const r = db
          .prepare(`UPDATE tax_settings SET ${sets.join(", ")} WHERE workspace_id = ?`)
          .run(...vals);
        return { saved: Number(r.changes) > 0, created: false };
      }

      // Insert branch. filing_status and tax_year are NOT NULL with no schema
      // default, so a create must supply both.
      if (args.filing === undefined || args.taxYear === undefined) {
        throw new Error(
          `No tax_settings row exists for workspace ${args.workspaceId}; creating one requires both "filing" and "taxYear".`,
        );
      }
      // Only the supplied columns are listed, so every omitted column takes
      // its schema DEFAULT. (Deliberately NOT an ON CONFLICT upsert: excluded.*
      // would overwrite unspecified columns on the update path.)
      const names = supplied.map(([c]) => c);
      const r = db
        .prepare(
          `INSERT INTO tax_settings (workspace_id, ${names.join(", ")})
           VALUES (${["?", ...names.map(() => "?")].join(", ")})`,
        )
        .run(args.workspaceId, ...supplied.map(([, v]) => v));
      return { saved: Number(r.changes) > 0, created: true };
    },
  };
}

function savingsRepo(db: DatabaseSync): SavingsRepo {
  return {
    list: (workspaceId) =>
      (db
        .prepare(
          `SELECT id, workspace_id AS workspaceId, label,
                  current_balance_dollars AS currentBalanceDollars,
                  target_balance_dollars AS targetBalanceDollars,
                  monthly_contribution_dollars AS monthlyContributionDollars,
                  account_type AS accountType,
                  contribution_pct_of_salary AS contributionPctOfSalary,
                  employer_match_kind AS employerMatchKind,
                  employer_match_value AS employerMatchValue,
                  tax_treatment AS taxTreatment,
                  filing_role AS filingRole
             FROM savings_items WHERE workspace_id = ? ORDER BY id`,
        )
        .all(workspaceId) as Array<Record<string, unknown>>).map((row) => ({
        ...row,
        // SQLite returns NULL for unset REAL columns; normalize once here so
        // callers don't have to defensively coalesce.
        contributionPctOfSalary:
          row.contributionPctOfSalary === null
            ? null
            : Number(row.contributionPctOfSalary),
        employerMatchKind:
          (row.employerMatchKind as string | null) ?? "none",
        employerMatchValue:
          row.employerMatchValue === null
            ? null
            : Number(row.employerMatchValue),
        taxTreatment: (row.taxTreatment as string | null) ?? null,
        // NOT NULL DEFAULT 'primary' in the schema, but coalesce defensively in
        // case an older row predates the column being populated.
        filingRole: (row.filingRole as string | null) ?? "primary",
      })) as ReturnType<SavingsRepo["list"]>,
    add: (args) => {
      const r = db
        .prepare(
          `INSERT INTO savings_items
             (workspace_id, label, current_balance_dollars, target_balance_dollars,
              monthly_contribution_dollars, account_type,
              contribution_pct_of_salary, employer_match_kind, employer_match_value,
              tax_treatment, filing_role)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          args.workspaceId,
          args.label,
          round2(args.currentBalanceDollars ?? 0),
          args.targetBalanceDollars == null ? null : round2(args.targetBalanceDollars),
          round2(args.monthlyContributionDollars ?? 0),
          args.accountType,
          args.contributionPctOfSalary ?? null,
          args.employerMatchKind ?? "none",
          args.employerMatchValue ?? null,
          args.taxTreatment ?? null,
          args.filingRole ?? "primary",
        );
      return { id: Number(r.lastInsertRowid) };
    },
    update: (args) => {
      const sets: string[] = [];
      const vals: Array<string | number | null> = [];
      if (args.label !== undefined) { sets.push("label = ?"); vals.push(args.label); }
      if (args.currentBalanceDollars !== undefined) { sets.push("current_balance_dollars = ?"); vals.push(round2(args.currentBalanceDollars)); }
      if (args.targetBalanceDollars !== undefined) { sets.push("target_balance_dollars = ?"); vals.push(args.targetBalanceDollars == null ? null : round2(args.targetBalanceDollars)); }
      if (args.monthlyContributionDollars !== undefined) { sets.push("monthly_contribution_dollars = ?"); vals.push(round2(args.monthlyContributionDollars)); }
      if (args.accountType !== undefined) { sets.push("account_type = ?"); vals.push(args.accountType); }
      if (args.contributionPctOfSalary !== undefined) { sets.push("contribution_pct_of_salary = ?"); vals.push(args.contributionPctOfSalary); }
      if (args.employerMatchKind !== undefined) { sets.push("employer_match_kind = ?"); vals.push(args.employerMatchKind); }
      if (args.employerMatchValue !== undefined) { sets.push("employer_match_value = ?"); vals.push(args.employerMatchValue); }
      if (args.taxTreatment !== undefined) { sets.push("tax_treatment = ?"); vals.push(args.taxTreatment); }
      if (args.filingRole !== undefined) { sets.push("filing_role = ?"); vals.push(args.filingRole); }
      if (sets.length === 0) return { updated: false };
      sets.push("updated_at = datetime('now')");
      vals.push(args.id);
      const r = db
        .prepare(`UPDATE savings_items SET ${sets.join(", ")} WHERE id = ?`)
        .run(...vals);
      return { updated: Number(r.changes) > 0 };
    },
    delete: (id) => {
      const r = db.prepare("DELETE FROM savings_items WHERE id = ?").run(id);
      return { deleted: Number(r.changes) > 0 };
    },
  };
}

function retirementRepo(db: DatabaseSync): RetirementRepo {
  return {
    get: (workspaceId) =>
      (db
        .prepare(
          `SELECT workspace_id AS workspaceId,
                  current_age AS currentAge,
                  retirement_age AS retirementAge,
                  initial_balance_dollars AS initialBalanceDollars,
                  growth_rate AS growthRate,
                  roth_split_pct AS rothSplitPct
             FROM retirement_settings WHERE workspace_id = ?`,
        )
        .get(workspaceId) as ReturnType<RetirementRepo["get"]>) ?? null,
    set: (args) => {
      if (args.retirementAge <= args.currentAge) {
        throw new Error(
          `retirementAge (${args.retirementAge}) must be > currentAge (${args.currentAge})`,
        );
      }
      if (args.rothSplitPct < 0 || args.rothSplitPct > 1) {
        throw new Error(`rothSplitPct must be in [0,1], got ${args.rothSplitPct}`);
      }
      const r = db
        .prepare(
          `INSERT INTO retirement_settings
             (workspace_id, current_age, retirement_age, initial_balance_dollars,
              growth_rate, roth_split_pct)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(workspace_id) DO UPDATE SET
              current_age = excluded.current_age,
              retirement_age = excluded.retirement_age,
              initial_balance_dollars = excluded.initial_balance_dollars,
              growth_rate = excluded.growth_rate,
              roth_split_pct = excluded.roth_split_pct`,
        )
        .run(
          args.workspaceId,
          args.currentAge,
          args.retirementAge,
          args.initialBalanceDollars,
          args.growthRate,
          args.rothSplitPct,
        );
      return { saved: Number(r.changes) > 0 };
    },
  };
}

function sensitivityRepo(db: DatabaseSync): SensitivityRepo {
  return {
    get: (workspaceId) =>
      (db
        .prepare(
          `SELECT workspace_id AS workspaceId,
                  primary_low_dollars AS primaryLowDollars,
                  primary_high_dollars AS primaryHighDollars,
                  spouse_low_dollars AS spouseLowDollars,
                  spouse_high_dollars AS spouseHighDollars
             FROM sensitivity_settings WHERE workspace_id = ?`,
        )
        .get(workspaceId) as ReturnType<SensitivityRepo["get"]>) ?? null,
    set: (args) => {
      if (args.primaryLowDollars >= args.primaryHighDollars) {
        throw new Error(
          `primaryLowDollars (${args.primaryLowDollars}) must be < primaryHighDollars (${args.primaryHighDollars})`,
        );
      }
      if (args.spouseLowDollars > args.spouseHighDollars) {
        throw new Error(
          `spouseLowDollars (${args.spouseLowDollars}) must be <= spouseHighDollars (${args.spouseHighDollars})`,
        );
      }
      const r = db
        .prepare(
          `INSERT INTO sensitivity_settings
             (workspace_id, primary_low_dollars, primary_high_dollars,
              spouse_low_dollars, spouse_high_dollars)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(workspace_id) DO UPDATE SET
              primary_low_dollars = excluded.primary_low_dollars,
              primary_high_dollars = excluded.primary_high_dollars,
              spouse_low_dollars = excluded.spouse_low_dollars,
              spouse_high_dollars = excluded.spouse_high_dollars`,
        )
        .run(
          args.workspaceId,
          args.primaryLowDollars,
          args.primaryHighDollars,
          args.spouseLowDollars,
          args.spouseHighDollars,
        );
      return { saved: Number(r.changes) > 0 };
    },
  };
}

function auditRepo(db: DatabaseSync): AuditLogRepo {
  return {
    append: (record: ToolCallRecord) => {
      db.prepare(
        `INSERT INTO tools_call_log (ts, tool_name, args_json, result_json, source)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(record.ts, record.toolName, record.argsJson, record.resultJson, record.source);
    },
  };
}

function categoriesRepo(db: DatabaseSync) {
  return {
    listByName() {
      const rows = db.prepare("SELECT id, name FROM categories").all() as Array<{
        id: number;
        name: string;
      }>;
      return new Map(rows.map((r) => [r.name, r.id]));
    },
    listAll() {
      const rows = db
        .prepare("SELECT id, name, color_hex AS colorHex FROM categories ORDER BY id")
        .all() as Array<{ id: number; name: string; colorHex: string }>;
      return rows;
    },
  };
}

/** Escape a user-supplied substring for use inside a LIKE pattern. The LIKE
 *  wildcards (% and _) and the escape character itself are neutralized, so a
 *  merchant search for "50%_off" matches that literal text instead of turning
 *  into a wildcard. Pair with `ESCAPE '\'` in the SQL. */
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** Shared WHERE-clause builder for the transaction query surface (search +
 *  topMerchants + aggregate). Every filter is optional and AND-ed;
 *  `includeCredits` defaults to false, i.e. charges only. Amount bounds
 *  compare against the ABSOLUTE value so callers reason in positive magnitudes
 *  regardless of the stored sign. */
function txnFilterClauses(args: {
  merchant?: string;
  from?: string;
  to?: string;
  categoryId?: number;
  minAmountDollars?: number;
  maxAmountDollars?: number;
  includeCredits?: boolean;
  dayOfWeek?: number;
}): { clauses: string[]; params: Array<string | number> } {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (args.includeCredits !== true) clauses.push("amount_dollars < 0");
  if (args.merchant !== undefined && args.merchant !== "") {
    // merchant_normalized is already lowercase; merchant_raw is not, so lower()
    // it to make the substring match case-insensitive on both forms.
    const pattern = `%${likeEscape(args.merchant.toLowerCase())}%`;
    clauses.push(
      `(merchant_normalized LIKE ? ESCAPE '\\' OR lower(merchant_raw) LIKE ? ESCAPE '\\')`,
    );
    params.push(pattern, pattern);
  }
  if (args.from !== undefined) { clauses.push("posted_date >= ?"); params.push(args.from); }
  if (args.to !== undefined) { clauses.push("posted_date <= ?"); params.push(args.to); }
  if (args.categoryId !== undefined) { clauses.push("category_id = ?"); params.push(args.categoryId); }
  if (args.minAmountDollars !== undefined) {
    clauses.push("abs(amount_dollars) >= ?");
    params.push(args.minAmountDollars);
  }
  if (args.maxAmountDollars !== undefined) {
    clauses.push("abs(amount_dollars) <= ?");
    params.push(args.maxAmountDollars);
  }
  if (args.dayOfWeek !== undefined) {
    // posted_date is a date-only 'YYYY-MM-DD' string, so strftime('%w') is
    // timezone-free and deterministic. 0=Sunday..6=Saturday, SQLite's own
    // numbering — the tool schema documents the same convention.
    clauses.push("CAST(strftime('%w', posted_date) AS INTEGER) = ?");
    params.push(args.dayOfWeek);
  }
  return { clauses, params };
}

/** SQL expression producing the grouping key for each `groupBy` mode. Chosen
 *  from this fixed map and NEVER built from caller input, so the group
 *  expression can't carry injected SQL (the schema enum is the outer gate;
 *  this is the inner one). `week` keys on the Sunday that starts the week, so
 *  the key stays a sortable YYYY-MM-DD date. */
const TXN_GROUP_EXPR = {
  day: "posted_date",
  week: "date(posted_date, '-' || strftime('%w', posted_date) || ' days')",
  month: "substr(posted_date, 1, 7)",
  dayOfWeek: "strftime('%w', posted_date)",
  category: "COALESCE(CAST(category_id AS TEXT), 'uncat')",
  merchant: "merchant_normalized",
} as const;

function transactionRepo(db: DatabaseSync) {
  return {
    monthlySumsByCategory(months: number) {
      // SQLite stores posted_date as YYYY-MM-DD text. substr(...,1,7) yields
      // the YYYY-MM month bucket.
      //
      // SPEND = CHARGES ONLY. Per the amount_dollars sign convention
      // (negative = charge/spend, positive = credit/payment/refund), category
      // spend is the absolute value of CHARGES only. Credits/payments/refunds
      // are NOT spend and must not net against a category's charges — a
      // category full of payment credits (e.g. a card-payment line mis-bucketed
      // into "Transport") was previously netting to a large negative, then
      // clamped to $0, hiding the category's real charges. We now sum only the
      // negative rows: SUM(CASE WHEN amount_dollars < 0 THEN -amount_dollars
      // ELSE 0 END). Income/savings overlays are computed elsewhere and are
      // unaffected.
      // The `months` cutoff is computed in JS to avoid SQLite date math.
      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - months);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      const rows = db
        .prepare(
          `SELECT substr(posted_date, 1, 7) AS monthKey,
                  category_id              AS categoryId,
                  SUM(CASE WHEN amount_dollars < 0
                           THEN -amount_dollars
                           ELSE 0 END)     AS totalDollars
             FROM transactions
            WHERE posted_date >= ?
            GROUP BY monthKey, categoryId
            ORDER BY monthKey`,
        )
        .all(cutoffStr) as Array<{
        monthKey: string;
        categoryId: number | null;
        totalDollars: number;
      }>;
      return rows.map((r) => ({
        monthKey: r.monthKey,
        categoryId: r.categoryId,
        // Charges-only sum is already ≥ 0; round2 at the boundary. No clamp
        // needed now that credits are excluded from the sum.
        totalDollars: round2(r.totalDollars),
      }));
    },
    monthlySumsByMerchant(months: number) {
      // Like monthlySumsByCategory, but grouped by MERCHANT (and the txn's own
      // category_id) instead of category alone. The Trends page uses this to
      // re-categorize each merchant via the budget's merchant→category map
      // (the importer's raw category_id buckets nearly everything into a
      // catch-all), and to collapse repeating merchants into a monthly average.
      // SPEND = CHARGES ONLY (negative amount_dollars), same sign convention.
      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - months);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      const rows = db
        .prepare(
          `SELECT substr(posted_date, 1, 7) AS monthKey,
                  merchant_raw             AS merchantRaw,
                  merchant_normalized      AS merchantNormalized,
                  category_id              AS categoryId,
                  SUM(CASE WHEN amount_dollars < 0
                           THEN -amount_dollars
                           ELSE 0 END)     AS totalDollars
             FROM transactions
            WHERE posted_date >= ?
            GROUP BY monthKey, merchant_raw, merchant_normalized, category_id
           HAVING totalDollars > 0
            ORDER BY monthKey`,
        )
        .all(cutoffStr) as Array<{
        monthKey: string;
        merchantRaw: string;
        merchantNormalized: string;
        categoryId: number | null;
        totalDollars: number;
      }>;
      return rows.map((r) => ({
        monthKey: r.monthKey,
        merchantRaw: r.merchantRaw,
        merchantNormalized: r.merchantNormalized,
        categoryId: r.categoryId,
        totalDollars: round2(r.totalDollars),
      }));
    },
    listChargeRows() {
      return db
        .prepare(
          `SELECT merchant_raw        AS merchantRaw,
                  merchant_normalized AS merchantNormalized,
                  posted_date         AS postedDate,
                  amount_dollars      AS amountDollars
             FROM transactions
            WHERE amount_dollars < 0`,
        )
        .all() as Array<{
        merchantRaw: string;
        merchantNormalized: string;
        postedDate: string;
        amountDollars: number;
      }>;
    },
    listChargeRowsInRange(from?: string, to?: string) {
      // listChargeRows widened with category + account, and bounded by an
      // optional posted_date window (inclusive both ends — posted_date is
      // YYYY-MM-DD text, so lexical comparison is date comparison and the
      // idx_txn_date index applies).
      const clauses = ["amount_dollars < 0"];
      const params: Array<string> = [];
      if (from !== undefined) { clauses.push("posted_date >= ?"); params.push(from); }
      if (to !== undefined) { clauses.push("posted_date <= ?"); params.push(to); }
      return db
        .prepare(
          `SELECT merchant_raw        AS merchantRaw,
                  merchant_normalized AS merchantNormalized,
                  posted_date         AS postedDate,
                  amount_dollars      AS amountDollars,
                  category_id         AS categoryId,
                  account_type        AS accountType
             FROM transactions
            WHERE ${clauses.join(" AND ")}
            ORDER BY posted_date`,
        )
        .all(...params) as Array<{
        merchantRaw: string;
        merchantNormalized: string;
        postedDate: string;
        amountDollars: number;
        categoryId: number | null;
        accountType: string;
      }>;
    },
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
    }) {
      const { clauses, params } = txnFilterClauses(args);
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const countRow = db
        .prepare(`SELECT COUNT(*) AS n FROM transactions ${where}`)
        .get(...params) as { n: number } | undefined;
      const rows = db
        .prepare(
          `SELECT posted_date         AS postedDate,
                  merchant_raw        AS merchantRaw,
                  merchant_normalized AS merchantNormalized,
                  amount_dollars      AS amountDollars,
                  category_id         AS categoryId,
                  account_type        AS accountType
             FROM transactions
            ${where}
            ORDER BY posted_date DESC, id DESC
            LIMIT ? OFFSET ?`,
        )
        .all(...params, args.limit, args.offset) as Array<{
        postedDate: string;
        merchantRaw: string;
        merchantNormalized: string;
        amountDollars: number;
        categoryId: number | null;
        accountType: string;
      }>;
      return {
        // round2 at the boundary (money.ts contract); the sign is preserved so
        // callers can tell a charge from a credit.
        rows: rows.map((r) => ({ ...r, amountDollars: round2(r.amountDollars) })),
        totalMatched: countRow?.n ?? 0,
      };
    },
    topMerchants(args: {
      from?: string;
      to?: string;
      categoryId?: number;
      limit: number;
    }) {
      // Charges only — a merchant's "spend" never nets against refunds here
      // (same convention as monthlySumsByCategory).
      const { clauses, params } = txnFilterClauses({
        from: args.from,
        to: args.to,
        categoryId: args.categoryId,
        includeCredits: false,
      });
      const rows = db
        .prepare(
          `SELECT merchant_normalized AS merchantNormalized,
                  MIN(merchant_raw)   AS merchantRawSample,
                  COUNT(*)            AS txnCount,
                  SUM(-amount_dollars) AS totalDollars,
                  MIN(posted_date)    AS firstSeen,
                  MAX(posted_date)    AS lastSeen
             FROM transactions
            WHERE ${clauses.join(" AND ")}
            GROUP BY merchant_normalized
            ORDER BY totalDollars DESC
            LIMIT ?`,
        )
        .all(...params, args.limit) as Array<{
        merchantNormalized: string;
        merchantRawSample: string;
        txnCount: number;
        totalDollars: number;
        firstSeen: string;
        lastSeen: string;
      }>;
      return rows.map((r) => ({ ...r, totalDollars: round2(r.totalDollars) }));
    },
    aggregate(args: {
      merchant?: string;
      from?: string;
      to?: string;
      categoryId?: number;
      minAmountDollars?: number;
      maxAmountDollars?: number;
      includeCredits?: boolean;
      dayOfWeek?: number;
      groupBy: keyof typeof TXN_GROUP_EXPR;
      metric: "sum" | "count" | "avg";
      limit: number;
    }) {
      const { clauses, params } = txnFilterClauses(args);
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const groupExpr = TXN_GROUP_EXPR[args.groupBy];
      // Sign convention: charges are stored negative, so -amount_dollars is
      // positive spend. With includeCredits the sum becomes NET spend (a
      // refund subtracts), which is the point of that flag.
      //
      // Time buckets read as a series and sort by key; category/merchant
      // buckets read as a ranking and sort by size.
      const orderBy =
        args.groupBy === "category" || args.groupBy === "merchant"
          ? "sumDollars DESC"
          : "key ASC";
      const rows = db
        .prepare(
          `SELECT ${groupExpr}        AS key,
                  COUNT(*)             AS cnt,
                  SUM(-amount_dollars) AS sumDollars,
                  AVG(-amount_dollars) AS avgDollars
             FROM transactions
            ${where}
            GROUP BY key
            ORDER BY ${orderBy}
            LIMIT ?`,
        )
        .all(...params, args.limit) as Array<{
        key: string;
        cnt: number;
        sumDollars: number;
        avgDollars: number;
      }>;
      // COUNT over the grouped subquery: how many buckets the filter produced
      // in total, so the caller can tell a truncated page from a whole answer.
      const totalRow = db
        .prepare(
          `SELECT COUNT(*) AS n
             FROM (SELECT 1 FROM transactions ${where} GROUP BY ${groupExpr})`,
        )
        .get(...params) as { n: number } | undefined;
      return {
        rows: rows.map((r) => ({
          key: String(r.key),
          value:
            args.metric === "count"
              ? r.cnt
              : round2(args.metric === "avg" ? r.avgDollars : r.sumDollars),
          count: r.cnt,
        })),
        totalGroups: totalRow?.n ?? 0,
      };
    },
    totalCount() {
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM transactions")
        .get() as { n: number } | undefined;
      return row?.n ?? 0;
    },
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
    ) {
      // Prepared once, run per row. The caller (catalogue_expenses commit)
      // wraps the whole import in one BEGIN/COMMIT, so this loop is a single
      // atomic unit with the statement_imports row + the expenses inserts.
      const stmt = db.prepare(
        `INSERT INTO transactions
           (import_id, posted_date, merchant_raw, merchant_normalized,
            amount_dollars, category_id, account_type)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      let inserted = 0;
      for (const r of rows) {
        stmt.run(
          importId,
          r.postedDate,
          r.merchantRaw,
          r.merchantNormalized,
          r.amountDollars,
          r.categoryId,
          r.accountType,
        );
        inserted++;
      }
      return { inserted };
    },
  };
}

function statementImportsRepo(db: DatabaseSync) {
  return {
    list() {
      // GROUP BY file_path to collapse re-imports of the same file (older
      // rows still exist but we want the most-recent imported_at + txn_count).
      const rows = db
        .prepare(
          `SELECT file_path     AS filePath,
                  MAX(imported_at) AS importedAt,
                  SUM(txn_count)   AS txnCount,
                  source_account   AS sourceAccount,
                  MAX(ignored)     AS ignored
             FROM statement_imports
            WHERE file_path IS NOT NULL
            GROUP BY file_path
            ORDER BY importedAt DESC`,
        )
        .all() as Array<{
        filePath: string;
        importedAt: string;
        txnCount: number;
        sourceAccount: string;
        ignored: number;
      }>;
      return rows.map((r) => ({
        filePath: r.filePath,
        importedAt: r.importedAt,
        txnCount: r.txnCount,
        sourceAccount: r.sourceAccount,
        ignored: r.ignored !== 0,
      }));
    },
    setIgnored(filePath: string, ignored: boolean) {
      const r = db
        .prepare("UPDATE statement_imports SET ignored = ? WHERE file_path = ?")
        .run(ignored ? 1 : 0, filePath);
      return { updated: Number(r.changes) > 0 };
    },
    record(args: {
      sourceAccount: string;
      fileHash: string;
      filePath: string;
      txnCount: number;
    }) {
      // Idempotent on the file_hash UNIQUE constraint (migration 001). A
      // re-commit of the same file content hits the conflict, inserts no
      // new row, and returns the existing id with alreadyImported:true so
      // the caller skips re-inserting that file's transactions.
      const ins = db
        .prepare(
          `INSERT INTO statement_imports (source_account, file_hash, file_path, txn_count)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(file_hash) DO NOTHING`,
        )
        .run(args.sourceAccount, args.fileHash, args.filePath, args.txnCount);
      if (Number(ins.changes) > 0) {
        return { importId: Number(ins.lastInsertRowid), alreadyImported: false };
      }
      const existing = db
        .prepare("SELECT id FROM statement_imports WHERE file_hash = ?")
        .get(args.fileHash) as { id: number } | undefined;
      return { importId: existing?.id ?? -1, alreadyImported: true };
    },
  };
}

/** Tiny key/value accessor over the `app_settings` table (migration 005).
 *  Standalone (NOT part of ToolCtx) — it's app/infra state, not a workspace
 *  tool surface. Used by the API to persist the last-used llama model id. */
export interface AppSettingsRepo {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export function appSettingsRepo(db: DatabaseSync): AppSettingsRepo {
  return {
    get(key) {
      const row = db
        .prepare("SELECT value FROM app_settings WHERE key = ?")
        .get(key) as { value: string } | undefined;
      return row?.value ?? null;
    },
    set(key, value) {
      // Upsert: keep a single row per key and refresh updated_at.
      db.prepare(
        `INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      ).run(key, value);
    },
  };
}

/** One rendered chat bubble, as the panel draws it. Mirrors ChatPanel's
 *  ChatMessage minus the transient fields (phase, pendingActions, setupCta) —
 *  see migration 012 for why those are deliberately not persisted. */
export interface ChatLogMessage {
  role: "user" | "assistant" | "system";
  text: string;
  tools?: Array<{ name: string; count?: number }>;
  step?: boolean;
  stopped?: boolean;
  compactionNotice?: boolean;
}

/** The stored transcript. `replace` is the only writer: the panel owns the
 *  rendered log and hands us the whole thing after each completed turn, which
 *  keeps the stored copy byte-identical to what the user is looking at instead
 *  of reconstructing it from model-facing messages. */
export interface ChatLogRepo {
  list(): ChatLogMessage[];
  replace(messages: ChatLogMessage[]): void;
  clear(): void;
}

export function chatLogRepo(db: DatabaseSync): ChatLogRepo {
  return {
    list() {
      const rows = db
        .prepare(
          `SELECT role, text, tools_json AS toolsJson, is_step AS isStep, stopped, compaction
             FROM chat_log ORDER BY seq ASC, id ASC`,
        )
        .all() as Array<{
        role: string;
        text: string;
        toolsJson: string | null;
        isStep: number;
        stopped: number;
        compaction: number;
      }>;
      return rows.map((r) => {
        const msg: ChatLogMessage = {
          role: r.role as ChatLogMessage["role"],
          text: r.text,
        };
        if (r.toolsJson) {
          try {
            const parsed = JSON.parse(r.toolsJson) as ChatLogMessage["tools"];
            if (Array.isArray(parsed) && parsed.length > 0) msg.tools = parsed;
          } catch {
            // A malformed chip list must not cost the user their transcript.
          }
        }
        if (r.isStep) msg.step = true;
        if (r.stopped) msg.stopped = true;
        if (r.compaction) msg.compactionNotice = true;
        return msg;
      });
    },
    replace(messages) {
      // Whole-log replace rather than append: the panel folds chips into
      // counted ones ("4x set_custom_page") and merges consecutive steps as a
      // turn proceeds, so earlier rows change after they were first written.
      // Appending would drift from what is on screen.
      db.exec("BEGIN");
      try {
        db.exec("DELETE FROM chat_log");
        const ins = db.prepare(
          `INSERT INTO chat_log (seq, role, text, tools_json, is_step, stopped, compaction)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        messages.forEach((m, i) => {
          ins.run(
            i,
            m.role,
            m.text ?? "",
            m.tools && m.tools.length > 0 ? JSON.stringify(m.tools) : null,
            m.step ? 1 : 0,
            m.stopped ? 1 : 0,
            m.compactionNotice ? 1 : 0,
          );
        });
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    clear() {
      db.exec("DELETE FROM chat_log");
    },
  };
}

/** The two `app_settings` keys holding the /custom page document. `.prev` is
 *  the one-step undo snapshot; the page is blank when `.def` is absent. */
const CUSTOM_PAGE_KEY = "customPage.def";
const CUSTOM_PAGE_PREV_KEY = "customPage.prev";

/** CustomPageRepo over `app_settings` — same upsert pattern as
 *  appSettingsRepo, narrowed to these two keys so the tool surface can't
 *  reach the rest of the KV table. The multi-statement methods rely on the
 *  handler's ctx.tx() for atomicity (a half-applied snapshot+write would lose
 *  the user's undo). */
function customPageRepo(db: DatabaseSync): CustomPageRepo {
  const get = (key: string) =>
    db
      .prepare("SELECT value, updated_at AS updatedAt FROM app_settings WHERE key = ?")
      .get(key) as { value: string; updatedAt: string } | undefined;
  const put = (key: string, value: string) => {
    db.prepare(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    ).run(key, value);
  };
  const drop = (key: string) => {
    db.prepare("DELETE FROM app_settings WHERE key = ?").run(key);
  };
  return {
    read() {
      const row = get(CUSTOM_PAGE_KEY);
      return row ? { definitionJson: row.value, updatedAt: row.updatedAt } : null;
    },
    readPrev() {
      const row = get(CUSTOM_PAGE_PREV_KEY);
      return row ? { definitionJson: row.value } : null;
    },
    write(definitionJson) {
      const current = get(CUSTOM_PAGE_KEY);
      // Blank is the ABSENCE of a key, so a first write leaves no snapshot to
      // undo to: `hasPrevious` stays false and the page offers "Reset to
      // blank" instead of "Undo last change".
      if (current) put(CUSTOM_PAGE_PREV_KEY, current.value);
      else drop(CUSTOM_PAGE_PREV_KEY);
      put(CUSTOM_PAGE_KEY, definitionJson);
      return { updatedAt: get(CUSTOM_PAGE_KEY)!.updatedAt };
    },
    reset() {
      const current = get(CUSTOM_PAGE_KEY);
      if (!current) return { hadDefinition: false };
      put(CUSTOM_PAGE_PREV_KEY, current.value);
      drop(CUSTOM_PAGE_KEY);
      return { hadDefinition: true };
    },
    revert() {
      const prev = get(CUSTOM_PAGE_PREV_KEY);
      if (!prev) return { reverted: false, updatedAt: null };
      const current = get(CUSTOM_PAGE_KEY);
      // Swap, not restore: between two real definitions, pressing undo twice
      // toggles back and forth instead of dead-ending.
      //
      // Reverting a RESET is the one asymmetric case. The page is blank, so
      // there is no current value to snapshot, and blank is represented as the
      // key being ABSENT — indistinguishable from "no snapshot exists". The
      // definition comes back but `hasPrevious` goes false, so Undo disables
      // until the next write. Re-blanking is still one click away via Reset.
      if (current) put(CUSTOM_PAGE_PREV_KEY, current.value);
      else drop(CUSTOM_PAGE_PREV_KEY);
      put(CUSTOM_PAGE_KEY, prev.value);
      return { reverted: true, updatedAt: get(CUSTOM_PAGE_KEY)!.updatedAt };
    },
  };
}

/** Build a ToolCtx backed by the given DB handle and source label. */
export function buildToolCtx(
  db: DatabaseSync,
  source: ToolSource,
  opts: { web?: WebRepo } = {},
): ToolCtx {
  return {
    audit: auditRepo(db),
    workspaces: workspaceRepo(db),
    expenses: expenseRepo(db),
    incomes: incomeRepo(db),
    tax: taxRepo(db),
    savings: savingsRepo(db),
    retirement: retirementRepo(db),
    sensitivity: sensitivityRepo(db),
    categories: categoriesRepo(db),
    transactions: transactionRepo(db),
    statementImports: statementImportsRepo(db),
    customPage: customPageRepo(db),
    web: opts.web ?? defaultWebFetcher(),
    source,
    tx<T>(fn: () => T): T {
      // node:sqlite has no transaction(fn) helper, so drive BEGIN/COMMIT as
      // prepared statements (same pattern as workspaceRepo.clone + migrate).
      db.prepare("BEGIN").run();
      try {
        const result = fn();
        db.prepare("COMMIT").run();
        return result;
      } catch (e) {
        db.prepare("ROLLBACK").run();
        throw e;
      }
    },
  };
}
