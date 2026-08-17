import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ALL_TOOLS,
  NeedsConfirmationError,
  ToolRegistry,
  ToolArgError,
  validateArgs,
  round2,
  takeHome,
  type ToolCtx,
  type WorkspaceRepo,
  type ExpenseRepo,
  type IncomeRepo,
  type TaxRepo,
  type AuditLogRepo,
  type SavingsRepo,
  type RetirementRepo,
  type SensitivityRepo,
  type SavingsAccountType,
  type ToolCallRecord,
  type WebRepo,
} from "../src/index.js";

// In-memory repository fakes — let the registry's invariants be tested
// independently from SQLite.

type TaxSettingsRow = ReturnType<TaxRepo["settingsForWorkspace"]>;

/** What every workspace's tax settings look like until a test overwrites or
 *  deletes them. Mirrors the values seeded by migration 001. */
const DEFAULT_TAX_SETTINGS: TaxSettingsRow = {
  filing: "single",
  taxYear: 2025,
  caSdiRate: 0.011,
  ssWageBaseDollars: 176100,
  ficaSsRate: 0.062,
  ficaMedicareRate: 0.0145,
  retirementEffectiveTaxRate: 0.12,
};

function mkMemoryCtx(): ToolCtx & {
  audit: AuditLogRepo & { records: ToolCallRecord[] };
  __txnRows: Array<{ monthKey: string; categoryId: number | null; totalDollars: number }>;
  __insertedTxns: Array<{
    importId: number;
    postedDate: string;
    merchantRaw: string;
    merchantNormalized: string;
    amountDollars: number;
    categoryId: number | null;
    accountType: string;
  }>;
  __statementImportRows: Array<{
    importId: number;
    fileHash: string;
    filePath: string;
    importedAt: string;
    txnCount: number;
    sourceAccount: string;
    ignored: boolean;
  }>;
  __deleteTaxSettings: (workspaceId: number) => void;
} {
  let nextWsId = 1;
  let nextExpId = 1;
  let nextIncId = 1;
  const workspaces: Array<{ id: number; name: string; kind: string; createdAt: string }> = [
    { id: nextWsId++, name: "Current", kind: "current", createdAt: "2026-01-01T00:00:00Z" },
  ];
  const expenses: Array<{
    id: number;
    workspaceId: number;
    label: string;
    amountDollars: number;
    frequency: string;
    spendDate: string | null;
    categoryId: number | null;
    source: string;
    createdAt: string;
    updatedAt: string;
  }> = [];
  const incomes: Array<{
    id: number;
    workspaceId: number;
    label: string;
    grossAnnualDollars: number;
    taxStatus: string;
    isFederalIncomeTax: boolean;
    filingRole: string;
  }> = [];
  const records: ToolCallRecord[] = [];

  const workspaceRepo: WorkspaceRepo = {
    list: () => workspaces.slice(),
    get: (id) => workspaces.find((w) => w.id === id) ?? null,
    create: ({ name, kind }) => {
      const ws = { id: nextWsId++, name, kind, createdAt: new Date().toISOString() };
      workspaces.push(ws);
      return { id: ws.id };
    },
    rename: (id, newName) => {
      const ws = workspaces.find((w) => w.id === id);
      if (!ws) return { updated: false };
      if (workspaces.some((w) => w.id !== id && w.name === newName)) {
        throw new Error("UNIQUE constraint failed: workspaces.name");
      }
      ws.name = newName;
      return { updated: true };
    },
    clone: (srcId, newName) => {
      const src = workspaces.find((w) => w.id === srcId);
      if (!src) throw new Error(`Workspace ${srcId} not found`);
      if (workspaces.some((w) => w.name === newName)) {
        throw new Error("UNIQUE constraint failed: workspaces.name");
      }
      const ws = { id: nextWsId++, name: newName, kind: "scenario", createdAt: new Date().toISOString() };
      workspaces.push(ws);
      // Copy expenses/incomes by re-running the test fakes' add().
      for (const e of expenses.filter((x) => x.workspaceId === srcId)) {
        const now = new Date().toISOString().replace("T", " ").slice(0, 19);
        expenses.push({
          id: nextExpId++,
          workspaceId: ws.id,
          label: e.label,
          amountDollars: e.amountDollars,
          frequency: e.frequency,
          categoryId: e.categoryId,
          source: e.source,
          createdAt: now,
          updatedAt: now,
        });
      }
      for (const i of incomes.filter((x) => x.workspaceId === srcId)) {
        incomes.push({
          id: nextIncId++,
          workspaceId: ws.id,
          label: i.label,
          grossAnnualDollars: i.grossAnnualDollars,
          taxStatus: i.taxStatus,
          isFederalIncomeTax: i.isFederalIncomeTax,
          filingRole: i.filingRole,
        });
      }
      return { id: ws.id };
    },
    delete: (id) => {
      const i = workspaces.findIndex((w) => w.id === id);
      if (i < 0) return { deleted: false };
      workspaces.splice(i, 1);
      return { deleted: true };
    },
  };

  const expenseRepo: ExpenseRepo = {
    list: (workspaceId) => expenses.filter((e) => e.workspaceId === workspaceId),
    add: (args) => {
      const now = new Date().toISOString().replace("T", " ").slice(0, 19);
      const e = {
        id: nextExpId++,
        workspaceId: args.workspaceId,
        label: args.label,
        amountDollars: args.amountDollars,
        frequency: args.frequency,
        spendDate: args.spendDate ?? null,
        categoryId: args.categoryId ?? null,
        source: args.source ?? "manual",
        createdAt: now,
        updatedAt: now,
      };
      expenses.push(e);
      return { id: e.id };
    },
    update: (args) => {
      const e = expenses.find((x) => x.id === args.id);
      if (!e) return { updated: false };
      if (args.label !== undefined) e.label = args.label;
      if (args.amountDollars !== undefined) e.amountDollars = args.amountDollars;
      if (args.frequency !== undefined) e.frequency = args.frequency;
      if (args.spendDate !== undefined) e.spendDate = args.spendDate;
      if (args.categoryId !== undefined) e.categoryId = args.categoryId;
      return { updated: true };
    },
    delete: (id) => {
      const i = expenses.findIndex((e) => e.id === id);
      if (i < 0) return { deleted: false };
      expenses.splice(i, 1);
      return { deleted: true };
    },
  };

  const incomeRepo: IncomeRepo = {
    list: (workspaceId) => incomes.filter((i) => i.workspaceId === workspaceId),
    add: (args) => {
      const inc = {
        id: nextIncId++,
        workspaceId: args.workspaceId,
        label: args.label,
        grossAnnualDollars: args.grossAnnualDollars,
        taxStatus: args.taxStatus,
        isFederalIncomeTax: args.isFederalIncomeTax ?? true,
        filingRole: args.filingRole ?? "primary",
      };
      incomes.push(inc);
      return { id: inc.id };
    },
    update: (args) => {
      const inc = incomes.find((x) => x.id === args.id);
      if (!inc) return { updated: false };
      if (args.label !== undefined) inc.label = args.label;
      if (args.grossAnnualDollars !== undefined) inc.grossAnnualDollars = args.grossAnnualDollars;
      if (args.taxStatus !== undefined) inc.taxStatus = args.taxStatus;
      if (args.isFederalIncomeTax !== undefined) inc.isFederalIncomeTax = args.isFederalIncomeTax;
      if (args.filingRole !== undefined) inc.filingRole = args.filingRole;
      return { updated: true };
    },
    delete: (id) => {
      const i = incomes.findIndex((x) => x.id === id);
      if (i < 0) return { deleted: false };
      incomes.splice(i, 1);
      return { deleted: true };
    },
  };

  const taxOverrides = new Map<number, TaxSettingsRow>();
  const deletedTaxSettings = new Set<number>();
  const taxRepo: TaxRepo = {
    tables: (year) => [
      {
        year,
        jurisdiction: "federal",
        filing: "single",
        standardDeductionDollars: 15750,
        brackets: [
          { upTo: 11925, rate: 0.1 },
          { upTo: 48475, rate: 0.12 },
          { upTo: 103350, rate: 0.22 },
          { upTo: 197300, rate: 0.24 },
          { upTo: 250525, rate: 0.32 },
          { upTo: 626350, rate: 0.35 },
          { rate: 0.37 },
        ],
      },
      {
        year,
        jurisdiction: "federal",
        filing: "mfj",
        standardDeductionDollars: 31500,
        brackets: [
          { upTo: 23850, rate: 0.1 },
          { upTo: 96950, rate: 0.12 },
          { upTo: 206700, rate: 0.22 },
          { upTo: 394600, rate: 0.24 },
          { upTo: 501050, rate: 0.32 },
          { upTo: 751600, rate: 0.35 },
          { rate: 0.37 },
        ],
      },
      {
        year,
        jurisdiction: "ca",
        filing: "single",
        standardDeductionDollars: 5685,
        brackets: [
          { upTo: 10756, rate: 0.01 },
          { upTo: 25499, rate: 0.02 },
          { upTo: 40245, rate: 0.04 },
          { upTo: 55866, rate: 0.06 },
          { upTo: 70606, rate: 0.08 },
          { upTo: 360659, rate: 0.093 },
          { upTo: 432790, rate: 0.103 },
          { upTo: 721315, rate: 0.113 },
          { upTo: 1000000, rate: 0.123 },
          { upTo: null, rate: 0.133 },
        ],
      },
      {
        year,
        jurisdiction: "ca",
        filing: "mfj",
        standardDeductionDollars: 11370,
        brackets: [
          { upTo: 21512, rate: 0.01 },
          { upTo: 50998, rate: 0.02 },
          { upTo: 80490, rate: 0.04 },
          { upTo: 111732, rate: 0.06 },
          { upTo: 141212, rate: 0.08 },
          { upTo: 721318, rate: 0.093 },
          { upTo: 865580, rate: 0.103 },
          { upTo: 1000000, rate: 0.113 },
          { upTo: 1442630, rate: 0.123 },
          { upTo: null, rate: 0.133 },
        ],
      },
    ],
    // Every workspace has settings by default (DEFAULT_TAX_SETTINGS) unless a
    // test removes them via __deleteTaxSettings; per-workspace writes are kept
    // in `taxOverrides` so a partial update_tax_settings is observable.
    settingsForWorkspace: (workspaceId) => {
      if (deletedTaxSettings.has(workspaceId)) {
        throw new Error(
          `No tax_settings row for workspace ${workspaceId}. Create one with the update_tax_settings tool or the Setup page.`,
        );
      }
      return { ...(taxOverrides.get(workspaceId) ?? DEFAULT_TAX_SETTINGS) };
    },
    setSettingsForWorkspace: (args) => {
      const { workspaceId, ...fields } = args;
      const supplied = Object.entries(fields).filter(([, v]) => v !== undefined);
      if (!deletedTaxSettings.has(workspaceId)) {
        if (supplied.length === 0) return { saved: false, created: false };
        taxOverrides.set(workspaceId, {
          ...(taxOverrides.get(workspaceId) ?? DEFAULT_TAX_SETTINGS),
          ...(Object.fromEntries(supplied) as Partial<TaxSettingsRow>),
        });
        return { saved: true, created: false };
      }
      if (fields.filing === undefined || fields.taxYear === undefined) {
        throw new Error(
          `No tax_settings row exists for workspace ${workspaceId}; creating one requires both "filing" and "taxYear".`,
        );
      }
      deletedTaxSettings.delete(workspaceId);
      taxOverrides.set(workspaceId, {
        ...DEFAULT_TAX_SETTINGS,
        ...(Object.fromEntries(supplied) as Partial<TaxSettingsRow>),
      });
      return { saved: true, created: true };
    },
    upsertTable: () => ({ saved: true }),
  };

  // Stub WebRepo with per-test override. Defaults to throwing so tests
  // that exercise fetch_tax_source must explicitly opt in via mkMemoryCtx
  // arguments OR by patching ctx.web before invoking.
  const web: WebRepo = {
    fetch: async () => {
      throw new Error("web.fetch stub: provide a real impl in your test");
    },
  };

  const audit: AuditLogRepo & { records: ToolCallRecord[] } = {
    records,
    append: (r) => records.push(r),
  };

  let nextSavingsId = 1;
  const savingsRows: Array<{
    id: number;
    workspaceId: number;
    label: string;
    currentBalanceDollars: number;
    targetBalanceDollars: number | null;
    monthlyContributionDollars: number;
    accountType: SavingsAccountType;
    contributionPctOfSalary: number | null;
    employerMatchKind: "none" | "pct_of_salary" | "flat_annual_dollars";
    employerMatchValue: number | null;
    taxTreatment: "payroll_pretax" | "payroll_posttax" | "from_cash" | null;
    filingRole: "primary" | "spouse";
  }> = [];
  const savings: SavingsRepo = {
    list: (workspaceId) =>
      savingsRows.filter((s) => s.workspaceId === workspaceId).map((s) => ({ ...s })),
    add: (args) => {
      const row = {
        id: nextSavingsId++,
        workspaceId: args.workspaceId,
        label: args.label,
        currentBalanceDollars: args.currentBalanceDollars ?? 0,
        targetBalanceDollars: args.targetBalanceDollars ?? null,
        monthlyContributionDollars: args.monthlyContributionDollars ?? 0,
        accountType: args.accountType,
        contributionPctOfSalary: args.contributionPctOfSalary ?? null,
        employerMatchKind: args.employerMatchKind ?? "none",
        employerMatchValue: args.employerMatchValue ?? null,
        taxTreatment: args.taxTreatment ?? null,
        filingRole: args.filingRole ?? "primary",
      };
      savingsRows.push(row);
      return { id: row.id };
    },
    update: (args) => {
      const row = savingsRows.find((s) => s.id === args.id);
      if (!row) return { updated: false };
      if (args.label !== undefined) row.label = args.label;
      if (args.currentBalanceDollars !== undefined) row.currentBalanceDollars = args.currentBalanceDollars;
      if (args.targetBalanceDollars !== undefined) row.targetBalanceDollars = args.targetBalanceDollars;
      if (args.monthlyContributionDollars !== undefined) row.monthlyContributionDollars = args.monthlyContributionDollars;
      if (args.accountType !== undefined) row.accountType = args.accountType;
      if (args.contributionPctOfSalary !== undefined) row.contributionPctOfSalary = args.contributionPctOfSalary;
      if (args.employerMatchKind !== undefined) row.employerMatchKind = args.employerMatchKind;
      if (args.employerMatchValue !== undefined) row.employerMatchValue = args.employerMatchValue;
      if (args.taxTreatment !== undefined) row.taxTreatment = args.taxTreatment;
      if (args.filingRole !== undefined) row.filingRole = args.filingRole;
      return { updated: true };
    },
    delete: (id) => {
      const i = savingsRows.findIndex((s) => s.id === id);
      if (i < 0) return { deleted: false };
      savingsRows.splice(i, 1);
      return { deleted: true };
    },
  };

  const retirementRows = new Map<
    number,
    {
      workspaceId: number;
      currentAge: number;
      retirementAge: number;
      initialBalanceDollars: number;
      growthRate: number;
      rothSplitPct: number;
    }
  >();
  const retirement: RetirementRepo = {
    get: (workspaceId) => retirementRows.get(workspaceId) ?? null,
    set: (args) => {
      if (args.retirementAge <= args.currentAge) {
        throw new Error(
          `retirementAge (${args.retirementAge}) must be > currentAge (${args.currentAge})`,
        );
      }
      if (args.rothSplitPct < 0 || args.rothSplitPct > 1) {
        throw new Error(`rothSplitPct must be in [0,1]`);
      }
      retirementRows.set(args.workspaceId, { ...args });
      return { saved: true };
    },
  };

  const sensitivityRows = new Map<
    number,
    {
      workspaceId: number;
      primaryLowDollars: number;
      primaryHighDollars: number;
      spouseLowDollars: number;
      spouseHighDollars: number;
    }
  >();
  const sensitivity: SensitivityRepo = {
    get: (workspaceId) => sensitivityRows.get(workspaceId) ?? null,
    set: (args) => {
      if (args.primaryLowDollars >= args.primaryHighDollars) {
        throw new Error(`primaryLowDollars must be < primaryHighDollars`);
      }
      if (args.spouseLowDollars > args.spouseHighDollars) {
        throw new Error(`spouseLowDollars must be <= spouseHighDollars`);
      }
      sensitivityRows.set(args.workspaceId, { ...args });
      return { saved: true };
    },
  };

  // Categories fake — mirrors the canonical BUDGET set seeded by the prod
  // migrations (001 → 008_categories_budget_set) so cataloguer tests resolve
  // the same names/ids the real DB uses. The resolver's catch-all is
  // "Discretionary" (id 8) — there is no "Other" in the budget set.
  const categoryRows = [
    { id: 1, name: "Housing",        colorHex: "#c97a4a" },
    { id: 2, name: "Utilities",      colorHex: "#7a9ec9" },
    { id: 3, name: "Communications", colorHex: "#a07cc9" },
    { id: 4, name: "Food",           colorHex: "#c9a14a" },
    { id: 5, name: "Transport",      colorHex: "#7ec98a" },
    { id: 6, name: "Subscriptions",  colorHex: "#c97a98" },
    { id: 7, name: "Insurance",      colorHex: "#5db8b8" },
    { id: 8, name: "Discretionary",  colorHex: "#9a9a9a" },
    { id: 9, name: "Annual fees",    colorHex: "#b89a4a" },
    { id: 99, name: "Uncategorized", colorHex: "#888888" },
  ];
  const categories: ToolCtx["categories"] = {
    listByName: () => new Map(categoryRows.map((c) => [c.name, c.id])),
    listAll: () => categoryRows.slice(),
  };

  // Transaction + statement_imports fakes: empty by default. Tests that
  // exercise list_statements_rich / compute_expense_trends seed the
  // underlying arrays before invocation.
  // Legacy month-sum seeds (some trends tests push pre-aggregated sums here).
  const txnRows: Array<{
    monthKey: string;
    categoryId: number | null;
    totalDollars: number;
  }> = [];
  // Raw rows written via insertMany (the commit path). monthlySumsByCategory
  // aggregates these (by YYYY-MM month + category, charges negated to positive)
  // and merges with the legacy seeds — so a commit round-trip is observable.
  const insertedTxns: Array<{
    importId: number;
    postedDate: string;
    merchantRaw: string;
    merchantNormalized: string;
    amountDollars: number;
    categoryId: number | null;
    accountType: string;
  }> = [];
  const transactions: ToolCtx["transactions"] = {
    monthlySumsByCategory: () => {
      const agg = new Map<string, number>();
      for (const t of insertedTxns) {
        const key = `${t.postedDate.slice(0, 7)}|${t.categoryId ?? "null"}`;
        agg.set(key, (agg.get(key) ?? 0) + -t.amountDollars);
      }
      const out = txnRows.slice();
      for (const [key, total] of agg) {
        const [monthKey, catStr] = key.split("|");
        out.push({
          monthKey: monthKey!,
          categoryId: catStr === "null" ? null : Number(catStr),
          totalDollars: Math.max(0, round2(total)),
        });
      }
      return out;
    },
    monthlySumsByMerchant: () => {
      const out: Array<{
        monthKey: string;
        merchantRaw: string;
        merchantNormalized: string;
        categoryId: number | null;
        totalDollars: number;
      }> = [];
      // Category-level seeds carry no merchant → emit with an empty merchant so
      // they fall back to their own categoryId (no budget remap) and remain
      // single-month spikes.
      for (const s of txnRows) {
        out.push({
          monthKey: s.monthKey,
          merchantRaw: "",
          merchantNormalized: "",
          categoryId: s.categoryId,
          totalDollars: s.totalDollars,
        });
      }
      // Inserted raw txns aggregated by (month, merchant, category); charges only.
      const magg = new Map<
        string,
        { merchantRaw: string; merchantNormalized: string; categoryId: number | null; total: number }
      >();
      for (const t of insertedTxns) {
        if (t.amountDollars >= 0) continue;
        const monthKey = t.postedDate.slice(0, 7);
        const key = `${monthKey}|${t.merchantRaw}|${t.merchantNormalized}|${t.categoryId ?? "null"}`;
        const e = magg.get(key) ?? {
          merchantRaw: t.merchantRaw,
          merchantNormalized: t.merchantNormalized,
          categoryId: t.categoryId,
          total: 0,
        };
        e.total += -t.amountDollars;
        magg.set(key, e);
      }
      for (const [key, e] of magg) {
        out.push({
          monthKey: key.split("|")[0]!,
          merchantRaw: e.merchantRaw,
          merchantNormalized: e.merchantNormalized,
          categoryId: e.categoryId,
          totalDollars: round2(e.total),
        });
      }
      return out;
    },
    listChargeRows: () =>
      insertedTxns
        .filter((t) => t.amountDollars < 0)
        .map((t) => ({
          merchantRaw: t.merchantRaw,
          merchantNormalized: t.merchantNormalized,
          postedDate: t.postedDate,
          amountDollars: t.amountDollars,
        })),
    listChargeRowsInRange: (from, to) =>
      insertedTxns
        .filter(
          (t) =>
            t.amountDollars < 0 &&
            (from === undefined || t.postedDate >= from) &&
            (to === undefined || t.postedDate <= to),
        )
        .map((t) => ({
          merchantRaw: t.merchantRaw,
          merchantNormalized: t.merchantNormalized,
          postedDate: t.postedDate,
          amountDollars: t.amountDollars,
          categoryId: t.categoryId,
          accountType: t.accountType,
        })),
    search: (args) => {
      const needle = args.merchant?.toLowerCase();
      const matched = insertedTxns.filter((t) => {
        if (args.includeCredits !== true && t.amountDollars >= 0) return false;
        if (
          needle !== undefined &&
          needle !== "" &&
          !t.merchantNormalized.toLowerCase().includes(needle) &&
          !t.merchantRaw.toLowerCase().includes(needle)
        ) {
          return false;
        }
        if (args.from !== undefined && t.postedDate < args.from) return false;
        if (args.to !== undefined && t.postedDate > args.to) return false;
        if (args.categoryId !== undefined && t.categoryId !== args.categoryId) return false;
        const abs = Math.abs(t.amountDollars);
        if (args.minAmountDollars !== undefined && abs < args.minAmountDollars) return false;
        if (args.maxAmountDollars !== undefined && abs > args.maxAmountDollars) return false;
        return true;
      });
      // posted_date DESC, id DESC — reverse first so the stable sort leaves
      // same-date rows newest-inserted-first, matching the SQL ORDER BY.
      const ordered = matched.slice().reverse().sort((a, b) => b.postedDate.localeCompare(a.postedDate));
      const page = ordered.slice(args.offset, args.offset + args.limit);
      return {
        rows: page.map((t) => ({
          postedDate: t.postedDate,
          merchantRaw: t.merchantRaw,
          merchantNormalized: t.merchantNormalized,
          amountDollars: round2(t.amountDollars),
          categoryId: t.categoryId,
          accountType: t.accountType,
        })),
        totalMatched: matched.length,
      };
    },
    topMerchants: (args) => {
      const groups = new Map<
        string,
        {
          merchantNormalized: string;
          merchantRawSample: string;
          txnCount: number;
          totalDollars: number;
          firstSeen: string;
          lastSeen: string;
        }
      >();
      for (const t of insertedTxns) {
        if (t.amountDollars >= 0) continue; // charges only
        if (args.from !== undefined && t.postedDate < args.from) continue;
        if (args.to !== undefined && t.postedDate > args.to) continue;
        if (args.categoryId !== undefined && t.categoryId !== args.categoryId) continue;
        const g = groups.get(t.merchantNormalized) ?? {
          merchantNormalized: t.merchantNormalized,
          merchantRawSample: t.merchantRaw,
          txnCount: 0,
          totalDollars: 0,
          firstSeen: t.postedDate,
          lastSeen: t.postedDate,
        };
        g.txnCount += 1;
        g.totalDollars += -t.amountDollars;
        if (t.merchantRaw < g.merchantRawSample) g.merchantRawSample = t.merchantRaw; // MIN()
        if (t.postedDate < g.firstSeen) g.firstSeen = t.postedDate;
        if (t.postedDate > g.lastSeen) g.lastSeen = t.postedDate;
        groups.set(t.merchantNormalized, g);
      }
      return [...groups.values()]
        .map((g) => ({ ...g, totalDollars: round2(g.totalDollars) }))
        .sort((a, b) => b.totalDollars - a.totalDollars)
        .slice(0, args.limit);
    },
    aggregate: (args) => {
      const matched = insertedTxns.filter((t) => {
        if (args.includeCredits !== true && t.amountDollars >= 0) return false;
        if (args.from !== undefined && t.postedDate < args.from) return false;
        if (args.to !== undefined && t.postedDate > args.to) return false;
        if (args.categoryId !== undefined && t.categoryId !== args.categoryId) return false;
        if (args.dayOfWeek !== undefined) {
          // Date-only string → UTC parse keeps this timezone-free, matching
          // SQLite's strftime('%w', posted_date).
          if (new Date(`${t.postedDate}T00:00:00Z`).getUTCDay() !== args.dayOfWeek) return false;
        }
        return true;
      });
      const keyOf = (t: (typeof insertedTxns)[number]): string => {
        switch (args.groupBy) {
          case "day":
            return t.postedDate;
          case "week": {
            const d = new Date(`${t.postedDate}T00:00:00Z`);
            d.setUTCDate(d.getUTCDate() - d.getUTCDay()); // Sunday-start week key
            return d.toISOString().slice(0, 10);
          }
          case "month":
            return t.postedDate.slice(0, 7);
          case "dayOfWeek":
            return String(new Date(`${t.postedDate}T00:00:00Z`).getUTCDay());
          case "category":
            return t.categoryId === null ? "uncat" : String(t.categoryId);
          default:
            return t.merchantNormalized;
        }
      };
      const groups = new Map<string, { key: string; sum: number; count: number }>();
      for (const t of matched) {
        const key = keyOf(t);
        const g = groups.get(key) ?? { key, sum: 0, count: 0 };
        g.sum += -t.amountDollars;
        g.count += 1;
        groups.set(key, g);
      }
      const ordered = [...groups.values()].sort((a, b) =>
        args.groupBy === "category" || args.groupBy === "merchant"
          ? b.sum - a.sum
          : a.key.localeCompare(b.key),
      );
      return {
        rows: ordered.slice(0, args.limit).map((g) => ({
          key: g.key,
          value:
            args.metric === "count"
              ? g.count
              : round2(args.metric === "avg" ? g.sum / g.count : g.sum),
          count: g.count,
        })),
        totalGroups: ordered.length,
      };
    },
    totalCount: () => txnRows.length + insertedTxns.length,
    insertMany: (importId, rows) => {
      for (const r of rows) insertedTxns.push({ importId, ...r });
      return { inserted: rows.length };
    },
  };
  let nextImportId = 1;
  const statementImportRows: Array<{
    importId: number;
    fileHash: string;
    filePath: string;
    importedAt: string;
    txnCount: number;
    sourceAccount: string;
    ignored: boolean;
  }> = [];
  const statementImports: ToolCtx["statementImports"] = {
    list: () =>
      statementImportRows.map((r) => ({
        filePath: r.filePath,
        importedAt: r.importedAt,
        txnCount: r.txnCount,
        sourceAccount: r.sourceAccount,
        ignored: r.ignored,
      })),
    setIgnored: (filePath, ignored) => {
      const r = statementImportRows.find((x) => x.filePath === filePath);
      if (!r) return { updated: false };
      r.ignored = ignored;
      return { updated: true };
    },
    record: ({ sourceAccount, fileHash, filePath, txnCount }) => {
      const existing = statementImportRows.find((x) => x.fileHash === fileHash);
      if (existing) return { importId: existing.importId, alreadyImported: true };
      const importId = nextImportId++;
      statementImportRows.push({
        importId,
        fileHash,
        filePath,
        importedAt: new Date().toISOString(),
        txnCount,
        sourceAccount,
        ignored: false,
      });
      return { importId, alreadyImported: false };
    },
  };

  // In-memory CustomPageRepo with the same "blank = absent" + snapshot
  // semantics as the SQLite one (packages/db/src/repositories.ts).
  const customPageRows = new Map<string, { value: string; updatedAt: string }>();
  const customPage: ToolCtx["customPage"] = {
    read: () => {
      const row = customPageRows.get("def");
      return row ? { definitionJson: row.value, updatedAt: row.updatedAt } : null;
    },
    readPrev: () => {
      const row = customPageRows.get("prev");
      return row ? { definitionJson: row.value } : null;
    },
    write: (definitionJson) => {
      const current = customPageRows.get("def");
      if (current) customPageRows.set("prev", { ...current });
      else customPageRows.delete("prev");
      const updatedAt = new Date().toISOString();
      customPageRows.set("def", { value: definitionJson, updatedAt });
      return { updatedAt };
    },
    reset: () => {
      const current = customPageRows.get("def");
      if (!current) return { hadDefinition: false };
      customPageRows.set("prev", { ...current });
      customPageRows.delete("def");
      return { hadDefinition: true };
    },
    revert: () => {
      const prev = customPageRows.get("prev");
      if (!prev) return { reverted: false, updatedAt: null };
      const current = customPageRows.get("def");
      if (current) customPageRows.set("prev", { ...current });
      else customPageRows.delete("prev");
      const updatedAt = new Date().toISOString();
      customPageRows.set("def", { value: prev.value, updatedAt });
      return { reverted: true, updatedAt };
    },
  };

  return {
    audit,
    workspaces: workspaceRepo,
    expenses: expenseRepo,
    incomes: incomeRepo,
    tax: taxRepo,
    savings,
    retirement,
    sensitivity,
    categories,
    transactions,
    statementImports,
    customPage,
    web,
    source: "api_direct",
    // Synchronous passthrough — the in-memory fakes don't need a real
    // transaction; the SQLite-backed buildToolCtx provides the real one.
    tx: <T>(fn: () => T): T => fn(),
    // Exposed on the returned object so tests can seed/inspect them; the
    // ToolCtx type doesn't see these but the test scope can cast.
    __txnRows: txnRows,
    __insertedTxns: insertedTxns,
    __statementImportRows: statementImportRows,
    __expenseRows: expenses,
    // Remove a workspace's tax_settings row, so settingsForWorkspace throws and
    // update_tax_settings takes its CREATE branch.
    __deleteTaxSettings: (workspaceId: number) => {
      deletedTaxSettings.add(workspaceId);
      taxOverrides.delete(workspaceId);
    },
  } as ToolCtx & {
    audit: AuditLogRepo & { records: ToolCallRecord[] };
    __txnRows: typeof txnRows;
    __insertedTxns: typeof insertedTxns;
    __statementImportRows: typeof statementImportRows;
    __expenseRows: typeof expenses;
    __deleteTaxSettings: (workspaceId: number) => void;
  };
}

