// LLM-driven expense categorizer — the engine behind the assistant's
// `/classify` command (POST /api/chat/classify).
//
// Why this exists: the rule-based `defaultMerchantCategorizer`
// (packages/core/src/category_resolver.ts) only knows ~23 merchants and dumps
// everything else into "Discretionary". A small local model reads merchant
// names far better. So instead of one big prompt, we run a CODE-driven `for`
// loop and feed the model ONE expense per call — multiple lines per prompt
// confuses a small model and makes the output hard to parse back to rows.
//
// Reliability levers for the small model, in order of importance:
//   1. Grammar-constrained decoding: a GBNF enum of the canonical category
//      names forces the reply to be exactly one valid name (buildCategoryGrammar).
//   2. An explicit prompt that lists every category AND how to categorize it
//      (CATEGORY_GUIDANCE / buildClassifierMessages).
//   3. temperature 0 + thinking off — this is shallow classification, not
//      reasoning; determinism beats creativity here.
//   4. A fuzzy fallback parser (matchCategory) for servers that ignore the
//      grammar field, so a stray reply still lands on a real category.

import type { ToolCtx } from "@budgetkit/core";
import type { ChatMessage, ChatRequest, LlamaClient } from "./llama_client.js";

/** A category as returned by `ctx.categories.listAll()` (id + name is all we
 *  need here). The canonical list lives in the DB (migrations/008) — we read it
 *  at runtime so this code tracks the budget set automatically. */
export interface ClassifierCategory {
  id: number;
  name: string;
}

/** One classified row, surfaced per loop iteration for live progress. */
export interface ClassifiedLine {
  id: number;
  label: string;
  categoryName: string;
  categoryId: number | null;
  /** True when the recommended category differs from the row's current one. */
  changed: boolean;
}

/** A proposed category change for one expense — the unit the user reviews and
 *  accepts/denies. Only rows whose recommendation DIFFERS from the current
 *  category become recommendations (unchanged rows are just counted). */
export interface ExpenseRecommendation {
  id: number;
  label: string;
  currentCategoryId: number | null;
  currentCategoryName: string | null;
  recommendedCategoryId: number | null; // resolvable in practice (Discretionary fallback)
  recommendedCategoryName: string;
}

/**
 * Explicit "how to categorize" guidance, one line per canonical budget
 * category. Seeded from the intent of the rule-based resolver's token table.
 * Keys MUST cover every name in the seeded `categories` table — a unit test
 * (expense_classifier.test.ts) asserts this against a freshly-migrated DB so
 * the two can't drift, mirroring categories_drift.test.ts. Names not found here
 * still work (the prompt falls back to the bare name), but lose their guidance.
 */
export const CATEGORY_GUIDANCE: Readonly<Record<string, string>> = {
  Housing: "rent, mortgage, property management, HOA dues",
  Utilities: "electricity, water, gas, trash/sewer (PG&E, SCE, SoCal Gas)",
  Communications: "phone / mobile carrier, home internet",
  Food: "groceries AND restaurants/fast food/coffee (Costco, Trader Joe's, Starbucks, Chipotle)",
  Transport: "gas/fuel, tolls, transit, rideshare, parking, auto repair",
  Subscriptions:
    "recurring streaming/software/memberships (Netflix, Spotify, YouTube, Apple, Google One)",
  Insurance: "auto, health, home, or life insurance premiums",
  Discretionary:
    "shopping, entertainment, personal care; the catch-all when nothing else fits",
  "Annual fees": "credit-card annual membership fees",
};

/** The catch-all every expense falls back to (guaranteed to exist in the
 *  canonical set; see category_resolver.ts). */
export const FALLBACK_CATEGORY = "Discretionary";

/**
 * Build a GBNF grammar that constrains the model to emit EXACTLY one of the
 * given category names. llama-server reads this as a top-level `grammar` field
 * and uses it during decoding, so a well-behaved server can't return anything
 * else. Names are emitted as quoted string literals with backslashes/quotes
 * escaped (the canonical set has neither today, but stay defensive).
 */
