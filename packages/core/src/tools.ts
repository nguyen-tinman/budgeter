// Concrete tool definitions wired to the registry contract in tool_registry.ts.
//
// Convention: tools are pure functions over their ToolCtx. They never reach
// into globals, never read process.env. This keeps them unit-testable with
// mock repositories and identical across transports (REST, chat, MCP).

import type { JsonSchema, ToolDef, ToolCtx } from "./tool_registry.js";
import { takeHome } from "./tax_calculator.js";
import {
  project,
  effectiveMonthlyContributionDollars,
} from "./retirement_projector.js";
import { catalogueExpenses, type ExpenseCandidate } from "./expense_cataloguer.js";
import { parseAmexXlsx, normalizeMerchant } from "./statement_parser.js";
import { parseChasePdf } from "./chase_parser.js";
import { parseStatementCsv } from "./csv_parser.js";
import { expenseDupKey, findDuplicateGroups } from "./expense_dedup.js";
import type { RawTxn } from "./statement_parser.js";
import { defaultMerchantCategorizer } from "./category_resolver.js";
import { computeTrends } from "./trends_calculator.js";
import { resolveWithholdingsByOwner, TAX_TREATMENTS } from "./account_tax.js";
import { round2 } from "./money.js";
import {
  validateTaxTablePayload,
  VALID_JURISDICTIONS,
  VALID_FILINGS,
  type TaxTablePayload,
} from "./tax_table_validation.js";

const EMPLOYER_MATCH_KINDS = [
  "none",
  "pct_of_salary",
  "flat_annual_dollars",
] as const;

const FREQUENCIES = [
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
  "annually",
  "one_time",
] as const;

const TAX_STATUSES = ["pretax", "posttax", "taxed", "untaxable"] as const;

const SAVINGS_ACCOUNT_TYPES = [
  "hysa",
  "brokerage",
  "roth_ira",
  "traditional_401k",
  "roth_401k",
  "hsa",
  "other",
] as const;

// ---------------------------------------------------------------------------
// Workspace tools
// ---------------------------------------------------------------------------

const list_workspaces: ToolDef = {
  name: "list_workspaces",
  description:
    "List all workspaces. Each workspace is either the user's 'current' real-life baseline or a 'scenario' (e.g. apartment-move comparison).",
  readOnly: true,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "integer" },
        name: { type: "string" },
        kind: { type: "string" },
        createdAt: { type: "string" },
      },
    },
  },
  handler: (_args, ctx) => ctx.workspaces.list(),
};

const create_scenario: ToolDef = {
  name: "create_scenario",
  description:
    "Create a new scenario workspace (e.g. 'Apartment-A' for a move comparison). Returns the new id.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Unique workspace name" },
      notes: { type: "string", description: "Optional human-readable notes" },
    },
    required: ["name"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { id: { type: "integer" } },
    required: ["id"],
  },
  handler: (args, ctx) => {
    const a = args as { name: string; notes?: string };
    return ctx.workspaces.create({ name: a.name, kind: "scenario", notes: a.notes });
  },
};

const delete_workspace: ToolDef = {
  name: "delete_workspace",
  description:
    "Delete a workspace and all its expenses, incomes, savings, retirement settings. Cannot delete the 'Current' workspace (kind=current).",
  inputSchema: {
    type: "object",
    properties: { id: { type: "integer", minimum: 1 } },
    required: ["id"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { deleted: { type: "boolean" } },
    required: ["deleted"],
  },
  handler: (args, ctx) => {
    const a = args as { id: number };
    const ws = ctx.workspaces.get(a.id);
    if (!ws) throw new Error(`Workspace ${a.id} not found`);
    if (ws.kind === "current") {
      throw new Error("Cannot delete the 'Current' workspace");
    }
    return ctx.workspaces.delete(a.id);
  },
};

const rename_workspace: ToolDef = {
  name: "rename_workspace",
  description:
    "Rename an existing workspace. The new name must be unique; the 'Current' workspace can be renamed too.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "integer", minimum: 1 },
      name: { type: "string", description: "1..100 chars, must be unique" },
    },
    required: ["id", "name"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { updated: { type: "boolean" } },
    required: ["updated"],
  },
  handler: (args, ctx) => {
    const a = args as { id: number; name: string };
    const trimmed = a.name.trim();
    if (trimmed.length === 0) throw new Error("Workspace name cannot be empty");
    if (trimmed.length > 100) throw new Error("Workspace name must be 100 characters or fewer");
    const ws = ctx.workspaces.get(a.id);
    if (!ws) throw new Error(`Workspace ${a.id} not found`);
    if (ws.name === trimmed) return { updated: false };
    try {
      return ctx.workspaces.rename(a.id, trimmed);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (msg.includes("UNIQUE")) {
        throw new Error(`Another workspace is already named "${trimmed}"`);
      }
      throw e;
    }
  },
};

const clone_workspace: ToolDef = {
  name: "clone_workspace",
  description:
    "Clone an existing workspace (incomes, expenses, savings, tax + retirement settings) into a new scenario. The new name must be unique. Returns the new workspace id.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "integer", minimum: 1 },
      name: { type: "string", description: "1..100 chars, must be unique" },
      notes: { type: "string" },
    },
    required: ["id", "name"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { id: { type: "integer" } },
    required: ["id"],
  },
  handler: (args, ctx) => {
    const a = args as { id: number; name: string; notes?: string };
    const trimmed = a.name.trim();
    if (trimmed.length === 0) throw new Error("Workspace name cannot be empty");
    if (trimmed.length > 100) throw new Error("Workspace name must be 100 characters or fewer");
    const src = ctx.workspaces.get(a.id);
    if (!src) throw new Error(`Workspace ${a.id} not found`);
    try {
      return ctx.workspaces.clone(a.id, trimmed, a.notes ?? null);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (msg.includes("UNIQUE")) {
        throw new Error(`Another workspace is already named "${trimmed}"`);
      }
      throw e;
    }
  },
};

// ---------------------------------------------------------------------------
// Expense tools
// ---------------------------------------------------------------------------

const list_expenses: ToolDef = {
  name: "list_expenses",
  description: "List expenses for a workspace.",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: { workspaceId: { type: "integer", minimum: 1 } },
    required: ["workspaceId"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "integer" },
        workspaceId: { type: "integer" },
        label: { type: "string" },
        amountDollars: { type: "number" },
        frequency: { type: "string" },
      },
    },
  },
  handler: (args, ctx) => {
    const a = args as { workspaceId: number };
    return ctx.expenses.list(a.workspaceId);
  },
};

/** Look up a category id by resolving the merchant label through the
 *  rule-based categorizer. Returns null if the resolved category name isn't
 *  in the seeded categories table. The resolver always returns a string —
 *  "Discretionary" at minimum — so the only way this returns null is if
 *  "Discretionary" was deleted from the categories table (which migrations
 *  don't permit). */
function resolveCategoryIdFromLabel(label: string, ctx: { categories: { listByName(): Map<string, number> } }): number | null {
  const synthetic: RawTxn = {
    postedDate: new Date().toISOString().slice(0, 10),
    merchantRaw: label,
    merchantNormalized: normalizeMerchant(label),
    amountDollars: -1,
    accountType: "unknown",
  };
  const categoryName = defaultMerchantCategorizer(synthetic);
  return ctx.categories.listByName().get(categoryName) ?? null;
}

const add_expense: ToolDef = {
  name: "add_expense",
  description:
    "Add an expense to a workspace. amountDollars is positive (the cost). Frequency is one of weekly/biweekly/monthly/quarterly/annually/one_time. " +
    "If categoryId is omitted, the merchant label is auto-resolved via the rule-based category resolver — known merchants get their category, everything else gets 'Discretionary'. " +
    "Pass categoryId explicitly to override the auto-assignment.",
  inputSchema: {
    type: "object",
    properties: {
      workspaceId: { type: "integer", minimum: 1 },
      label: { type: "string", description: "Short human-readable name (also drives auto-categorization when categoryId is omitted)" },
      amountDollars: {
        type: "number",
        minimum: 0,
        description: "Cost in dollars (positive number; $25 = 25, $25.99 = 25.99)",
      },
      frequency: { type: "string", enum: [...FREQUENCIES] },
      spendDate: { type: "string", description: "For one_time expenses: YYYY-MM-DD the spend occurred (drives Trends placement). Ignored for recurring frequencies." },
      categoryId: { type: "integer", description: "Optional category id — overrides auto-categorization" },
    },
    required: ["workspaceId", "label", "amountDollars", "frequency"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { id: { type: "integer" } },
    required: ["id"],
  },
  handler: (args, ctx) => {
    const a = args as {
      workspaceId: number;
      label: string;
      amountDollars: number;
      frequency: string;
      spendDate?: string;
      categoryId?: number;
    };
    // Auto-categorize when the caller didn't supply a category. This gives
    // LLM-added rows a sensible default and ensures byCat totals on the
    // Dashboard always include this expense in some bucket.
    const categoryId = a.categoryId ?? resolveCategoryIdFromLabel(a.label, ctx);
    return ctx.expenses.add({
      workspaceId: a.workspaceId,
      label: a.label,
      amountDollars: a.amountDollars,
      frequency: a.frequency,
      // spend_date only carries meaning for one-time rows.
      spendDate: a.frequency === "one_time" ? (a.spendDate ?? null) : null,
      categoryId,
      source: "manual",
    });
  },
};

const update_expense: ToolDef = {
  name: "update_expense",
  description: "Update fields on an existing expense. Only fields provided are changed.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "integer", minimum: 1 },
      label: { type: "string" },
      amountDollars: { type: "number", minimum: 0 },
      frequency: { type: "string", enum: [...FREQUENCIES] },
      spendDate: { type: "string", description: "For one_time expenses: YYYY-MM-DD; ignored for recurring frequencies." },
      categoryId: { type: "integer" },
    },
    required: ["id"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { updated: { type: "boolean" } },
    required: ["updated"],
  },
  handler: (args, ctx) => ctx.expenses.update(args as Parameters<typeof ctx.expenses.update>[0]),
};

const delete_expense: ToolDef = {
  name: "delete_expense",
  description: "Delete an expense by id.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "integer", minimum: 1 } },
    required: ["id"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { deleted: { type: "boolean" } },
    required: ["deleted"],
  },
  handler: (args, ctx) => {
    const a = args as { id: number };
    return ctx.expenses.delete(a.id);
  },
};

// ---------------------------------------------------------------------------
// Income tools
// ---------------------------------------------------------------------------

const list_incomes: ToolDef = {
  name: "list_incomes",
  description: "List income lines for a workspace.",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: { workspaceId: { type: "integer", minimum: 1 } },
    required: ["workspaceId"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "integer" },
        workspaceId: { type: "integer" },
        label: { type: "string" },
        grossAnnualDollars: { type: "number" },
        taxStatus: { type: "string" },
        filingRole: { type: "string" },
      },
    },
  },
  handler: (args, ctx) => {
    const a = args as { workspaceId: number };
    return ctx.incomes.list(a.workspaceId);
  },
};

const add_income: ToolDef = {
  name: "add_income",
  description:
    "Add an income line to a workspace. grossAnnualDollars is the gross annual amount in dollars (e.g. $120,000 = 120000). taxStatus: 'pretax' reduces taxable income, 'taxed' is normal W-2, 'posttax' adds to take-home directly.",
  inputSchema: {
    type: "object",
    properties: {
      workspaceId: { type: "integer", minimum: 1 },
      label: { type: "string" },
      grossAnnualDollars: { type: "number", minimum: 0 },
      taxStatus: { type: "string", enum: [...TAX_STATUSES] },
      isFederalIncomeTax: {
        type: "boolean",
        description: "Whether this income is subject to federal income tax",
      },
      filingRole: { type: "string", enum: ["primary", "spouse"] },
    },
    required: ["workspaceId", "label", "grossAnnualDollars", "taxStatus"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { id: { type: "integer" } },
    required: ["id"],
  },
  handler: (args, ctx) => {
    const a = args as {
      workspaceId: number;
      label: string;
      grossAnnualDollars: number;
      taxStatus: string;
      isFederalIncomeTax?: boolean;
      filingRole?: "primary" | "spouse";
    };
    return ctx.incomes.add({
      workspaceId: a.workspaceId,
      label: a.label,
      grossAnnualDollars: a.grossAnnualDollars,
      taxStatus: a.taxStatus,
      isFederalIncomeTax: a.isFederalIncomeTax ?? true,
      filingRole: a.filingRole ?? "primary",
    });
  },
};

const update_income: ToolDef = {
  name: "update_income",
  description: "Update fields on an existing income. Only fields provided are changed.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "integer", minimum: 1 },
      label: { type: "string" },
      grossAnnualDollars: { type: "number", minimum: 0 },
      taxStatus: { type: "string", enum: [...TAX_STATUSES] },
      isFederalIncomeTax: { type: "boolean" },
      filingRole: { type: "string", enum: ["primary", "spouse"] },
    },
    required: ["id"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { updated: { type: "boolean" } },
    required: ["updated"],
  },
  handler: (args, ctx) => ctx.incomes.update(args as Parameters<typeof ctx.incomes.update>[0]),
};

