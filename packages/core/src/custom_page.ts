// Shared contract for the assistant-authored /custom page: the query-tool
// allowlist, the definition caps, the definition validator, and the authoring
// guide the model fetches on demand.
//
// This module never executes anything the assistant writes. A definition is
// two halves: declarative `queries` (run by the TRUSTED host through the
// ordinary tool registry) and a `render` function BODY that runs only inside
// the web app's sandboxed iframe. Validation here is what guarantees the
// render half can never see data its declared queries didn't fetch.
//
// Lives in core rather than tools.ts because the tool handlers, the web
// query-runner (via the exported allowlist), and the tests all need it.

import { ToolArgError, validateArgs, type JsonSchema } from "./tool_registry.js";

/**
 * Tools a custom-page query may call. EXPLICIT allowlist, deliberately not
 * "any readOnly tool": `fetch_tax_source*` are readOnly but perform network
 * I/O, and loading a page must never trigger an outbound fetch. Adding a name
 * here makes it callable unattended on every page load — only local,
 * side-effect-free readers belong.
 */
export const CUSTOM_PAGE_QUERY_TOOLS = [
  "query_transactions",
  "search_transactions",
  "top_merchants",
  "list_expenses",
  "list_incomes",
  "list_savings",
  "list_categories",
  "list_workspaces",
  "compute_budget_summary",
  "compute_expense_trends",
  "compute_take_home",
  "compute_category_baselines",
  // Retirement was missing here originally, which had a visible cost: asked for
  // a retirement projection, the model silently substituted compute_take_home
  // (the nearest permitted tool) and drew the wrong data rather than reporting
  // that it could not get at the numbers.
  "compute_retirement",
  "get_retirement_settings",
] as const;

export type CustomPageQueryTool = (typeof CUSTOM_PAGE_QUERY_TOOLS)[number];

/** Any query arg whose value is EXACTLY this string is replaced with the
 *  active workspace id at page-load time (and with 1 at write time, so the
 *  args still type-check against the target tool's integer schema). */
export const WORKSPACE_ID_PLACEHOLDER = "$WORKSPACE_ID";

export const MAX_QUERIES = 8;
export const MAX_RENDER_CHARS = 32768;
export const MAX_DEF_CHARS = 65536;
export const MAX_TITLE_CHARS = 120;
export const MAX_NOTE_CHARS = 500;
/** Serialized size cap for one query's `args` object. */
export const MAX_QUERY_ARGS_CHARS = 2048;
/** Query ids are referenced from render code as `data.<id>`, so they are
 *  restricted to identifier shape. Anchored and backtracking-free. */
export const QUERY_ID_PATTERN = "^[a-zA-Z_][a-zA-Z0-9_]{0,31}$";

const QUERY_ID_RE = new RegExp(QUERY_ID_PATTERN);

export interface CustomPageQuery {
  id: string;
  tool: CustomPageQueryTool;
  args: Record<string, unknown>;
}

/** The stored document. `version` exists so a future shape change can be
 *  migrated (or rejected) rather than silently mis-rendered. */
export interface CustomPageDefinition {
  version: 1;
  title: string;
  note?: string;
  queries: CustomPageQuery[];
  render: string;
}

/** Recursively replace every `"$WORKSPACE_ID"` string with `workspaceId`.
 *  Returns a deep copy — the caller's object is never mutated. Used by the
 *  write-time validator (with 1) and by the web page's query runner (with the
 *  active workspace id). */
export function substituteWorkspaceId(value: unknown, workspaceId: number): unknown {
  if (value === WORKSPACE_ID_PLACEHOLDER) return workspaceId;
  if (Array.isArray(value)) return value.map((v) => substituteWorkspaceId(v, workspaceId));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteWorkspaceId(v, workspaceId);
    }
    return out;
  }
  return value;
}

/**
 * A complete, minimal, VALID `set` payload. Small models retry a rejected tool
 * call from the error text alone, so a bare "field X is missing" invites the
 * next attempt to supply X and drop something else — observed in the wild as a
 * loop of alternating title/render/queries failures that never converges.
 * Every missing-field error therefore carries the whole shape, not just the
 * name of the field that was absent.
 */
const SET_EXAMPLE = JSON.stringify({
  action: "set",
  title: "Food spending by week",
  queries: [
    {
      id: "food",
      tool: "query_transactions",
      args: { categoryId: 4, groupBy: "week", metric: "sum" },
    },
  ],
  render:
    "var g = (data.food && data.food.groups) || [];" +
    " bk.barChart(root, { bars: g.map(function (r) { return { label: r.key, value: r.value }; }) });",
});

