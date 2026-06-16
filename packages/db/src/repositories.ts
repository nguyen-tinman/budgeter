// SQLite-backed repository implementations of the tool registry contracts.
// One file because each repo is small; if any grows past ~50 lines, split it.

import type {
  AuditLogRepo,
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
      const r = db
        .prepare("INSERT INTO workspaces (name, kind, notes) VALUES (?, ?, ?)")
        .run(name, kind, notes ?? null);
      return { id: Number(r.lastInsertRowid) };
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
          args.isFederalIncomeTax ?? true ? 1 : 0,
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
          `No tax_settings row for workspace ${workspaceId}. Initialize via /api/workspaces.`,
        );
      }
      return row;
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