const delete_income: ToolDef = {
  name: "delete_income",
  description: "Delete an income line by id.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "integer", minimum: 1 } },
    required: ["id"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { deleted: { type: "boolean" } },
    required: ["deleted"],
  },
  handler: (args, ctx) => {
    const a = args as { id: number };
    return ctx.incomes.delete(a.id);
  },
};

// ---------------------------------------------------------------------------
// Tax compute
// ---------------------------------------------------------------------------

/**
 * Compute a workspace's take-home breakdown, sourcing payroll withholdings
 * (employee side) from its savings accounts. Shared by compute_take_home and
 * the Trends income overlay so both agree exactly. Throws if the workspace's
 * tax tables are missing — callers that can't guarantee them (Trends) wrap in
 * try/catch and fall back to an estimate.
 */
function computeWorkspaceTakeHome(
  ctx: ToolCtx,
  workspaceId: number,
  opts: { overridePretax?: number; pretaxHealthDollars?: number } = {},
): {
  breakdown: ReturnType<typeof takeHome>;
  payrollPretaxDollars: number;
  payrollPostTaxDollars: number;
  fromCashContribDollars: number;
} {
  const settings = ctx.tax.settingsForWorkspace(workspaceId);
  const tables = ctx.tax.tables(settings.taxYear);
  const incomes = ctx.incomes.list(workspaceId);
  const primaryIncome = incomes
    .filter((i) => i.filingRole === "primary" && i.taxStatus === "taxed")
    .reduce((s, i) => s + i.grossAnnualDollars, 0);
  const spouseIncome = incomes
    .filter((i) => i.filingRole === "spouse" && i.taxStatus === "taxed")
    .reduce((s, i) => s + i.grossAnnualDollars, 0);
  const has_spouse = spouseIncome > 0 || settings.filing === "mfj";

  // Payroll withholdings (employee side; %-of-salary aware; employer match
  // excluded), split by the filer who OWNS each savings account so a spouse's
  // 401k/Roth feeds the spouse leg of take-home and its %-of-salary scales
  // against the spouse's salary. An explicit override forces the PRIMARY
  // pre-tax payroll figure only (its historical meaning); spouse pre-tax is
  // always sourced from spouse-owned savings.
  const wh = resolveWithholdingsByOwner(
    ctx.savings.list(workspaceId),
    primaryIncome,
    spouseIncome,
  );
  const pretaxPrimary = opts.overridePretax ?? wh.primary.pretaxAnnualDollars;

  const breakdown = takeHome({
    primary: {
      grossAnnualDollars: primaryIncome,
      pretax401kDollars: pretaxPrimary,
      pretaxHealthDollars: opts.pretaxHealthDollars ?? 0,
      postTaxPayrollDollars: wh.primary.postTaxPayrollAnnualDollars,
    },
    spouse: has_spouse
      ? {
          grossAnnualDollars: spouseIncome,
          pretax401kDollars: wh.spouse.pretaxAnnualDollars,
          pretaxHealthDollars: 0,
          postTaxPayrollDollars: wh.spouse.postTaxPayrollAnnualDollars,
        }
      : undefined,
    settings,
    tables,
  });

  // Aggregate figures returned to callers cover the whole household (both
  // filers) so the reported pretax/post-tax/from-cash totals match what was
  // actually withheld across the workspace's savings accounts. When an
  // overridePretax is supplied it replaces ONLY the primary pre-tax leg, so add
  // any spouse pre-tax on top.
  const payrollPretaxDollars = round2(
    pretaxPrimary + (has_spouse ? wh.spouse.pretaxAnnualDollars : 0),
  );
  const payrollPostTaxDollars = round2(
    wh.primary.postTaxPayrollAnnualDollars +
      (has_spouse ? wh.spouse.postTaxPayrollAnnualDollars : 0),
  );
  const fromCashContribDollars = round2(
    wh.primary.fromCashAnnualDollars +
      (has_spouse ? wh.spouse.fromCashAnnualDollars : 0),
  );

  return {
    breakdown,
    payrollPretaxDollars,
    payrollPostTaxDollars,
    fromCashContribDollars,
  };
}

const compute_take_home: ToolDef = {
  name: "compute_take_home",
  description:
    "Compute monthly + annual take-home for a workspace, applying federal + CA income tax, FICA, CA SDI, and payroll withholdings. By DEFAULT it sources payroll contributions from the workspace's savings accounts (employee side only): pre-tax payroll (traditional 401k, HSA) reduces taxable income and cash; post-tax payroll (Roth 401k) reduces cash only; from-cash accounts (Roth IRA, brokerage, HYSA) are returned as fromCashContribDollars but do NOT reduce take-home. Employer match is excluded. Returns the full breakdown.",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      workspaceId: { type: "integer", minimum: 1 },
      pretax401kDollars: {
        type: "number",
        minimum: 0,
        description: "Override annual pre-tax payroll (primary). When provided, replaces the value sourced from savings accounts. Default: sourced from savings.",
      },
      pretaxHealthDollars: {
        type: "number",
        minimum: 0,
        description: "Annual pre-tax health premium (separate from HSA). Default 0.",
      },
    },
    required: ["workspaceId"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      grossCombinedDollars: { type: "number" },
      federalTaxDollars: { type: "number" },
      caTaxDollars: { type: "number" },
      ficaDollars: { type: "number" },
      caSdiDollars: { type: "number" },
      preTaxDeductionsDollars: { type: "number" },
      postTaxPayrollDollars: { type: "number" },
      annualTakeHomeDollars: { type: "number" },
      monthlyTakeHomeDollars: { type: "number" },
      effectiveTaxRate: { type: "number" },
      // Withholding breakdown sourced from savings accounts (annual, employee).
      payrollPretaxDollars: { type: "number" },
      payrollPostTaxDollars: { type: "number" },
      fromCashContribDollars: { type: "number" },
    },
  },
  handler: (args, ctx) => {
    const a = args as {
      workspaceId: number;
      pretax401kDollars?: number;
      pretaxHealthDollars?: number;
    };
    const r = computeWorkspaceTakeHome(ctx, a.workspaceId, {
      overridePretax: a.pretax401kDollars,
      pretaxHealthDollars: a.pretaxHealthDollars,
    });
    // Augment with the withholding breakdown so downstream UIs can split
    // "already in take-home" (payroll) from "use of take-home" (from-cash)
    // without re-deriving the classification.
    return {
      ...r.breakdown,
      payrollPretaxDollars: r.payrollPretaxDollars,
      payrollPostTaxDollars: r.payrollPostTaxDollars,
      fromCashContribDollars: r.fromCashContribDollars,
    };
  },
};

// ---------------------------------------------------------------------------
// Savings tools (M11)
// ---------------------------------------------------------------------------

const list_savings: ToolDef = {
  name: "list_savings",
  description: "List savings accounts (HYSA, 401k, IRA, brokerage) for a workspace.",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: { workspaceId: { type: "integer", minimum: 1 } },
    required: ["workspaceId"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "integer" },
        workspaceId: { type: "integer" },
        label: { type: "string" },
        currentBalanceDollars: { type: "number" },
        monthlyContributionDollars: { type: "number" },
        accountType: { type: "string" },
        contributionPctOfSalary: { type: "number" },
        employerMatchKind: { type: "string" },
        employerMatchValue: { type: "number" },
        filingRole: { type: "string", enum: ["primary", "spouse"] },
      },
    },
  },
  handler: (args, ctx) => {
    const a = args as { workspaceId: number };
    return ctx.savings.list(a.workspaceId);
  },
};

const add_savings: ToolDef = {
  name: "add_savings",
  description:
    "Add a savings/investment account to a workspace. accountType is one of hysa/brokerage/roth_ira/traditional_401k/roth_401k/hsa/other. " +
    "OPTIONAL 401k contribution-as-percentage knob: contributionPctOfSalary (0..1) overrides monthlyContributionDollars — the effective employee contribution becomes (primary_taxed_gross * pct) / 12. " +
    "OPTIONAL employer match: employerMatchKind ∈ none|pct_of_salary|flat_annual_dollars (default 'none'), with employerMatchValue interpreted as a 0..1 fraction or an annual dollar amount accordingly.",
  inputSchema: {
    type: "object",
    properties: {
      workspaceId: { type: "integer", minimum: 1 },
      label: { type: "string" },
      currentBalanceDollars: { type: "number", minimum: 0 },
      targetBalanceDollars: { type: "number", minimum: 0 },
      monthlyContributionDollars: { type: "number", minimum: 0 },
      accountType: { type: "string", enum: [...SAVINGS_ACCOUNT_TYPES] },
      contributionPctOfSalary: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description:
          "Fraction (0..1) of primary taxed gross treated as the employee 401k contribution. Overrides monthlyContributionDollars when non-zero.",
      },
      employerMatchKind: {
        type: "string",
        enum: [...EMPLOYER_MATCH_KINDS],
        description:
          "How to interpret employerMatchValue: 'pct_of_salary' (0..1 of gross), 'flat_annual_dollars' (annual dollars), or 'none' (ignored).",
      },
      employerMatchValue: {
        type: "number",
        minimum: 0,
        // Upper bound: $100,000/yr for flat_annual_dollars (an extreme but
        // legal match cap), or 1.0 for pct_of_salary. The single bound
        // 100_000 covers both — a pct match > 1.0 would imply the
        // employer contributes more than the employee's full salary, which
        // never happens in practice and is almost certainly a typo (e.g.
        // entering "5" meaning 5% rather than 0.05).
        maximum: 100_000,
        description:
          "Employer match value. For 'pct_of_salary' use 0..1; for 'flat_annual_dollars' use the annual dollar amount (max 100000 = $100k/yr).",
      },
      taxTreatment: {
        type: "string",
        enum: [...TAX_TREATMENTS],
        description:
          "Optional tax-treatment override: 'payroll_pretax' (reduces taxable income + take-home), 'payroll_posttax' (Roth — reduces take-home only), or 'from_cash' (a use of take-home, not a reduction). Omit to derive from accountType.",
      },
      filingRole: {
        type: "string",
        enum: ["primary", "spouse"],
        description:
          "Which filer owns this account (default 'primary'). 'spouse' makes a %-of-salary contribution scale against the spouse's salary and reduces the spouse's leg of take-home in an MFJ household.",
      },
    },
    required: ["workspaceId", "label", "accountType"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { id: { type: "integer" } },
    required: ["id"],
  },
  handler: (args, ctx) => {
    const a = args as Parameters<typeof ctx.savings.add>[0];
    return ctx.savings.add(a);
  },
};

const update_savings: ToolDef = {
  name: "update_savings",
  description: "Update fields on a savings account. Only fields provided are changed.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "integer", minimum: 1 },
      label: { type: "string" },
      currentBalanceDollars: { type: "number", minimum: 0 },
      targetBalanceDollars: { type: "number", minimum: 0 },
      monthlyContributionDollars: { type: "number", minimum: 0 },
      accountType: { type: "string", enum: [...SAVINGS_ACCOUNT_TYPES] },
      contributionPctOfSalary: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description:
          "Fraction (0..1) of primary taxed gross treated as the employee 401k contribution. Overrides monthlyContributionDollars when non-zero.",
      },
      employerMatchKind: {
        type: "string",
        enum: [...EMPLOYER_MATCH_KINDS],
        description:
          "How to interpret employerMatchValue: 'pct_of_salary' (0..1 of gross), 'flat_annual_dollars' (annual dollars), or 'none' (ignored).",
      },
      employerMatchValue: {
        type: "number",
        minimum: 0,
        // Upper bound: $100,000/yr for flat_annual_dollars (an extreme but
        // legal match cap), or 1.0 for pct_of_salary. The single bound
        // 100_000 covers both — a pct match > 1.0 would imply the
        // employer contributes more than the employee's full salary, which
        // never happens in practice and is almost certainly a typo (e.g.
        // entering "5" meaning 5% rather than 0.05).
        maximum: 100_000,
        description:
          "Employer match value. For 'pct_of_salary' use 0..1; for 'flat_annual_dollars' use the annual dollar amount (max 100000 = $100k/yr).",
      },
      taxTreatment: {
        type: "string",
        enum: [...TAX_TREATMENTS],
        description:
          "Optional tax-treatment override: 'payroll_pretax', 'payroll_posttax', or 'from_cash'. Setting an account's treatment to its account-type default is equivalent to deriving.",
      },
      filingRole: {
        type: "string",
        enum: ["primary", "spouse"],
        description:
          "Which filer owns this account ('primary' or 'spouse'). Moving an account to 'spouse' attributes its withholdings to the spouse's leg of take-home and scales any %-of-salary contribution against the spouse's salary.",
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { updated: { type: "boolean" } },
    required: ["updated"],
  },
  handler: (args, ctx) =>
    ctx.savings.update(args as Parameters<typeof ctx.savings.update>[0]),
};

const delete_savings: ToolDef = {
  name: "delete_savings",
  description: "Delete a savings account by id.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "integer", minimum: 1 } },
    required: ["id"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { deleted: { type: "boolean" } },
    required: ["deleted"],
  },
  handler: (args, ctx) => {
    const a = args as { id: number };
    return ctx.savings.delete(a.id);
  },
};