const MISSING_FIELD_HELP = (missing: readonly string[]): string =>
  `action "set" is missing: ${missing.map((f) => `"${f}"`).join(", ")}. Send the COMPLETE ` +
  `definition in ONE call — "title", "queries" and "render" are all required together, and a ` +
  `payload carrying only some of them is rejected. Copy this shape and adapt it: ${SET_EXAMPLE} ` +
  `Call get_custom_page{"includeGuide":true} for the full authoring contract.`;

/**
 * Reject a render body that cannot even be COMPILED.
 *
 * Without this a syntax error is stored happily and only surfaces later in the
 * browser, as a page that fails to draw — by which time the model has finished
 * its turn and the user is the one who has to notice, copy the message back,
 * and ask for a fix. Compiling here turns that into an ordinary rejected tool
 * call the model repairs immediately, in the same turn. (Observed live: a
 * stored body with one extra closing paren.)
 *
 * The function is COMPILED, never called: `new Function` parses its argument
 * and returns; nothing in the body executes. Execution stays exclusively in the
 * browser's sandboxed iframe, which is what actually contains this code.
 */
function assertRenderCompiles(render: string): void {
  try {
    // Same signature the harness uses, so a body referencing root/data/bk
    // compiles here exactly as it will there.
    new Function("root", "data", "bk", `"use strict";\n${render}`);
  } catch (e) {
    throw new ToolArgError(
      `"render" is not valid JavaScript: ${(e as Error).message}. It is the BODY of ` +
        `function (root, data, bk) — statements only, no wrapping "function render(...) {}".`,
      ["render"],
    );
  }
}

/**
 * Blank out string literals and comments so a scan of the render body sees only
 * code. Without this, `bk.text("see data.total")` would read as a data
 * reference. Regex literals are left alone — mis-tokenizing one can only affect
 * the reference scan below, which is advisory in shape (it names what it saw and
 * what is available) rather than a correctness gate.
 */
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

function stripLiterals(src: string): string {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      out += " ";
    } else if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      const start = ++i;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i++;
        i++;
      }
      // Identifier-shaped literals survive so `data["food"]` stays visible to
      // the reference scan; anything longer collapses, which is what keeps prose
      // like "renamed from data.old" from reading as code.
      const body = src.slice(start, i);
      out += IDENT_RE.test(body) ? `"${body}"` : '""';
    } else {
      out += c;
    }
  }
  return out;
}