describe("ToolRegistry — invocation + audit", () => {
  let ctx: ReturnType<typeof mkMemoryCtx>;
  let registry: ToolRegistry;

  beforeEach(() => {
    ctx = mkMemoryCtx();
    registry = new ToolRegistry(ALL_TOOLS);
  });

  it("lists tools", () => {
    const names = registry.list().map((t) => t.name);
    expect(names).toContain("list_workspaces");
    expect(names).toContain("add_expense");
    expect(names).toContain("compute_take_home");
  });

  it("invokes a list (read-only) tool but does NOT write to the audit log", async () => {
    const result = (await registry.invoke("list_workspaces", {}, ctx)) as Array<{
      name: string;
    }>;
    expect(result.length).toBe(1);
    expect(result[0]!.name).toBe("Current");
    // Privacy: read-only tools must not embed query results in the audit log.
    expect(ctx.audit.records).toHaveLength(0);
  });

  it("invokes a mutation tool and writes to the audit log", async () => {
    await registry.invoke(
      "add_expense",
      { workspaceId: 1, label: "Test", amountDollars: 1, frequency: "monthly" },
      ctx,
    );
    expect(ctx.audit.records).toHaveLength(1);
    expect(ctx.audit.records[0]!.toolName).toBe("add_expense");
    expect(ctx.audit.records[0]!.source).toBe("api_direct");
  });

  it("redacts PII from the audit log (CWE-200): no raw labels/amounts persisted", async () => {
    await registry.invoke(
      "add_expense",
      { workspaceId: 7, label: "SECRET MERCHANT LLC", amountDollars: 1234.56, frequency: "monthly" },
      ctx,
    );
    const rec = ctx.audit.records[0]!;
    // Raw merchant string + amount must NOT appear anywhere in the row.
    expect(rec.argsJson).not.toContain("SECRET MERCHANT LLC");
    expect(rec.argsJson).not.toContain("123456");
    expect(rec.resultJson).not.toContain("SECRET MERCHANT LLC");
    // Non-sensitive scalars + field presence ARE retained for traceability.
    const args = JSON.parse(rec.argsJson) as Record<string, unknown>;
    expect(args.workspaceId).toBe(7);
    expect(args.label).toBe("[string]");   // presence + type only
    expect(args.amountDollars).toBe("[number]");
  });

  it("validateArgs enforces maxItems and maxLength (CWE-400/20)", () => {
    const schema = {
      type: "array" as const,
      maxItems: 2,
      items: { type: "string" as const, maxLength: 5 },
    };
    expect(() => validateArgs(schema, ["a", "b"])).not.toThrow();
    expect(() => validateArgs(schema, ["a", "b", "c"])).toThrow(ToolArgError);
    expect(() => validateArgs(schema, ["toolong"])).toThrow(ToolArgError);
  });

  it("logs failed mutations into the audit trail", async () => {
    // Force a handler-level failure (workspace exists check on delete_workspace
    // throws if id is missing). Use a non-existent workspace id.
    await expect(
      registry.invoke("delete_workspace", { id: 99999 }, ctx),
    ).rejects.toThrow();
    expect(ctx.audit.records).toHaveLength(1);
    expect(ctx.audit.records[0]!.toolName).toBe("delete_workspace");
    expect(JSON.parse(ctx.audit.records[0]!.resultJson)).toMatchObject({
      error: expect.stringMatching(/not found/i),
    });
  });

  it("rejects unknown tool names", async () => {
    await expect(registry.invoke("not_a_tool", {}, ctx)).rejects.toThrow(/Unknown tool/);
  });

  it("validates required fields", async () => {
    await expect(
      registry.invoke("add_expense", { label: "missing-workspaceId" }, ctx),
    ).rejects.toThrow(/missing required field/);
  });

  it("validates enums", async () => {
    await expect(
      registry.invoke(
        "add_expense",
        {
          workspaceId: 1,
          label: "X",
          amountDollars: 1,
          frequency: "fortnightly", // not in enum
        },
        ctx,
      ),
    ).rejects.toThrow(/not in enum/);
  });

  it("rejects unknown fields with additionalProperties:false", async () => {
    await expect(
      registry.invoke(
        "add_expense",
        {
          workspaceId: 1,
          label: "X",
          amountDollars: 1,
          frequency: "monthly",
          bogus: "extra",
        },
        ctx,
      ),
    ).rejects.toThrow(/unknown field/);
  });

  it("round-trips add → list → update → delete on an expense", async () => {
    const added = (await registry.invoke(
      "add_expense",
      {
        workspaceId: 1,
        label: "Test",
        amountDollars: 50,
        frequency: "monthly",
      },
      ctx,
    )) as { id: number };
    expect(added.id).toBeGreaterThan(0);

    const listed = (await registry.invoke(
      "list_expenses",
      { workspaceId: 1 },
      ctx,
    )) as Array<{ id: number; label: string; amountDollars: number }>;
    expect(listed).toHaveLength(1);
    expect(listed[0]!.label).toBe("Test");

    const updated = (await registry.invoke(
      "update_expense",
      { id: added.id, amountDollars: 60 },
      ctx,
    )) as { updated: boolean };
    expect(updated.updated).toBe(true);

    const listed2 = (await registry.invoke(
      "list_expenses",
      { workspaceId: 1 },
      ctx,
    )) as Array<{ amountDollars: number }>;
    expect(listed2[0]!.amountDollars).toBe(60);

    const deleted = (await registry.invoke(
      "delete_expense",
      { id: added.id },
      ctx,
    )) as { deleted: boolean };
    expect(deleted.deleted).toBe(true);

    const listed3 = (await registry.invoke(
      "list_expenses",
      { workspaceId: 1 },
      ctx,
    )) as Array<unknown>;
    expect(listed3).toHaveLength(0);
  });

  it("add_expense auto-categorizes from the label when categoryId is omitted", async () => {
    // SPOTIFY USA → Subscriptions (id=6 in the budget categories map).
    const added = (await registry.invoke(
      "add_expense",
      { workspaceId: 1, label: "SPOTIFY USA NEW YORK NY", amountDollars: 9.99, frequency: "monthly" },
      ctx,
    )) as { id: number };
    const listed = (await registry.invoke("list_expenses", { workspaceId: 1 }, ctx)) as Array<{
      id: number;
      categoryId: number | null;
    }>;
    expect(listed[0]!.id).toBe(added.id);
    expect(listed[0]!.categoryId).toBe(6);
  });

  it("add_expense honors an explicit categoryId over auto-categorization", async () => {
    // SPOTIFY would normally resolve to Subscriptions (6), but caller-supplied
    // categoryId wins — useful for the wizard / LLM "categorize as X" path.
    const added = (await registry.invoke(
      "add_expense",
      { workspaceId: 1, label: "SPOTIFY USA", amountDollars: 9.99, frequency: "monthly", categoryId: 7 },
      ctx,
    )) as { id: number };
    const listed = (await registry.invoke("list_expenses", { workspaceId: 1 }, ctx)) as Array<{
      id: number;
      categoryId: number | null;
    }>;
    expect(listed.find((e) => e.id === added.id)!.categoryId).toBe(7);
  });

  it("add_expense falls back to 'Discretionary' (id=8) for an unmapped merchant", async () => {
    const added = (await registry.invoke(
      "add_expense",
      { workspaceId: 1, label: "Random One-Off Service", amountDollars: 25, frequency: "one_time" },
      ctx,
    )) as { id: number };
    const listed = (await registry.invoke("list_expenses", { workspaceId: 1 }, ctx)) as Array<{
      id: number;
      categoryId: number | null;
    }>;
    expect(listed.find((e) => e.id === added.id)!.categoryId).toBe(8);
  });

  it("auto_categorize_expenses fills missing categoryIds; preserves manual ones by default", async () => {
    // Seed three rows: one unmapped, one without a category set, one with a
    // manual override the user wouldn't want clobbered.
    // Both expenses auto-categorize on insert (Transport/Food). We then mutate
    // them via update_expense to set up the test scenario explicitly.
    const a = (await registry.invoke(
      "add_expense",
      { workspaceId: 1, label: "CHEVRON #4521", amountDollars: 55, frequency: "monthly" },
      ctx,
    )) as { id: number };
    const b = (await registry.invoke(
      "add_expense",
      { workspaceId: 1, label: "WHOLE FOODS MKT", amountDollars: 88, frequency: "weekly" },
      ctx,
    )) as { id: number };
    // a: user overrode to Insurance (7) — default mode must preserve.
    // b: cleared to null directly via the repo (the tool can't pass null
    // through the JSON schema validator). The default mode must re-categorize.
    await registry.invoke("update_expense", { id: a.id, categoryId: 7 }, ctx);
    ctx.expenses.update({ id: b.id, categoryId: null });

    const result = (await registry.invoke(
      "auto_categorize_expenses",
      { workspaceId: 1 },
      ctx,
    )) as {
      examined: number;
      changed: number;
      skipped: number;
      changes: Array<{ id: number; newCategoryId: number; categoryName: string }>;
    };
    expect(result.examined).toBe(2);
    // a was manually set to 7 → skipped. b had null → re-categorized to Food (4).
    expect(result.changed).toBe(1);
    expect(result.changes[0]!.id).toBe(b.id);
    expect(result.changes[0]!.categoryName).toBe("Food");
    expect(result.changes[0]!.newCategoryId).toBe(4);
  });

  it("list_statements returns a files array (empty ok) with the expected shape", async () => {
    const out = (await registry.invoke("list_statements", {}, ctx)) as {
      files: Array<{ relativePath: string; sizeBytes: number; kind: string }>;
    };
    expect(Array.isArray(out.files)).toBe(true);
    // If statements/ has files, each row must have the documented shape and a
    // valid kind. If statements/ is empty (clean checkout), files=[] is also
    // valid. Either way we assert the contract.
    for (const f of out.files) {
      expect(typeof f.relativePath).toBe("string");
      expect(f.relativePath.startsWith("statements/")).toBe(true);
      expect(typeof f.sizeBytes).toBe("number");
      expect(["chase_pdf", "amex_xlsx", "unknown"]).toContain(f.kind);
    }
    // Sorted lexicographically — caller depends on stable ordering.
    const sorted = [...out.files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    expect(out.files).toEqual(sorted);
  });

  it("auto_categorize_expenses overwrite=true re-categorizes manually-set rows", async () => {
    const a = (await registry.invoke(
      "add_expense",
      { workspaceId: 1, label: "STARBUCKS #4528", amountDollars: 6, frequency: "weekly" },
      ctx,
    )) as { id: number };
    // User overrode to Insurance (7) but the merchant is Food (4).
    await registry.invoke("update_expense", { id: a.id, categoryId: 7 }, ctx);
    const result = (await registry.invoke(
      "auto_categorize_expenses",
      { workspaceId: 1, overwrite: true },
      ctx,
    )) as { changed: number; changes: Array<{ newCategoryId: number }> };
    expect(result.changed).toBe(1);
    expect(result.changes[0]!.newCategoryId).toBe(4);
  });

  it("create_scenario then delete_workspace works; delete on Current is rejected", async () => {
    const created = (await registry.invoke(
      "create_scenario",
      { name: "Apartment-A" },
      ctx,
    )) as { id: number };
    expect(created.id).toBeGreaterThan(1);

    const del = (await registry.invoke("delete_workspace", { id: created.id }, ctx)) as {
      deleted: boolean;
    };
    expect(del.deleted).toBe(true);

    // Cannot delete Current
    await expect(registry.invoke("delete_workspace", { id: 1 }, ctx)).rejects.toThrow(
      /Cannot delete/,
    );
  });

  it("rename_workspace updates the name and rejects duplicates / empties", async () => {
    const created = (await registry.invoke(
      "create_scenario",
      { name: "ScenarioOriginal" },
      ctx,
    )) as { id: number };

    // Happy path: rename to a new unique name.
    const r1 = (await registry.invoke(
      "rename_workspace",
      { id: created.id, name: "ScenarioRenamed" },
      ctx,
    )) as { updated: boolean };
    expect(r1.updated).toBe(true);
    const after = ctx.workspaces.get(created.id);
    expect(after?.name).toBe("ScenarioRenamed");

    // Renaming to the same name is a no-op (updated: false).
    const r2 = (await registry.invoke(
      "rename_workspace",
      { id: created.id, name: "ScenarioRenamed" },
      ctx,
    )) as { updated: boolean };
    expect(r2.updated).toBe(false);

    // Collision with another workspace's name should reject.
    await expect(
      registry.invoke("rename_workspace", { id: created.id, name: "Current" }, ctx),
    ).rejects.toThrow(/already named/);

    // Empty name rejected.
    await expect(
      registry.invoke("rename_workspace", { id: created.id, name: "   " }, ctx),
    ).rejects.toThrow(/cannot be empty/);
  });

  it("clone_workspace deep-copies expenses + incomes into a new scenario", async () => {
    // Seed the Current workspace with one expense and one income.
    await registry.invoke(
      "add_expense",
      { workspaceId: 1, label: "Netflix", amountDollars: 15.99, frequency: "monthly" },
      ctx,
    );
    await registry.invoke(
      "add_income",
      {
        workspaceId: 1,
        label: "Salary",
        grossAnnualDollars: 120000,
        taxStatus: "taxed",
      },
      ctx,
    );

    const clone = (await registry.invoke(
      "clone_workspace",
      { id: 1, name: "CloneTarget" },
      ctx,
    )) as { id: number };
    expect(clone.id).toBeGreaterThan(1);

    // The clone is kind=scenario, not a second Current.
    const meta = ctx.workspaces.get(clone.id);
    expect(meta?.kind).toBe("scenario");
    expect(meta?.name).toBe("CloneTarget");

    // Expenses copied across.
    const clonedExpenses = (await registry.invoke(
      "list_expenses",
      { workspaceId: clone.id },
      ctx,
    )) as Array<{ label: string; amountDollars: number }>;
    expect(clonedExpenses).toHaveLength(1);
    expect(clonedExpenses[0]!.label).toBe("Netflix");
    expect(clonedExpenses[0]!.amountDollars).toBe(15.99);

    // Incomes copied across.
    const clonedIncomes = (await registry.invoke(
      "list_incomes",
      { workspaceId: clone.id },
      ctx,
    )) as Array<{ label: string; grossAnnualDollars: number }>;
    expect(clonedIncomes).toHaveLength(1);
    expect(clonedIncomes[0]!.label).toBe("Salary");
    expect(clonedIncomes[0]!.grossAnnualDollars).toBe(120000);

    // Name collision rejected.
    await expect(
      registry.invoke("clone_workspace", { id: 1, name: "CloneTarget" }, ctx),
    ).rejects.toThrow(/already named/);
  });

  // -------------------------------------------------------------------------
   // Library + Trends backend tools
   // -------------------------------------------------------------------------

  it("compute_expense_trends returns 24mo of zero-filled series for an empty workspace", async () => {
    const r = (await registry.invoke(
      "compute_expense_trends",
      { workspaceId: 1 },
      ctx,
    )) as {
      x: Array<{ key: string }>;
      categories: Record<string, { series: number[] }>;
      overlays: { takeHome: { series: number[] }; savings: { series: number[] }; retirement: { series: number[] } };
    };
    expect(r.x).toHaveLength(24);
    // Every seeded category has a zero-filled series of length 24.
    for (const k of Object.keys(r.categories)) {
      expect(r.categories[k]!.series).toHaveLength(24);
      expect(r.categories[k]!.series.every((v) => v === 0)).toBe(true);
    }
    // Overlays — with no incomes/savings on the workspace, everything is 0.
    expect(r.overlays.takeHome.series.every((v) => v === 0)).toBe(true);
    expect(r.overlays.savings.series.every((v) => v === 0)).toBe(true);
    expect(r.overlays.retirement.series.every((v) => v === 0)).toBe(true);
  });

  it("compute_expense_trends builds series from the budget (recurring flat + one-time spike)", async () => {
    // Discover the window so we can date a one-time spike inside it.
    const x0 = (await registry.invoke("compute_expense_trends", { workspaceId: 1 }, ctx)) as {
      x: Array<{ key: string }>;
    };
    const latestKey = x0.x[x0.x.length - 1]!.key;   // 'YYYY-MM'
    const olderKey = x0.x[x0.x.length - 6]!.key;
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    // Seed the budget directly: a recurring monthly line (category 1), and a
    // one-time line (category 2) dated in an earlier month of the window.
    ctx.__expenseRows.push(
      { id: 9001, workspaceId: 1, label: "Rent", amountDollars: 300, frequency: "monthly", spendDate: null, categoryId: 1, source: "manual", createdAt: now, updatedAt: now },
      { id: 9002, workspaceId: 1, label: "Sofa", amountDollars: 500, frequency: "one_time", spendDate: `${olderKey}-10`, categoryId: 2, source: "manual", createdAt: now, updatedAt: now },
    );
    const r = (await registry.invoke("compute_expense_trends", { workspaceId: 1 }, ctx)) as {
      x: Array<{ key: string }>;
      categories: Record<string, { series: number[] }>;
      topOneTime: Array<Array<{ label: string; amount: number }>>;
    };
    const last = r.x.length - 1;
    const olderIdx = r.x.findIndex((m) => m.key === olderKey);
    // Recurring → flat $300 across the whole window.
    expect(r.categories["1"]!.series.every((v) => v === 300)).toBe(true);
    expect(r.categories["1"]!.series[last]).toBe(300);
    // One-time → a single $500 spike in its dated month, zero in the latest.
    expect(r.categories["2"]!.series[olderIdx]).toBe(500);
    expect(r.categories["2"]!.series[last]).toBe(0);
    // The one-time item surfaces in that month's topOneTime list.
    expect(r.topOneTime[olderIdx]).toEqual([{ label: "Sofa", amount: 500, category: expect.any(String), color: expect.any(String) }]);
  });

  it("ignore_statement toggles the ignored flag and reports updated:false on miss", async () => {
    ctx.__statementImportRows.push({
      filePath: "statements/chase/2026-04.pdf",
      importedAt: "2026-04-15T10:00:00Z",
      txnCount: 22,
      sourceAccount: "chase",
      ignored: false,
    });
    const ok = (await registry.invoke(
      "ignore_statement",
      { relativePath: "statements/chase/2026-04.pdf", ignored: true },
      ctx,
    )) as { updated: boolean };
    expect(ok.updated).toBe(true);
    expect(ctx.__statementImportRows[0]!.ignored).toBe(true);

    const miss = (await registry.invoke(
      "ignore_statement",
      { relativePath: "statements/no-such.pdf", ignored: true },
      ctx,
    )) as { updated: boolean };
    expect(miss.updated).toBe(false);
  });

  it("compute_take_home returns a sensible breakdown for a single $120k income", async () => {
    await registry.invoke(
      "add_income",
      {
        workspaceId: 1,
        label: "Salary",
        grossAnnualDollars: 120000,
        taxStatus: "taxed",
      },
      ctx,
    );
    const result = (await registry.invoke(
      "compute_take_home",
      { workspaceId: 1 },
      ctx,
    )) as { grossCombinedDollars: number; annualTakeHomeDollars: number; effectiveTaxRate: number };
    expect(result.grossCombinedDollars).toBe(120000);
    // For $120k single in CA, take-home should fall in $82k–$88k range.
    expect(result.annualTakeHomeDollars).toBeGreaterThan(82000);
    expect(result.annualTakeHomeDollars).toBeLessThan(88000);
    expect(result.effectiveTaxRate).toBeGreaterThan(0.25);
    expect(result.effectiveTaxRate).toBeLessThan(0.35);
  });

  it("compute_take_home subtracts a pre-tax 401k sourced from savings (employer match excluded)", async () => {
    await registry.invoke(
      "add_income",
      { workspaceId: 1, label: "Salary", grossAnnualDollars: 120000, taxStatus: "taxed" },
      ctx,
    );
    const baseline = (await registry.invoke("compute_take_home", { workspaceId: 1 }, ctx)) as {
      annualTakeHomeDollars: number;
      payrollPretaxDollars: number;
    };
    expect(baseline.payrollPretaxDollars).toBe(0); // no savings yet

    // $1,000/mo employee 401k + a 5% employer match (which must NOT reduce take-home).
    await registry.invoke(
      "add_savings",
      {
        workspaceId: 1,
        label: "401k",
        accountType: "traditional_401k",
        monthlyContributionDollars: 1000,
        employerMatchKind: "pct_of_salary",
        employerMatchValue: 0.05,
      },
      ctx,
    );
    const withK = (await registry.invoke("compute_take_home", { workspaceId: 1 }, ctx)) as {
      annualTakeHomeDollars: number;
      preTaxDeductionsDollars: number;
      payrollPretaxDollars: number;
      fromCashContribDollars: number;
    };
    // Employee 401k = $12,000/yr pre-tax; the 5% employer match is excluded.
    expect(withK.payrollPretaxDollars).toBe(12000);
    expect(withK.preTaxDeductionsDollars).toBe(12000);
    expect(withK.fromCashContribDollars).toBe(0);
    // Take-home drops by (contribution − tax saved): between $6k and $12k.
    const drop = baseline.annualTakeHomeDollars - withK.annualTakeHomeDollars;
    expect(drop).toBeGreaterThan(6000);
    expect(drop).toBeLessThan(12000);
  });

  it("compute_take_home (MFJ): a SPOUSE-owned pre-tax 401k reduces take-home AND taxable income", async () => {
    // Dual-earner MFJ golden: the spouse's pre-tax 401k must flow into the
    // spouse leg of take-home. Before the filing_role fix this was dropped —
    // spouse withholdings were hardcoded to 0.
    const mfjCtx: typeof ctx = {
      ...ctx,
      tax: {
        ...ctx.tax,
        settingsForWorkspace: () => ({ ...ctx.tax.settingsForWorkspace(1), filing: "mfj" }),
      },
    };
    await registry.invoke(
      "add_income",
      { workspaceId: 1, label: "Primary", grossAnnualDollars: 150000, taxStatus: "taxed", filingRole: "primary" },
      mfjCtx,
    );
    await registry.invoke(
      "add_income",
      { workspaceId: 1, label: "Spouse", grossAnnualDollars: 100000, taxStatus: "taxed", filingRole: "spouse" },
      mfjCtx,
    );

    const baseline = (await registry.invoke("compute_take_home", { workspaceId: 1 }, mfjCtx)) as {
      annualTakeHomeDollars: number;
      federalTaxDollars: number;
      payrollPretaxDollars: number;
    };
    expect(baseline.payrollPretaxDollars).toBe(0);

    // Spouse-owned $1,000/mo pre-tax 401k = $12,000/yr.
    await registry.invoke(
      "add_savings",
      {
        workspaceId: 1,
        label: "Spouse 401k",
        accountType: "traditional_401k",
        monthlyContributionDollars: 1000,
        filingRole: "spouse",
      },
      mfjCtx,
    );
    const withSpouseK = (await registry.invoke("compute_take_home", { workspaceId: 1 }, mfjCtx)) as {
      annualTakeHomeDollars: number;
      federalTaxDollars: number;
      preTaxDeductionsDollars: number;
      payrollPretaxDollars: number;
    };
    // The household pre-tax now reflects the spouse's contribution.
    expect(withSpouseK.payrollPretaxDollars).toBe(12000);
    expect(withSpouseK.preTaxDeductionsDollars).toBe(12000);
    // Federal taxable income dropped, so federal tax dropped. Combined MFJ
    // taxable income (~$218.5k) straddles the 22%/24% bracket boundary, so the
    // $12k deduction saves a blended amount in the [22%, 24%] marginal band.
    expect(withSpouseK.federalTaxDollars).toBeLessThan(baseline.federalTaxDollars);
    const fedSaved = baseline.federalTaxDollars - withSpouseK.federalTaxDollars;
    expect(fedSaved).toBeGreaterThanOrEqual(12000 * 0.22);
    expect(fedSaved).toBeLessThanOrEqual(12000 * 0.24);
    // Take-home drops by (contribution − tax saved): strictly between $6k–$12k.
    const drop = baseline.annualTakeHomeDollars - withSpouseK.annualTakeHomeDollars;
    expect(drop).toBeGreaterThan(6000);
    expect(drop).toBeLessThan(12000);
  });

  it("compute_take_home (MFJ): %-of-salary spouse 401k scales with the SPOUSE salary", async () => {
    const mfjCtx: typeof ctx = {
      ...ctx,
      tax: {
        ...ctx.tax,
        settingsForWorkspace: () => ({ ...ctx.tax.settingsForWorkspace(1), filing: "mfj" }),
      },
    };
    await registry.invoke(
      "add_income",
      { workspaceId: 1, label: "Primary", grossAnnualDollars: 150000, taxStatus: "taxed", filingRole: "primary" },
      mfjCtx,
    );
    await registry.invoke(
      "add_income",
      { workspaceId: 1, label: "Spouse", grossAnnualDollars: 80000, taxStatus: "taxed", filingRole: "spouse" },
      mfjCtx,
    );
    // Spouse contributes 10% of THEIR $80k salary = $8,000/yr (NOT 10% of $150k).
    await registry.invoke(
      "add_savings",
      {
        workspaceId: 1,
        label: "Spouse 401k",
        accountType: "traditional_401k",
        contributionPctOfSalary: 0.1,
        filingRole: "spouse",
      },
      mfjCtx,
    );
    const r = (await registry.invoke("compute_take_home", { workspaceId: 1 }, mfjCtx)) as {
      payrollPretaxDollars: number;
      preTaxDeductionsDollars: number;
    };
    expect(r.payrollPretaxDollars).toBe(8000);
    expect(r.preTaxDeductionsDollars).toBe(8000);
  });

  it("INVARIANT (MFJ): moving a 401k primary→spouse keeps the household pretax total constant but changes per-filer attribution", async () => {
    const mfjCtx: typeof ctx = {
      ...ctx,
      tax: {
        ...ctx.tax,
        settingsForWorkspace: () => ({ ...ctx.tax.settingsForWorkspace(1), filing: "mfj" }),
      },
    };
    await registry.invoke(
      "add_income",
      { workspaceId: 1, label: "Primary", grossAnnualDollars: 150000, taxStatus: "taxed", filingRole: "primary" },
      mfjCtx,
    );
    await registry.invoke(
      "add_income",
      { workspaceId: 1, label: "Spouse", grossAnnualDollars: 100000, taxStatus: "taxed", filingRole: "spouse" },
      mfjCtx,
    );
    // A flat-dollar 401k owned by the primary.
    const added = (await registry.invoke(
      "add_savings",
      {
        workspaceId: 1,
        label: "401k",
        accountType: "traditional_401k",
        monthlyContributionDollars: 1000,
        filingRole: "primary",
      },
      mfjCtx,
    )) as { id: number };
    const asPrimary = (await registry.invoke("compute_take_home", { workspaceId: 1 }, mfjCtx)) as {
      payrollPretaxDollars: number;
      preTaxDeductionsDollars: number;
      federalTaxDollars: number;
      annualTakeHomeDollars: number;
    };

    // Move the SAME account to the spouse. Contribution is a flat dollar amount
    // (no %-of-salary), so the household total contribution is unchanged.
    await registry.invoke("update_savings", { id: added.id, filingRole: "spouse" }, mfjCtx);
    const asSpouse = (await registry.invoke("compute_take_home", { workspaceId: 1 }, mfjCtx)) as {
      payrollPretaxDollars: number;
      preTaxDeductionsDollars: number;
      federalTaxDollars: number;
      annualTakeHomeDollars: number;
    };

    // Household-level totals are invariant: same total pre-tax contribution,
    // same combined federal tax, same combined take-home (federal/CA tax depend
    // only on COMBINED taxable income under MFJ, and a flat 401k reduces it the
    // same regardless of which spouse owns it).
    expect(asSpouse.payrollPretaxDollars).toBe(asPrimary.payrollPretaxDollars);
    expect(asSpouse.preTaxDeductionsDollars).toBe(asPrimary.preTaxDeductionsDollars);
    expect(asSpouse.federalTaxDollars).toBe(asPrimary.federalTaxDollars);
    expect(asSpouse.annualTakeHomeDollars).toBe(asPrimary.annualTakeHomeDollars);
    expect(asSpouse.payrollPretaxDollars).toBe(12000);
  });

  it("compute_take_home (MFJ): a SPOUSE-owned Roth 401k reduces take-home but NOT taxable income", async () => {
    // End-to-end post-tax payroll path for the spouse leg: a spouse-owned Roth
    // 401k must be withheld from the spouse's paycheck (reducing take-home
    // dollar-for-dollar) without touching taxable income, and must surface in
    // the payrollPostTaxDollars aggregate.
    const mfjCtx: typeof ctx = {
      ...ctx,
      tax: {
        ...ctx.tax,
        settingsForWorkspace: () => ({ ...ctx.tax.settingsForWorkspace(1), filing: "mfj" }),
      },
    };
    await registry.invoke(
      "add_income",
      { workspaceId: 1, label: "Primary", grossAnnualDollars: 150000, taxStatus: "taxed", filingRole: "primary" },
      mfjCtx,
    );
    await registry.invoke(
      "add_income",
      { workspaceId: 1, label: "Spouse", grossAnnualDollars: 100000, taxStatus: "taxed", filingRole: "spouse" },
      mfjCtx,
    );
    const baseline = (await registry.invoke("compute_take_home", { workspaceId: 1 }, mfjCtx)) as {
      annualTakeHomeDollars: number;
      federalTaxDollars: number;
      caTaxDollars: number;
    };

    // Spouse-owned $500/mo Roth 401k = $6,000/yr post-tax payroll.
    await registry.invoke(
      "add_savings",
      {
        workspaceId: 1,
        label: "Spouse Roth 401k",
        accountType: "roth_401k",
        monthlyContributionDollars: 500,
        filingRole: "spouse",
      },
      mfjCtx,
    );
    const withRoth = (await registry.invoke("compute_take_home", { workspaceId: 1 }, mfjCtx)) as {
      annualTakeHomeDollars: number;
      federalTaxDollars: number;
      caTaxDollars: number;
      preTaxDeductionsDollars: number;
      postTaxPayrollDollars: number;
      payrollPretaxDollars: number;
      payrollPostTaxDollars: number;
    };
    // (a) Taxable income untouched: federal and CA tax identical to baseline,
    //     and no pre-tax deduction appears anywhere.
    expect(withRoth.federalTaxDollars).toBe(baseline.federalTaxDollars);
    expect(withRoth.caTaxDollars).toBe(baseline.caTaxDollars);
    expect(withRoth.preTaxDeductionsDollars).toBe(0);
    expect(withRoth.payrollPretaxDollars).toBe(0);
    // (b) Take-home drops by exactly the withheld Roth amount (no tax offset).
    expect(withRoth.annualTakeHomeDollars).toBe(baseline.annualTakeHomeDollars - 6000);
    // (c) The contribution surfaces as post-tax payroll, both in the breakdown
    //     and the savings-sourced aggregate.
    expect(withRoth.postTaxPayrollDollars).toBe(6000);
    expect(withRoth.payrollPostTaxDollars).toBe(6000);
  });

  it("audit log captures every mutation with the source", async () => {
    await registry.invoke(
      "add_expense",
      { workspaceId: 1, label: "A", amountDollars: 1, frequency: "monthly" },
      { ...ctx, source: "in_app_llm" },
    );
    await registry.invoke(
      "add_expense",
      { workspaceId: 1, label: "B", amountDollars: 2, frequency: "monthly" },
      { ...ctx, source: "mcp_client" },
    );
    expect(ctx.audit.records.map((r) => r.source)).toEqual([
      "in_app_llm",
      "mcp_client",
    ]);
  });

  // -------------------------------------------------------------------------
  // M11: savings + retirement + sensitivity
  // -------------------------------------------------------------------------

  it("round-trips savings CRUD via the registry", async () => {
    const added = (await registry.invoke(
      "add_savings",
      {
        workspaceId: 1,
        label: "HYSA",
        currentBalanceDollars: 50000,
        monthlyContributionDollars: 5000,
        accountType: "hysa",
      },
      ctx,
    )) as { id: number };
    expect(added.id).toBeGreaterThan(0);

    const listed = (await registry.invoke(
      "list_savings",
      { workspaceId: 1 },
      ctx,
    )) as Array<{ label: string; currentBalanceDollars: number }>;
    expect(listed).toHaveLength(1);
    expect(listed[0]!.currentBalanceDollars).toBe(50000);

    await registry.invoke(
      "update_savings",
      { id: added.id, monthlyContributionDollars: 6000 },
      ctx,
    );
    const after = (await registry.invoke(
      "list_savings",
      { workspaceId: 1 },
      ctx,
    )) as Array<{ monthlyContributionDollars: number }>;
    expect(after[0]!.monthlyContributionDollars).toBe(6000);

    const del = (await registry.invoke(
      "delete_savings",
      { id: added.id },
      ctx,
    )) as { deleted: boolean };
    expect(del.deleted).toBe(true);
  });

  it("set_retirement_settings → get round-trips", async () => {
    await registry.invoke(
      "set_retirement_settings",
      {
        workspaceId: 1,
        currentAge: 30,
        retirementAge: 65,
        initialBalanceDollars: 100000,
        growthRate: 0.07,
        rothSplitPct: 0.5,
      },
      ctx,
    );
    const got = (await registry.invoke(
      "get_retirement_settings",
      { workspaceId: 1 },
      ctx,
    )) as { currentAge: number; retirementAge: number; growthRate: number };
    expect(got.currentAge).toBe(30);
    expect(got.retirementAge).toBe(65);
    expect(got.growthRate).toBeCloseTo(0.07, 6);
  });

  it("set_retirement_settings rejects retirementAge <= currentAge", async () => {
    await expect(
      registry.invoke(
        "set_retirement_settings",
        {
          workspaceId: 1,
          currentAge: 65,
          retirementAge: 65,
          initialBalanceDollars: 0,
          growthRate: 0.07,
          rothSplitPct: 0.5,
        },
        ctx,
      ),
    ).rejects.toThrow(/must be > currentAge/);
  });

  it("compute_retirement: sums 401k+IRA contributions from savings and projects", async () => {
    await registry.invoke(
      "set_retirement_settings",
      {
        workspaceId: 1,
        currentAge: 30,
        retirementAge: 65,
        initialBalanceDollars: 0,
        growthRate: 0.07,
        rothSplitPct: 0.5,
      },
      ctx,
    );
    // $1000/mo into a 401k + $500/mo into a Roth IRA = $18k/yr total
    await registry.invoke(
      "add_savings",
      {
        workspaceId: 1,
        label: "401k",
        monthlyContributionDollars: 1000,
        accountType: "traditional_401k",
      },
      ctx,
    );
    await registry.invoke(
      "add_savings",
      {
        workspaceId: 1,
        label: "Roth IRA",
        monthlyContributionDollars: 500,
        accountType: "roth_ira",
      },
      ctx,
    );
    // Add a HYSA — should NOT count toward retirement contributions
    await registry.invoke(
      "add_savings",
      {
        workspaceId: 1,
        label: "Emergency HYSA",
        monthlyContributionDollars: 200,
        accountType: "hysa",
      },
      ctx,
    );

    const result = (await registry.invoke(
      "compute_retirement",
      { workspaceId: 1 },
      ctx,
    )) as {
      years: Array<{ totalDollars: number }>;
      preTaxAtRetirementDollars: number;
      afterTaxAtRetirementDollars: number;
      annualContributionDollars: number;
    };
    // ($1000 + $500) * 12 = $18,000/yr (HYSA excluded)
    expect(result.annualContributionDollars).toBe(18000);
    expect(result.years).toHaveLength(36); // 30..65 inclusive
    // 35 years of $18k/yr at 7% end-of-year contributions → FV ≈ $2.49M.
    // Dollars: ~2,488,264. Allow a wide window.
    expect(result.preTaxAtRetirementDollars).toBeGreaterThan(2400000);
    expect(result.preTaxAtRetirementDollars).toBeLessThan(2600000);
    // After-tax must be less than pre-tax (Trad lane gets taxed)
    expect(result.afterTaxAtRetirementDollars).toBeLessThan(result.preTaxAtRetirementDollars);
  });

  it("compute_retirement: a %-of-salary account scales against its OWNING filer's salary", async () => {
    // Dual earner with deliberately unequal salaries so the two bases can't be
    // confused: primary $100k, spouse $200k.
    await registry.invoke(
      "add_income",
      {
        workspaceId: 1,
        label: "Primary Salary",
        grossAnnualDollars: 100_000,
        taxStatus: "taxed",
        filingRole: "primary",
      },
      ctx,
    );
    await registry.invoke(
      "add_income",
      {
        workspaceId: 1,
        label: "Spouse Salary",
        grossAnnualDollars: 200_000,
        taxStatus: "taxed",
        filingRole: "spouse",
      },
      ctx,
    );
    await registry.invoke(
      "set_retirement_settings",
      {
        workspaceId: 1,
        currentAge: 30,
        retirementAge: 65,
        initialBalanceDollars: 0,
        growthRate: 0.07,
        rothSplitPct: 0.5,
      },
      ctx,
    );
    // 10% of the SPOUSE's $200k, not 10% of the primary's $100k. The monthly
    // figure is rounded to the cent before annualizing, so $200k × 10% / 12 =
    // $1,666.67/mo → $20,000.04/yr. Keying off the primary would give $9,999.96.
    await registry.invoke(
      "add_savings",
      {
        workspaceId: 1,
        label: "Spouse 401k",
        accountType: "traditional_401k",
        contributionPctOfSalary: 0.1,
        filingRole: "spouse",
      },
      ctx,
    );
    const spouseOnly = (await registry.invoke(
      "compute_retirement",
      { workspaceId: 1 },
      ctx,
    )) as { annualContributionDollars: number };
    expect(spouseOnly.annualContributionDollars).toBe(20_000.04);

    // A primary-owned row still resolves against the primary's $100k: 10% is
    // $833.33/mo → $9,999.96/yr on top, for $30,000.00 combined.
    await registry.invoke(
      "add_savings",
      {
        workspaceId: 1,
        label: "Primary 401k",
        accountType: "traditional_401k",
        contributionPctOfSalary: 0.1,
        filingRole: "primary",
      },
      ctx,
    );
    const both = (await registry.invoke(
      "compute_retirement",
      { workspaceId: 1 },
      ctx,
    )) as { annualContributionDollars: number };
    expect(both.annualContributionDollars).toBe(30_000);
  });

  it("compute_retirement: errors if retirement_settings unset", async () => {
    await expect(
      registry.invoke("compute_retirement", { workspaceId: 1 }, ctx),
    ).rejects.toThrow(/No retirement_settings/);
  });

  it("compute_retirement: respects annualContributionDollarsOverride", async () => {
    await registry.invoke(
      "set_retirement_settings",
      {
        workspaceId: 1,
        currentAge: 30,
        retirementAge: 65,
        initialBalanceDollars: 0,
        growthRate: 0.07,
        rothSplitPct: 0.5,
      },
      ctx,
    );
    const result = (await registry.invoke(
      "compute_retirement",
      { workspaceId: 1, annualContributionDollarsOverride: 24000 },
      ctx,
    )) as { annualContributionDollars: number };
    expect(result.annualContributionDollars).toBe(24000);
  });

  it("compute_sensitivity: returns a 5x5 grid covering [primary] x [spouse]", async () => {
    // Add a small monthly expense so remaining < take-home
    await registry.invoke(
      "add_expense",
      {
        workspaceId: 1,
        label: "Rent",
        amountDollars: 2000,
        frequency: "monthly",
      },
      ctx,
    );
    const out = (await registry.invoke(
      "compute_sensitivity",
      {
        workspaceId: 1,
        primaryRangeDollars: [50000, 200000],
        spouseRangeDollars: [0, 100000],
      },
      ctx,
    )) as {
      primaryAxisDollars: number[];
      spouseAxisDollars: number[];
      grid: number[][];
    };
    expect(out.primaryAxisDollars).toHaveLength(5);
    expect(out.spouseAxisDollars).toHaveLength(5);
    expect(out.grid).toHaveLength(5);
    expect(out.grid[0]).toHaveLength(5);
    // Endpoints honor the requested range exactly (rounding to 2dp dollars).
    expect(out.primaryAxisDollars[0]).toBe(50000);
    expect(out.primaryAxisDollars[4]).toBe(200000);
    expect(out.spouseAxisDollars[0]).toBe(0);
    expect(out.spouseAxisDollars[4]).toBe(100000);
    // Monotonicity: more primary income → more monthly remaining at fixed spouse
    for (let s = 0; s < 5; s++) {
      const col = out.grid.map((row) => row[s]!);
      for (let i = 1; i < col.length; i++) {
        expect(col[i]).toBeGreaterThan(col[i - 1]!);
      }
    }
  });

  it("compute_sensitivity: gridSize=3 produces a 3x3 grid", async () => {
    const out = (await registry.invoke(
      "compute_sensitivity",
      {
        workspaceId: 1,
        primaryRangeDollars: [0, 100000],
        spouseRangeDollars: [0, 100000],
        gridSize: 3,
      },
      ctx,
    )) as { grid: number[][] };
    expect(out.grid).toHaveLength(3);
    expect(out.grid[0]).toHaveLength(3);
  });

  it("get_sensitivity_settings: returns null before any set", async () => {
    const got = await registry.invoke("get_sensitivity_settings", { workspaceId: 1 }, ctx);
    expect(got).toBeNull();
    // Read-only → no audit row.
    expect(ctx.audit.records).toHaveLength(0);
  });

  it("set_sensitivity_settings → get round-trips (dollars preserved)", async () => {
    const saved = (await registry.invoke(
      "set_sensitivity_settings",
      {
        workspaceId: 1,
        primaryLowDollars: 50000,
        primaryHighDollars: 200000,
        spouseLowDollars: 0,
        spouseHighDollars: 100000,
      },
      ctx,
    )) as { saved: boolean };
    expect(saved.saved).toBe(true);
    // Mutation → audited.
    expect(ctx.audit.records.map((r) => r.toolName)).toContain("set_sensitivity_settings");

    const got = (await registry.invoke(
      "get_sensitivity_settings",
      { workspaceId: 1 },
      ctx,
    )) as {
      primaryLowDollars: number;
      primaryHighDollars: number;
      spouseLowDollars: number;
      spouseHighDollars: number;
    };
    expect(got.primaryLowDollars).toBe(50000);
    expect(got.primaryHighDollars).toBe(200000);
    expect(got.spouseLowDollars).toBe(0);
    expect(got.spouseHighDollars).toBe(100000);
  });

  it("set_sensitivity_settings: upserts (second set overwrites the first)", async () => {
    await registry.invoke(
      "set_sensitivity_settings",
      { workspaceId: 1, primaryLowDollars: 50000, primaryHighDollars: 200000, spouseLowDollars: 0, spouseHighDollars: 100000 },
      ctx,
    );
    await registry.invoke(
      "set_sensitivity_settings",
      { workspaceId: 1, primaryLowDollars: 60000, primaryHighDollars: 150000, spouseLowDollars: 10000, spouseHighDollars: 90000 },
      ctx,
    );
    const got = (await registry.invoke(
      "get_sensitivity_settings",
      { workspaceId: 1 },
      ctx,
    )) as { primaryLowDollars: number; spouseLowDollars: number };
    expect(got.primaryLowDollars).toBe(60000);
    expect(got.spouseLowDollars).toBe(10000);
  });

  it("set_sensitivity_settings: rejects primaryLow >= primaryHigh", async () => {
    await expect(
      registry.invoke(
        "set_sensitivity_settings",
        { workspaceId: 1, primaryLowDollars: 200000, primaryHighDollars: 50000, spouseLowDollars: 0, spouseHighDollars: 100000 },
        ctx,
      ),
    ).rejects.toThrow(/primaryLowDollars.*must be < primaryHighDollars/);
  });

  it("set_sensitivity_settings: rejects spouseLow > spouseHigh", async () => {
    await expect(
      registry.invoke(
        "set_sensitivity_settings",
        { workspaceId: 1, primaryLowDollars: 50000, primaryHighDollars: 200000, spouseLowDollars: 100000, spouseHighDollars: 0 },
        ctx,
      ),
    ).rejects.toThrow(/spouseLowDollars.*must be <= spouseHighDollars/);
  });

  it("set_sensitivity_settings: allows spouseLow == spouseHigh (degenerate column)", async () => {
    const saved = (await registry.invoke(
      "set_sensitivity_settings",
      { workspaceId: 1, primaryLowDollars: 50000, primaryHighDollars: 200000, spouseLowDollars: 0, spouseHighDollars: 0 },
      ctx,
    )) as { saved: boolean };
    expect(saved.saved).toBe(true);
  });

  // -------------------------------------------------------------------------
  // M11 follow-ups (AHS round-2 fixes)
  // -------------------------------------------------------------------------

  it("compute_sensitivity: single-filer workspace uses per-cell filing (s=0 single, s>0 MFJ)", async () => {
    // Filing is "single" by default in the test fake. The grid models a
    // what-if: s=0 column reflects the user's real single-filer baseline;
    // s>0 columns are MFJ (a two-earner cell is only coherent as a married
    // household). Replaces the old assertion that all cells were identical
    // — that assertion documented a bug where the spouse axis was ignored.
    const out = (await registry.invoke(
      "compute_sensitivity",
      {
        workspaceId: 1,
        primaryRangeDollars: [100000, 100000],
        spouseRangeDollars: [0, 100000],
      },
      ctx,
    )) as { grid: number[][]; spouseAxisDollars: number[]; filing: string };
    // The echoed `filing` reflects the workspace baseline (used for s=0 cells).
    expect(out.filing).toBe("single");
    expect(out.spouseAxisDollars).toHaveLength(5);
    expect(out.spouseAxisDollars[0]).toBe(0);
    expect(out.spouseAxisDollars[4]).toBe(100000);
    const row = out.grid[0]!;
    // s>0 cells must differ from the s=0 baseline (proves MFJ math is being
    // applied for two-earner cells rather than being silently ignored).
    expect(row[1]).not.toBe(row[0]);
    expect(row[4]).not.toBe(row[0]);
    // The grid should be monotonically non-decreasing along the spouse axis
    // for s>0 (more spouse income → more household take-home → higher remaining,
    // even after MFJ progressive bracket impact).
    for (let i = 2; i < row.length; i++) {
      expect(row[i]).toBeGreaterThanOrEqual(row[i - 1]!);
    }
  });

  it("catalogue_expenses: rejects paths outside ./statements/ allowlist", async () => {
    // The tool must refuse any path that doesn't resolve under the
    // ./statements/ directory of the project root. Critical for security:
    // the LLM could otherwise be coerced into reading arbitrary files.
    const out = (await registry.invoke(
      "catalogue_expenses",
      { statementPaths: ["/etc/passwd", "../../README.md"] },
      ctx,
    )) as {
      parsedFiles: number;
      parseErrors: Array<{ path: string; error: string }>;
      candidates: unknown[];
    };
    expect(out.parsedFiles).toBe(0);
    expect(out.parseErrors).toHaveLength(2);
    expect(out.parseErrors[0]!.error).toMatch(/allowlist/);
    expect(out.parseErrors[1]!.error).toMatch(/allowlist/);
    expect(out.candidates).toEqual([]);
  });

  it("catalogue_expenses: commit:true requires workspaceId", async () => {
    await expect(
      registry.invoke(
        "catalogue_expenses",
        { statementPaths: ["statements/anything.pdf"], commit: true },
        ctx,
      ),
    ).rejects.toThrow(/commit:true requires workspaceId/);
  });

  it("compute_sensitivity: MFS workspace falls back to MFJ for s=0 cells without crashing", async () => {
    // The fixture seeds {single, mfj} brackets only — no MFS. Pre-B4 this
    // test would have thrown inside takeHome (`Missing tax_table for ...
    // filing=mfs`) on the very first s=0 cell, aborting the entire grid.
    // After B4 the handler retries the cell as MFJ and surfaces a
    // `fallbackCells` count so the UI can flag the approximation.
    const mfsCtx: typeof ctx = {
      ...ctx,
      tax: {
        ...ctx.tax,
        settingsForWorkspace: () => ({
          ...ctx.tax.settingsForWorkspace(1),
          filing: "mfs",
        }),
      },
    };
    const out = (await registry.invoke(
      "compute_sensitivity",
      {
        workspaceId: 1,
        primaryRangeDollars: [100000, 100000],
        spouseRangeDollars: [0, 100000],
      },
      mfsCtx,
    )) as { grid: number[][]; filing: string; fallbackCells: number };
    // Filing is echoed as the workspace's baseline (mfs), not the cell-level value.
    expect(out.filing).toBe("mfs");
    // Grid is 5×5 (default gridSize=5, applied to BOTH axes even when lo==hi).
    // The s=0 column has 5 cells (one per primary axis row), each of which
    // fell back to MFJ. The s>0 columns use MFJ natively (which IS seeded),
    // so no fallback there.
    expect(out.fallbackCells).toBe(5);
    expect(out.grid).toHaveLength(5);
    expect(out.grid[0]).toHaveLength(5);
  });

  it("compute_sensitivity: rejects lo > hi for either range", async () => {
    await expect(
      registry.invoke(
        "compute_sensitivity",
        {
          workspaceId: 1,
          primaryRangeDollars: [200000, 50000],
          spouseRangeDollars: [0, 100000],
        },
        ctx,
      ),
    ).rejects.toThrow(/primaryRangeDollars low.*must be <= high/);
    await expect(
      registry.invoke(
        "compute_sensitivity",
        {
          workspaceId: 1,
          primaryRangeDollars: [0, 100000],
          spouseRangeDollars: [100000, 0],
        },
        ctx,
      ),
    ).rejects.toThrow(/spouseRangeDollars low.*must be <= high/);
  });

  it("compute_sensitivity: monotonicity holds along BOTH axes for MFJ", async () => {
    // Override filing in the ctx tax repo to mfj for this test only.
    const mfjCtx: typeof ctx = {
      ...ctx,
      tax: {
        ...ctx.tax,
        settingsForWorkspace: () => ({
          ...ctx.tax.settingsForWorkspace(1),
          filing: "mfj",
        }),
      },
    };
    const out = (await registry.invoke(
      "compute_sensitivity",
      {
        workspaceId: 1,
        primaryRangeDollars: [50000, 200000],
        spouseRangeDollars: [0, 100000],
      },
      mfjCtx,
    )) as { grid: number[][] };
    // Strictly increasing along the primary axis (each column).
    for (let s = 0; s < 5; s++) {
      const col = out.grid.map((r) => r[s]!);
      for (let i = 1; i < col.length; i++) {
        expect(col[i]).toBeGreaterThan(col[i - 1]!);
      }
    }
    // Strictly increasing along the spouse axis (each row).
    for (let p = 0; p < 5; p++) {
      const row = out.grid[p]!;
      for (let j = 1; j < row.length; j++) {
        expect(row[j]).toBeGreaterThan(row[j - 1]!);
      }
    }
  });

  it("compute_sensitivity (MFJ): a SPOUSE-owned %-of-salary 401k moves the spouse axis, not the primary axis", async () => {
    const mfjCtx: typeof ctx = {
      ...ctx,
      tax: {
        ...ctx.tax,
        settingsForWorkspace: () => ({ ...ctx.tax.settingsForWorkspace(1), filing: "mfj" }),
      },
    };
    const args = {
      workspaceId: 1,
      primaryRangeDollars: [50000, 150000],
      spouseRangeDollars: [0, 100000],
    };
    const baseline = (await registry.invoke("compute_sensitivity", args, mfjCtx)) as {
      grid: number[][];
      spouseAxisDollars: number[];
    };
    expect(baseline.spouseAxisDollars).toEqual([0, 25000, 50000, 75000, 100000]);

    // Spouse contributes 10% of THEIR salary to a traditional 401k.
    await registry.invoke(
      "add_savings",
      {
        workspaceId: 1,
        label: "Spouse 401k",
        accountType: "traditional_401k",
        contributionPctOfSalary: 0.1,
        filingRole: "spouse",
      },
      mfjCtx,
    );
    const withK = (await registry.invoke("compute_sensitivity", args, mfjCtx)) as {
      grid: number[][];
    };

    for (let i = 0; i < 5; i++) {
      // s=0 column UNCHANGED for every primary income: the spouse's
      // %-of-salary contribution is 10% of $0 there. Under the legacy bug the
      // row resolved against the swept PRIMARY income p, which would have
      // dragged this whole column down by ~10% of p — this is the
      // regression-catching assertion.
      expect(withK.grid[i]![0]).toBe(baseline.grid[i]![0]);
      // s>0 cells strictly lower (the spouse 401k is really withheld), and the
      // reduction strictly GROWS along the spouse axis (contribution = 10% of
      // s; the net take-home hit grows since marginal rates < 100%).
      let prevDelta = 0; // delta at j=0 is exactly 0
      for (let j = 1; j < 5; j++) {
        expect(withK.grid[i]![j]).toBeLessThan(baseline.grid[i]![j]!);
        const delta = baseline.grid[i]![j]! - withK.grid[i]![j]!;
        expect(delta).toBeGreaterThan(prevDelta);
        prevDelta = delta;
      }
    }
  });

  it("compute_sensitivity (MFJ): a PRIMARY-owned %-of-salary 401k does not leak onto the spouse axis", async () => {
    const mfjCtx: typeof ctx = {
      ...ctx,
      tax: {
        ...ctx.tax,
        settingsForWorkspace: () => ({ ...ctx.tax.settingsForWorkspace(1), filing: "mfj" }),
      },
    };
    const args = {
      workspaceId: 1,
      primaryRangeDollars: [0, 100000],
      spouseRangeDollars: [0, 100000],
    };
    const baseline = (await registry.invoke("compute_sensitivity", args, mfjCtx)) as {
      grid: number[][];
    };
    await registry.invoke(
      "add_savings",
      {
        workspaceId: 1,
        label: "Primary 401k",
        accountType: "traditional_401k",
        contributionPctOfSalary: 0.1,
        // filingRole omitted → defaults to 'primary'
      },
      mfjCtx,
    );
    const withK = (await registry.invoke("compute_sensitivity", args, mfjCtx)) as {
      grid: number[][];
    };
    for (let j = 0; j < 5; j++) {
      // p=0 row unchanged: 10% of $0 primary salary is $0 regardless of spouse income.
      expect(withK.grid[0]![j]).toBe(baseline.grid[0]![j]);
      // p>0 rows strictly lower: the primary's 401k is withheld in every cell.
      for (let i = 1; i < 5; i++) {
        expect(withK.grid[i]![j]).toBeLessThan(baseline.grid[i]![j]!);
      }
    }
  });

  it("compute_sensitivity (single-earner): grid values match the legacy single-salary formula exactly (regression guard)", async () => {
    // All-primary savings + zero spouse axis must reproduce the pre-A6 cell
    // values bit-for-bit: hand-compute each cell with takeHome() using the
    // legacy "all withholdings against primary income" figure.
    await registry.invoke(
      "add_savings",
      {
        workspaceId: 1,
        label: "401k",
        accountType: "traditional_401k",
        monthlyContributionDollars: 1000, // flat $12,000/yr — salary-independent
      },
      ctx,
    );
    const out = (await registry.invoke(
      "compute_sensitivity",
      {
        workspaceId: 1,
        primaryRangeDollars: [60000, 120000],
        spouseRangeDollars: [0, 0],
      },
      ctx,
    )) as { grid: number[][]; primaryAxisDollars: number[]; spouseAxisDollars: number[] };
    expect(out.primaryAxisDollars).toEqual([60000, 75000, 90000, 105000, 120000]);
    expect(out.spouseAxisDollars).toEqual([0, 0, 0, 0, 0]);

    const settings = ctx.tax.settingsForWorkspace(1);
    const tables = ctx.tax.tables(settings.taxYear);
    for (let i = 0; i < 5; i++) {
      const p = out.primaryAxisDollars[i]!;
      const th = takeHome({
        primary: {
          grossAnnualDollars: p,
          pretax401kDollars: 12000, // legacy resolveWithholdings(rows, p) for a flat row
          pretaxHealthDollars: 0,
          postTaxPayrollDollars: 0,
        },
        settings,
        tables,
      });
      const expected = round2(th.annualTakeHomeDollars / 12); // no expenses in ctx
      for (let j = 0; j < 5; j++) {
        expect(out.grid[i]![j]).toBe(expected);
      }
    }
  });

  // -------------------------------------------------------------------------
  // M7+: tax-source ingest (fetch_tax_source + set_tax_table)
  // -------------------------------------------------------------------------

  it("fetch_tax_source: passes through to the web repo and returns body", async () => {
    const ctxWithFetch: typeof ctx = {
      ...ctx,
      web: {
        fetch: async (url: string) => ({
          status: 200,
          body: `<!doctype html><h1>${url}</h1>`,
          truncated: false,
          finalUrl: url,
        }),
      },
    };
    const out = (await registry.invoke(
      "fetch_tax_source",
      { url: "https://www.irs.gov/some-page" },
      ctxWithFetch,
    )) as { status: number; body: string; finalUrl: string };
    expect(out.status).toBe(200);
    expect(out.body).toMatch(/some-page/);
    expect(out.finalUrl).toBe("https://www.irs.gov/some-page");
  });

  it("set_tax_table: dryRun returns echo and does NOT call upsertTable", async () => {
    let upsertCalls = 0;
    const ctxWithRecord: typeof ctx = {
      ...ctx,
      tax: {
        ...ctx.tax,
        upsertTable: () => {
          upsertCalls++;
          return { saved: true };
        },
      },
    };
    const out = (await registry.invoke(
      "set_tax_table",
      {
        year: 2026,
        jurisdiction: "federal",
        filing: "mfj",
        standardDeductionDollars: 32000,
        brackets: [
          { upTo: 24000, rate: 0.1 },
          { upTo: 98000, rate: 0.12 },
          { rate: 0.37 },
        ],
        sourceUrl: "https://www.irs.gov/newsroom/...",
        dryRun: true,
      },
      ctxWithRecord,
    )) as { saved: boolean; dryRun: boolean; brackets: unknown[] };
    expect(out.saved).toBe(false);
    expect(out.dryRun).toBe(true);
    expect(out.brackets).toHaveLength(3);
    expect(upsertCalls).toBe(0);
  });

  it("set_tax_table: live (no dryRun) calls upsertTable and returns saved:true", async () => {
    let upsertCalls = 0;
    const ctxWithRecord: typeof ctx = {
      ...ctx,
      tax: {
        ...ctx.tax,
        upsertTable: () => {
          upsertCalls++;
          return { saved: true };
        },
      },
    };
    const out = (await registry.invoke(
      "set_tax_table",
      {
        year: 2026,
        jurisdiction: "federal",
        filing: "single",
        standardDeductionDollars: 16000,
        brackets: [
          { upTo: 12000, rate: 0.1 },
          { upTo: 49000, rate: 0.12 },
          { rate: 0.37 },
        ],
        sourceUrl: "https://www.irs.gov/newsroom/...",
      },
      ctxWithRecord,
    )) as { saved: boolean; dryRun: boolean };
    expect(out.saved).toBe(true);
    expect(out.dryRun).toBe(false);
    expect(upsertCalls).toBe(1);
  });

  it("set_tax_table: rejects non-ascending brackets", async () => {
    await expect(
      registry.invoke(
        "set_tax_table",
        {
          year: 2026,
          jurisdiction: "federal",
          filing: "single",
          standardDeductionDollars: 15000,
          brackets: [
            { upTo: 49000, rate: 0.12 },
            { upTo: 12000, rate: 0.1 }, // OUT OF ORDER
            { rate: 0.37 },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow(/ascending/);
  });

  it("set_tax_table: rejects missing top-bracket null", async () => {
    await expect(
      registry.invoke(
        "set_tax_table",
        {
          year: 2026,
          jurisdiction: "federal",
          filing: "single",
          standardDeductionDollars: 15000,
          brackets: [
            { upTo: 12000, rate: 0.1 },
            { upTo: 49000, rate: 0.12 }, // missing null sentinel
          ],
        },
        ctx,
      ),
    ).rejects.toThrow(/last bracket must omit upTo/i);
  });

  it("set_tax_table: rejects decreasing rate (non-monotone)", async () => {
    await expect(
      registry.invoke(
        "set_tax_table",
        {
          year: 2026,
          jurisdiction: "federal",
          filing: "single",
          standardDeductionDollars: 15000,
          brackets: [
            { upTo: 12000, rate: 0.2 },
            { upTo: 49000, rate: 0.1 }, // rate goes DOWN
            { rate: 0.37 },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow(/non-decreasing/);
  });

  it("compute_retirement: sums savings_items.currentBalanceDollars into initial balance", async () => {
    await registry.invoke(
      "set_retirement_settings",
      {
        workspaceId: 1,
        currentAge: 64,
        retirementAge: 65,
        initialBalanceDollars: 100000,
        growthRate: 0,
        rothSplitPct: 0.5,
      },
      ctx,
    );
    // Add a 401k with $200k current balance + $0 monthly so growth is solely
    // from the initial balance.
    await registry.invoke(
      "add_savings",
      {
        workspaceId: 1,
        label: "401k",
        currentBalanceDollars: 200000,
        monthlyContributionDollars: 0,
        accountType: "traditional_401k",
      },
      ctx,
    );
    // Add a HYSA — must NOT contribute to retirement initial.
    await registry.invoke(
      "add_savings",
      {
        workspaceId: 1,
        label: "HYSA",
        currentBalanceDollars: 50000,
        accountType: "hysa",
      },
      ctx,
    );
    const result = (await registry.invoke(
      "compute_retirement",
      { workspaceId: 1 },
      ctx,
    )) as {
      initialBalanceDollars: number;
      preTaxAtRetirementDollars: number;
      years: Array<{ totalDollars: number }>;
    };
    // Stored 100k + retirement-tagged 200k = 300k. HYSA 50k is excluded.
    expect(result.initialBalanceDollars).toBe(300000);
    expect(result.years[0]!.totalDollars).toBe(300000);
  });
});

describe("validateArgs — primitive boundary cases", () => {
  it("rejects non-finite numbers", () => {
    expect(() =>
      validateArgs({ type: "number" }, Number.POSITIVE_INFINITY),
    ).toThrow(ToolArgError);
    expect(() => validateArgs({ type: "number" }, NaN)).toThrow(ToolArgError);
  });

  it("accepts integer 0 at minimum:0", () => {
    expect(() => validateArgs({ type: "integer", minimum: 0 }, 0)).not.toThrow();
  });

  it("rejects float when integer required", () => {
    expect(() => validateArgs({ type: "integer" }, 1.5)).toThrow(ToolArgError);
  });

  it("validates nested arrays", () => {
    const schema = {
      type: "array",
      items: { type: "object", properties: { x: { type: "integer" } }, required: ["x"] },
    } as const;
    expect(() => validateArgs(schema, [{ x: 1 }, { x: 2 }])).not.toThrow();
    expect(() => validateArgs(schema, [{ x: 1 }, { y: 2 }])).toThrow(/missing required/);
  });
});

// catalogue_expenses tool acceptedKeys filter — gated on real ./statements/
// being present with at least one *.pdf or *.xlsx file (CI without personal
// data skips). Uses the in-memory ctx fake to exercise the commit path
// without touching a real DB.
describe("catalogue_expenses tool — acceptedKeys filter", () => {
  // The tool resolves statementPaths against process.cwd(), so chdir into
  // the project root for these tests (vitest starts in packages/core/).
  const projectRoot = resolve(__dirname, "..", "..", "..");
  const statementsRoot = join(projectRoot, "statements");

  /** Walk statements/ up to 2 levels deep and return the first pdf/xlsx path found, or null. */
  function findAnyStatementFile(): string | null {
    if (!existsSync(statementsRoot)) return null;
    for (const entry of readdirSync(statementsRoot, { withFileTypes: true })) {
      const ext = entry.name.split(".").pop()?.toLowerCase();
      if (!entry.isDirectory() && (ext === "pdf" || ext === "xlsx")) {
        return join(statementsRoot, entry.name);
      }
      if (entry.isDirectory()) {
        const sub = join(statementsRoot, entry.name);
        for (const subEntry of readdirSync(sub, { withFileTypes: true })) {
          const subExt = subEntry.name.split(".").pop()?.toLowerCase();
          if (!subEntry.isDirectory() && (subExt === "pdf" || subExt === "xlsx")) {
            return join(sub, subEntry.name);
          }
        }
      }
    }
    return null;
  }

  const shouldRun = findAnyStatementFile() !== null;

  if (!shouldRun) {
    if (existsSync(statementsRoot)) {
      console.warn(
        "[tool_registry.test] statements/ exists but contains no *.pdf or *.xlsx files — " +
        "skipping catalogue_expenses acceptedKeys tests.",
      );
    }
    it.skip("statements/ with *.pdf/*.xlsx present → would exercise acceptedKeys round-trip", () => {});
    return;
  }

  let prevCwd = "";
  beforeEach(() => {
    prevCwd = process.cwd();
    process.chdir(projectRoot);
  });
  afterEach(() => {
    process.chdir(prevCwd);
  });

  async function previewCandidates(): Promise<{
    candidates: Array<{
      label: string;
      sourceAccount: string;
      amountDollars: number;
      frequency: string;
    }>;
    paths: string[];
  }> {
    // Discover what's actually in ./statements/ via list_statements so the
    // test stays robust to whatever fixtures the dev has.
    const ctx = mkMemoryCtx();
    const registry = new ToolRegistry(ALL_TOOLS);
    const ls = (await registry.invoke("list_statements", {}, ctx)) as {
      files: Array<{ relativePath: string; kind: string }>;
    };
    const paths = ls.files
      .filter((f) => f.kind !== "unknown")
      .map((f) => f.relativePath)
      .slice(0, 4); // cap so the test stays fast (~PDF parsing is slow)
    if (paths.length === 0) {
      // Guard: shouldRun already checked for pdf/xlsx files, so this branch
      // should not be reachable. If it is, warn and return empty so the
      // calling it() will receive empty candidates rather than hard-failing.
      console.warn(
        "[tool_registry.test] list_statements returned no recognized files — skipping acceptedKeys test body.",
      );
      return { candidates: [], paths: [] };
    }
    const preview = (await registry.invoke(
      "catalogue_expenses",
      { statementPaths: paths },
      ctx,
    )) as { candidates: Array<{ label: string; sourceAccount: string; amountDollars: number; frequency: string }> };
    return { candidates: preview.candidates, paths };
  }

  function candidateKey(c: { label: string; sourceAccount: string; amountDollars: number; frequency: string }): string {
    return `${c.label}|${c.sourceAccount}|${c.amountDollars}|${c.frequency}`;
  }

  it("commit with no acceptedKeys writes all candidates", async () => {
    const { candidates, paths } = await previewCandidates();
    const ctx = mkMemoryCtx();
    const registry = new ToolRegistry(ALL_TOOLS);
    const res = (await registry.invoke(
      "catalogue_expenses",
      { statementPaths: paths, commit: true, workspaceId: 1 },
      ctx,
    )) as { committedIds: number[] };
    expect(res.committedIds.length).toBeGreaterThan(0);
    expect(res.committedIds.length).toBeLessThanOrEqual(candidates.length);
  }, 60_000);

  it("commit with acceptedKeys=[] writes zero expenses", async () => {
    const { paths } = await previewCandidates();
    const ctx = mkMemoryCtx();
    const registry = new ToolRegistry(ALL_TOOLS);
    const res = (await registry.invoke(
      "catalogue_expenses",
      { statementPaths: paths, commit: true, workspaceId: 1, acceptedKeys: [] },
      ctx,
    )) as { committedIds: number[] };
    expect(res.committedIds).toEqual([]);
  }, 60_000);

  it("commit with a 2-candidate subset writes exactly those two", async () => {
    const { candidates, paths } = await previewCandidates();
    if (candidates.length < 2) return; // need at least 2 to test
    const subset = candidates.slice(0, 2);
    const keys = subset.map(candidateKey);
    const ctx = mkMemoryCtx();
    const registry = new ToolRegistry(ALL_TOOLS);
    const res = (await registry.invoke(
      "catalogue_expenses",
      { statementPaths: paths, commit: true, workspaceId: 1, acceptedKeys: keys },
      ctx,
    )) as { committedIds: number[] };
    expect(res.committedIds.length).toBe(2);
    // Confirm exactly the chosen rows landed in the in-memory store.
    const rows = ctx.expenses.list(1);
    expect(rows.map((r) => r.label).sort()).toEqual(subset.map((c) => c.label).sort());
  }, 60_000);
});

// ---------------------------------------------------------------------------
// C1 — mutation gate at the registry boundary (audit MCP-1 / API-3 / API-4).
// A registry constructed with { requireMutationConsent: true } refuses to run
// mutating tools unless invoke() carries { mutationConsent: true }. Read-only
// tools are never gated; an ungated registry keeps legacy behavior.
// ---------------------------------------------------------------------------
describe("ToolRegistry — mutation gate (requireMutationConsent)", () => {
  it("rejects a mutating tool without consent: NeedsConfirmationError, handler NOT run", async () => {
    const ctx = mkMemoryCtx();
    const registry = new ToolRegistry(ALL_TOOLS, { requireMutationConsent: true });
    await expect(
      registry.invoke(
        "add_expense",
        { workspaceId: 1, label: "Gated", amountDollars: 10, frequency: "monthly" },
        ctx,
      ),
    ).rejects.toMatchObject({
      name: "NeedsConfirmationError",
      code: "needs_confirmation",
      toolName: "add_expense",
    });
    // The handler must not have executed.
    expect(ctx.expenses.list(1)).toHaveLength(0);
  });

  it("error shape: instance of NeedsConfirmationError with an actionable message", async () => {
    const ctx = mkMemoryCtx();
    const registry = new ToolRegistry(ALL_TOOLS, { requireMutationConsent: true });
    try {
      await registry.invoke("delete_workspace", { id: 1 }, ctx);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(NeedsConfirmationError);
      expect((e as NeedsConfirmationError).message).toMatch(/delete_workspace/);
      expect((e as NeedsConfirmationError).message).toMatch(/confirm/i);
    }
  });

  it("explicit mutationConsent: false is NOT consent", async () => {
    const ctx = mkMemoryCtx();
    const registry = new ToolRegistry(ALL_TOOLS, { requireMutationConsent: true });
    await expect(
      registry.invoke(
        "add_expense",
        { workspaceId: 1, label: "Gated", amountDollars: 10, frequency: "monthly" },
        ctx,
        { mutationConsent: false },
      ),
    ).rejects.toBeInstanceOf(NeedsConfirmationError);
  });

  it("executes the mutation when mutationConsent: true is passed", async () => {
    const ctx = mkMemoryCtx();
    const registry = new ToolRegistry(ALL_TOOLS, { requireMutationConsent: true });
    const added = (await registry.invoke(
      "add_expense",
      { workspaceId: 1, label: "Consented", amountDollars: 25, frequency: "monthly" },
      ctx,
      { mutationConsent: true },
    )) as { id: number };
    expect(added.id).toBeGreaterThan(0);
    expect(ctx.expenses.list(1)).toHaveLength(1);
    // Normal mutation audit row (ok: true) was written.
    expect(ctx.audit.records).toHaveLength(1);
    expect(JSON.parse(ctx.audit.records[0]!.resultJson)).toMatchObject({ ok: true });
  });

  it("read-only tools are unaffected by the gate (no consent needed)", async () => {
    const ctx = mkMemoryCtx();
    const registry = new ToolRegistry(ALL_TOOLS, { requireMutationConsent: true });
    const result = (await registry.invoke("list_workspaces", {}, ctx)) as Array<{ name: string }>;
    expect(result[0]!.name).toBe("Current");
    // Read-only stays audit-free, gated or not.
    expect(ctx.audit.records).toHaveLength(0);
  });

  it("a blocked attempt writes a redacted audit row (refusals are auditable)", async () => {
    const ctx = mkMemoryCtx();
    const registry = new ToolRegistry(ALL_TOOLS, { requireMutationConsent: true });
    await expect(
      registry.invoke(
        "add_expense",
        { workspaceId: 1, label: "SECRET BLOCKED LLC", amountDollars: 77, frequency: "monthly" },
        ctx,
      ),
    ).rejects.toBeInstanceOf(NeedsConfirmationError);
    expect(ctx.audit.records).toHaveLength(1);
    const rec = ctx.audit.records[0]!;
    expect(rec.toolName).toBe("add_expense");
    expect(JSON.parse(rec.resultJson)).toMatchObject({ ok: false, error: "needs_confirmation" });
    // Redaction applies to blocked attempts too (CWE-200).
    expect(rec.argsJson).not.toContain("SECRET BLOCKED LLC");
  });

  it("validation precedes the gate: malformed args throw ToolArgError even without consent", async () => {
    const ctx = mkMemoryCtx();
    const registry = new ToolRegistry(ALL_TOOLS, { requireMutationConsent: true });
    await expect(
      registry.invoke("add_expense", { label: "missing-everything" }, ctx),
    ).rejects.toThrow(ToolArgError);
    // Validation failures never reach the audit log (same as ungated registry).
    expect(ctx.audit.records).toHaveLength(0);
  });

  it("an UNGATED registry (default opts) keeps legacy behavior: mutations run without consent", async () => {
    const ctx = mkMemoryCtx();
    const registry = new ToolRegistry(ALL_TOOLS);
    const added = (await registry.invoke(
      "add_expense",
      { workspaceId: 1, label: "Legacy", amountDollars: 5, frequency: "monthly" },
      ctx,
    )) as { id: number };
    expect(added.id).toBeGreaterThan(0);
    expect(ctx.audit.records).toHaveLength(1);
  });

  it("isMutating(): false for readOnly tools, true for mutations and unknown names", () => {
    const registry = new ToolRegistry(ALL_TOOLS);
    expect(registry.isMutating("list_workspaces")).toBe(false);
    expect(registry.isMutating("compute_take_home")).toBe(false);
    expect(registry.isMutating("add_expense")).toBe(true);
    expect(registry.isMutating("delete_workspace")).toBe(true);
    expect(registry.isMutating("not_a_tool")).toBe(true); // fail safe
  });
});

// ---------------------------------------------------------------------------
// Schema hardening: `pattern` on date strings, `nullable` for explicit clears
// ---------------------------------------------------------------------------

describe("validateArgs — pattern + nullable", () => {
  const dateSchema = { type: "string" as const, pattern: "^\\d{4}-\\d{2}-\\d{2}$" };

  it("accepts a YYYY-MM-DD string and rejects other date shapes", () => {
    expect(() => validateArgs(dateSchema, "2026-03-04")).not.toThrow();
    expect(() => validateArgs(dateSchema, "03/04/2026")).toThrow(ToolArgError);
    expect(() => validateArgs(dateSchema, "last Tuesday")).toThrow(ToolArgError);
    expect(() => validateArgs(dateSchema, "2026-3-4")).toThrow(ToolArgError);
  });

  it("is a FORMAT check only — an impossible calendar date still passes", () => {
    expect(() => validateArgs(dateSchema, "2025-13-45")).not.toThrow();
  });

  it("accepts null only where nullable is set", () => {
    expect(() => validateArgs({ type: "integer", nullable: true }, null)).not.toThrow();
    expect(() => validateArgs({ type: "integer" }, null)).toThrow(ToolArgError);
    // nullable does not weaken the non-null path.
    expect(() => validateArgs({ type: "integer", nullable: true }, "7")).toThrow(ToolArgError);
  });

  it("rejects a null on add_expense.categoryId (omission means auto-categorize)", async () => {
    const ctx = mkMemoryCtx();
    const registry = new ToolRegistry(ALL_TOOLS);
    await expect(
      registry.invoke(
        "add_expense",
        { workspaceId: 1, label: "X", amountDollars: 5, frequency: "monthly", categoryId: null },
        ctx,
      ),
    ).rejects.toThrow(ToolArgError);
  });

  it("update_expense accepts null to CLEAR categoryId and spendDate", async () => {
    const ctx = mkMemoryCtx();
    const registry = new ToolRegistry(ALL_TOOLS);
    const { id } = (await registry.invoke(
      "add_expense",
      {
        workspaceId: 1,
        label: "Sofa",
        amountDollars: 500,
        frequency: "one_time",
        spendDate: "2026-02-01",
        categoryId: 4,
      },
      ctx,
    )) as { id: number };
    expect(ctx.expenses.list(1).find((e) => e.id === id)!.categoryId).toBe(4);

    await registry.invoke("update_expense", { id, categoryId: null, spendDate: null }, ctx);
    const row = ctx.expenses.list(1).find((e) => e.id === id)!;
    expect(row.categoryId).toBeNull();
    expect(row.spendDate).toBeNull();
  });

  it("rejects a malformed spendDate on add_expense", async () => {
    const ctx = mkMemoryCtx();
    const registry = new ToolRegistry(ALL_TOOLS);
    await expect(
      registry.invoke(
        "add_expense",
        { workspaceId: 1, label: "X", amountDollars: 5, frequency: "one_time", spendDate: "March 4th" },
        ctx,
      ),
    ).rejects.toThrow(ToolArgError);
  });
});

describe("employer-match fraction guard", () => {
  let ctx: ReturnType<typeof mkMemoryCtx>;
  let registry: ToolRegistry;
  beforeEach(() => {
    ctx = mkMemoryCtx();
    registry = new ToolRegistry(ALL_TOOLS);
  });

  it("rejects a percent-shaped employerMatchValue when the kind is pct_of_salary", async () => {
    await expect(
      registry.invoke(
        "add_savings",
        {
          workspaceId: 1,
          label: "401k",
          accountType: "traditional_401k",
          employerMatchKind: "pct_of_salary",
          employerMatchValue: 5, // meant 5%, i.e. 0.05
        },
        ctx,
      ),
    ).rejects.toThrow(/0\.\.1 fraction/);
  });

  it("still allows a large flat_annual_dollars match", async () => {
    const r = (await registry.invoke(
      "add_savings",
      {
        workspaceId: 1,
        label: "401k",
        accountType: "traditional_401k",
        employerMatchKind: "flat_annual_dollars",
        employerMatchValue: 12000,
      },
      ctx,
    )) as { id: number };
    expect(r.id).toBeGreaterThan(0);
  });

  it("applies to update_savings when kind and value arrive together", async () => {
    const { id } = (await registry.invoke(
      "add_savings",
      { workspaceId: 1, label: "401k", accountType: "traditional_401k" },
      ctx,
    )) as { id: number };
    await expect(
      registry.invoke(
        "update_savings",
        { id, employerMatchKind: "pct_of_salary", employerMatchValue: 5 },
        ctx,
      ),
    ).rejects.toThrow(/0\.\.1 fraction/);
  });
});

// ---------------------------------------------------------------------------
// New tools: taxonomy, tax settings, budget summary, transaction queries
// ---------------------------------------------------------------------------

describe("list_categories / get_tax_settings / update_tax_settings", () => {
  let ctx: ReturnType<typeof mkMemoryCtx>;
  let registry: ToolRegistry;
  beforeEach(() => {
    ctx = mkMemoryCtx();
    registry = new ToolRegistry(ALL_TOOLS);
  });

  it("list_categories returns the taxonomy and writes no audit row", async () => {
    const rows = (await registry.invoke("list_categories", {}, ctx)) as Array<{
      id: number;
      name: string;
      colorHex: string;
    }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ id: 1, name: "Housing" });
    expect(rows.every((r) => typeof r.colorHex === "string")).toBe(true);
    expect(ctx.audit.records).toHaveLength(0);
  });

  it("get_tax_settings returns the row and writes no audit entry", async () => {
    const s = (await registry.invoke("get_tax_settings", { workspaceId: 1 }, ctx)) as {
      filing: string;
      taxYear: number;
    };
    expect(s).toMatchObject({ filing: "single", taxYear: 2025 });
    expect(ctx.audit.records).toHaveLength(0);
  });

  it("get_tax_settings propagates the missing-row error instead of returning null", async () => {
    ctx.__deleteTaxSettings(1);
    await expect(registry.invoke("get_tax_settings", { workspaceId: 1 }, ctx)).rejects.toThrow(
      /No tax_settings row/,
    );
  });

  it("update_tax_settings updates only the supplied fields and audits the write", async () => {
    const r = (await registry.invoke(
      "update_tax_settings",
      { workspaceId: 1, taxYear: 2026 },
      ctx,
    )) as { saved: boolean; created: boolean };
    expect(r).toEqual({ saved: true, created: false });

    const after = (await registry.invoke("get_tax_settings", { workspaceId: 1 }, ctx)) as Record<
      string,
      unknown
    >;
    expect(after.taxYear).toBe(2026);
    // Untouched fields keep their stored values.
    expect(after.filing).toBe("single");
    expect(after.caSdiRate).toBe(0.011);
    expect(after.ficaSsRate).toBe(0.062);

    // Mutating tool → exactly one audit row (get_* contributed none).
    expect(ctx.audit.records).toHaveLength(1);
    expect(ctx.audit.records[0]!.toolName).toBe("update_tax_settings");
  });

  it("update_tax_settings with only a workspaceId is a no-op", async () => {
    expect(await registry.invoke("update_tax_settings", { workspaceId: 1 }, ctx)).toEqual({
      saved: false,
      created: false,
    });
  });

  it("update_tax_settings creating a row requires filing AND taxYear", async () => {
    ctx.__deleteTaxSettings(1);
    await expect(
      registry.invoke("update_tax_settings", { workspaceId: 1, caSdiRate: 0.02 }, ctx),
    ).rejects.toThrow(/requires both "filing" and "taxYear"/);

    const created = (await registry.invoke(
      "update_tax_settings",
      { workspaceId: 1, filing: "mfj", taxYear: 2026 },
      ctx,
    )) as { saved: boolean; created: boolean };
    expect(created).toEqual({ saved: true, created: true });
    const after = (await registry.invoke("get_tax_settings", { workspaceId: 1 }, ctx)) as Record<
      string,
      unknown
    >;
    expect(after).toMatchObject({ filing: "mfj", taxYear: 2026 });
    // Omitted columns fall back to their schema defaults.
    expect(after.ficaMedicareRate).toBe(0.0145);
  });

  it("rejects an out-of-range rate", async () => {
    await expect(
      registry.invoke("update_tax_settings", { workspaceId: 1, ficaSsRate: 62 }, ctx),
    ).rejects.toThrow(ToolArgError);
  });
});

describe("compute_budget_summary", () => {
  let ctx: ReturnType<typeof mkMemoryCtx>;
  let registry: ToolRegistry;
  beforeEach(async () => {
    ctx = mkMemoryCtx();
    registry = new ToolRegistry(ALL_TOOLS);
    await registry.invoke(
      "add_expense",
      { workspaceId: 1, label: "Rent", amountDollars: 1800, frequency: "monthly", categoryId: 1 },
      ctx,
    );
    await registry.invoke(
      "add_expense",
      { workspaceId: 1, label: "Car insurance", amountDollars: 1200, frequency: "annually", categoryId: 7 },
      ctx,
    );
    await registry.invoke(
      "add_expense",
      {
        workspaceId: 1,
        label: "Sofa",
        amountDollars: 900,
        frequency: "one_time",
        spendDate: "2026-02-10",
        categoryId: 8,
      },
      ctx,
    );
  });

  it("keeps one-time spend out of the monthly run rate and annualizes at exactly 12x", async () => {
    const r = (await registry.invoke("compute_budget_summary", { workspaceId: 1 }, ctx)) as {
      workspaceName: string;
      monthlyRecurringExpenseDollars: number;
      annualRecurringExpenseDollars: number;
      oneTimeTotalDollars: number;
      expenseCount: number;
      byCategory: Array<{ categoryId: number | null; categoryName: string; monthlyDollars: number; annualDollars: number; sharePct: number }>;
    };
    expect(r.workspaceName).toBe("Current");
    // 1800/mo + 1200/yr → 1900/mo. The $900 one-off contributes 0.
    expect(r.monthlyRecurringExpenseDollars).toBeCloseTo(1900, 2);
    expect(r.annualRecurringExpenseDollars).toBeCloseTo(r.monthlyRecurringExpenseDollars * 12, 2);
    expect(r.oneTimeTotalDollars).toBe(900);
    expect(r.expenseCount).toBe(3);

    // Sorted by monthly cost, descending; per-category annual is also 12x.
    expect(r.byCategory[0]!).toMatchObject({ categoryId: 1, categoryName: "Housing" });
    expect(r.byCategory[0]!.monthlyDollars).toBe(1800);
    expect(r.byCategory[0]!.annualDollars).toBeCloseTo(21600, 2);
    expect(r.byCategory[0]!.sharePct).toBeCloseTo((1800 / 1900) * 100, 1);
    // The one-time row's category is present but carries no monthly cost.
    const disc = r.byCategory.find((c) => c.categoryId === 8)!;
    expect(disc.monthlyDollars).toBe(0);
  });

  it("reports take-home and what is left after recurring expenses", async () => {
    await registry.invoke(
      "add_income",
      { workspaceId: 1, label: "Salary", grossAnnualDollars: 150000, taxStatus: "taxed" },
      ctx,
    );
    const r = (await registry.invoke("compute_budget_summary", { workspaceId: 1 }, ctx)) as {
      takeHomeAvailable: boolean;
      monthlyTakeHomeDollars: number;
      annualTakeHomeDollars: number;
      monthlyRemainingDollars: number;
      monthlyRecurringExpenseDollars: number;
      monthlySavingsFromCashDollars: number;
    };
    expect(r.takeHomeAvailable).toBe(true);
    expect(r.monthlyTakeHomeDollars).toBeGreaterThan(0);
    expect(r.annualTakeHomeDollars).toBeGreaterThan(r.monthlyTakeHomeDollars);
    expect(r.monthlyRemainingDollars).toBeCloseTo(
      round2(r.monthlyTakeHomeDollars - r.monthlyRecurringExpenseDollars),
      2,
    );
    // No from-cash savings accounts seeded.
    expect(r.monthlySavingsFromCashDollars).toBe(0);
    expect(ctx.audit.records.filter((a) => a.toolName === "compute_budget_summary")).toHaveLength(0);
  });

  it("degrades to takeHomeAvailable:false (null dollars) when tax settings are missing", async () => {
    ctx.__deleteTaxSettings(1);
    const r = (await registry.invoke("compute_budget_summary", { workspaceId: 1 }, ctx)) as {
      takeHomeAvailable: boolean;
      monthlyTakeHomeDollars: number | null;
      annualTakeHomeDollars: number | null;
      monthlyRemainingDollars: number | null;
      monthlySavingsFromCashDollars: number | null;
      monthlyRecurringExpenseDollars: number;
    };
    expect(r.takeHomeAvailable).toBe(false);
    expect(r.monthlyTakeHomeDollars).toBeNull();
    expect(r.annualTakeHomeDollars).toBeNull();
    expect(r.monthlyRemainingDollars).toBeNull();
    expect(r.monthlySavingsFromCashDollars).toBeNull();
    // The expense picture still comes back.
    expect(r.monthlyRecurringExpenseDollars).toBeCloseTo(1900, 2);
  });

  it("throws on an unknown workspace", async () => {
    await expect(
      registry.invoke("compute_budget_summary", { workspaceId: 4242 }, ctx),
    ).rejects.toThrow(/not found/i);
  });
});

describe("search_transactions / top_merchants / compute_category_baselines", () => {
  let ctx: ReturnType<typeof mkMemoryCtx>;
  let registry: ToolRegistry;

  beforeEach(() => {
    ctx = mkMemoryCtx();
    registry = new ToolRegistry(ALL_TOOLS);
    ctx.__insertedTxns.push(
      { importId: 1, postedDate: "2026-01-05", merchantRaw: "TRADER JOE'S #123", merchantNormalized: "trader joes", amountDollars: -85.5, categoryId: 4, accountType: "chase" },
      { importId: 1, postedDate: "2026-01-20", merchantRaw: "TRADER JOE'S #123", merchantNormalized: "trader joes", amountDollars: -114.5, categoryId: 4, accountType: "chase" },
      { importId: 1, postedDate: "2026-02-02", merchantRaw: "SHELL OIL 4471", merchantNormalized: "shell oil", amountDollars: -60, categoryId: 5, accountType: "chase" },
      { importId: 1, postedDate: "2026-02-14", merchantRaw: "UNITED AIRLINES", merchantNormalized: "united airlines", amountDollars: -660.82, categoryId: 5, accountType: "amex_gold" },
      { importId: 1, postedDate: "2026-02-20", merchantRaw: "PAYMENT THANK YOU", merchantNormalized: "payment thank you", amountDollars: 500, categoryId: null, accountType: "chase" },
    );
  });

  it("returns charges only by default, newest first", async () => {
    const r = (await registry.invoke("search_transactions", {}, ctx)) as {
      rows: Array<{ postedDate: string; amountDollars: number }>;
      totalMatched: number;
      returned: number;
      truncated: boolean;
    };
    expect(r.totalMatched).toBe(4);            // the +500 credit is excluded
    expect(r.returned).toBe(4);
    expect(r.truncated).toBe(false);
    expect(r.rows.every((x) => x.amountDollars < 0)).toBe(true);
    expect(r.rows[0]!.postedDate).toBe("2026-02-14");
    expect(ctx.audit.records).toHaveLength(0); // read-only
  });

  it("includeCredits admits positive rows", async () => {
    const r = (await registry.invoke("search_transactions", { includeCredits: true }, ctx)) as {
      totalMatched: number;
      rows: Array<{ amountDollars: number }>;
    };
    expect(r.totalMatched).toBe(5);
    expect(r.rows.some((x) => x.amountDollars > 0)).toBe(true);
  });

  it("matches the merchant case-insensitively as a substring", async () => {
    const r = (await registry.invoke("search_transactions", { merchant: "trader" }, ctx)) as {
      totalMatched: number;
    };
    expect(r.totalMatched).toBe(2);
    // Matching against merchant_raw (uppercase in the fixture) works too.
    const r2 = (await registry.invoke("search_transactions", { merchant: "shell oil 4471" }, ctx)) as {
      totalMatched: number;
    };
    expect(r2.totalMatched).toBe(1);
  });

  it("bounds posted dates inclusively at both ends", async () => {
    const r = (await registry.invoke(
      "search_transactions",
      { from: "2026-01-20", to: "2026-02-02" },
      ctx,
    )) as { totalMatched: number; rows: Array<{ postedDate: string }> };
    expect(r.totalMatched).toBe(2);
    expect(r.rows.map((x) => x.postedDate).sort()).toEqual(["2026-01-20", "2026-02-02"]);
  });

  it("filters on absolute amount and on category", async () => {
    const big = (await registry.invoke("search_transactions", { minAmountDollars: 100 }, ctx)) as {
      totalMatched: number;
    };
    expect(big.totalMatched).toBe(2); // 114.50 and 660.82
    const food = (await registry.invoke("search_transactions", { categoryId: 4 }, ctx)) as {
      totalMatched: number;
    };
    expect(food.totalMatched).toBe(2);
  });

  it("pages with limit/offset and reports truncation against totalMatched", async () => {
    const page1 = (await registry.invoke("search_transactions", { limit: 2 }, ctx)) as {
      returned: number;
      totalMatched: number;
      truncated: boolean;
      rows: Array<{ postedDate: string }>;
    };
    expect(page1).toMatchObject({ returned: 2, totalMatched: 4, truncated: true });

    const page2 = (await registry.invoke("search_transactions", { limit: 2, offset: 2 }, ctx)) as {
      returned: number;
      truncated: boolean;
      rows: Array<{ postedDate: string }>;
    };
    expect(page2).toMatchObject({ returned: 2, truncated: false });
    // Pages don't overlap.
    expect(page2.rows.map((r) => r.postedDate)).not.toEqual(page1.rows.map((r) => r.postedDate));
  });

  it("rejects a limit above the cap and a malformed date", async () => {
    await expect(registry.invoke("search_transactions", { limit: 500 }, ctx)).rejects.toThrow(
      ToolArgError,
    );
    await expect(registry.invoke("search_transactions", { from: "Jan 2026" }, ctx)).rejects.toThrow(
      ToolArgError,
    );
  });

  it("top_merchants ranks by positive spend, biggest first", async () => {
    const r = (await registry.invoke("top_merchants", {}, ctx)) as {
      merchants: Array<{
        merchantNormalized: string;
        merchantRawSample: string;
        txnCount: number;
        totalDollars: number;
        avgDollars: number;
        firstSeen: string;
        lastSeen: string;
      }>;
      windowFrom: string | null;
      windowTo: string | null;
    };
    expect(r.merchants.map((m) => m.merchantNormalized)).toEqual([
      "united airlines",
      "trader joes",
      "shell oil",
    ]);
    expect(r.merchants.every((m) => m.totalDollars > 0)).toBe(true);
    const tj = r.merchants.find((m) => m.merchantNormalized === "trader joes")!;
    expect(tj.txnCount).toBe(2);
    expect(tj.totalDollars).toBeCloseTo(200, 2);
    expect(tj.avgDollars).toBeCloseTo(100, 2);
    expect(tj.firstSeen).toBe("2026-01-05");
    expect(tj.lastSeen).toBe("2026-01-20");
    expect(tj.merchantRawSample).toBe("TRADER JOE'S #123");
    // The +500 credit never becomes a merchant.
    expect(r.merchants.some((m) => m.merchantNormalized === "payment thank you")).toBe(false);
    expect(r).toMatchObject({ windowFrom: null, windowTo: null });
    expect(ctx.audit.records).toHaveLength(0);
  });

  it("top_merchants honors the window + limit and echoes the window back", async () => {
    const r = (await registry.invoke(
      "top_merchants",
      { from: "2026-02-01", to: "2026-02-28", limit: 1 },
      ctx,
    )) as { merchants: Array<{ merchantNormalized: string }>; windowFrom: string; windowTo: string };
    expect(r.merchants).toHaveLength(1);
    expect(r.merchants[0]!.merchantNormalized).toBe("united airlines");
    expect(r).toMatchObject({ windowFrom: "2026-02-01", windowTo: "2026-02-28" });
  });

  it("compute_category_baselines reports POSITIVE cost per category", async () => {
    const r = (await registry.invoke("compute_category_baselines", { windowMonths: 12 }, ctx)) as {
      asOf: string;
      windowMonths: number;
      baselines: Array<{
        category: string;
        monthlyAverageDollars: number;
        monthlyMedianDollars: number;
        windowTotalDollars: number;
        monthsWithActivity: number;
        txnCount: number;
      }>;
    };
    // asOf defaults to the newest charge on file (the +500 credit is not one).
    expect(r.asOf).toBe("2026-02-14");
    expect(r.windowMonths).toBe(12);
    expect(r.baselines.every((b) => b.monthlyAverageDollars >= 0)).toBe(true);
    expect(r.baselines.every((b) => b.windowTotalDollars >= 0)).toBe(true);

    const food = r.baselines.find((b) => b.category === "Food")!;
    expect(food.txnCount).toBe(2);
    expect(food.monthsWithActivity).toBe(1);      // both charges are in 2026-01
    expect(food.windowTotalDollars).toBeCloseTo(200, 2);
    expect(food.monthlyAverageDollars).toBeCloseTo(200 / 12, 2);
    expect(food.monthlyMedianDollars).toBeCloseTo(200, 2);

    const transport = r.baselines.find((b) => b.category === "Transport")!;
    expect(transport.windowTotalDollars).toBeCloseTo(720.82, 2);
    expect(ctx.audit.records).toHaveLength(0);
  });

  it("compute_category_baselines honors an explicit asOf window", async () => {
    const r = (await registry.invoke(
      "compute_category_baselines",
      { windowMonths: 1, asOf: "2026-01-31" },
      ctx,
    )) as { asOf: string; baselines: Array<{ category: string; windowTotalDollars: number }> };
    expect(r.asOf).toBe("2026-01-31");
    // Only January's two grocery charges fall inside a 1-month window.
    expect(r.baselines).toHaveLength(1);
    expect(r.baselines[0]!.category).toBe("Food");
    expect(r.baselines[0]!.windowTotalDollars).toBeCloseTo(200, 2);
  });
});

describe("backfill_spend_dates", () => {
  let ctx: ReturnType<typeof mkMemoryCtx>;
  let registry: ToolRegistry;

  beforeEach(async () => {
    ctx = mkMemoryCtx();
    registry = new ToolRegistry(ALL_TOOLS);
    ctx.__insertedTxns.push({
      importId: 1,
      postedDate: "2026-02-14",
      merchantRaw: "UNITED AIRLINES",
      merchantNormalized: "united airlines",
      amountDollars: -660.82,
      categoryId: 5,
      accountType: "amex_gold",
    });
    await registry.invoke(
      "add_expense",
      { workspaceId: 1, label: "UNITED AIRLINES", amountDollars: 660.82, frequency: "one_time" },
      ctx,
    );
  });

  it("dryRun reports the matches without writing, then a live run applies them", async () => {
    const preview = (await registry.invoke("backfill_spend_dates", { dryRun: true }, ctx)) as {
      dryRun: boolean;
      scanned: number;
      matched: number;
      changed: Array<{ id: number; label?: string; spendDate: string }>;
    };
    expect(preview).toMatchObject({ dryRun: true, scanned: 1, matched: 1 });
    expect(preview.changed[0]).toMatchObject({ label: "UNITED AIRLINES", spendDate: "2026-02-14" });
    // Nothing was written.
    expect(ctx.expenses.list(1)[0]!.spendDate).toBeNull();

    const live = (await registry.invoke("backfill_spend_dates", {}, ctx)) as {
      dryRun: boolean;
      matched: number;
      changed: Array<{ id: number }>;
    };
    expect(live).toMatchObject({ dryRun: false, matched: 1 });
    expect(ctx.expenses.list(1)[0]!.spendDate).toBe("2026-02-14");

    // Idempotent: a second pass finds nothing left to do.
    const again = (await registry.invoke("backfill_spend_dates", {}, ctx)) as { scanned: number };
    expect(again.scanned).toBe(0);
  });

  it("is a mutating tool — both the preview and the live run are audited", async () => {
    await registry.invoke("backfill_spend_dates", { dryRun: true }, ctx);
    await registry.invoke("backfill_spend_dates", {}, ctx);
    expect(
      ctx.audit.records.filter((r) => r.toolName === "backfill_spend_dates"),
    ).toHaveLength(2);
  });
});