// ---------------------------------------------------------------------------
// Retirement tools (M11)
// ---------------------------------------------------------------------------

const get_retirement_settings: ToolDef = {
  name: "get_retirement_settings",
  description:
    "Get the retirement projection inputs (age, retirement age, growth rate, Roth split, initial balance) for a workspace. Returns null if not yet set.",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: { workspaceId: { type: "integer", minimum: 1 } },
    required: ["workspaceId"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      workspaceId: { type: "integer" },
      currentAge: { type: "integer" },
      retirementAge: { type: "integer" },
      initialBalanceDollars: { type: "number" },
      growthRate: { type: "number" },
      rothSplitPct: { type: "number" },
    },
  },
  handler: (args, ctx) => {
    const a = args as { workspaceId: number };
    return ctx.retirement.get(a.workspaceId);
  },
};

const set_retirement_settings: ToolDef = {
  name: "set_retirement_settings",
  description:
    "Set (upsert) the retirement projection inputs for a workspace. Must satisfy retirementAge > currentAge and 0 <= rothSplitPct <= 1.",
  inputSchema: {
    type: "object",
    properties: {
      workspaceId: { type: "integer", minimum: 1 },
      currentAge: { type: "integer", minimum: 0, maximum: 120 },
      retirementAge: { type: "integer", minimum: 1, maximum: 120 },
      initialBalanceDollars: { type: "number", minimum: 0 },
      growthRate: { type: "number", minimum: -1, maximum: 1 },
      rothSplitPct: { type: "number", minimum: 0, maximum: 1 },
    },
    required: [
      "workspaceId",
      "currentAge",
      "retirementAge",
      "initialBalanceDollars",
      "growthRate",
      "rothSplitPct",
    ],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { saved: { type: "boolean" } },
    required: ["saved"],
  },
  handler: (args, ctx) =>
    ctx.retirement.set(args as Parameters<typeof ctx.retirement.set>[0]),
};

const compute_retirement: ToolDef = {
  name: "compute_retirement",
  description:
    "Project retirement savings for a workspace. Sums monthlyContributionDollars from retirement-flagged savings_items (traditional_401k, roth_401k, roth_ira), adds their currentBalanceDollars to the stored retirement_settings.initialBalanceDollars, feeds the totals through the Roth/Traditional projector, and returns year-by-year balances + after-tax-at-retirement figure.",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      workspaceId: { type: "integer", minimum: 1 },
      annualContributionDollarsOverride: {
        type: "number",
        minimum: 0,
        description:
          "Optional: override the contribution amount inferred from savings_items.",
      },
    },
    required: ["workspaceId"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      years: {
        type: "array",
        items: {
          type: "object",
          properties: {
            age: { type: "integer" },
            yearsElapsed: { type: "integer" },
            traditionalDollars: { type: "number" },
            rothDollars: { type: "number" },
            totalDollars: { type: "number" },
          },
        },
      },
      preTaxAtRetirementDollars: { type: "number" },
      afterTaxAtRetirementDollars: { type: "number" },
      annualContributionDollars: { type: "number" },
      initialBalanceDollars: { type: "number" },
    },
  },
  handler: (args, ctx) => {
    const a = args as {
      workspaceId: number;
      annualContributionDollarsOverride?: number;
    };
    const settings = ctx.retirement.get(a.workspaceId);
    if (!settings) {
      throw new Error(
        `No retirement_settings row for workspace ${a.workspaceId}. Call set_retirement_settings first.`,
      );
    }
    const taxSettings = ctx.tax.settingsForWorkspace(a.workspaceId);
    const retirementBuckets = new Set([
      "traditional_401k",
      "roth_401k",
      "roth_ira",
    ]);
    const retirementSavings = ctx.savings
      .list(a.workspaceId)
      .filter((s) => retirementBuckets.has(s.accountType));
    // Resolve "% of salary" against the PRIMARY taxed gross. Employer-match
    // fractions also key off this same base. We deliberately use only the
    // 'taxed' (W-2) lines for the 'primary' filing role — pretax/posttax
    // adjustments don't change the salary 401k% applies to.
    const primaryTaxedGrossAnnualDollars = ctx.incomes
      .list(a.workspaceId)
      .filter((i) => i.filingRole === "primary" && i.taxStatus === "taxed")
      .reduce((s, i) => s + i.grossAnnualDollars, 0);
    const annualContributionDollars =
      a.annualContributionDollarsOverride ??
      round2(
        retirementSavings.reduce(
          (sum, s) =>
            sum +
            effectiveMonthlyContributionDollars(s, primaryTaxedGrossAnnualDollars) * 12,
          0,
        ),
      );
    // Effective initial balance = stored retirement_settings.initialBalanceDollars
    // PLUS the current balance of every retirement-tagged savings item. Users
    // edit savings balances in /budget; this avoids forcing them to also keep
    // retirement_settings.initialBalanceDollars in sync by hand.
    const initialBalanceDollars = round2(
      settings.initialBalanceDollars +
        retirementSavings.reduce((sum, s) => sum + s.currentBalanceDollars, 0),
    );
    const result = project({
      settings: {
        currentAge: settings.currentAge,
        retirementAge: settings.retirementAge,
        initialBalanceDollars,
        growthRate: settings.growthRate,
        rothSplitPct: settings.rothSplitPct,
      },
      annualContributionDollars,
      retirementEffectiveTaxRate: taxSettings.retirementEffectiveTaxRate,
    });
    return { ...result, annualContributionDollars, initialBalanceDollars };
  },
};

const compute_sensitivity: ToolDef = {
  name: "compute_sensitivity",
  description:
    "Build a sensitivity grid of monthly remaining (take-home minus expenses) over a 5x5 sweep of primary x spouse income. Useful for 'what combined income makes this scenario feasible?' analysis. Each grid cell is annualTakeHome - sum(annualized expenses), divided by 12. Per-cell filing: cells with spouse=0 use the workspace's actual filing status (single/mfj/mfs/hoh); cells with spouse>0 are computed as MFJ since a 2-earner cell is only legally coherent as a married household.",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      workspaceId: { type: "integer", minimum: 1 },
      primaryRangeDollars: {
        type: "array",
        items: { type: "number", minimum: 0 },
        minItems: 2,
        maxItems: 2,
        description: "[minDollars, maxDollars] for primary annual gross",
      },
      spouseRangeDollars: {
        type: "array",
        items: { type: "number", minimum: 0 },
        minItems: 2,
        maxItems: 2,
        description: "[minDollars, maxDollars] for spouse annual gross",
      },
      gridSize: {
        type: "integer",
        minimum: 2,
        maximum: 11,
        description: "Number of steps per axis (default 5).",
      },
    },
    required: ["workspaceId", "primaryRangeDollars", "spouseRangeDollars"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      primaryAxisDollars: { type: "array", items: { type: "number" } },
      spouseAxisDollars: { type: "array", items: { type: "number" } },
      grid: {
        type: "array",
        items: {
          type: "array",
          items: { type: "number" },
        },
        description:
          "grid[primaryIdx][spouseIdx] = monthly remaining in dollars (can be negative).",
      },
      filing: {
        type: "string",
        description:
          "Workspace's baseline filing status (used for s=0 cells). Cells with spouse>0 are always computed as MFJ regardless of this value.",
      },
      fallbackCells: {
        type: "integer",
        description:
          "Count of cells where the workspace's filing (MFS/HOH) lacked seeded tax brackets and the computation fell back to MFJ. UI may surface this as a small footnote so the user knows those cells are approximations.",
      },
    },
  },
  handler: (args, ctx) => {
    const a = args as {
      workspaceId: number;
      primaryRangeDollars: [number, number];
      spouseRangeDollars: [number, number];
      gridSize?: number;
    };
    const N = a.gridSize ?? 5;
    // Guard: ranges must be lo <= hi. Server-side because MCP/API callers
    // bypass the UI-side check.
    if (a.primaryRangeDollars[0] > a.primaryRangeDollars[1]) {
      throw new Error(
        `primaryRangeDollars low (${a.primaryRangeDollars[0]}) must be <= high (${a.primaryRangeDollars[1]})`,
      );
    }
    if (a.spouseRangeDollars[0] > a.spouseRangeDollars[1]) {
      throw new Error(
        `spouseRangeDollars low (${a.spouseRangeDollars[0]}) must be <= high (${a.spouseRangeDollars[1]})`,
      );
    }
    const settings = ctx.tax.settingsForWorkspace(a.workspaceId);
    const tables = ctx.tax.tables(settings.taxYear);

    // Annualize all expenses in dollars.
    const annualExpensesDollars = round2(ctx.expenses
      .list(a.workspaceId)
      .reduce((sum, e) => sum + annualizeDollars(e.amountDollars, e.frequency), 0));

    // Savings accounts for per-cell payroll-withholding resolution. %-of-salary
    // contributions scale with the swept income OF THE OWNING FILER, so they're
    // resolved inside computeCell against that cell's (p, s) pair — primary-owned
    // rows against p, spouse-owned rows against s. That per-owner scaling is the
    // point of the sweep: a spouse's 10%-of-salary 401k must move along the
    // spouse axis, not the primary axis.
    const savingsRows = ctx.savings.list(a.workspaceId);

    const primaryAxisDollars = stepAxis(a.primaryRangeDollars, N);
    const spouseAxisDollars = stepAxis(a.spouseRangeDollars, N);

    // Per-cell filing semantics. The grid is a "what-if combined income"
    // tool:
    //   s == 0 → use the workspace's actual filing (single/mfj/mfs/hoh
    //            as-is). This is the user's real baseline for that primary
    //            income value; do NOT promote to MFJ just because the
    //            spouse axis happens to extend past 0.
    //   s >  0 → promote to MFJ. A two-earner cell is only coherent as a
    //            married household — you can't legally be single/mfs/hoh
    //            and have a spouse with income.
    // This replaces a prior workspace-level coercion that:
    //   (a) silently overwrote MFS/HOH to MFJ for the whole grid, and
    //   (b) applied the MFJ standard deduction to a single income on the
    //       s=0 column whenever the spouse range had any non-zero step.
    // Per-cell fallback: takeHome throws if the tax_tables for cellFiling
    // aren't seeded (the seeded data ships brackets for {single, mfj}; MFS
    // and HOH brackets are optional). Rather than aborting the whole grid
    // — which would surface as a generic error to the user — we retry the
    // cell as MFJ. We track which cells fell back so the response can flag
    // the UI to render a small footnote ("MFJ approximation: N/M cells").
    function computeCell(p: number, s: number): { remaining: number; fallback: boolean } {
      const baseFiling: "mfj" | "single" | "mfs" | "hoh" =
        s > 0 ? "mfj" : settings.filing;
      // Resolve payroll withholdings against THIS cell's incomes, split by the
      // filer who OWNS each account (employer match excluded): primary-owned
      // %-of-salary rows scale with p, spouse-owned rows with s, and each
      // owner's withholdings reduce that owner's leg of takeHome(). At s === 0
      // there is no spouse leg (same rule as before), so spouse-owned
      // withholdings don't apply to that cell — consistent with
      // computeWorkspaceTakeHome's no-spouse-leg behavior, and the coherent
      // reading of "what if the spouse earns $0" (nothing can be withheld from
      // a paycheck that doesn't exist; %-of-salary rows resolve to $0 there
      // anyway).
      const wh = resolveWithholdingsByOwner(savingsRows, p, s);
      const primary = {
        grossAnnualDollars: p,
        pretax401kDollars: wh.primary.pretaxAnnualDollars,
        pretaxHealthDollars: 0,
        postTaxPayrollDollars: wh.primary.postTaxPayrollAnnualDollars,
      };
      const spouse = s > 0
        ? {
            grossAnnualDollars: s,
            pretax401kDollars: wh.spouse.pretaxAnnualDollars,
            pretaxHealthDollars: 0,
            postTaxPayrollDollars: wh.spouse.postTaxPayrollAnnualDollars,
          }
        : undefined;
      try {
        const th = takeHome({
          primary,
          spouse,
          settings: { ...settings, filing: baseFiling },
          tables,
        });
        return { remaining: th.annualTakeHomeDollars - annualExpensesDollars, fallback: false };
      } catch (e) {
        if (baseFiling === "mfj") throw e; // MFJ should always have brackets
        const th = takeHome({
          primary,
          spouse,
          settings: { ...settings, filing: "mfj" },
          tables,
        });
        return { remaining: th.annualTakeHomeDollars - annualExpensesDollars, fallback: true };
      }
    }

    const grid: number[][] = [];
    let fallbackCells = 0;
    for (const p of primaryAxisDollars) {
      const row: number[] = [];
      for (const s of spouseAxisDollars) {
        const cell = computeCell(p, s);
        if (cell.fallback) fallbackCells++;
        row.push(round2(cell.remaining / 12));
      }
      grid.push(row);
    }
    // Echo the workspace's baseline filing — used for s=0 cells. Spouse
    // columns are always MFJ. `fallbackCells` is the count of cells whose
    // workspace-baseline filing lacked brackets and were computed as MFJ
    // instead (graceful degradation for MFS/HOH workspaces without seeded
    // brackets); UI can surface it as a small footnote.
    return {
      primaryAxisDollars,
      spouseAxisDollars,
      grid,
      filing: settings.filing,
      fallbackCells,
    };
  },
};