const DATA_DOT_RE = /\bdata\s*\.\s*([A-Za-z_$][\w$]*)/g;
const DATA_INDEX_RE = /\bdata\s*\[\s*(["'])([A-Za-z_$][\w$]*)\1\s*\]/g;
/** Reading these off `data` is object plumbing, not a query reference. */
const OBJECT_MEMBERS = new Set([
  "hasOwnProperty", "toString", "valueOf", "constructor", "propertyIsEnumerable",
  "isPrototypeOf", "toLocaleString",
]);

/**
 * Reject a render that reads `data.<id>` for an id no query declares.
 *
 * This is the defect that shipped live: a definition declared query id
 * `retirement_plot` while its render read `data.retirement`. Both halves are
 * individually valid — the queries run, the body compiles — so nothing caught it
 * until the page threw in the browser, where the model cannot see it. The
 * mismatch is entirely visible at write time.
 */
function assertRenderUsesDeclaredQueries(render: string, ids: string[]): void {
  const declared = new Set(ids);
  const code = stripLiterals(render);
  const unknown = new Set<string>();
  for (const re of [DATA_DOT_RE, DATA_INDEX_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const name = (m[2] ?? m[1])!;
      if (!declared.has(name) && !OBJECT_MEMBERS.has(name)) unknown.add(name);
    }
  }
  if (unknown.size === 0) return;
  const bad = [...unknown];
  throw new ToolArgError(
    `"render" reads ${bad.map((n) => `data.${n}`).join(", ")}, but no query declares ` +
      `${bad.length === 1 ? "that id" : "those ids"}. Declared query ids: ` +
      `${ids.map((n) => `"${n}"`).join(", ")}. Each query's result is available as ` +
      `data.<that query's id> — either rename the query id or read the id you declared.`,
    ["render"],
  );
}

/**
 * Validate an assistant-proposed definition and return it normalized.
 *
 * `lookupTool` resolves a query's target tool so its args can be checked
 * against that tool's own inputSchema HERE, at authoring time — a broken query
 * then fails the write with the offending query id in the message (which the
 * model can act on) instead of erroring silently on every page load. It is
 * injected rather than imported to keep tools.ts → custom_page.ts a one-way
 * dependency.
 *
 * Throws ToolArgError; the registry surfaces that as a 400-class failure on
 * every transport.
 */
export function validateCustomPageDefinition(
  input: unknown,
  lookupTool: (name: string) => { inputSchema: JsonSchema } | undefined,
): CustomPageDefinition {
  const a = (input ?? {}) as Record<string, unknown>;

  // Report ALL missing required fields at once. Checking them one at a time
  // costs a whole model turn per defect: the caller fixes the named field,
  // resends, and only then learns the next one is missing — a walk that does
  // not converge inside any sane turn budget (observed live: four consecutive
  // attempts, each supplying one field and dropping another).
  const missing: string[] = [];
  if (typeof a.title !== "string" || a.title.trim() === "") missing.push("title");
  if (!Array.isArray(a.queries) || a.queries.length === 0) missing.push("queries");
  if (typeof a.render !== "string" || a.render.trim() === "") missing.push("render");
  if (missing.length > 0) {
    throw new ToolArgError(MISSING_FIELD_HELP(missing), [missing[0]!]);
  }
  // Narrowed by the checks above; the collect-then-throw form loses TS's
  // control-flow narrowing, so restate the types once here.
  const title = a.title as string;
  const render = a.render as string;
  const rawQueries = a.queries as unknown[];

  if (title.length > MAX_TITLE_CHARS) {
    throw new ToolArgError(`"title" exceeds ${MAX_TITLE_CHARS} characters`, ["title"]);
  }
  if (a.note !== undefined && typeof a.note !== "string") {
    throw new ToolArgError('"note" must be a string', ["note"]);
  }
  if (typeof a.note === "string" && a.note.length > MAX_NOTE_CHARS) {
    throw new ToolArgError(`"note" exceeds ${MAX_NOTE_CHARS} characters`, ["note"]);
  }
  if (render.length > MAX_RENDER_CHARS) {
    throw new ToolArgError(`"render" exceeds ${MAX_RENDER_CHARS} characters`, ["render"]);
  }
  assertRenderCompiles(render);
  if (rawQueries.length > MAX_QUERIES) {
    throw new ToolArgError(`"queries" exceeds ${MAX_QUERIES} entries`, ["queries"]);
  }

  const seen = new Set<string>();
  const queries: CustomPageQuery[] = [];
  for (let i = 0; i < rawQueries.length; i++) {
    const raw = rawQueries[i] as Record<string, unknown>;
    const path = ["queries", String(i)];
    const id = raw?.id;
    if (typeof id !== "string" || !QUERY_ID_RE.test(id)) {
      throw new ToolArgError(
        `query #${i}: "id" must match ${QUERY_ID_PATTERN}`,
        [...path, "id"],
      );
    }
    if (seen.has(id)) {
      throw new ToolArgError(`duplicate query id "${id}"`, [...path, "id"]);
    }
    seen.add(id);

    const tool = raw.tool;
    if (
      typeof tool !== "string" ||
      !(CUSTOM_PAGE_QUERY_TOOLS as readonly string[]).includes(tool)
    ) {
      throw new ToolArgError(
        `query "${id}": tool "${String(tool)}" is not an allowed custom-page query tool`,
        [...path, "tool"],
      );
    }
    const args = raw.args ?? {};
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      throw new ToolArgError(`query "${id}": "args" must be an object`, [...path, "args"]);
    }
    const argsJson = JSON.stringify(args);
    if (argsJson.length > MAX_QUERY_ARGS_CHARS) {
      throw new ToolArgError(
        `query "${id}": "args" exceeds ${MAX_QUERY_ARGS_CHARS} serialized characters`,
        [...path, "args"],
      );
    }
    const target = lookupTool(tool);
    if (!target) {
      throw new ToolArgError(`query "${id}": unknown tool "${tool}"`, [...path, "tool"]);
    }
    // Placeholder stands in for a real workspace id (1 always exists — the
    // seeded "Current" workspace) so the integer-typed workspaceId args of the
    // workspace-scoped tools validate the same way they will at page load.
    const probe = substituteWorkspaceId(args, 1);
    try {
      validateArgs(target.inputSchema, probe);
    } catch (e) {
      throw new ToolArgError(
        `query "${id}" (${tool}): ${(e as Error).message}`,
        [...path, "args"],
      );
    }
    queries.push({ id, tool: tool as CustomPageQueryTool, args: args as Record<string, unknown> });
  }

  // After the ids are known, so the message can list them.
  assertRenderUsesDeclaredQueries(render, queries.map((q) => q.id));

  return {
    version: 1,
    title,
    ...(typeof a.note === "string" && a.note !== "" ? { note: a.note } : {}),
    queries,
    render,
  };
}

/** Serialize a validated definition for storage, enforcing the total cap.
 *  Separate from the validator because the cap is about what we're willing to
 *  persist and round-trip through the model's context, not about shape. */
export function serializeCustomPageDefinition(def: CustomPageDefinition): string {
  const json = JSON.stringify(def);
  if (json.length > MAX_DEF_CHARS) {
    throw new ToolArgError(
      `custom page definition is ${json.length} characters, over the ${MAX_DEF_CHARS} limit`,
      [],
    );
  }
  return json;
}

/**
 * Authoring instructions for the model, served ONLY when it asks for them
 * (`get_custom_page { includeGuide: true }`). Deliberately kept out of
 * SYSTEM_PROMPT and out of the tool descriptions: both are re-serialized into
 * every single chat request, and this text is ~2.5KB.
 */
export const CUSTOM_PAGE_GUIDE = `CUSTOM PAGE AUTHORING GUIDE

The /custom page is a blank canvas. You fill it with set_custom_page by writing a
DEFINITION: declarative queries the app runs for you, plus a render function body
that draws the results. Your write auto-applies and the user sees it immediately.

DEFINITION SHAPE (arguments to set_custom_page)
{
  "action": "set",
  "title": "Food spend on Tuesdays",   // required, <= 120 chars
  "note": "Last 10 weeks",             // optional caption, <= 500 chars
  "queries": [                         // required, 1-8 entries
    { "id": "food",                    // ^[a-zA-Z_][a-zA-Z0-9_]{0,31}$, unique
      "tool": "query_transactions",    // must be an allowed query tool (below)
      "args": { } }                    // <= 2048 chars serialized
  ],
  "render": "...function body..."      // required, <= 32768 chars
}
The whole definition must serialize to <= 65536 chars.

ALLOWED QUERY TOOLS
query_transactions, search_transactions, top_merchants, list_expenses, list_incomes,
list_savings, list_categories, list_workspaces, compute_budget_summary,
compute_expense_trends, compute_take_home, compute_category_baselines,
compute_retirement, get_retirement_settings.
Pick the tool that actually holds the numbers you were asked about — for a
retirement chart use compute_retirement, not compute_take_home. If nothing here
can answer the request, say so instead of substituting a different metric.
An arg whose value is exactly "$WORKSPACE_ID" is replaced with the user's active
workspace id at page load — use it for every workspaceId argument.

RENDER CONTRACT
Your string is the BODY of function (root, data, bk). Build DOM under root.
- data[queryId] holds that query's result, or { error: "..." } if it failed. The
  id must match EXACTLY: declare { "id": "food" } and read data.food. Reading an
  id no query declares is rejected at write time (below, the id "food" appears in
  both halves — keep them in step whenever you rename one).
  ALWAYS check .error and check for empty arrays before indexing: a render that
  throws shows an error box instead of the user's chart.
- It runs in a locked sandbox iframe. There is no fetch, no import, no
  localStorage, no cookies, no access to the app. Only root, data and bk exist.
- Synchronous only. No timers, no while(true): a render that has not finished
  after 5 seconds is killed and the user sees a failure message.

bk HELPERS
bk.el(tag, attrs?, children?)   -> element; children may be string | Node | array
bk.formatDollars(n)             -> "$1,234.56"
bk.palette                      -> the app's category colors
bk.colorFor(i)                  -> palette color, cycles
bk.lineChart(parent, { series: [{ label, points: [{ x, y }] }], yFormat?, height? })
bk.barChart(parent, { bars: [{ label, value, color? }], yFormat?, height?, horizontal? })
bk.table(parent, { columns: [{ key, label, align?, format? }], rows })
bk.note(parent, text)

WORKED EXAMPLE — food spend on every Tuesday, week by week
queries:
[{ "id": "food", "tool": "query_transactions",
   "args": { "categoryId": 4, "dayOfWeek": 2, "from": "2026-06-02",
             "groupBy": "week", "metric": "sum" } }]
render:
var q = data.food;
if (!q || q.error) { bk.note(root, "Could not load transactions: " + ((q && q.error) || "no data")); return; }
var groups = q.groups || [];
if (groups.length === 0) { bk.note(root, "No Tuesday food charges in this window."); return; }
bk.barChart(root, {
  bars: groups.map(function (g) { return { label: g.key, value: g.value }; }),
  yFormat: bk.formatDollars,
  height: 280
});
bk.note(root, "Each bar sums that week's Tuesday charges; labels are week-start dates.");

DO
- Read this guide (get_custom_page includeGuide:true) before your first write.
- Look up real category ids with list_categories instead of guessing them.
- Handle empty results and { error } entries in every branch.
- Keep render concise: it round-trips through the conversation on every edit.
DON'T
- Don't invent args. Every query's args are validated against that tool's own
  schema at write time; one bad arg rejects the whole write and the error names
  the query id, so fix that query and re-send the complete definition.
- Don't write loops or recursion without a termination condition.
- Don't attempt any network or storage access.

MODIFYING AN EXISTING PAGE
There are no partial edits. To change the page: read it with get_custom_page,
apply your edit, and rewrite the WHOLE definition in one call.
Make exactly ONE set_custom_page call per turn — compose the finished
definition, then write it once — so every version the user sees is coherent
even if they stop you mid-turn.
Also available: { "action": "reset" } blanks the page, and
{ "action": "revert" } restores the version from before your last write.`;
