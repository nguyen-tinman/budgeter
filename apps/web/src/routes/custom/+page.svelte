<script lang="ts">
  // Section VI — the assistant-authored page.
  //
  // The definition (title / note / declared queries / render body) is written by
  // the assistant through set_custom_page. THIS page is the trusted half: it
  // runs the declared queries itself via the read-only tool allowlist, then
  // hands the results plus the render body to CustomSandbox, which executes the
  // untrusted code inside a locked iframe. Nothing authored by the model is
  // ever interpolated as markup here — title and note go through Svelte text
  // interpolation, never {@html}.
  import { onDestroy, onMount } from "svelte";
  import {
    api,
    CUSTOM_PAGE_QUERY_TOOLS,
    MAX_QUERIES,
    WORKSPACE_ID_PLACEHOLDER,
    substituteWorkspaceId,
    type CustomPageDefinition,
    type CustomPageQuery,
    type CustomPageQueryTool,
    type CustomPageState,
  } from "$lib/api.js";
  import { workspaceState } from "$lib/workspace.svelte.js";
  import {
    onInvalidate,
    setShellPref,
    shellState,
    type ResourceName,
  } from "$lib/appShellState.svelte.js";
  import { CATEGORIES } from "$lib/helpers.js";
  import { CUSTOM_HARNESS_THEME_VARS } from "$lib/customHarness.js";

  import PageHead from "$lib/components/PageHead.svelte";
  import CustomSandbox from "$lib/components/CustomSandbox.svelte";

  const ws = workspaceState();
  const shell = shellState();

  /** Which invalidation resources each allowlisted query tool depends on. A
   *  data change in one of these re-runs the queries WITHOUT reloading the
   *  definition, so an import or a budget edit live-updates the chart. */
  const QUERY_TOOL_RESOURCES: Record<CustomPageQueryTool, ResourceName[]> = {
    query_transactions: ["statements", "expenses"],
    search_transactions: ["statements", "expenses"],
    top_merchants: ["statements", "expenses"],
    compute_category_baselines: ["statements", "expenses"],
    list_expenses: ["expenses"],
    compute_expense_trends: ["expenses"],
    compute_budget_summary: ["expenses"],
    list_incomes: ["incomes", "takeHome"],
    compute_take_home: ["incomes", "takeHome"],
    list_savings: ["savings"],
    compute_retirement: ["savings", "retirement"],
    get_retirement_settings: ["retirement"],
    list_workspaces: ["workspaces"],
    // Categories are a static palette — nothing invalidates them.
    list_categories: [],
  };

  let pageState = $state<CustomPageState | null>(null);
  let queryData = $state<Record<string, unknown>>({});
  let queryErrors = $state<string[]>([]);
  let renderError = $state<string | null>(null);
  let loadError = $state<string | null>(null);
  let actionError = $state<string | null>(null);
  let loading = $state(true);
  let actionBusy = $state(false);
  /** Transient "the assistant just changed this" highlight; decays to the
   *  absolute timestamp. */
  let justUpdated = $state(false);
  let themeVars = $state<Record<string, string>>({});
  /** Payload identity handed to CustomSandbox — every bump re-mounts the
   *  iframe with the current render/data/theme. */
  let nonce = $state(0);

  // Plain (non-reactive) counter: bumpNonce() is called from $effect bodies, so
  // it must not READ reactive state (`nonce += 1` would make the effect depend
  // on its own write and loop).
  let nonceSeq = 0;
  function bumpNonce(): void {
    nonceSeq += 1;
    nonce = nonceSeq;
    // A new payload starts a fresh render cycle, so any error from the previous
    // one is stale by construction. (Write-only from inside $effect bodies —
    // reading reactive state here would make those effects self-triggering.)
    renderError = null;
  }

  /** Race guard shared by every load path — the newest wins, stale awaits are
   *  discarded (workspace switch, overlapping invalidations, poll vs click). */
  let wsGen = 0;
  /** Which generation currently owns the `loading` flag. Needed because
   *  refreshQueries() also bumps wsGen but never raises `loading`: without this,
   *  a superseded refreshAll() would skip its own `loading = false` and the page
   *  would sit on "Loading…" forever. */
  let loadingGen = 0;

  const definition = $derived<CustomPageDefinition | null>(pageState?.definition ?? null);
  const hasDefinition = $derived(!!pageState?.exists && !!definition);
  /** Resources whose invalidation should re-run the queries (definition
   *  unchanged), derived from the tools the definition actually declares. */
  const dataResources = $derived.by<Set<ResourceName>>(() => {
    const out = new Set<ResourceName>();
    for (const q of definition?.queries ?? []) {
      for (const r of QUERY_TOOL_RESOURCES[q.tool] ?? []) out.add(r);
    }
    return out;
  });

  /** Runtime membership set for the query allowlist. The stored definition is
   *  JSON that the server validated when it was WRITTEN — but this page is the
   *  thing that turns `q.tool` into a live tool invocation with consent
   *  asserted, so it re-checks rather than trusting the row. A definition
   *  tampered with in the DB, or left behind by an older/looser server, can
   *  therefore never reach a tool outside the read-only allowlist. */
  const ALLOWED_QUERY_TOOLS: ReadonlySet<string> = new Set(CUSTOM_PAGE_QUERY_TOOLS);

  /** Does this query reference the workspace placeholder anywhere in its args?
   *  Needed only for the one case core's substituteWorkspaceId cannot express:
   *  its signature takes a non-nullable id, while the page has to cope with "no
   *  workspace selected". Substitution itself stays core's. */
  function usesWorkspacePlaceholder(value: unknown): boolean {
    if (value === WORKSPACE_ID_PLACEHOLDER) return true;
    if (Array.isArray(value)) return value.some(usesWorkspacePlaceholder);
    if (value !== null && typeof value === "object") {
      return Object.values(value as Record<string, unknown>).some(usesWorkspacePlaceholder);
    }
    return false;
  }

  /** Resolve one query's args, or throw with the reason to record against it. */
  function resolveQueryArgs(q: CustomPageQuery): Record<string, unknown> {
    if (!ALLOWED_QUERY_TOOLS.has(q.tool)) throw new Error("tool not allowed on this page");
    const args = q.args ?? {};
    const workspaceId = ws.activeId;
    if (workspaceId == null) {
      if (usesWorkspacePlaceholder(args)) throw new Error("no active workspace");
      return args;
    }
    return substituteWorkspaceId(args, workspaceId) as Record<string, unknown>;
  }

  /** Run the declared queries in order. A failure becomes `{ error }` in the
   *  data bag AND a line in the banner — the render still runs so a page with
   *  one broken query degrades instead of disappearing. */
  async function runQueries(def: CustomPageDefinition, gen: number): Promise<void> {
    const data: Record<string, unknown> = {};
    const errs: string[] = [];
    for (const q of def.queries.slice(0, MAX_QUERIES)) {
      try {
        data[q.id] = await api.invokeQueryTool(q.tool, resolveQueryArgs(q));
      } catch (e) {
        const message = (e as Error).message;
        data[q.id] = { error: message };
        errs.push(`${q.id} (${q.tool}): ${message}`);
      }
      if (gen !== wsGen) return;
    }
    if (gen !== wsGen) return;
    queryData = data;
    queryErrors = errs;
    // A query failure is reported here rather than after the render: the render
    // still runs (degrading around the `{ error }` entries), so a page whose
    // data never loaded would otherwise report a cheerful "ok".
    if (errs.length > 0) {
      api.reportCustomPageStatus({
        state: "query_error",
        message: errs.join("; "),
        title: def.title,
      });
    }
    bumpNonce();
  }

  /** Reload the definition AND re-run its queries. */
  async function refreshAll(): Promise<void> {
    const gen = ++wsGen;
    loadingGen = gen;
    loading = true;
    loadError = null;
    try {
      const next = await api.getCustomPage();
      if (gen !== wsGen) return;
      pageState = next;
      renderError = null;
      if (next.exists && next.definition) {
        await runQueries(next.definition, gen);
      } else {
        queryData = {};
        queryErrors = [];
        api.reportCustomPageStatus({ state: "blank" });
      }
    } catch (e) {
      if (gen !== wsGen) return;
      loadError = (e as Error).message;
    } finally {
      if (loadingGen === gen) loading = false;
    }
  }

  /** Re-run the queries against the definition already loaded (a data change,
   *  not a definition change). Skipped while a full refresh is in flight — that
   *  one re-runs the queries itself, and superseding it would drop the
   *  definition reload it is halfway through. */
  async function refreshQueries(): Promise<void> {
    const def = definition;
    if (!def || loading) return;
    await runQueries(def, ++wsGen);
  }

  /** Flash the "assistant updated this page" badge, then decay to the absolute
   *  timestamp. Purely client-side — no extra wire data. */
  let badgeHandle: ReturnType<typeof setTimeout> | null = null;
  function noteAssistantUpdate(): void {
    justUpdated = true;
    if (badgeHandle !== null) clearTimeout(badgeHandle);
    badgeHandle = setTimeout(() => {
      justUpdated = false;
      badgeHandle = null;
    }, 8000);
  }

  // Load on mount and whenever the active workspace changes — queries carrying
  // $WORKSPACE_ID resolve against the new one.
  $effect(() => {
    ws.activeId;
    void refreshAll();
  });

  // Theme tokens are read out of the app's own computed style so the sandbox
  // charts match light/dark exactly. Reading in an $effect (not a $derived) is
  // deliberate: effects run AFTER the DOM update that flipped data-theme, so
  // getComputedStyle returns the new palette rather than the old one.
  $effect(() => {
    shell.theme;
    themeVars = readThemeVars();
    bumpNonce();
  });

  function readThemeVars(): Record<string, string> {
    if (typeof document === "undefined") return {};
    const host = document.querySelector<HTMLElement>(".bk-root") ?? document.documentElement;
    const cs = getComputedStyle(host);
    const out: Record<string, string> = {};
    for (const name of CUSTOM_HARNESS_THEME_VARS) {
      const value = cs.getPropertyValue(name).trim();
      if (value) out[name] = value;
    }
    return out;
  }

  let disposeInvalidate: (() => void) | null = null;
  let pollHandle: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    disposeInvalidate = onInvalidate((r) => {
      if (r === "customPage") {
        // The definition itself changed (assistant write, undo, reset).
        noteAssistantUpdate();
        void refreshAll();
      } else if (dataResources.has(r)) {
        void refreshQueries();
      }
    });

    // Backstop for writes that never touch this tab's invalidation bus — an
    // MCP client calling set_custom_page from outside the app. Visibility-gated
    // so a background tab costs nothing; the read is a single SELECT.
    pollHandle = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void pollForOutOfBandChange();
    }, 15000);
  });

  onDestroy(() => {
    disposeInvalidate?.();
    if (pollHandle !== null) clearInterval(pollHandle);
    if (badgeHandle !== null) clearTimeout(badgeHandle);
  });

  async function pollForOutOfBandChange(): Promise<void> {
    if (actionBusy || loading) return;
    try {
      const next = await api.getCustomPage();
      const changed =
        next.exists !== (pageState?.exists ?? false) ||
        next.updatedAt !== (pageState?.updatedAt ?? null);
      if (!changed) return;
      noteAssistantUpdate();
      await refreshAll();
    } catch {
      // Transient failures are not worth a banner — the next tick retries and
      // the invalidation bus covers in-app writes regardless.
    }
  }

  async function undoLastChange(): Promise<void> {
    if (actionBusy) return;
    actionBusy = true;
    actionError = null;
    try {
      const r = await api.setCustomPage({ action: "revert" });
      if (r.reverted === false) {
        actionError = "There is no previous version to go back to.";
      }
      await refreshAll();
    } catch (e) {
      actionError = (e as Error).message;
    } finally {
      actionBusy = false;
    }
  }

  async function resetToBlank(): Promise<void> {
    if (actionBusy) return;
    if (!confirm("Reset this page to blank? The current version is kept as the undo step, so you can bring it back with “Undo last change”.")) {
      return;
    }
    actionBusy = true;
    actionError = null;
    try {
      await api.setCustomPage({ action: "reset" });
      await refreshAll();
    } catch (e) {
      actionError = (e as Error).message;
    } finally {
      actionBusy = false;
    }
  }

  /** SQLite `datetime('now')` returns "YYYY-MM-DD HH:MM:SS" in UTC with no zone
   *  marker, which Date() would otherwise read as local time. Normalize before
   *  parsing so the stamp is honest. */
  function formatUpdatedAt(raw: string | null): string {
    if (!raw) return "—";
    const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw.replace(" ", "T")}Z`;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return raw;
    return d.toLocaleString();
  }

  function openAssistant(): void {
    setShellPref("chatOpen", true);
  }
</script>

<article class="ed-article">
  <PageHead
    section="Section VI"
    kicker="Your Own Page"
    title="Custom"
    rightLabel="Custom"
    byline="A page the assistant builds for you. Describe the chart or table you want in chat and it appears here — live, while the assistant is still talking. Its code runs sandboxed and read‑only, over data you already have."
  />

  {#if loadError}
    <div class="bk-error-banner" role="alert" data-testid="custom-error">
      {loadError}
    </div>
  {/if}
  {#if actionError}
    <div class="bk-error-banner" role="alert" data-testid="custom-action-error">
      {actionError}
    </div>
  {/if}

  {#if loading && !hasDefinition}
    <div class="custom-empty" data-testid="custom-loading">Loading…</div>
  {:else if !hasDefinition}
    <div class="custom-empty" data-testid="custom-blank">
      <div class="custom-empty-title">This page is blank — for now.</div>
      <p class="bk-text-3" style="max-width: 46ch; margin: 0 auto 14px">
        Ask the assistant for anything it can draw from your data. For example:
        <em>“Build me a chart of food spending by week”</em>, or
        <em>“plot my food expenses every Tuesday for the past 10 weeks”</em>.
      </p>
      <div class="custom-empty-actions">
        <button
          type="button"
          class="bk-btn bk-btn-sm bk-btn-primary"
          data-testid="custom-open-chat"
          onclick={openAssistant}
        >Open the assistant →</button>
        <!-- Blanking the page keeps the version it replaced, and revert restores
             it — so the blank state has to offer the way back. Without this the
             Reset button's own tooltip ("the current version stays available")
             would be a promise the UI never lets you collect. -->
        {#if pageState?.hasPrevious}
          <button
            type="button"
            class="bk-btn bk-btn-sm"
            data-testid="custom-restore"
            disabled={actionBusy}
            title="Bring back the version that was here before this page was reset."
            onclick={() => void undoLastChange()}
          >Restore last version</button>
        {/if}
      </div>
    </div>
  {:else if definition}
    <div class="custom-doc-head">
      <div class="custom-doc-titles">
        <h2 class="custom-doc-title" data-testid="custom-title">{definition.title}</h2>
        {#if definition.note}
          <p class="custom-doc-note" data-testid="custom-note">{definition.note}</p>
        {/if}
      </div>
      <div class="custom-doc-actions">
        {#if justUpdated}
          <span class="custom-updated-badge" data-testid="custom-updated-badge">
            Assistant updated this page · just now
          </span>
        {:else}
          <span class="bk-text-3" style="font-size: 11.5px" data-testid="custom-updated-at">
            Updated {formatUpdatedAt(pageState?.updatedAt ?? null)}
          </span>
        {/if}
        <!-- Hidden, not disabled, when there is nothing to undo: blank is stored
             as key-absence, so the FIRST write leaves no snapshot and
             hasPrevious is false. A permanently greyed-out button would read as
             broken; "Reset to blank" already covers that state. -->
        {#if pageState?.hasPrevious}
          <button
            type="button"
            class="bk-btn bk-btn-sm"
            data-testid="custom-undo"
            disabled={actionBusy}
            title="Go back to the version before this one. Between two real versions it toggles, so pressing it again returns you here; undoing a reset is a one-way step."
            onclick={() => void undoLastChange()}
          >Undo last change</button>
        {/if}
        <button
          type="button"
          class="bk-btn bk-btn-sm bk-btn-danger"
          data-testid="custom-reset"
          disabled={actionBusy}
          title="Clear the page. The current version stays available as the undo step."
          onclick={() => void resetToBlank()}
        >Reset to blank</button>
      </div>
    </div>

    {#if queryErrors.length > 0}
      <div class="bk-error-banner" role="alert" data-testid="custom-query-error">
        <strong>{queryErrors.length === 1 ? "A query" : `${queryErrors.length} queries`} failed.</strong>
        The page still rendered with whatever came back.
        <div style="margin-top: 6px; font-size: 12px">
          {#each queryErrors as qe, i (i)}
            <div>{qe}</div>
          {/each}
        </div>
      </div>
    {/if}

    {#if renderError}
      <div class="bk-error-banner" role="alert" data-testid="custom-render-error">
        <strong>The page code failed.</strong>
        {renderError}
        <div class="bk-text-3" style="margin-top: 6px; font-size: 12px">
          Paste that message to the assistant and it can fix the page.
        </div>
      </div>
    {/if}

    <div class="custom-canvas" data-testid="custom-canvas">
      <CustomSandbox
        render={definition.render}
        data={queryData}
        theme={themeVars}
        title={definition.title}
        workspaceId={ws.activeId}
        palette={CATEGORIES}
        {nonce}
        onrendererror={(m) => (renderError = m)}
        onoutcome={(o) => {
          // A clean render only counts as "ok" if the data behind it loaded;
          // otherwise the query failure already reported is the real state.
          if (o.state === "ok" && queryErrors.length > 0) return;
          api.reportCustomPageStatus({
            state: o.state,
            ...(o.message ? { message: o.message } : {}),
            title: definition.title,
          });
        }}
      />
    </div>
  {/if}

  <div class="ed-footnotes">
    <div>
      <b>Where this comes from.</b> The assistant writes one definition — a title, up to
      {MAX_QUERIES} read‑only queries, and the drawing code. This page runs the queries itself and
      passes only those results to the code, so the page can never see data it did not declare.
    </div>
    <div>
      <b>Sandbox.</b> The drawing code runs in an isolated frame with no network access and no
      access to the rest of the app. If it loops forever it is stopped after five seconds.
    </div>
    <div>
      <b>Undo.</b> Each write keeps the version it replaced, so <em>Undo last change</em> appears
      from the second write onward. Between two real versions it toggles — press it twice and you
      are back where you started. Undoing a <em>Reset to blank</em> is instead a one-way step:
      blank leaves nothing to swap back to, so the button retires until the next write. Use
      <em>Reset to blank</em> again to clear the page.
    </div>
  </div>
</article>

<style>
  .custom-empty {
    border: 1px dashed var(--border-strong);
    border-radius: 10px;
    padding: 48px 24px;
    margin-bottom: 22px;
    text-align: center;
    color: var(--text-2);
  }
  .custom-empty-title {
    font-family: var(--font-display);
    font-size: 19px;
    color: var(--text);
    margin-bottom: 10px;
  }
  .custom-empty-actions {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .custom-doc-head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 12px;
    padding-bottom: 10px;
    margin-bottom: 14px;
    border-bottom: 1px solid var(--text);
  }
  .custom-canvas {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    padding: 16px 14px;
    margin-bottom: 18px;
    overflow: hidden;
  }
  .custom-doc-titles {
    flex: 1;
    min-width: 240px;
  }
  .custom-doc-title {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.015em;
    margin: 0;
  }
  .custom-doc-note {
    color: var(--text-2);
    font-size: 13px;
    margin: 4px 0 0;
  }
  .custom-doc-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .custom-updated-badge {
    font-size: 11.5px;
    color: var(--accent);
    border: 1px solid color-mix(in oklab, var(--accent) 40%, var(--border));
    background: var(--accent-soft);
    border-radius: 999px;
    padding: 3px 10px;
    animation: custom-badge-in 0.35s ease-out;
  }
  @keyframes custom-badge-in {
    from { opacity: 0; transform: translateY(-3px); }
    to   { opacity: 1; transform: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .custom-updated-badge { animation: none; }
  }
</style>