const get_sensitivity_settings: ToolDef = {
  name: "get_sensitivity_settings",
  description:
    "Get the persisted sensitivity-grid axis ranges (primary + spouse annual gross, in dollars) for a workspace. Returns null if not yet set. Drives the Planning page so the grid restores its last-used ranges on load.",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: { workspaceId: { type: "integer", minimum: 1 } },
    required: ["workspaceId"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      workspaceId: { type: "integer" },
      primaryLowDollars: { type: "number" },
      primaryHighDollars: { type: "number" },
      spouseLowDollars: { type: "number" },
      spouseHighDollars: { type: "number" },
    },
  },
  handler: (args, ctx) => {
    const a = args as { workspaceId: number };
    return ctx.sensitivity.get(a.workspaceId);
  },
};

const set_sensitivity_settings: ToolDef = {
  name: "set_sensitivity_settings",
  description:
    "Set (upsert) the sensitivity-grid axis ranges for a workspace. All four bounds are DOLLARS (e.g. $50,000 → 50000). Must satisfy primaryLowDollars < primaryHighDollars and spouseLowDollars <= spouseHighDollars.",
  inputSchema: {
    type: "object",
    properties: {
      workspaceId: { type: "integer", minimum: 1 },
      primaryLowDollars: { type: "number", minimum: 0 },
      primaryHighDollars: { type: "number", minimum: 0 },
      spouseLowDollars: { type: "number", minimum: 0 },
      spouseHighDollars: { type: "number", minimum: 0 },
    },
    required: [
      "workspaceId",
      "primaryLowDollars",
      "primaryHighDollars",
      "spouseLowDollars",
      "spouseHighDollars",
    ],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { saved: { type: "boolean" } },
    required: ["saved"],
  },
  handler: (args, ctx) => {
    const a = args as Parameters<typeof ctx.sensitivity.set>[0];
    // Mirror compute_sensitivity's server-side range guards so MCP/API callers
    // (which bypass the UI check) can't persist an inverted range.
    if (a.primaryLowDollars >= a.primaryHighDollars) {
      throw new Error(
        `primaryLowDollars (${a.primaryLowDollars}) must be < primaryHighDollars (${a.primaryHighDollars})`,
      );
    }
    if (a.spouseLowDollars > a.spouseHighDollars) {
      throw new Error(
        `spouseLowDollars (${a.spouseLowDollars}) must be <= spouseHighDollars (${a.spouseHighDollars})`,
      );
    }
    return ctx.sensitivity.set(a);
  },
};

function stepAxis(
  range: readonly [number, number],
  steps: number,
): number[] {
  const [lo, hi] = range;
  if (steps === 1) return [round2((lo + hi) / 2)];
  const step = (hi - lo) / (steps - 1);
  const out: number[] = [];
  for (let i = 0; i < steps; i++) {
    out.push(round2(lo + step * i));
  }
  return out;
}

function annualizeDollars(amountDollars: number, frequency: string): number {
  switch (frequency) {
    case "weekly":
      return round2(amountDollars * 52);
    case "biweekly":
      return round2(amountDollars * 26);
    case "monthly":
      return round2(amountDollars * 12);
    case "quarterly":
      return round2(amountDollars * 4);
    case "annually":
      return amountDollars;
    case "one_time":
      return amountDollars;
    default:
      return round2(amountDollars * 12); // safe fallback
  }
}

// ---------------------------------------------------------------------------
// Tax-table query tool (Train F / F1) — the HONEST dropdown source.
// ---------------------------------------------------------------------------

/** Year window list_tax_tables scans. The TaxRepo interface exposes only
 *  `tables(year)` (no "list all years" accessor), so we probe a bounded set
 *  of plausible years and return whichever rows actually exist. The window
 *  covers the seeded year (2025) plus a few back/forward so a freshly-fetched
 *  2026 or a historical 2023 table both surface without a code change. If
 *  this proves too narrow, the right fix is a `listAllYears()` accessor on
 *  TaxRepo — see the TODO on list_tax_tables. */
const TAX_TABLE_SCAN_YEARS = (() => {
  const years: number[] = [];
  for (let y = 2018; y <= 2035; y++) years.push(y);
  return years;
})();

const list_tax_tables: ToolDef = {
  name: "list_tax_tables",
  description:
    "List the tax brackets that are ACTUALLY present in the database. Returns one entry per (year, jurisdiction, filing) combination found, each with its standard deduction (dollars) and full bracket schedule. " +
    "READ-ONLY. This is the source of truth for what the app can compute with — the Setup tax-table dropdowns enumerate ONLY these combinations, and the brackets render from these rows (no hardcoded copies). " +
    "jurisdiction is 'federal' or 'ca'; filing is 'single' or 'mfj' (the app does not model MFS/HoH). " +
    "When a (year, jurisdiction, filing) the user wants is NOT in this list, that's the signal to offer the fetch-and-import flow (fetch_tax_source_by_year → import_tax_table) to add it.",
  readOnly: true,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: {
    type: "object",
    properties: {
      tables: {
        type: "array",
        items: {
          type: "object",
          properties: {
            year: { type: "integer" },
            jurisdiction: { type: "string", enum: [...VALID_JURISDICTIONS] },
            filing: { type: "string", enum: [...VALID_FILINGS] },
            standardDeductionDollars: { type: "number" },
            // sourceUrl is null today: the read accessor (TaxRepo.tables) does
            // not surface source_url even though the write path stores it.
            // See the TODO in the handler.
            sourceUrl: { type: "string" },
            brackets: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  upTo: { type: "number" },
                  rate: { type: "number" },
                },
                required: ["rate"],
              },
            },
          },
          required: ["year", "jurisdiction", "filing", "standardDeductionDollars", "brackets"],
        },
      },
      years: {
        type: "array",
        items: { type: "integer" },
        description: "Distinct years present, ascending — convenience for populating a year dropdown.",
      },
    },
    required: ["tables", "years"],
  },
  handler: (_args, ctx) => {
    interface TaxTableRow {
      year: number;
      jurisdiction: "federal" | "ca";
      filing: "single" | "mfj";
      standardDeductionDollars: number;
      // TODO(train-with-TaxRepo-ownership): TaxRepo.tables() does not return
      // source_url, so we can't surface the provenance the write path stored.
      // Add a `listAllTables()` accessor (returning source_url + spanning all
      // years) and replace the year-window scan below. Until then sourceUrl is
      // null in this output. Assigned to the repositories.ts-owning train.
      sourceUrl: string | null;
      brackets: Array<{ upTo: number | null; rate: number }>;
    }
    const tables: TaxTableRow[] = [];
    const yearSet = new Set<number>();
    for (const year of TAX_TABLE_SCAN_YEARS) {
      let rows: ReturnType<typeof ctx.tax.tables>;
      try {
        rows = ctx.tax.tables(year);
      } catch {
        // A year with no rows may surface as an empty array OR (depending on
        // the repo impl) throw — treat both as "nothing for this year".
        continue;
      }
      for (const r of rows) {
        tables.push({
          year: r.year,
          jurisdiction: r.jurisdiction,
          filing: r.filing,
          standardDeductionDollars: r.standardDeductionDollars,
          sourceUrl: null,
          brackets: r.brackets,
        });
        yearSet.add(r.year);
      }
    }
    // Deterministic order: year asc, then jurisdiction, then filing.
    tables.sort(
      (a, b) =>
        a.year - b.year ||
        a.jurisdiction.localeCompare(b.jurisdiction) ||
        a.filing.localeCompare(b.filing),
    );
    return { tables, years: [...yearSet].sort((a, b) => a - b) };
  },
};

// ---------------------------------------------------------------------------
// Tax-source ingest tools (M7+ / LLM agent)
// ---------------------------------------------------------------------------

const KNOWN_TAX_SOURCES = [
  {
    label: "IRS — 2025 inflation adjustments (federal brackets, std. deductions)",
    url: "https://www.irs.gov/newsroom/irs-releases-tax-inflation-adjustments-for-tax-year-2025",
    jurisdiction: "federal",
  },
  {
    label: "IRS — main inflation-adjustment index",
    url: "https://www.irs.gov/inflation-adjustments-and-tax-tables",
    jurisdiction: "federal",
  },
  {
    label: "California FTB — current-year tax rates + brackets",
    url: "https://www.ftb.ca.gov/file/personal/filing-information.html",
    jurisdiction: "ca",
  },
];

const fetch_tax_source: ToolDef = {
  name: "fetch_tax_source",
  description:
    "Fetch a known tax-authority page and return its visible text content (HTML is stripped server-side). ALLOWED HOSTS: www.irs.gov, www.ftb.ca.gov — any other host is rejected. KNOWN STARTING URLS:\n" +
    KNOWN_TAX_SOURCES.map((s) => `  - ${s.url} (${s.label})`).join("\n") +
    "\nReturns { status, body, truncated, finalUrl }. body is plain text (script/style/markup stripped), capped at ~40K chars to fit small LLM contexts. After parsing the brackets, call set_tax_table to write — but use dryRun:true first so the user can confirm.",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description:
          "Absolute HTTPS URL on the allowlist (www.irs.gov or www.ftb.ca.gov).",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      status: { type: "integer" },
      body: { type: "string" },
      truncated: { type: "boolean" },
      finalUrl: { type: "string" },
    },
  },
  handler: (args, ctx) => {
    const a = args as { url: string };
    return ctx.web.fetch(a.url);
  },
};

const BRACKETS_ITEM_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    upTo: {
      // Our minimal JSON Schema validator doesn't support union types, so
      // we encode the "top bracket" sentinel by OMITTING `upTo` rather
      // than sending `null`. The handler normalizes missing-or-null →
      // null for storage in tax_tables.brackets_json.
      type: "number",
      minimum: 0.01,
      description:
        "Upper income cutoff in DOLLARS. OMIT this field entirely for the top (highest) bracket; the handler treats absence as 'extends to infinity'.",
    },
    rate: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["rate"],
  additionalProperties: false,
};

const set_tax_table: ToolDef = {
  name: "set_tax_table",
  description:
    "Upsert (replace) a single tax_tables row keyed on (year, jurisdiction, filing). Use this AFTER parsing brackets from a fetch_tax_source result.\n\nConventions:\n- All amounts are DOLLARS (e.g. $15,750 → 15750).\n- brackets is an array of objects {upTo: dollars, rate: 0..1}.\n- For the TOP (highest) bracket, OMIT the upTo field — the handler treats absence as 'extends to infinity'.\n- Lower brackets must be in ascending order by upTo, with non-decreasing rates.\n- jurisdiction = 'federal' | 'ca'; filing = 'single' | 'mfj'.\n- Set dryRun:true on the first call so the user can confirm the parsed values before the live write.\n- sourceUrl should be the page you fetched the data from.",
  inputSchema: {
    type: "object",
    properties: {
      year: { type: "integer", minimum: 2000, maximum: 2100 },
      jurisdiction: { type: "string", enum: ["federal", "ca"] },
      filing: { type: "string", enum: ["single", "mfj"] },
      standardDeductionDollars: { type: "number", minimum: 0 },
      brackets: {
        type: "array",
        items: BRACKETS_ITEM_SCHEMA,
        minItems: 1,
      },
      sourceUrl: { type: "string" },
      dryRun: {
        type: "boolean",
        description:
          "If true, validate + echo back the parsed table but do NOT write to the DB. Default false.",
      },
    },
    required: ["year", "jurisdiction", "filing", "standardDeductionDollars", "brackets"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      saved: { type: "boolean" },
      dryRun: { type: "boolean" },
      year: { type: "integer" },
      jurisdiction: { type: "string" },
      filing: { type: "string" },
      standardDeductionDollars: { type: "number" },
      brackets: {
        type: "array",
        items: BRACKETS_ITEM_SCHEMA,
      },
      sourceUrl: { type: "string" },
    },
  },
  handler: (args, ctx) => {
    const a = args as {
      year: number;
      jurisdiction: "federal" | "ca";
      filing: "single" | "mfj";
      standardDeductionDollars: number;
      brackets: Array<{ upTo?: number | null; rate: number }>;
      sourceUrl?: string;
      dryRun?: boolean;
    };
    // Normalize: omitted-upTo OR explicit null both mean "top bracket".
    // Store as null for compatibility with the existing brackets_json format.
    const normalized: Array<{ upTo: number | null; rate: number }> = a.brackets.map(
      (b) => ({ upTo: b.upTo ?? null, rate: b.rate }),
    );

    // Domain validation:
    // (a) exactly one top-bracket sentinel at the end,
    // (b) lower brackets ascending by upTo,
    // (c) rates non-decreasing.
    let lastUpTo = -Infinity;
    let lastRate = -Infinity;
    for (let i = 0; i < normalized.length; i++) {
      const b = normalized[i]!;
      if (b.upTo === null) {
        if (i !== normalized.length - 1) {
          throw new Error(
            `Only the LAST bracket may omit upTo (top bracket). Index ${i} omits it.`,
          );
        }
      } else {
        if (b.upTo <= lastUpTo) {
          throw new Error(
            `Brackets must be ascending by upTo. Index ${i} (upTo=${b.upTo}) is not > previous (${lastUpTo}).`,
          );
        }
        lastUpTo = b.upTo;
      }
      if (b.rate < lastRate) {
        throw new Error(
          `Bracket rates must be non-decreasing. Index ${i} rate ${b.rate} < previous ${lastRate}.`,
        );
      }
      lastRate = b.rate;
    }
    if (normalized[normalized.length - 1]!.upTo !== null) {
      throw new Error(
        "The last bracket must omit upTo (top bracket extends to infinity).",
      );
    }

    // Train F hardening (Gemini FIX 2): route the legacy write path through
    // the SAME domain validator import_tax_table uses, so garbage that passes
    // the looser inline checks above (rate 0 or >= 0.5, zero/negative
    // standard deduction, non-zero-based first bracket) can no longer reach
    // the DB through this tool. The inline checks stay FIRST — their error
    // messages are load-bearing for existing tests and the API route's
    // domain-error mapping; the validator runs after them as the stricter
    // gate. set_tax_table has no separate requested-year context, so the
    // payload's own year doubles as the expected year — the year cross-check
    // is a no-op here, but every other invariant still applies.
    const legacyValidation = validateTaxTablePayload(
      {
        year: a.year,
        jurisdiction: a.jurisdiction,
        filing: a.filing,
        standardDeductionDollars: a.standardDeductionDollars,
        brackets: normalized,
        ...(a.sourceUrl !== undefined ? { sourceUrl: a.sourceUrl } : {}),
      },
      a.year,
    );
    if (!legacyValidation.ok) {
      const detail = legacyValidation.errors
        .map((e) => `${e.field}: ${e.message}`)
        .join("; ");
      throw new Error(`tax table validation failed — ${detail}`);
    }

    const echo = {
      year: a.year,
      jurisdiction: a.jurisdiction,
      filing: a.filing,
      standardDeductionDollars: a.standardDeductionDollars,
      brackets: normalized,
      sourceUrl: a.sourceUrl,
    };
    if (a.dryRun) {
      return { saved: false, dryRun: true, ...echo };
    }
    ctx.tax.upsertTable({
      year: a.year,
      jurisdiction: a.jurisdiction,
      filing: a.filing,
      standardDeductionDollars: a.standardDeductionDollars,
      brackets: normalized,
      sourceUrl: a.sourceUrl,
    });
    return { saved: true, dryRun: false, ...echo };
  },
};

