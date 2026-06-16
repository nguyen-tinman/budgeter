<script lang="ts">
  import {
    api,
    type Expense,
    type Income,
    type SavingsItem,
    type TakeHome,
  } from "$lib/api.js";
  import { workspaceState } from "$lib/workspace.svelte.js";
  import {
    formatDollars,
    formatDollarsWhole,
    freqToMonthlyDollars,
    monthlyExpenseTotal,
    categoryById,
  } from "$lib/helpers.js";
  import { round2 } from "@budgetkit/core/money";
  import { setModal, onInvalidate, type ResourceName } from "$lib/appShellState.svelte.js";

  import EdMasthead from "$lib/components/EdMasthead.svelte";
  import EdSection from "$lib/components/EdSection.svelte";
  import PullQuote from "$lib/components/PullQuote.svelte";
  import FootnoteRef from "$lib/components/FootnoteRef.svelte";
  import Donut from "$lib/components/Donut.svelte";

  const ws = workspaceState();

  // Each visible section is driven by its own $state slice. A refresh of one
  // section mutates only that slice, so Svelte's diff swaps just the changed
  // nodes — the rest of the article stays in place and never blinks.
  let incomes = $state<Income[]>([]);
  let expenses = $state<Expense[]>([]);
  let savings = $state<SavingsItem[]>([]);
  let takeHome = $state<TakeHome | null>(null);

  // Per-section error slots. A failure refreshing expenses must not blank the
  // incomes summary, so errors are scoped per resource.
  let incomesError = $state<string | null>(null);
  let expensesError = $state<string | null>(null);
  let savingsError = $state<string | null>(null);
  let takeHomeError = $state<string | null>(null);

  // firstLoadDone gates the initial-mount skeleton ONLY. After it flips to
  // true, every refresh (CRUD, workspace switch, etc.) leaves the existing
  // content in place and only the affected section's nodes re-render.
  let firstLoadDone = $state(false);

  // Workspace-switch race guard. Every full reload (`reloadAll`) bumps
  // `wsGen`; each per-resource refresher captures the current `wsGen` at
  // call time and discards its response if the counter has moved on by the
  // time the fetch resolves. Without this, a slow refresh for workspace A
  // can resolve AFTER a switch to B and overwrite B's data with A's. The
  // single-resource refreshers default `gen` to the current `wsGen` so that
  // post-mutation refreshes (e.g., after `addExpense`) implicitly belong to
  // the active generation; only `reloadAll` increments it.
  let wsGen = 0;

  $effect(() => {
    if (ws.activeId !== null) {
      void reloadAll(ws.activeId);
    }
  });

  // Subscribe to LLM-tool-driven invalidations. When the chat bridge runs a
  // tool that mutated server state, ChatPanel calls invalidateResources()
  // with the affected names; we re-run only the matching per-resource
  // refresher. The `$effect` returns the disposer so Svelte unsubscribes on
  // component teardown.
  $effect(() => {
    const unsub = onInvalidate((resource: ResourceName) => {
      if (ws.activeId === null) return;
      const id = ws.activeId;
      if (resource === "incomes") {
        void refreshIncomes(id).then(() => refreshTakeHome(id));
      } else if (resource === "expenses") {
        void refreshExpenses(id);
      } else if (resource === "savings") {
        void refreshSavings(id).then(() => refreshTakeHome(id));
      } else if (resource === "takeHome") {
        void refreshTakeHome(id);
      }
      // "workspaces" handled by ChatPanel's refreshWorkspaces; nothing to
      // do on this page. "retirement" affects /planning, not Dashboard.
    });
    return unsub;
  });

  async function refreshIncomes(workspaceId: number, gen: number = wsGen): Promise<void> {
    try {
      const result = await api.listIncomes(workspaceId);
      if (gen !== wsGen) return; // stale — a newer reload superseded us
      incomes = result;
      incomesError = null;
    } catch (e) {
      if (gen !== wsGen) return;
      incomesError = (e as Error).message;
    }
  }

  async function refreshExpenses(workspaceId: number, gen: number = wsGen): Promise<void> {
    try {
      const result = await api.listExpenses(workspaceId);
      if (gen !== wsGen) return;
      expenses = result;
      expensesError = null;
    } catch (e) {
      if (gen !== wsGen) return;
      expensesError = (e as Error).message;
    }
  }

  async function refreshSavings(workspaceId: number, gen: number = wsGen): Promise<void> {
    try {
      const result = await api.listSavings(workspaceId);
      if (gen !== wsGen) return;
      savings = result;
      savingsError = null;
    } catch (e) {
      if (gen !== wsGen) return;
      savingsError = (e as Error).message;
    }
  }

  // Take-home depends on incomes; refresh it whenever incomes change OR on a
  // full reload. We re-derive whether to call the endpoint each time based on
  // the latest incomes array.
  async function refreshTakeHome(workspaceId: number, gen: number = wsGen): Promise<void> {
    try {
      const hasTaxed = incomes.some((i) => i.taxStatus === "taxed");
      const result = hasTaxed ? await api.computeTakeHome(workspaceId) : null;
      if (gen !== wsGen) return;
      takeHome = result;
      takeHomeError = null;
    } catch (e) {
      if (gen !== wsGen) return;
      takeHomeError = (e as Error).message;
    }
  }

  // Workspace-switch path: fire every refresher in parallel under a single
  // fresh generation. Stale resolutions from a previous workspace's fetches
  // are discarded inside each refresher.
  async function reloadAll(workspaceId: number): Promise<void> {
    const gen = ++wsGen;
    await Promise.all([
      refreshIncomes(workspaceId, gen),
      refreshExpenses(workspaceId, gen),
      refreshSavings(workspaceId, gen),
    ]);
    if (gen !== wsGen) return;
    // Take-home is computed from the now-fresh incomes, so run it after.
    await refreshTakeHome(workspaceId, gen);
    if (gen !== wsGen) return;
    if (!firstLoadDone) firstLoadDone = true;
  }

  const monthlyExp = $derived(monthlyExpenseTotal(expenses));
  const monthlyTakeHome = $derived(takeHome?.monthlyTakeHomeDollars ?? 0);
  const monthlyRemaining = $derived(round2(monthlyTakeHome - monthlyExp));
  const totalSavingsBalance = $derived(round2(savings.reduce((s, x) => s + x.currentBalanceDollars, 0)));
  // Savings funded FROM take-home (Roth IRA, brokerage, HYSA, "other") — the
  // only contributions that reduce discretionary cash. Payroll savings (pre-tax
  // 401k/HSA and Roth 401k) are ALREADY netted out of take-home by the server,
  // so subtracting them again here would double-count. The server resolves the
  // from-cash total (employee side, %-of-salary aware; employer match excluded)
  // alongside the tax math, so we just read it back.
  const fromCashMonthly = $derived(round2((takeHome?.fromCashContribDollars ?? 0) / 12));

  // Section I — by-category breakdown.
  //
  // BASIS: this is the PLANNED recurring budget — it derives category spend
  // from the `expenses` table (recurring/manual lines + committed import
  // candidates), frequency-converted to a monthly figure. The Trends page
  // derives category spend from the raw `transactions` table (actual charges).
  // Both pages use the SAME unified budget-category set, the SAME credit
  // handling (expense lines are positive planned costs; Trends sums only
  // charges and excludes credits), and the SAME "Uncategorized" label for
  // null-category buckets — so a category prominent here is never $0 on Trends
  // for the same underlying spend. The remaining difference is intentional:
  // Dashboard/Budget = forward-looking plan, Trends = historical actuals.
  interface ByCat { name: string; color: string; value: number }
  const byCat = $derived<ByCat[]>(((): ByCat[] => {
    const m = new Map<string, ByCat>();
    for (const e of expenses) {
      const monthly = freqToMonthlyDollars(e.amountDollars, e.frequency);
      const cat = categoryById(e.categoryId);
      // Every expense lands in some bucket so byCat totals sum cleanly to the
      // full expense total. An expense with categoryId=null (or an id not in
      // the canonical budget set) falls back to the "Uncategorized" bucket —
      // the same label Trends uses for null-category spend. The budget set has
      // no "Other"; unknown merchants get "Discretionary" at resolve time.
      const key = cat?.name ?? "Uncategorized";
      const existing = m.get(key);
      if (existing) existing.value = round2(existing.value + monthly);
      else m.set(key, { name: key, color: cat?.color ?? "#888", value: round2(monthly) });
    }
    return Array.from(m.values()).sort((a, b) => b.value - a.value);
  })());
  const totalCat = $derived(byCat.reduce((s, c) => s + c.value, 0) || 1);

  // Section III — cash-flow river
  interface RiverRow { name: string; topic: string; value: number; tone: "pos" | "neg" }
  const river = $derived<RiverRow[]>(((): RiverRow[] => {
    if (!takeHome) return [];
    const annualTaxed = incomes.filter((i) => i.taxStatus === "taxed").reduce((s, i) => s + i.grossAnnualDollars, 0);
    const grossMonthly = annualTaxed / 12;
    const monthlyTax = (takeHome.federalTaxDollars + takeHome.caTaxDollars + takeHome.ficaDollars + takeHome.caSdiDollars) / 12;
    const monthlyPretax = takeHome.preTaxDeductionsDollars / 12;
    const monthlyRothPayroll = (takeHome.postTaxPayrollDollars ?? 0) / 12;
    // Waterfall: gross − tax − pretax − roth-payroll = take-home; then
    // − expenses − from-cash savings = discretionary. Payroll savings appear
    // here as paycheck deductions, NOT in the savings line (no double-count).
    const rows: RiverRow[] = [
      { name: "Gross paycheck",       topic: "gross-paycheck",   value: round2(grossMonthly),   tone: "pos" },
      { name: "Federal · CA · FICA",  topic: "tax-monthly",      value: -round2(monthlyTax),    tone: "neg" },
      { name: "401k · HSA (pre-tax)", topic: "pretax-monthly",   value: -round2(monthlyPretax), tone: "neg" },
    ];
    if (monthlyRothPayroll > 0) {
      rows.push({ name: "Roth 401k (post-tax)", topic: "pretax-monthly", value: -round2(monthlyRothPayroll), tone: "neg" });
    }
    rows.push(
      { name: "Recurring expenses",       topic: "monthly-expenses",        value: -monthlyExp,     tone: "neg" },
      { name: "Savings (from take-home)", topic: "savings-contrib-monthly", value: -fromCashMonthly, tone: "neg" },
      { name: "Discretionary remainder",  topic: "discretionary",           value: round2(monthlyTakeHome - monthlyExp - fromCashMonthly), tone: "pos" },
    );
    return rows;
  })());
  const riverMax = $derived(Math.max(...river.map((r) => Math.abs(r.value)), 1));

  interface Goal { name: string; current: number; target: number }
  const goals = $derived<Goal[]>(
    savings
      .filter((s) => s.targetBalanceDollars && s.targetBalanceDollars > 0)
      .map((s) => ({
        name: s.label,
        current: s.currentBalanceDollars,
        target: s.targetBalanceDollars!,
      }))
  );

  const wsName = $derived(ws.list.find((w) => w.id === ws.activeId)?.name);

  function openFootnote(topic: string) {
    setModal(`help-${topic}`);
  }

  // Stable footnote numbering — each topic always gets the same [N] on this
  // page, in order of first appearance. The footnotes section at the bottom
  // mirrors this ordering.
  const FN_ORDER = [
    "monthly-remaining",
    "take-home",
    "effective-rate",
    "remaining-share",
    "pretax",
    "monthly-expenses",
    "net-worth",
    "freq-conversion",
    "category-pct",
    "gross-paycheck",
    "tax-monthly",
    "pretax-monthly",
    "savings-contrib-monthly",
    "discretionary",
    "goal-pct",
    "goal-remaining",
  ];
  const FN = Object.fromEntries(FN_ORDER.map((t, i) => [t, i + 1])) as Record<string, number>;