export function buildCategoryGrammar(categoryNames: readonly string[]): string {
  const alts = categoryNames
    .map((n) => `"${n.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join(" | ");
  return `root ::= ${alts}`;
}

/**
 * Assemble the per-expense messages: a system prompt enumerating every category
 * with its guidance, and a tight user message describing the one transaction.
 * Category order follows `categoryNames` (DB order = id 1..9), so the most
 * specific buckets appear before the Discretionary catch-all.
 */
export function buildClassifierMessages(
  categoryNames: readonly string[],
  expense: { label: string; amountDollars: number },
): ChatMessage[] {
  const lines = categoryNames.map((name) => {
    const guidance = CATEGORY_GUIDANCE[name];
    return guidance ? `- ${name} — ${guidance}.` : `- ${name}.`;
  });
  const system =
    "You are a personal-finance transaction categorizer. Assign exactly ONE " +
    "budget category to the transaction below. Reply with ONLY the category " +
    "name — no explanation, no punctuation.\n\n" +
    "Categories:\n" +
    lines.join("\n") +
    `\n\nIf unsure, choose ${FALLBACK_CATEGORY}.`;
  const user = `Description: ${expense.label}\nAmount: $${expense.amountDollars}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * Map a raw model reply back to a canonical category name. Primary path (with
 * grammar) is an exact, case-insensitive match. Fallbacks (for servers that
 * ignore the grammar field) try substring containment — longest name first so
 * "Annual fees" wins over a stray "fees" — then give up to the catch-all.
 */
export function matchCategory(raw: string, categoryNames: readonly string[]): string {
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .trim()
    .toLowerCase();
  if (!cleaned) return FALLBACK_CATEGORY;
  for (const name of categoryNames) {
    if (name.toLowerCase() === cleaned) return name;
  }
  // Substring containment, longest candidate first to avoid short-prefix
  // collisions (e.g. a reply mentioning "annual fees" shouldn't match "Food").
  const byLength = [...categoryNames].sort((a, b) => b.length - a.length);
  for (const name of byLength) {
    if (cleaned.includes(name.toLowerCase())) return name;
  }
  return FALLBACK_CATEGORY;
}

/**
 * Classify ONE expense with a single isolated llama call. Deterministic
 * (temperature 0), no chain-of-thought (this is shallow lookup, not reasoning),
 * a tiny reply budget, and the enum grammar. Always resolves to a real category
 * name + its id (never throws on a weird reply — matchCategory backstops it).
 * A network/server error DOES throw, so the caller can surface it.
 */
export async function classifyOneExpense(
  client: LlamaClient,
  categories: readonly ClassifierCategory[],
  expense: { label: string; amountDollars: number },
  signal?: AbortSignal,
): Promise<{ categoryName: string; categoryId: number | null }> {
  const names = categories.map((c) => c.name);
  const req: ChatRequest = {
    messages: buildClassifierMessages(names, expense),
    temperature: 0,
    max_tokens: 24,
    chat_template_kwargs: { enable_thinking: false },
    grammar: buildCategoryGrammar(names),
  };
  const res = await client.chat(req, signal);
  const raw = res.choices[0]?.message?.content ?? "";
  const categoryName = matchCategory(raw, names);
  const categoryId = categories.find((c) => c.name === categoryName)?.id ?? null;
  return { categoryName, categoryId };
}

/**
 * The `for` loop: classify EVERY expense in the workspace, one isolated call at
 * a time, WITHOUT writing anything. It returns a recommendation for each row
 * whose suggested category differs from its current one, so the caller can let
 * the user review + accept/deny before any DB change (applyExpenseCategories
 * does the writing). `onLine` fires once per row for live UI streaming; the
 * loop checks `signal.aborted` between rows so a client Stop halts it (with no
 * writes to undo).
 */
export async function recommendWorkspaceExpenses(
  client: LlamaClient,
  ctx: ToolCtx,
  workspaceId: number,
  opts: { onLine?: (line: ClassifiedLine) => void; signal?: AbortSignal } = {},
): Promise<{
  examined: number;
  total: number;
  changedCount: number;
  recommendations: ExpenseRecommendation[];
}> {
  const categories = ctx.categories.listAll();
  const nameById = new Map(categories.map((c) => [c.id, c.name]));
  const rows = ctx.expenses.list(workspaceId);
  const recommendations: ExpenseRecommendation[] = [];
  let examined = 0;
  for (const row of rows) {
    if (opts.signal?.aborted) break;
    const { categoryName, categoryId } = await classifyOneExpense(
      client,
      categories,
      { label: row.label, amountDollars: row.amountDollars },
      opts.signal,
    );
    examined += 1;
    const didChange = categoryId !== row.categoryId;
    if (didChange) {
      recommendations.push({
        id: row.id,
        label: row.label,
        currentCategoryId: row.categoryId,
        currentCategoryName: row.categoryId !== null ? nameById.get(row.categoryId) ?? null : null,
        recommendedCategoryId: categoryId,
        recommendedCategoryName: categoryName,
      });
    }
    opts.onLine?.({ id: row.id, label: row.label, categoryName, categoryId, changed: didChange });
  }
  return { examined, total: rows.length, changedCount: recommendations.length, recommendations };
}

/**
 * Commit the user-accepted category changes in a single transaction. Each entry
 * is one expense id + the category to set on it; ids that no longer exist are
 * simply skipped. Returns how many rows were actually updated.
 */
export function applyExpenseCategories(
  ctx: ToolCtx,
  changes: Array<{ id: number; categoryId: number | null }>,
): { updated: number } {
  let updated = 0;
  ctx.tx(() => {
    for (const change of changes) {
      const r = ctx.expenses.update({ id: change.id, categoryId: change.categoryId });
      if (r.updated) updated += 1;
    }
  });
  return { updated };
}