// ---------------------------------------------------------------------------
// Tax-source URL prediction + year-aware fetch (Train F / F2).
// ---------------------------------------------------------------------------

/** Sources the year-aware fetcher knows how to predict a URL for. */
export type TaxSourceName = "irs" | "ca_ftb";

/**
 * Predict the canonical URL for a tax-authority's inflation-adjustment /
 * tax-rate page for a given year.
 *
 * IRS — federal brackets + standard deductions:
 *   Pattern: https://www.irs.gov/newsroom/irs-provides-tax-inflation-adjustments-for-tax-year-{year}
 *   The IRS publishes one newsroom article per tax year with this slug shape.
 *   FAILURE MODE: the slug VERB is not perfectly stable — the IRS has used
 *   both "irs-provides-..." (most years, e.g. 2024 and earlier) and
 *   "irs-releases-..." (tax year 2025). We predict the "provides" form (the
 *   long-run majority and the form the brief specifies); when the prediction
 *   404s or the page doesn't mention the target year, the caller is told to
 *   retry with `urlOverride` pointing at the real article. Future years are
 *   PREDICTED on this same pattern (the article doesn't exist until the IRS
 *   publishes it, typically the autumn before the tax year).
 *
 * CA FTB — California personal income tax rates + brackets:
 *   Pattern: https://www.ftb.ca.gov/file/personal/tax-rates.html
 *   The FTB consolidates current-year personal tax rates on this stable,
 *   non-year-suffixed page (it does NOT mint a per-year URL the way the IRS
 *   does). FAILURE MODE: because the URL carries no year, the page reflects
 *   whatever the FTB currently shows — the year-sanity check below guards
 *   against importing a year the page doesn't actually cover. FALLBACK: the
 *   filing-information index (https://www.ftb.ca.gov/file/personal/filing-information.html)
 *   if the rates page moves; pass it via `urlOverride`.
 *
 * Both hosts are on the web_fetcher allowlist (www.irs.gov, www.ftb.ca.gov).
 */
export function predictTaxSourceUrl(source: TaxSourceName, year: number): string {
  switch (source) {
    case "irs":
      return `https://www.irs.gov/newsroom/irs-provides-tax-inflation-adjustments-for-tax-year-${year}`;
    case "ca_ftb":
      // FTB's tax-rates page is not year-suffixed; year is validated against
      // the fetched page text instead of being baked into the URL.
      return "https://www.ftb.ca.gov/file/personal/tax-rates.html";
    default: {
      // Exhaustiveness guard — a new TaxSourceName must extend this switch.
      const _never: never = source;
      throw new Error(`Unknown tax source: ${String(_never)}`);
    }
  }
}

/** Reduce a fetched page's already-HTML-stripped text down to the sections
 *  likely to carry bracket/standard-deduction data, and cap the length so it
 *  comfortably fits the assistant's context window.
 *
 *  Strategy: keep paragraphs that mention tax-schedule keywords (rate, bracket,
 *  taxable income, standard deduction, dollar figures) plus a little
 *  surrounding context; drop pure navigation/boilerplate lines. If filtering
 *  would drop almost everything (an unexpected page layout), fall back to the
 *  head of the raw text so we never hand the assistant an empty excerpt. */
export function reduceTaxPageText(text: string, maxChars: number): string {
  const KEYWORDS =
    /(tax rate|tax bracket|marginal|taxable income|standard deduction|filing|married|single|head of household|\$[\d,]{3,}|\d{1,3}(?:\.\d+)?\s*%)/i;
  const lines = text.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    if (KEYWORDS.test(line)) kept.push(line);
  }
  let excerpt = kept.join("\n");
  // If keyword filtering nuked nearly everything (layout we didn't anticipate),
  // fall back to the raw head so the assistant still has something to parse.
  if (excerpt.length < 200) {
    excerpt = text;
  }
  if (excerpt.length > maxChars) {
    excerpt = excerpt.slice(0, maxChars);
  }
  return excerpt.trim();
}

/** Excerpt cap. The web_fetcher already strips HTML and caps the text form at
 *  ~40K chars; we reduce further to the relevant sections and cap at 25K so the
 *  excerpt + the rest of the chat prompt stays well under chat.ts's
 *  CONTEXT_BUDGET (a 131K-token window; 25K chars ≈ 7K tokens leaves ample
 *  room for the system prompt, workspace summary, history, and the reply). */
const TAX_EXCERPT_MAX_CHARS = 25_000;

const fetch_tax_source_by_year: ToolDef = {
  name: "fetch_tax_source_by_year",
  description:
    "Predict the official tax-authority page URL for a given source + year, fetch it (allowlisted hosts only: www.irs.gov, www.ftb.ca.gov), and return the relevant page text reduced to fit the assistant's context.\n" +
    "Inputs: source ('irs' for federal brackets + standard deductions, 'ca_ftb' for California rates); year (e.g. 2025); optional urlOverride (an allowlisted URL to use INSTEAD of the predicted one — pass this when prediction misses).\n" +
    "URL PREDICTION: irs → https://www.irs.gov/newsroom/irs-provides-tax-inflation-adjustments-for-tax-year-{year} (future years are predicted on this pattern; the slug verb 'provides' vs 'releases' varies by year — if it 404s, retry with urlOverride). ca_ftb → https://www.ftb.ca.gov/file/personal/tax-rates.html (no year suffix; validated against page text).\n" +
    "Returns { url, fetchedAt, textExcerpt } on success. SANITY CHECK: if the fetched page does NOT mention the requested year, returns { error, hint, url } inviting you to retry with urlOverride rather than parsing the wrong year.\n" +
    "After a successful fetch, parse the brackets + standard deduction, then call import_tax_table with dryRun:true to preview before the user confirms.",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      source: { type: "string", enum: ["irs", "ca_ftb"] },
      year: { type: "integer", minimum: 2000, maximum: 2100 },
      urlOverride: {
        type: "string",
        description:
          "Optional. An allowlisted absolute HTTPS URL (www.irs.gov or www.ftb.ca.gov) to fetch INSTEAD of the predicted one. Use when the predicted slug is wrong (e.g. 'releases' vs 'provides') or the page moved.",
      },
    },
    required: ["source", "year"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL actually fetched (predicted or override)." },
      fetchedAt: { type: "string", description: "ISO timestamp of the fetch." },
      textExcerpt: {
        type: "string",
        description: "Page text reduced to the bracket/deduction-relevant sections, capped to fit context. Present only on success.",
      },
      error: { type: "string", description: "Present instead of textExcerpt when the fetch failed or the page didn't mention the requested year." },
      hint: { type: "string", description: "Present with error: how to recover (typically: retry with urlOverride)." },
    },
  },
  handler: async (args, ctx) => {
    const a = args as { source: TaxSourceName; year: number; urlOverride?: string };
    const url = a.urlOverride ?? predictTaxSourceUrl(a.source, a.year);
    const fetchedAt = new Date().toISOString();

    let fetched: Awaited<ReturnType<typeof ctx.web.fetch>>;
    try {
      fetched = await ctx.web.fetch(url);
    } catch (e) {
      // The allowlist / network error from the fetcher. Surface it structured
      // (not thrown) so the assistant can react and retry with urlOverride.
      return {
        url,
        fetchedAt,
        error: `fetch failed: ${(e as Error).message}`,
        hint:
          "If the predicted URL is wrong (e.g. an IRS slug using 'releases' instead of 'provides', or a moved page), retry with urlOverride set to the correct allowlisted URL (www.irs.gov or www.ftb.ca.gov).",
      };
    }

    if (fetched.status >= 400) {
      return {
        url: fetched.finalUrl || url,
        fetchedAt,
        error: `page returned HTTP ${fetched.status}`,
        hint:
          a.source === "irs"
            ? `The IRS article for ${a.year} may use the 'irs-releases-...' slug instead of 'irs-provides-...', or may not be published yet. Retry with urlOverride pointing at the correct www.irs.gov article.`
            : "Retry with urlOverride pointing at the correct www.ftb.ca.gov page (e.g. the filing-information index).",
      };
    }

    // Reduce FIRST, then year-sanity-check the EXCERPT (Gemini FIX 3). The
    // guard must run against the text the assistant will actually parse: a
    // raw-body check false-accepts pages whose only mention of the year is a
    // site footer ("© 2025 ...") that the reducer strips. Two failure shapes:
    //   - year absent from the excerpt but present in the raw body → the page
    //     mentions the year only OUTSIDE the rate-table content (footer/nav),
    //     or the reducer truncated the year-bearing section. Recoverable —
    //     the hint says so and invites urlOverride.
    //   - year absent from both → almost certainly the wrong page/year.
    const textExcerpt = reduceTaxPageText(fetched.body, TAX_EXCERPT_MAX_CHARS);
    if (!textExcerpt.includes(String(a.year))) {
      const yearInRawBody = fetched.body.includes(String(a.year));
      return {
        url: fetched.finalUrl || url,
        fetchedAt,
        error: yearInRawBody
          ? `the page mentions ${a.year} only outside the rate-table content (e.g. a footer or navigation), not in the bracket/deduction sections`
          : `the fetched page does not mention the year ${a.year}`,
        hint: yearInRawBody
          ? `The reduced excerpt does not carry ${a.year} — this may be the wrong article for that tax year, or the year-bearing section was filtered/truncated. Retry with urlOverride pointing at the specific article for tax year ${a.year} (allowlisted hosts only).`
          : "This is likely the wrong page for that year. Retry with urlOverride pointing at the specific article for that tax year (allowlisted hosts only).",
      };
    }

    return { url: fetched.finalUrl || url, fetchedAt, textExcerpt };
  },
};

// ---------------------------------------------------------------------------
// Validated import wrapper (Train F / F3b).
//
// Why a NEW tool rather than wiring validation into set_tax_table: the
// existing set_tax_table ToolDef ships its own (looser) inline checks and is
// frozen for this train. import_tax_table is the clean path — it runs the
// full validateTaxTablePayload() contract (year-matches-request, rate bounds,
// zero-based first bracket, etc.) BEFORE delegating to ctx.tax.upsertTable.
// It rides the same confirm-before-mutation gate (NOT readOnly), and supports
// dryRun:true for the preview step. The assistant import flow should prefer
// this tool; set_tax_table remains for backward compatibility.
// ---------------------------------------------------------------------------