</script>

<article class="ed-article">
  <EdMasthead workspaceName={wsName} />

  {#if !firstLoadDone}
    <p class="bk-text" data-testid="loading">Loading…</p>
  {:else}
    {#if incomesError || expensesError || savingsError || takeHomeError}
      <div class="bk-error-banner" data-testid="load-error" role="alert">
        <span style="display: flex; flex-direction: column; gap: 4px">
          {#if incomesError}<span><strong>Couldn't refresh incomes.</strong>{incomesError}</span>{/if}
          {#if expensesError}<span><strong>Couldn't refresh expenses.</strong>{expensesError}</span>{/if}
          {#if savingsError}<span><strong>Couldn't refresh savings.</strong>{savingsError}</span>{/if}
          {#if takeHomeError}<span><strong>Couldn't refresh take-home.</strong>{takeHomeError}</span>{/if}
        </span>
      </div>
    {/if}
    <div class="ed-cols" data-cols="2" style="margin-bottom: 32px; gap: 36px">
      <div>
        <div class="bk-eyebrow" style="margin-bottom: 8px">The bottom line</div>
        <p class="ed-lede">
          {#if takeHome}
            <em>You keep</em> <strong>{formatDollarsWhole(monthlyRemaining)}</strong><FootnoteRef topic="monthly-remaining" n={FN["monthly-remaining"]} onopen={openFootnote} /> a month after expenses, on {formatDollarsWhole(monthlyTakeHome)}<FootnoteRef topic="take-home" n={FN["take-home"]} onopen={openFootnote} /> of take-home pay
            (effective rate {(takeHome.effectiveTaxRate * 100).toFixed(1)}%<FootnoteRef topic="effective-rate" n={FN["effective-rate"]} onopen={openFootnote} />).
            That is {monthlyTakeHome > 0 ? ((monthlyRemaining / monthlyTakeHome) * 100).toFixed(0) : "—"}%<FootnoteRef topic="remaining-share" n={FN["remaining-share"]} onopen={openFootnote} /> of every dollar that lands in your account, free to direct as you wish.
          {:else}
            <em>Set up your incomes</em> first — add a <strong>taxed W-2</strong> line in <a href="/budget" style="color: var(--accent)">Budget</a> to see take-home, tax burden, and the discretionary remainder<FootnoteRef topic="pretax" n={FN["pretax"]} onopen={openFootnote} />.
          {/if}
        </p>
      </div>
      <div>
        <div class="bk-eyebrow" style="margin-bottom: 8px">What's in the river</div>
        <p class="bk-text" style="font-size: 14px; line-height: 1.55; color: var(--text-2)">
          {incomes.length === 0
            ? "No incomes recorded yet."
            : `${incomes.length} income line${incomes.length === 1 ? "" : "s"} feed this budget`}{#if incomes.filter((i) => i.taxStatus === "pretax").length > 0}, including pretax buckets<FootnoteRef topic="pretax" n={FN["pretax"]} onopen={openFootnote} />{/if}.
          {#if ws.list.length > 1}Switch via the workspace picker to model a move or a raise without disturbing this ledger.{/if}
        </p>
        <p class="bk-text" style="font-size: 14px; line-height: 1.55; color: var(--text-2); margin-top: 8px">
          {#if expenses.length === 0}
            No expense lines yet. <a href="/budget" style="color: var(--accent)">Add some</a> to see your full cash-flow river.
          {:else}
            {expenses.length} expense line{expenses.length === 1 ? "" : "s"} feed Section I &amp; III below.
            Annual fees and one-off charges are pro-rated to monthly<FootnoteRef topic="freq-conversion" n={FN["freq-conversion"]} onopen={openFootnote} />.
          {/if}
        </p>
      </div>
    </div>

    <div class="ed-money-grid">
      <div class="ed-money-cell">
        <div class="ed-money-label">
          Take-home<FootnoteRef topic="take-home" n={FN["take-home"]} onopen={openFootnote} />
        </div>
        <div class="ed-money-val" data-testid="card-monthly-takehome">{takeHome ? formatDollarsWhole(monthlyTakeHome) : "—"}</div>
        <div class="ed-money-sub">
          {takeHome ? `${(takeHome.effectiveTaxRate * 100).toFixed(1)}% effective rate` : "add a taxed income"}{#if takeHome}<FootnoteRef topic="effective-rate" n={FN["effective-rate"]} onopen={openFootnote} />{/if}
        </div>
      </div>
      <div class="ed-money-cell">
        <div class="ed-money-label">
          Expenses<FootnoteRef topic="monthly-expenses" n={FN["monthly-expenses"]} onopen={openFootnote} />
        </div>
        <div class="ed-money-val" data-testid="card-monthly-expenses">{formatDollarsWhole(monthlyExp)}</div>
        <div class="ed-money-sub">across {expenses.length} lines</div>
      </div>
      <div class="ed-money-cell {monthlyRemaining >= 0 ? 'ed-pos' : 'ed-neg'}">
        <div class="ed-money-label">
          Remaining<FootnoteRef topic="monthly-remaining" n={FN["monthly-remaining"]} onopen={openFootnote} />
        </div>
        <div class="ed-money-val" data-testid="card-monthly-remaining">{takeHome ? formatDollarsWhole(monthlyRemaining) : "—"}</div>
        <div class="ed-money-sub">per calendar month</div>
      </div>
      <div class="ed-money-cell">
        <div class="ed-money-label">
          Net worth (savings)<FootnoteRef topic="net-worth" n={FN["net-worth"]} onopen={openFootnote} />
        </div>
        <div class="ed-money-val">{formatDollarsWhole(totalSavingsBalance)}</div>
        <div class="ed-money-sub">{savings.length} account{savings.length === 1 ? "" : "s"}</div>
      </div>
    </div>

    <EdSection
      num={1}
      title="Where the money goes"
      deck="Planned recurring spend across categories, from your Budget lines (annual fees pro-rated to monthly). This is your forward-looking plan; Trends shows actual transaction spend per category."
    >
      {#if byCat.length === 0}
        <p class="bk-text">No expenses categorized yet. Add lines in <a href="/budget" style="color: var(--accent)">Budget</a> to see this breakdown.</p>
      {:else}
        <div class="ed-cols" data-cols="2" style="align-items: start">
          <div style="display: flex; gap: 24px; align-items: center; justify-content: center">
            <Donut slices={byCat.map((c) => ({ value: c.value, color: c.color }))} size={180} />
            <div class="bk-stack" data-gap="6" style="min-width: 0">
              <div class="bk-eyebrow">
                Monthly<FootnoteRef topic="monthly-expenses" n={FN["monthly-expenses"]} onopen={openFootnote} />
              </div>
              <div class="bk-big-num ed-serif" style="font-size: 36px">{formatDollarsWhole(monthlyExp)}</div>
              <div class="bk-text-3" style="font-size: 12px">{expenses.length} expense lines</div>
            </div>
          </div>
          <div>
            <div class="bk-eyebrow" style="margin-bottom: 12px">
              By category<FootnoteRef topic="category-pct" n={FN["category-pct"]} onopen={openFootnote} />
            </div>
            <div class="ed-bar-list" data-testid="category-bars">
              {#each byCat as c (c.name)}
                {@const pct = c.value / totalCat}
                <div class="ed-bar-row">
                  <span class="ed-bar-name">
                    <span class="bk-cat-dot" style:background={c.color}></span>
                    {c.name}
                  </span>
                  <div>
                    <div class="ed-bar-track">
                      <div class="ed-bar-fill" style:width="{pct * 100}%" style:background={c.color}></div>
                    </div>
                    <div style="display: flex; justify-content: space-between; margin-top: 4px">
                      <span class="ed-bar-pct">{(pct * 100).toFixed(0)}% of monthly spend</span>
                    </div>
                  </div>
                  <span class="ed-bar-val">{formatDollars(c.value)}</span>
                </div>
              {/each}
            </div>
          </div>
        </div>
      {/if}
    </EdSection>

    <EdSection num={2} title="The fixed costs" deck="Recurring and fixed-frequency expense lines from your budget.">
      {#if expensesError}
        <p class="bk-text" style="color: var(--negative)">{expensesError}</p>
      {:else if !firstLoadDone}
        <p class="bk-text">Loading…</p>
      {:else}
        {@const fixedExpenses = expenses.filter((e) => e.frequency !== "one_time")}
        {#if fixedExpenses.length === 0}
          <p class="bk-text">
            No recurring expense lines yet. <a href="/budget" style="color: var(--accent)">Add lines in Budget</a> or <a href="/library" style="color: var(--accent)">import statements</a> to populate this section.
          </p>
        {:else}
          <div class="ed-bar-list" style="max-width: 560px">
            {#each fixedExpenses.slice().sort((a, b) => freqToMonthlyDollars(b.amountDollars, b.frequency) - freqToMonthlyDollars(a.amountDollars, a.frequency)).slice(0, 8) as e (e.id)}
              {@const monthly = freqToMonthlyDollars(e.amountDollars, e.frequency)}
              {@const cat = categoryById(e.categoryId)}
              <div class="ed-bar-row">
                <span class="ed-bar-name">
                  {#if cat}<span class="bk-cat-dot" style:background={cat.color}></span>{/if}
                  {e.label}
                </span>
                <span class="bk-text-3" style="font-size: 12px; white-space: nowrap">{e.frequency}</span>
                <span class="ed-bar-val">{formatDollars(monthly)}<span class="bk-text-3">/mo</span></span>
              </div>
            {/each}
            {#if fixedExpenses.length > 8}
              <p class="bk-text-3" style="font-size: 12px; margin-top: 8px">
                +{fixedExpenses.length - 8} more lines in <a href="/budget" style="color: var(--accent)">Budget</a>
              </p>
            {/if}
          </div>
          <p class="bk-text-3" style="font-size: 12px; margin-top: 12px">
            {fixedExpenses.length} recurring line{fixedExpenses.length === 1 ? "" : "s"} ·
            {formatDollarsWhole(fixedExpenses.reduce((s, e) => s + freqToMonthlyDollars(e.amountDollars, e.frequency), 0))}/mo ·
            <a href="/library" style="color: var(--accent)">Import statements</a> to seed more lines automatically.
          </p>
        {/if}
      {/if}
    </EdSection>

    <PullQuote attribution="Editorial maxim">
      "Track what's already automatic. Decide on the rest."
    </PullQuote>

    {#if takeHome}
      <EdSection num={3} title="The cash-flow river" deck="Where each gross dollar travels — from paycheck through taxes to the remainder you direct.">
        <div class="ed-river" data-testid="cash-flow-river">
          {#each river as r (r.name)}
            <div class="ed-river-row">
              <div class="bk-stack" data-gap="6">
                <div style="font-family: var(--font-display); font-size: 15px">
                  {r.name}<FootnoteRef topic={r.topic} n={FN[r.topic]} onopen={openFootnote} />
                </div>
                <div class="ed-river-bar {r.tone}">
                  <i style:width="{(Math.abs(r.value) / riverMax) * 100}%"></i>
                </div>
              </div>
              <span
                class="bk-num"
                style="font-size: 15px; min-width: 120px; text-align: right"
                style:color={r.value < 0 ? "var(--negative)" : "var(--positive)"}
              >{formatDollarsWhole(r.value, { withSign: true })}</span>
            </div>
          {/each}
        </div>
      </EdSection>
    {/if}

    {#if goals.length > 0}
      <EdSection num={4} title="Goals & savings runway" deck="Progress against the things you said you wanted to save toward.">
        {#each goals as g (g.name)}
          {@const pct = Math.min(1, g.current / g.target)}
          <div class="ed-goal">
            <Donut slices={[{ value: pct, color: "var(--accent)" }, { value: 1 - pct, color: "var(--surface-3)" }]} size={70} />
            <div style="flex: 1">
              <div style="display: flex; justify-content: space-between">
                <span class="ed-goal-name">{g.name}</span>
                <span class="bk-num" style="font-size: 14px">
                  {formatDollarsWhole(g.current)}<span class="bk-text-3"> / {formatDollarsWhole(g.target)}</span>
                </span>
              </div>
              <div class="ed-goal-bar"><i style:width="{pct * 100}%"></i></div>
              <div class="ed-goal-meta">
                {(pct * 100).toFixed(0)}% complete<FootnoteRef topic="goal-pct" n={FN["goal-pct"]} onopen={openFootnote} /> · {formatDollarsWhole(Math.max(0, g.target - g.current))} to go<FootnoteRef topic="goal-remaining" n={FN["goal-remaining"]} onopen={openFootnote} />
              </div>
            </div>
          </div>
        {/each}
      </EdSection>
    {/if}

    <div class="ed-footnotes" data-testid="footnotes">
      <div><b>[{FN["monthly-remaining"]}] Monthly remaining.</b> Take-home minus recurring expenses (frequency-converted to monthly).</div>
      <div><b>[{FN["take-home"]}] Take-home.</b> What lands in your account after federal + CA + FICA + CA SDI + pretax buckets are removed.</div>
      <div><b>[{FN["effective-rate"]}] Effective rate.</b> Federal + CA + FICA + CA SDI as a fraction of taxed W-2 gross.</div>
      <div><b>[{FN["remaining-share"]}] Share of take-home.</b> Monthly remaining divided by monthly take-home.</div>
      <div><b>[{FN["pretax"]}] Pretax buckets.</b> 401k Traditional, HSA, transit FSA, dependent-care — leave the paycheck but lower the taxable base.</div>
      <div><b>[{FN["monthly-expenses"]}] Monthly expenses.</b> Sum of frequency-converted expense lines.</div>
      <div><b>[{FN["net-worth"]}] Net worth (savings).</b> Snapshot sum of current balances across savings accounts.</div>
      <div><b>[{FN["freq-conversion"]}] Frequency → monthly.</b> weekly × 52/12 · biweekly × 26/12 · quarterly ÷ 3 · annually ÷ 12 · one_time = 0.</div>
      <div><b>[{FN["category-pct"]}] Category share.</b> Each category's monthly total divided by the grand monthly total.</div>
      <div><b>[{FN["gross-paycheck"]}] Gross paycheck.</b> Sum of taxed-status income / 12.</div>
      <div><b>[{FN["tax-monthly"]}] Monthly taxes.</b> (federal + CA + FICA + CA SDI) / 12.</div>
      <div><b>[{FN["pretax-monthly"]}] Pretax monthly.</b> Sum of pretax-status income / 12.</div>
      <div><b>[{FN["savings-contrib-monthly"]}] Savings contributions.</b> Sum of savings.monthlyContributionDollars across all accounts.</div>
      <div><b>[{FN["discretionary"]}] Discretionary remainder.</b> Take-home − expenses − savings contributions.</div>
      <div><b>[{FN["goal-pct"]}] Goal progress.</b> currentBalance ÷ targetBalance for savings rows with a target.</div>
      <div><b>[{FN["goal-remaining"]}] Remaining to goal.</b> targetBalance − currentBalance.</div>
      <div style="margin-top: 8px"><em>Click any bracketed numeral to see the exact formula and trace it back to the raw inputs.</em></div>
    </div>
  {/if}
</article>