const import_tax_table: ToolDef = {
  name: "import_tax_table",
  description:
    "Validate AND upsert a single tax_tables row keyed on (year, jurisdiction, filing). This is the VALIDATED import path — call it after parsing brackets from a fetch_tax_source_by_year result.\n\n" +
    "Validation (all enforced before any write; ALL failures are reported at once):\n" +
    "- year must match the `year` argument you pass (guards against parsing the wrong year's page),\n" +
    "- jurisdiction ∈ {federal, ca}; filing ∈ {single, mfj} (the app does not model MFS/HoH),\n" +
    "- standardDeductionDollars > 0,\n" +
    "- every rate strictly in (0, 0.5) — a value like 37 instead of 0.37 is rejected,\n" +
    "- bracket cutoffs strictly ascending,\n" +
    "- the first bracket is zero-based (its upTo > 0; the lowest bracket spans $0..upTo),\n" +
    "- the last (top) bracket is open-ended (OMIT upTo, or send null); no interior bracket is open-ended.\n\n" +
    "Conventions: all amounts are DOLLARS ($15,750 → 15750); brackets is [{upTo, rate}]; OMIT upTo on the top bracket. " +
    "Set dryRun:true on the FIRST call so the user can confirm the validated values before the live write; only call again without dryRun after explicit confirmation. Always pass sourceUrl (the page you fetched).",
  inputSchema: {
    type: "object",
    properties: {
      year: { type: "integer", minimum: 2000, maximum: 2100 },
      jurisdiction: { type: "string", enum: [...VALID_JURISDICTIONS] },
      filing: { type: "string", enum: [...VALID_FILINGS] },
      standardDeductionDollars: { type: "number", minimum: 0 },
      brackets: {
        type: "array",
        items: BRACKETS_ITEM_SCHEMA,
        minItems: 1,
      },
      sourceUrl: { type: "string" },
      dryRun: {
        type: "boolean",
        description: "If true, validate + echo back the normalized table but do NOT write to the DB. Default false.",
      },
    },
    required: ["year", "jurisdiction", "filing", "standardDeductionDollars", "brackets"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      saved: { type: "boolean" },
      dryRun: { type: "boolean" },
      year: { type: "integer" },
      jurisdiction: { type: "string" },
      filing: { type: "string" },
      standardDeductionDollars: { type: "number" },
      brackets: { type: "array", items: BRACKETS_ITEM_SCHEMA },
      sourceUrl: { type: "string" },
    },
  },
  handler: (args, ctx) => {
    const a = args as {
      year: number;
      jurisdiction: string;
      filing: string;
      standardDeductionDollars: number;
      brackets: Array<{ upTo?: number | null; rate: number }>;
      sourceUrl?: string;
      dryRun?: boolean;
    };
    // Normalize omitted-upTo / explicit-null → null (the top-bracket sentinel)
    // before validating, matching the storage format.
    const payload: TaxTablePayload = {
      year: a.year,
      jurisdiction: a.jurisdiction,
      filing: a.filing,
      standardDeductionDollars: a.standardDeductionDollars,
      brackets: a.brackets.map((b) => ({ upTo: b.upTo ?? null, rate: b.rate })),
      ...(a.sourceUrl !== undefined ? { sourceUrl: a.sourceUrl } : {}),
    };
    const result = validateTaxTablePayload(payload, a.year);
    if (!result.ok) {
      // Surface every failure in one message so the assistant can re-parse
      // and fix all of them in a single follow-up rather than one at a time.
      const detail = result.errors
        .map((e) => `${e.field}: ${e.message}`)
        .join("; ");
      throw new Error(`tax table validation failed — ${detail}`);
    }
    const n = result.normalized!;
    const echo = {
      year: n.year,
      jurisdiction: n.jurisdiction,
      filing: n.filing,
      standardDeductionDollars: n.standardDeductionDollars,
      brackets: n.brackets,
      sourceUrl: n.sourceUrl,
    };
    if (a.dryRun) {
      return { saved: false, dryRun: true, ...echo };
    }
    ctx.tax.upsertTable({
      year: n.year,
      jurisdiction: n.jurisdiction,
      filing: n.filing,
      standardDeductionDollars: n.standardDeductionDollars,
      brackets: n.brackets,
      sourceUrl: n.sourceUrl,
    });
    return { saved: true, dryRun: false, ...echo };
  },
};

// ---------------------------------------------------------------------------
// Registry assembly
// ---------------------------------------------------------------------------

/**
 * Map detector cadence-derived frequency → expense frequency enum used by
 * `expenses.add`. catalogueExpenses already returns the enum strings, but
 * we re-validate here so a future cadence label doesn't slip through and
 * land in the DB as "one_time" by accident.
 */
const CATALOGUE_FREQS = new Set([
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
  "annually",
  "one_time",
]);

const catalogue_expenses: ToolDef = {
  name: "catalogue_expenses",
  description:
    "Expense Cataloguer. Parses one or more bank/credit-card statement files (Chase PDF or Amex XLSX), runs the same recurring-detection + annual-fee detection + alias detection the human reviewer used on 2026-05-26, and returns expense candidates with auto-assigned category labels (via the merchant category resolver). " +
    "Use when the user asks to 'import statements', 'catalogue expenses', or 'review statements'. " +
    "By default this is READ-ONLY — the candidates are returned for the user to review. Pass `commit: true` AND a `workspaceId` to actually persist the candidates as expenses (source='imported'). " +
    "On commit, optionally pass `acceptedKeys: string[]` to filter to a user-selected subset. Each candidate's key is `${label}|${sourceAccount}|${amountDollars}|${frequency}` — the LLM should build this list when the user expresses preferences like 'accept just the recurring ones' or 'reject the SHELL one'. (The UI sends the per-candidate `candidateId` instead; both are accepted.) Omitting acceptedKeys means accept ALL. " +
    "On commit, the full parsed transaction history of each file is also persisted (idempotently, keyed on file content hash) so the Trends page and Library status reflect the import. " +
    "Paths must live under ./statements/ (allowlist, symlink-resolved). The tool reads file contents but NEVER echoes raw merchant strings or amounts in audit logs (counts and patterns only).",
  // NOT readOnly: commit:true mutates (expenses + transactions + statement_imports),
  // so the registry must audit it. Preview (commit:false) also produces a
  // metadata-only audit row — acceptable, since the audit log is redacted
  // (no raw args/results persisted).
  readOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      statementPaths: {
        type: "array",
        items: { type: "string", maxLength: 1024 },
        minItems: 1,
        maxItems: 100,
        description: "Paths to statement files. Must resolve under ./statements/. Mix of .pdf (Chase statements), .xlsx (Amex activity), and .csv (Chase activity export or bank exports with a Credit Debit Indicator column) supported. Max 100 per call.",
      },
      workspaceId: {
        type: "integer",
        minimum: 1,
        description: "Required only when commit:true — the workspace into which the candidates will be inserted as expenses.",
      },
      commit: {
        type: "boolean",
        description: "When true, persist each candidate as an expense row with source='imported'. Default false (analysis only).",
      },
      acceptedKeys: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional commit-time filter. If provided AND commit:true, only candidates whose key `${label}|${sourceAccount}|${amountDollars}|${frequency}` is in this list get persisted. Omit to accept all candidates.",
      },
    },
    required: ["statementPaths"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      summary: {
        type: "object",
        properties: {
          totalTxns: { type: "integer" },
          uniqueMerchants: { type: "integer" },
          seedCount: { type: "integer" },
          recurringCount: { type: "integer" },
          annualFeeCount: { type: "integer" },
          aliasCount: { type: "integer" },
          categorizedRate: { type: "number" },
        },
      },
      candidates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            candidateId: { type: "string", description: "Stable collision-free id for this candidate; the UI uses it for selection identity." },
            label: { type: "string" },
            amountDollars: { type: "number" },
            frequency: { type: "string" },
            category: { type: "string" },
            sourceAccount: { type: "string" },
            occurrences: { type: "integer" },
            seedReason: { type: "string" },
            lastSeen: { type: "string" },
          },
        },
      },
      aliasCandidates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            normalizedPrefix: { type: "string" },
            variants: { type: "array", items: { type: "object", properties: {
              merchant: { type: "string" },
              count: { type: "integer" },
            } } },
          },
        },
      },
      parsedFiles: { type: "integer" },
      parseErrors: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            error: { type: "string" },
          },
        },
      },
      committedIds: {
        type: "array",
        items: { type: "integer" },
        description: "Present only when commit:true. The expense row ids created from the candidates, in candidate-list order.",
      },
      skippedDuplicates: {
        type: "array",
        description: "Present only when commit:true. Accepted candidates that were NOT written because an identical budget item (same label, amount, frequency, spend date) already exists in the workspace. Relay these to the user.",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            amountDollars: { type: "number" },
            frequency: { type: "string" },
            spendDate: { type: "string" },
          },
        },
      },
    },
  },
  handler: async (args, ctx) => {
    const a = args as {
      statementPaths: string[];
      workspaceId?: number;
      commit?: boolean;
      acceptedKeys?: string[];
    };
    if (a.commit && (a.workspaceId === undefined || a.workspaceId === null)) {
      throw new Error("commit:true requires workspaceId");
    }

    // Path safety: resolve each path; require it to fall under the
    // ./statements/ directory of the current working directory (the API
    // server's cwd, which is the project root). Rejects path traversal and
    // arbitrary file reads.
    const pathMod = await import("node:path");
    const fsMod = await import("node:fs/promises");
    const statementsRoot = pathMod.resolve("statements");
    // Real path of the allowlist root, resolved once. Comparing realpaths
    // (not lexical paths) closes the symlink/junction escape (CWE-22): a
    // link placed under ./statements/ that points outside is rejected here
    // before any read.
    let realRoot: string;
    try {
      realRoot = await fsMod.realpath(statementsRoot);
    } catch {
      realRoot = statementsRoot;
    }
    const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB per statement file
    const validPaths: string[] = [];
    const seen = new Set<string>(); // dedupe so repeated paths don't reparse
    const parseErrors: Array<{ path: string; error: string }> = [];
    for (const p of a.statementPaths) {
      const resolved = pathMod.resolve(p);
      // Lexical pre-check (fast reject of obvious traversal).
      if (!resolved.startsWith(statementsRoot + pathMod.sep) && resolved !== statementsRoot) {
        parseErrors.push({ path: p, error: "path outside ./statements/ allowlist" });
        continue;
      }
      // Symlink-resolved check: the real target must still live under the
      // real allowlist root.
      let real: string;
      try {
        real = await fsMod.realpath(resolved);
      } catch {
        parseErrors.push({ path: p, error: "file not readable" });
        continue;
      }
      if (!real.startsWith(realRoot + pathMod.sep) && real !== realRoot) {
        parseErrors.push({ path: p, error: "path escapes ./statements/ via symlink" });
        continue;
      }
      if (seen.has(real)) continue; // already queued
      // Size cap (CWE-400): refuse to parse pathologically large files.
      try {
        const st = await fsMod.stat(real);
        if (st.size > MAX_FILE_BYTES) {
          parseErrors.push({ path: p, error: `file exceeds ${MAX_FILE_BYTES} byte limit` });
          continue;
        }
      } catch {
        parseErrors.push({ path: p, error: "file not readable" });
        continue;
      }
      seen.add(real);
      validPaths.push(real);
    }

    // Parse per-file so we can persist each file's transactions against its
    // own statement_imports row on commit. `allTxns` (the flattened view) is
    // still what catalogueExpenses() needs for cross-file recurring detection.
    const allTxns: RawTxn[] = [];
    const fileGroups: Array<{ filePath: string; txns: RawTxn[] }> = [];
    let parsedFiles = 0;
    for (const fp of validPaths) {
      const ext = fp.split(".").pop()?.toLowerCase() ?? "";
      try {
        let txns: RawTxn[];
        if (ext === "pdf") {
          txns = (await parseChasePdf(fp)).txns;
        } else if (ext === "xlsx" || ext === "xls") {
          txns = parseAmexXlsx(fp).txns;
        } else if (ext === "csv") {
          const parsed = parseStatementCsv(fp);
          if (parsed.txns.length === 0 && parsed.warnings.length > 0) {
            parseErrors.push({ path: fp, error: parsed.warnings.join("; ") });
            continue;
          }
          txns = parsed.txns;
        } else {
          parseErrors.push({ path: fp, error: `unsupported extension .${ext}` });
          continue;
        }
        allTxns.push(...txns);
        fileGroups.push({ filePath: fp, txns });
        parsedFiles++;
      } catch (e) {
        parseErrors.push({ path: fp, error: (e as Error).message });
      }
    }

    const result = catalogueExpenses(allTxns);

    const { createHash } = await import("node:crypto");

    // Two ids per candidate:
    //  - candidateKey: human-constructable `${label}|${account}|${amount}|${freq}`,
    //    documented for the LLM assistant-import path.
    //  - candidateId: a stable, collision-resistant hash the UI uses for
    //    selection identity (two genuinely distinct charges that happen to
    //    share label+amount+freq still differ by lastSeen/occurrences).
    const candidateKey = (c: ExpenseCandidate): string =>
      `${c.label}|${c.sourceAccount}|${c.amountDollars}|${c.frequency}`;
    const candidateIdOf = (c: ExpenseCandidate): string =>
      createHash("sha256")
        .update(`${candidateKey(c)}|${c.lastSeen}|${c.occurrences}`)
        .digest("hex")
        .slice(0, 16);

    // Attach candidateId to every candidate in the returned list (UI identity).
    const candidatesOut = result.candidates.map((c) => ({
      ...c,
      candidateId: candidateIdOf(c),
    }));

    const acceptedKeysSet =
      a.acceptedKeys !== undefined ? new Set(a.acceptedKeys) : null;
    // A candidate is accepted if its candidateId OR its legacy candidateKey is
    // in the set — so both the UI (sends candidateId) and the LLM (builds
    // candidateKey) work without the caller knowing which the other uses.
    const isAccepted = (c: ExpenseCandidate): boolean =>
      acceptedKeysSet === null ||
      acceptedKeysSet.has(candidateIdOf(c)) ||
      acceptedKeysSet.has(candidateKey(c));

    const committedIds: number[] = [];
    const skippedDuplicates: Array<{
      label: string;
      amountDollars: number;
      frequency: string;
      spendDate: string | null;
    }> = [];
    let importedFiles = 0;
    let importedTxns = 0;
    let alreadyImported = 0;

    if (a.commit && a.workspaceId !== undefined) {
      const workspaceId = a.workspaceId;
      const catMap = ctx.categories.listByName();
      // Resolve a transaction's category FK via the same rule-based resolver
      // the cataloguer uses, so persisted transactions carry categories for
      // the Trends chart.
      const txnCategoryId = (t: RawTxn): number | null =>
        catMap.get(defaultMerchantCategorizer(t)) ?? null;

      // Hash each file up front (async I/O) so the transaction body stays sync.
      const fileMeta = await Promise.all(
        fileGroups.map(async (grp) => {
          const bytes = await fsMod.readFile(grp.filePath);
          const fileHash = createHash("sha256").update(bytes).digest("hex");
          const relPath = pathMod
            .relative(pathMod.resolve("."), grp.filePath)
            .split(pathMod.sep)
            .join("/");
          return { grp, fileHash, relPath };
        }),
      );

      // One DB transaction for the whole commit: statement_imports +
      // transactions (full history, idempotent per file) + accepted expenses.
      ctx.tx(() => {
        for (const { grp, fileHash, relPath } of fileMeta) {
          const sourceAccount = grp.txns[0]?.accountType ?? "unknown";
          const rec = ctx.statementImports.record({
            sourceAccount,
            fileHash,
            filePath: relPath,
            txnCount: grp.txns.length,
          });
          if (rec.alreadyImported) {
            alreadyImported++;
            continue; // history already banked — don't double-insert
          }
          importedFiles++;
          if (grp.txns.length > 0) {
            const rows = grp.txns.map((t) => ({
              postedDate: t.postedDate,
              merchantRaw: t.merchantRaw,
              merchantNormalized: t.merchantNormalized,
              amountDollars: t.amountDollars,
              categoryId: txnCategoryId(t),
              accountType: t.accountType,
            }));
            const { inserted } = ctx.transactions.insertMany(rec.importId, rows);
            importedTxns += inserted;
          }
        }

        // Duplicate guard: an accepted candidate whose (label, amount,
        // frequency, spend date) already exists in the target workspace —
        // or appears twice within this batch — is skipped and reported,
        // so re-importing an overlapping statement can't double-book.
        const seenDupKeys = new Set(
          ctx.expenses.list(workspaceId).map((e) => expenseDupKey(e)),
        );

        // Accepted candidates → recurring expense rows. Per-row failures are
        // collected (non-fatal); they don't roll back the import history.
        for (const cand of result.candidates) {
          if (!isAccepted(cand)) continue;
          if (!CATALOGUE_FREQS.has(cand.frequency)) {
            parseErrors.push({ path: cand.label, error: `unsupported frequency ${cand.frequency}` });
            continue;
          }
          // One-time candidates land on the cluster's most-recent posted date
          // so the Trends chart places the spike in the right month.
          const spendDate = cand.frequency === "one_time" ? cand.lastSeen : null;
          const dupKey = expenseDupKey({
            label: cand.label,
            amountDollars: cand.amountDollars,
            frequency: cand.frequency,
            spendDate,
          });
          if (seenDupKeys.has(dupKey)) {
            skippedDuplicates.push({
              label: cand.label,
              amountDollars: cand.amountDollars,
              frequency: cand.frequency,
              spendDate,
            });
            continue;
          }
          const categoryId = catMap.get(cand.category) ?? null;
          try {
            const { id } = ctx.expenses.add({
              workspaceId,
              label: cand.label,
              amountDollars: cand.amountDollars,
              frequency: cand.frequency,
              spendDate,
              categoryId,
              source: "imported",
            });
            committedIds.push(id);
            seenDupKeys.add(dupKey);
          } catch (e) {
            parseErrors.push({ path: cand.label, error: (e as Error).message });
          }
        }
      });
    }

    return {
      summary: result.summary,
      candidates: candidatesOut,
      aliasCandidates: result.aliasCandidates,
      parsedFiles,
      parseErrors,
      ...(a.commit
        ? { committedIds, skippedDuplicates, importedFiles, importedTxns, alreadyImported }
        : {}),
    } satisfies {
      summary: typeof result.summary;
      candidates: Array<ExpenseCandidate & { candidateId: string }>;
      aliasCandidates: typeof result.aliasCandidates;
      parsedFiles: number;
      parseErrors: Array<{ path: string; error: string }>;
      committedIds?: number[];
      skippedDuplicates?: Array<{
        label: string;
        amountDollars: number;
        frequency: string;
        spendDate: string | null;
      }>;
      importedFiles?: number;
      importedTxns?: number;
      alreadyImported?: number;
    };
  },
};

const auto_categorize_expenses: ToolDef = {
  name: "auto_categorize_expenses",
  description:
    "Bulk-categorize expenses in a workspace by running each row's label through the rule-based category resolver. " +
    "By default this only fills expenses with NO existing category (null categoryId). " +
    "Pass overwrite:true to re-categorize every row, including ones the user has manually set. " +
    "Returns the number of rows changed and a per-row before/after summary for the LLM to relay back to the user.",
  inputSchema: {
    type: "object",
    properties: {
      workspaceId: { type: "integer", minimum: 1 },
      overwrite: {
        type: "boolean",
        description: "If true, re-categorize even rows that already have a category. Default false (only fills missing ones).",
      },
    },
    required: ["workspaceId"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      examined: { type: "integer" },
      changed: { type: "integer" },
      skipped: { type: "integer" },
      changes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "integer" },
            label: { type: "string" },
            // JsonSchema's local type union doesn't allow ["integer","null"].
            // Use integer-or-null semantics implicitly: client treats absent
            // / 0 / null uniformly. Tests cover the null case explicitly.
            previousCategoryId: { type: "integer" },
            newCategoryId: { type: "integer" },
            categoryName: { type: "string" },
          },
          required: ["id", "label", "categoryName"],
        },
      },
    },
    required: ["examined", "changed", "skipped", "changes"],
  },
  handler: (args, ctx) => {
    const a = args as { workspaceId: number; overwrite?: boolean };
    const overwrite = a.overwrite === true;
    const catByName = ctx.categories.listByName();
    const rows = ctx.expenses.list(a.workspaceId);
    const changes: Array<{
      id: number;
      label: string;
      previousCategoryId: number | null;
      newCategoryId: number | null;
      categoryName: string;
    }> = [];
    let examined = 0;
    let changed = 0;
    let skipped = 0;
    for (const row of rows) {
      examined += 1;
      if (!overwrite && row.categoryId !== null) {
        skipped += 1;
        continue;
      }
      const synthetic: RawTxn = {
        postedDate: row.createdAt.slice(0, 10),
        merchantRaw: row.label,
        merchantNormalized: normalizeMerchant(row.label),
        amountDollars: -row.amountDollars,
        accountType: "unknown",
      };
      const categoryName = defaultMerchantCategorizer(synthetic);
      const newCategoryId = catByName.get(categoryName) ?? null;
      if (newCategoryId === row.categoryId) {
        skipped += 1;
        continue;
      }
      ctx.expenses.update({ id: row.id, categoryId: newCategoryId });
      changed += 1;
      changes.push({
        id: row.id,
        label: row.label,
        previousCategoryId: row.categoryId,
        newCategoryId,
        categoryName,
      });
    }
    return { examined, changed, skipped, changes };
  },
};

const dedupe_expenses: ToolDef = {
  name: "dedupe_expenses",
  description:
    "Find budget items in a workspace that are exact duplicates of each other (same label ignoring case/whitespace, same amount, same frequency, same spend date) and remove the redundant copies, keeping the oldest row of each group. " +
    "Call with dryRun:true FIRST to preview the duplicate groups, present them to the user, and only run without dryRun after they confirm. " +
    "Typical cause: the same statement imported twice before the import-time duplicate guard existed.",
  inputSchema: {
    type: "object",
    properties: {
      workspaceId: { type: "integer", minimum: 1 },
      dryRun: {
        type: "boolean",
        description: "If true, report the duplicate groups without deleting anything.",
      },
    },
    required: ["workspaceId"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      dryRun: { type: "boolean" },
      groupCount: { type: "integer", description: "Number of distinct items that have duplicates." },
      duplicateCount: { type: "integer", description: "Total redundant rows (would-be-)removed." },
      removed: { type: "integer", description: "Rows actually deleted (0 on dryRun)." },
      groups: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            amountDollars: { type: "number" },
            frequency: { type: "string" },
            spendDate: { type: "string" },
            keepId: { type: "integer" },
            removeIds: { type: "array", items: { type: "integer" } },
          },
        },
      },
    },
    required: ["dryRun", "groupCount", "duplicateCount", "removed", "groups"],
  },
  handler: (args, ctx) => {
    const a = args as { workspaceId: number; dryRun?: boolean };
    const dryRun = a.dryRun === true;
    const groups = findDuplicateGroups(ctx.expenses.list(a.workspaceId));
    const duplicateCount = groups.reduce((s, g) => s + g.removeIds.length, 0);
    let removed = 0;
    if (!dryRun && duplicateCount > 0) {
      ctx.tx(() => {
        for (const g of groups) {
          for (const id of g.removeIds) {
            const r = ctx.expenses.delete(id);
            if (r.deleted) removed += 1;
          }
        }
      });
    }
    return { dryRun, groupCount: groups.length, duplicateCount, removed, groups };
  },
};

const list_statements: ToolDef = {
  name: "list_statements",
  description:
    "List statement files available in ./statements/ for import. Returns each file's path (relative to the project root), size in bytes, and detected kind (chase_pdf | amex_xlsx | csv | unknown — inferred from extension). " +
    "READ-ONLY. Use as the first step of the import flow: the UI displays the file list so the user can pick, and the LLM enumerates available files before calling catalogue_expenses. " +
    "Files outside ./statements/ are not reachable — the same path-allowlist boundary that catalogue_expenses enforces.",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      files: {
        type: "array",
        items: {
          type: "object",
          properties: {
            relativePath: { type: "string", description: "Path relative to the project root, with forward slashes — pass this verbatim to catalogue_expenses." },
            sizeBytes: { type: "integer" },
            kind: { type: "string", enum: ["chase_pdf", "amex_xlsx", "csv", "unknown"] },
          },
          required: ["relativePath", "sizeBytes", "kind"],
        },
      },
    },
    required: ["files"],
  },
  handler: async () => {
    const pathMod = await import("node:path");
    const fsMod = await import("node:fs/promises");
    const statementsRoot = pathMod.resolve("statements");

    interface FileRow {
      relativePath: string;
      sizeBytes: number;
      kind: "chase_pdf" | "amex_xlsx" | "csv" | "unknown";
    }
    const out: FileRow[] = [];

    async function walk(dir: string): Promise<void> {
      // Use the {withFileTypes:true} overload to get Dirent[]. The
      // ReturnType<typeof fsMod.readdir> union loses narrowing because of
      // the overloaded signatures, so we explicitly type entries below.
      let entries: Array<{
        name: string;
        isDirectory(): boolean;
        isFile(): boolean;
      }>;
      try {
        entries = (await fsMod.readdir(dir, { withFileTypes: true })) as Array<{
          name: string;
          isDirectory(): boolean;
          isFile(): boolean;
        }>;
      } catch {
        // Missing or unreadable: return empty list, not an error. A fresh
        // install may not have any statements yet.
        return;
      }
      for (const ent of entries) {
        const full = pathMod.join(dir, ent.name);
        if (ent.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!ent.isFile()) continue;
        const ext = ent.name.split(".").pop()?.toLowerCase() ?? "";
        let kind: FileRow["kind"] = "unknown";
        if (ext === "pdf") kind = "chase_pdf";
        else if (ext === "xlsx" || ext === "xls") kind = "amex_xlsx";
        else if (ext === "csv") kind = "csv";
        const stat = await fsMod.stat(full);
        // Build a stable relative path with forward slashes so it's portable
        // across Windows / POSIX. catalogue_expenses resolves with node:path
        // which accepts either separator.
        const rel = pathMod.relative(pathMod.resolve("."), full).split(pathMod.sep).join("/");
        out.push({ relativePath: rel, sizeBytes: stat.size, kind });
      }
    }
    await walk(statementsRoot);
    // Deterministic order so tests + UI can rely on it.
    out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return { files: out };
  },
};

// ---------------------------------------------------------------------------
// Library + Trends tools (richer statement listing, trends chart data,
// per-statement ignore flag).
// ---------------------------------------------------------------------------

/** Path/filename heuristics for issuer detection — used by list_statements_rich.
 *  Matched against the full relative path (e.g. "statements/plat/activity.xlsx"),
 *  so the organizing directory (chase/ gold/ plat/) is an authoritative signal —
 *  Amex exports are all named "activity*.xlsx" and only differ by directory. This
 *  mirrors the parser's inferAmexFlavor(), which also keys off the path.
 *  Order matters: more-specific patterns first (gold before the bare \bplat\b, etc). */
const ISSUER_PATTERNS: Array<{
  re: RegExp;
  issuer: "chase" | "amex_gold" | "amex_plat";
  issuerLabel: string;
}> = [
  { re: /amex.*gold|gold.*amex|amex_gold|\bgold\b/i, issuer: "amex_gold", issuerLabel: "Amex Gold" },
  { re: /amex.*plat|plat.*amex|amex_plat|platinum|\bplat\b/i, issuer: "amex_plat", issuerLabel: "Amex Platinum" },
  { re: /chase|sapphire|freedom/i, issuer: "chase", issuerLabel: "Chase" },
];

export function detectIssuer(pathOrName: string, ext: string): {
  issuer: "chase" | "amex_gold" | "amex_plat" | "unknown";
  issuerLabel: string;
} {
  for (const p of ISSUER_PATTERNS) {
    if (p.re.test(pathOrName)) return { issuer: p.issuer, issuerLabel: p.issuerLabel };
  }
  // Fallback by extension — only when neither the directory nor the filename
  // carried an issuer token (e.g. a loose file dropped directly in statements/).
  if (ext === "pdf") return { issuer: "chase", issuerLabel: "Chase (assumed)" };
  if (ext === "xlsx" || ext === "xls") return { issuer: "amex_gold", issuerLabel: "Amex (assumed)" };
  return { issuer: "unknown", issuerLabel: "Unknown" };
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTH_LOOKUP = new Map<string, number>(
  MONTH_NAMES.flatMap((n, i) => [
    [n.toLowerCase(), i],
    [n.slice(0, 3).toLowerCase(), i],
  ]),
);

/** Parse a statement filename for its period. Accepts:
 *  - YYYY-MM or YYYY_MM
 *  - "Month YYYY" or "Mon YYYY"
 *  Returns { periodStart, periodEnd, periodLabel } or all null on miss. */
function parseFilenamePeriod(fileName: string): {
  periodStart: string | null;
  periodEnd: string | null;
  periodLabel: string | null;
} {
  // YYYYMMDD (no separator) — common in Chase exports (e.g., 20250521-...).
  // Anchored with digit-boundary lookarounds so a longer run (e.g. an
  // account number like 1234567890) doesn't get sliced into a bogus date.
  // Also validate the day (01-31) to reject coincidental 8-digit runs.
  let m = fileName.match(/(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/);
  if (m) {
    const yr = parseInt(m[1]!, 10);
    const mo = parseInt(m[2]!, 10);
    const day = parseInt(m[3]!, 10);
    if (yr >= 2000 && yr <= 2100 && mo >= 1 && mo <= 12 && day >= 1 && day <= 31) {
      return formatPeriod(yr, mo - 1);
    }
  }
  // YYYY-MM or YYYY_MM
  m = fileName.match(/(\d{4})[-_](\d{2})/);
  if (m) {
    const yr = parseInt(m[1]!, 10);
    const mo = parseInt(m[2]!, 10);
    if (yr >= 2000 && yr <= 2100 && mo >= 1 && mo <= 12) {
      return formatPeriod(yr, mo - 1);
    }
  }
  // Mon[th] YYYY
  m = fileName.match(/([A-Za-z]{3,9})[\s_-]+(\d{4})/);
  if (m) {
    const monIdx = MONTH_LOOKUP.get(m[1]!.toLowerCase());
    const yr = parseInt(m[2]!, 10);
    if (monIdx != null && yr >= 2000 && yr <= 2100) {
      return formatPeriod(yr, monIdx);
    }
  }
  return { periodStart: null, periodEnd: null, periodLabel: null };
}

function formatPeriod(year: number, monthIdx: number): {
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
} {
  const start = new Date(Date.UTC(year, monthIdx, 1));
  const end = new Date(Date.UTC(year, monthIdx + 1, 0));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    periodStart: iso(start),
    periodEnd: iso(end),
    periodLabel: `${MONTH_NAMES[monthIdx]} ${year}`,
  };
}

/** Stable id from a relative path — small djb2 hash, hex-encoded.
 *  Avoids importing node:crypto just for this. */
function fileIdFromPath(rel: string): string {
  let h = 5381;
  for (let i = 0; i < rel.length; i++) {
    h = (h * 33) ^ rel.charCodeAt(i);
  }
  return (h >>> 0).toString(16);
}

const list_statements_rich: ToolDef = {
  name: "list_statements_rich",
  description:
    "Richer variant of list_statements for the Library page. Walks ./statements/ recursively and joins each file against statement_imports + transactions to surface: issuer (chase/amex_gold/amex_plat/unknown), parsed status, transaction count, last-imported timestamp, and ignored flag. READ-ONLY.",
  readOnly: true,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: {
    type: "object",
    properties: {
      files: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            relativePath: { type: "string" },
            fileName: { type: "string" },
            sizeBytes: { type: "integer" },
            issuer: { type: "string", enum: ["chase", "amex_gold", "amex_plat", "unknown"] },
            issuerLabel: { type: "string" },
            periodStart: { type: "string" },
            periodEnd: { type: "string" },
            periodLabel: { type: "string" },
            status: { type: "string", enum: ["parsed", "unparsed", "error"] },
            txnCount: { type: "integer" },
            hasErrors: { type: "boolean" },
            ignored: { type: "boolean" },
            parsedAt: { type: "string" },
          },
          required: [
            "id", "relativePath", "fileName", "sizeBytes",
            "issuer", "issuerLabel", "status", "txnCount",
            "hasErrors", "ignored",
          ],
        },
      },
    },
    required: ["files"],
  },
  handler: async (_args, ctx) => {
    const pathMod = await import("node:path");
    const fsMod = await import("node:fs/promises");
    const statementsRoot = pathMod.resolve("statements");

    // Pre-fetch the import metadata so we don't N+1 the DB.
    const importsByPath = new Map(
      ctx.statementImports.list().map((r) => [r.filePath, r]),
    );

    interface RichFileRow {
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
    const out: RichFileRow[] = [];

    async function walk(dir: string): Promise<void> {
      let entries: Array<{
        name: string;
        isDirectory(): boolean;
        isFile(): boolean;
      }>;
      try {
        entries = (await fsMod.readdir(dir, { withFileTypes: true })) as Array<{
          name: string;
          isDirectory(): boolean;
          isFile(): boolean;
        }>;
      } catch {
        return;
      }
      for (const ent of entries) {
        const full = pathMod.join(dir, ent.name);
        if (ent.isDirectory()) { await walk(full); continue; }
        if (!ent.isFile()) continue;
        const ext = ent.name.split(".").pop()?.toLowerCase() ?? "";
        const rel = pathMod.relative(pathMod.resolve("."), full).split(pathMod.sep).join("/");
        const stat = await fsMod.stat(full);
        const { issuer, issuerLabel } = detectIssuer(rel, ext);
        const period = parseFilenamePeriod(ent.name);
        const imp = importsByPath.get(rel);
        // An import row with zero transactions means the parse ran but
        // extracted nothing — a real "this file didn't parse cleanly" signal.
        // That's what backs the Library "With errors" status filter (no
        // dedicated parse-errors table yet).
        const erroredParse = !!imp && imp.txnCount === 0;
        out.push({
          id: fileIdFromPath(rel),
          relativePath: rel,
          fileName: ent.name,
          sizeBytes: stat.size,
          issuer,
          issuerLabel,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          periodLabel: period.periodLabel,
          status: imp ? (erroredParse ? "error" : "parsed") : "unparsed",
          txnCount: imp?.txnCount ?? 0,
          hasErrors: erroredParse,
          ignored: imp?.ignored ?? false,
          parsedAt: imp?.importedAt ?? null,
        });
      }
    }

    await walk(statementsRoot);
    out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return { files: out };
  },
};

const compute_expense_trends: ToolDef = {
  name: "compute_expense_trends",
  description:
    "24-month per-category expense series + overlays (take-home / savings / 401k) for the Trends page. Categories series come from the global transactions table; overlays are derived from the active workspace's incomes + savings_items and held constant across the window. Also returns undatedOneTimeCount/undatedOneTimeLabels: one-time expenses with no spend_date that couldn't be placed (surfaced so the user can assign a month). READ-ONLY.",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      workspaceId: { type: "integer", minimum: 1 },
      months: { type: "integer", minimum: 1, maximum: 60 },
    },
    required: ["workspaceId"],
    additionalProperties: false,
  },
  outputSchema: {
    // Output validation here is intentionally coarse — the wire shape is a
    // dynamically-keyed `categories` map plus a fixed-shape `overlays`
    // object. JsonSchema's typed-properties form doesn't model dynamic
    // keys cleanly, so we declare the top-level keys and let the wire
    // serializer pass the rest through. The TrendsResult interface in
    // packages/core/src/trends_calculator.ts is the authoritative shape.
    type: "object",
    properties: {
      x: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { type: "string" },
            short: { type: "string" },
            label: { type: "string" },
            year: { type: "integer" },
            monthIdx: { type: "integer" },
            ts: { type: "integer" },
          },
        },
      },
      categories: {
        type: "object",
        properties: {},
        additionalProperties: true,
      },
      overlays: {
        type: "object",
        properties: {},
        additionalProperties: true,
      },
      topOneTime: {
        type: "array",
        items: {
          type: "array",
          items: { type: "object", properties: {}, additionalProperties: true },
        },
      },
      // One-time expenses missing a spend_date — placed nowhere on the chart but
      // surfaced here so the UI can prompt the user to assign a month.
      undatedOneTimeCount: { type: "integer" },
      undatedOneTimeLabels: { type: "array", items: { type: "string" } },
    },
    required: ["x", "categories", "overlays", "topOneTime", "undatedOneTimeCount", "undatedOneTimeLabels"],
  },
  handler: (args, ctx) => {
    const a = args as { workspaceId: number; months?: number };
    // Real monthly take-home for the income overlay (net of taxes + payroll
    // 401k/HSA/Roth). Best-effort: a workspace with no taxed income or missing
    // tax tables falls back to the calculator's flat-30% estimate.
    let takeHomeMonthlyDollars: number | undefined;
    try {
      takeHomeMonthlyDollars = computeWorkspaceTakeHome(ctx, a.workspaceId).breakdown.monthlyTakeHomeDollars;
    } catch {
      takeHomeMonthlyDollars = undefined;
    }
    return computeTrends({
      months: a.months ?? 24,
      workspaceId: a.workspaceId,
      categories: ctx.categories,
      incomes: ctx.incomes,
      savings: ctx.savings,
      expenses: ctx.expenses,
      takeHomeMonthlyDollars,
    });
  },
};

const ignore_statement: ToolDef = {
  name: "ignore_statement",
  description:
    "Toggle the ignored flag on a statement_imports row. Ignored statements are hidden from the Library's default browse list. Useful for hiding corrupted files, duplicates, or statements from closed accounts.",
  inputSchema: {
    type: "object",
    properties: {
      relativePath: { type: "string" },
      ignored: { type: "boolean" },
    },
    required: ["relativePath", "ignored"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { updated: { type: "boolean" } },
    required: ["updated"],
  },
  handler: (args, ctx) => {
    const a = args as { relativePath: string; ignored: boolean };
    return ctx.statementImports.setIgnored(a.relativePath, a.ignored);
  },
};

/** All tool definitions, exported as a flat array so callers can build the
 *  ToolRegistry with whichever subset they want. Adding a new tool: define
 *  it above and append the export here. */
export const ALL_TOOLS: ToolDef[] = [
  list_workspaces,
  create_scenario,
  delete_workspace,
  rename_workspace,
  clone_workspace,
  list_statements_rich,
  compute_expense_trends,
  ignore_statement,
  list_expenses,
  add_expense,
  update_expense,
  delete_expense,
  list_incomes,
  add_income,
  update_income,
  delete_income,
  compute_take_home,
  list_savings,
  add_savings,
  update_savings,
  delete_savings,
  get_retirement_settings,
  set_retirement_settings,
  compute_retirement,
  compute_sensitivity,
  get_sensitivity_settings,
  set_sensitivity_settings,
  list_tax_tables,
  fetch_tax_source,
  fetch_tax_source_by_year,
  set_tax_table,
  import_tax_table,
  catalogue_expenses,
  auto_categorize_expenses,
  dedupe_expenses,
  list_statements,
];
