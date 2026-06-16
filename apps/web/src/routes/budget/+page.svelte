<script lang="ts">
  import {
    api,
    effectiveMonthlyContributionDollars,
    resolveTreatment,
    type DedupeResult,
    type Expense,
    type Income,
    type SavingsItem,
    type SavingsAccountType,
    type EmployerMatchKind,
    type TaxTreatment,
  } from "$lib/api.js";
  import { round2 } from "@budgetkit/core/money";
  import { workspaceState } from "$lib/workspace.svelte.js";
  import {
    formatDollars,
    formatDollarsWhole,
    freqToMonthlyDollars,
    monthlyExpenseTotal,
    parseDollars,
    categoryById,
    CATEGORIES,
    type Frequency,
  } from "$lib/helpers.js";

  import PageHead from "$lib/components/PageHead.svelte";
  import EdSection from "$lib/components/EdSection.svelte";
  import PullQuote from "$lib/components/PullQuote.svelte";
  import Badge from "$lib/components/Badge.svelte";
  import Chip from "$lib/components/Chip.svelte";
  import CellEdit from "$lib/components/CellEdit.svelte";
  import Icon from "$lib/components/Icon.svelte";
  import FootnoteRef from "$lib/components/FootnoteRef.svelte";
  import { setModal, onInvalidate, invalidateResources, type ResourceName } from "$lib/appShellState.svelte.js";

  function openFootnote(topic: string) {
    setModal(`help-${topic}`);
  }

  // Stable footnote numbering — each topic always gets the same [N] on this
  // page, in order of first appearance.
  const FN_ORDER = [
    "income-total",
    "monthly-expenses",
    "freq-conversion",
    "annual-fees-total",
    "pro-rated",
    "savings-balance-total",
    "savings-monthly-total",
    "annualized-savings",
    "savings-annualized-total",
  ];
  const FN = Object.fromEntries(FN_ORDER.map((t, i) => [t, i + 1])) as Record<string, number>;

  const ws = workspaceState();

  let incomes = $state<Income[]>([]);
  let expenses = $state<Expense[]>([]);
  let savings = $state<SavingsItem[]>([]);
  let loading = $state(true);
  let actionError = $state<string | null>(null);

  // Filters
  let expenseSearch = $state("");
  let expenseCategoryFilter = $state<number | null>(null);
  let expenseFreqFilter = $state<Frequency | null>(null);
  // Date range filters operate on the expense's createdAt timestamp (when the
  // row was added to the system). Values are ISO date strings ("YYYY-MM-DD")
  // straight from <input type="date">; empty string = no bound.
  let expenseDateFrom = $state("");
  let expenseDateTo = $state("");
  // Cost range filters operate on amountDollars (positive). Bound to
  // <input type="number">, which Svelte coerces to `number | null` (null when
  // the field is empty) — NOT a string. Treat null as "no bound". (The earlier
  // `string` typing + `.trim()` threw the moment a value was typed, which is
  // why the filter appeared to do nothing.)
  let expenseCostMin = $state<number | null>(null);
  let expenseCostMax = $state<number | null>(null);

  // Sort controls for the expenses table. "category" keys off the resolved
  // category name (uncategorized last) so same-category rows — e.g. everything
  // in "Food" — group together; the others order by their numeric/text value.
  type ExpenseSortKey = "label" | "amount" | "monthly" | "category";
  let expenseSortKey = $state<ExpenseSortKey>("label");
  let expenseSortDir = $state<"asc" | "desc">("asc");

  // New-income form
  let newIncLabel = $state("");
  let newIncDollars = $state("");
  let newIncStatus = $state<Income["taxStatus"]>("taxed");
  let newIncRole = $state<Income["filingRole"]>("primary");

  // New-expense form
  let newExpLabel = $state("");
  let newExpDollars = $state("");
  let newExpFreq = $state<Frequency>("monthly");
  let newExpCat = $state<string>("");
  let newExpSpendDate = $state<string>("");

  // New-savings form
  let newSavLabel = $state("");
  let newSavBalance = $state("");
  let newSavMonthly = $state("");
  let newSavType = $state<SavingsAccountType>("hysa");
  // Which filer owns the account — spouse-owned 401k/Roth feed the spouse leg
  // of take-home and %-of-salary scales with the spouse salary.
  let newSavRole = $state<"primary" | "spouse">("primary");
  // Optional 401k knobs on the new-row form. Empty string = leave default.
  let newSavPct = $state("");
  let newSavMatchKind = $state<EmployerMatchKind>("none");
  let newSavMatchValue = $state("");

  // Per-resource error slots. A failure refreshing expenses must not blank
  // the incomes summary, so errors are scoped per resource and rendered
  // inline next to their section. `actionError` stays around for action
  // failures (add/edit/delete) where the failure is the user's mutation,
  // not a refresh.
  let incomesError = $state<string | null>(null);
  let expensesError = $state<string | null>(null);
  let savingsError = $state<string | null>(null);

  // Workspace-switch race guard. Every full reload (`reloadAll`) bumps
  // `wsGen`; each per-resource refresher captures the current `wsGen` at
  // call time and discards its response if the counter has moved on by the
  // time the fetch resolves. Without this, a slow refresh for workspace A
  // can resolve AFTER a switch to B and overwrite B's data with A's.
  let wsGen = 0;

  $effect(() => {
    if (ws.activeId !== null) void reloadAll(ws.activeId);
  });

  // Subscribe to LLM-tool-driven invalidations. The chat bridge calls
  // invalidateResources() with the affected resource names; we re-run only
  // the matching per-resource refresher (no monolithic reload).
  $effect(() => {
    const unsub = onInvalidate((resource: ResourceName) => {
      if (ws.activeId === null) return;
      const id = ws.activeId;
      if (resource === "incomes") {
        void refreshIncomes(id);
      } else if (resource === "expenses") {
        void refreshExpenses(id);
      } else if (resource === "savings") {
        void refreshSavings(id);
      }
      // "takeHome", "workspaces", "retirement" don't render here.
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

  // Workspace-switch path: bump the generation once, fire every refresher
  // under it in parallel. Stale resolutions from a previous workspace's
  // fetches are discarded inside each refresher via the gen check.
  async function reloadAll(workspaceId: number): Promise<void> {
    const gen = ++wsGen;
    await Promise.all([
      refreshIncomes(workspaceId, gen),
      refreshExpenses(workspaceId, gen),
      refreshSavings(workspaceId, gen),
    ]);
    // Flip the initial-load gate only after the FIRST successful workspace
    // load so subsequent refreshes don't re-trigger the skeleton swap.
    if (gen === wsGen && loading) loading = false;
  }

  // Backwards-compatible alias — action handlers below call `reload(id)`
  // after every CRUD op. Funnel through the per-resource refreshers so
  // we don't accidentally re-introduce the monolithic fetch.
  async function reload(workspaceId: number): Promise<void> {
    await reloadAll(workspaceId);
  }

  // Parse the cost-range bounds once per evaluation. NaN (from empty string
  // or garbage) → null, which the filter treats as unbounded. The bounds are
  // already in dollars, matching the row's amountDollars.
  const expenseCostMinDollars = $derived(
    expenseCostMin === null ? null : round2(expenseCostMin),
  );
  const expenseCostMaxDollars = $derived(
    expenseCostMax === null ? null : round2(expenseCostMax),
  );
  const filteredExpenses = $derived(
    expenses.filter((e) => {
      const q = expenseSearch.trim().toLowerCase();
      // SQLite stores createdAt as "YYYY-MM-DD HH:MM:SS" (UTC). Compare on
      // the leading date portion so "from = 2026-05-27" includes any row
      // created at any time on that date. Lexical comparison works because
      // ISO date strings sort chronologically.
      const createdDate = e.createdAt.slice(0, 10);
      const fromOk = !expenseDateFrom || createdDate >= expenseDateFrom;
      const toOk = !expenseDateTo || createdDate <= expenseDateTo;
      const minOk =
        expenseCostMinDollars === null ||
        Number.isNaN(expenseCostMinDollars) ||
        e.amountDollars >= expenseCostMinDollars;
      const maxOk =
        expenseCostMaxDollars === null ||
        Number.isNaN(expenseCostMaxDollars) ||
        e.amountDollars <= expenseCostMaxDollars;
      return (
        (!q || e.label.toLowerCase().includes(q)) &&
        (expenseCategoryFilter === null || e.categoryId === expenseCategoryFilter) &&
        (expenseFreqFilter === null || e.frequency === expenseFreqFilter) &&
        fromOk &&
        toOk &&
        minOk &&
        maxOk
      );
    })
  );
  const filteredMonthly = $derived(monthlyExpenseTotal(filteredExpenses));

  // Sort the filtered rows by the chosen key/direction. Category sorts by the
  // resolved category name; uncategorized rows use a "~" sentinel so they fall
  // after any real category name in ascending order.
  const sortedExpenses = $derived.by(() => {
    const dir = expenseSortDir === "asc" ? 1 : -1;
    const keyOf = (e: Expense): string | number => {
      switch (expenseSortKey) {
        case "label":
          return e.label.toLowerCase();
        case "amount":
          return e.amountDollars;
        case "monthly":
          return freqToMonthlyDollars(e.amountDollars, e.frequency);
        case "category":
          return e.categoryId != null
            ? (categoryById(e.categoryId)?.name ?? "~").toLowerCase()
            : "~";
      }
    };
    return [...filteredExpenses].sort((a, b) => {
      const av = keyOf(a);
      const bv = keyOf(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  });
  // ── Merchant grouping (view-only) ──────────────────────────────────
  // Same-merchant expense lines can be collapsed into one expandable group
  // row — a dropdown. Reversible (a toggle, plus per-merchant disclosure) and
  // purely a DISPLAY of the existing rows: it never mutates expense data.
  let groupByMerchant = $state(false);
  let expandedMerchants = $state<Set<string>>(new Set());
  const normLabel = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  // "Continuous monthly run-rate": recurring lines at their monthly-equivalent;
  // one-time amounts amortized over 12 months (the budget has no per-line date).
  const memberMonthlyAvg = (e: Expense): number =>
    e.frequency === "one_time"
      ? round2(e.amountDollars / 12)
      : freqToMonthlyDollars(e.amountDollars, e.frequency);
  interface MerchantGroup {
    key: string;
    label: string;
    members: Expense[];
    total: number;
    monthlyAvg: number;
  }
  const merchantGroups = $derived.by<MerchantGroup[]>(() => {
    const map = new Map<string, MerchantGroup>();
    for (const e of sortedExpenses) {
      const key = normLabel(e.label) || `#${e.id}`;
      const g = map.get(key) ?? { key, label: e.label, members: [], total: 0, monthlyAvg: 0 };
      g.members.push(e);
      g.total = round2(g.total + e.amountDollars);
      g.monthlyAvg = round2(g.monthlyAvg + memberMonthlyAvg(e));
      map.set(key, g);
    }
    return [...map.values()];
  });
  function toggleMerchant(key: string): void {
    const n = new Set(expandedMerchants);
    if (n.has(key)) n.delete(key);
    else n.add(key);
    expandedMerchants = n;
  }
  function expandAllMerchants(): void {
    expandedMerchants = new Set(merchantGroups.filter((g) => g.members.length > 1).map((g) => g.key));
  }
  function collapseAllMerchants(): void {
    expandedMerchants = new Set();
  }

  const annualFees = $derived(expenses.filter((e) => e.frequency === "annually"));
  const totalAnnualFees = $derived(annualFees.reduce((s, e) => s + e.amountDollars, 0));
  const totalGrossAnnual = $derived(incomes.reduce((s, i) => s + i.grossAnnualDollars, 0));

  // The "% of salary" 401k knob and employer-match-% knob both key off the
  // PRIMARY filer's taxed (W-2) gross. Mirrors the same selector used by
  // compute_retirement in the API.
  const primaryTaxedGrossAnnual = $derived(
    incomes
      .filter((i) => i.filingRole === "primary" && i.taxStatus === "taxed")
      .reduce((s, i) => s + i.grossAnnualDollars, 0)
  );

  // Combined (employee + employer) effective monthly contribution for a row.
  // Delegates to the core helper so the UI shows what the projection will
  // actually use — single source of truth for the math.
  function effectiveMonthlyDollars(s: SavingsItem): number {
    return effectiveMonthlyContributionDollars(s, primaryTaxedGrossAnnual);
  }

  async function addIncome(): Promise<void> {
    if (!ws.activeId) return;
    const dollars = parseDollars(newIncDollars);
    if (!newIncLabel.trim() || dollars === null) { actionError = "Need label and dollar amount"; return; }
    actionError = null;
    try {
      await api.addIncome({
        workspaceId: ws.activeId,
        label: newIncLabel.trim(),
        grossAnnualDollars: dollars,
        taxStatus: newIncStatus,
        filingRole: newIncRole,
      });
      newIncLabel = ""; newIncDollars = ""; newIncStatus = "taxed"; newIncRole = "primary";
      await reload(ws.activeId);
      invalidateResources(["incomes", "takeHome", "retirement"]);
    } catch (e) { actionError = (e as Error).message; }
  }

  async function deleteIncome(id: number): Promise<void> {
    if (!ws.activeId) return;
    try {
      await api.deleteIncome(id);
      await reload(ws.activeId);
      invalidateResources(["incomes", "takeHome", "retirement"]);
    } catch (e) { actionError = (e as Error).message; }
  }

  async function updateIncome(
    id: number,
    patch: { label?: string; grossAnnualDollars?: number; taxStatus?: Income["taxStatus"]; isFederalIncomeTax?: boolean; filingRole?: "primary" | "spouse" },
  ): Promise<void> {
    if (!ws.activeId) return;
    try {
      await api.updateIncome({ id, ...patch });
      await reload(ws.activeId);
      invalidateResources(["incomes", "takeHome", "retirement"]);
    } catch (e) { actionError = (e as Error).message; }
  }

  async function addExpense(): Promise<void> {
    if (!ws.activeId) return;
    const dollars = parseDollars(newExpDollars);
    if (!newExpLabel.trim() || dollars === null) { actionError = "Need label and dollar amount"; return; }
    actionError = null;
    try {
      // add_expense schema rejects categoryId: null — omit the field entirely
      // when the user hasn't picked a category yet.
      const payload: {
        workspaceId: number;
        label: string;
        amountDollars: number;
        frequency: typeof newExpFreq;
        categoryId?: number;
        spendDate?: string;
      } = {
        workspaceId: ws.activeId,
        label: newExpLabel.trim(),
        amountDollars: dollars,
        frequency: newExpFreq,
      };
      if (newExpCat) payload.categoryId = Number(newExpCat);
      if (newExpFreq === "one_time" && newExpSpendDate) payload.spendDate = newExpSpendDate;
      await api.addExpense(payload);
      newExpLabel = ""; newExpDollars = ""; newExpCat = ""; newExpSpendDate = "";
      await reload(ws.activeId);
      invalidateResources(["expenses"]);
    } catch (e) { actionError = (e as Error).message; }
  }

  async function deleteExpense(id: number): Promise<void> {
    if (!ws.activeId) return;
    try {
      await api.deleteExpense(id);
      await reload(ws.activeId);
      invalidateResources(["expenses"]);
    } catch (e) { actionError = (e as Error).message; }
  }

  async function updateExpense(
    id: number,
    patch: Partial<Pick<Expense, "label" | "amountDollars" | "frequency" | "categoryId">> & { spendDate?: string | null },
  ): Promise<void> {
    if (!ws.activeId) return;
    try {
      // update_expense schema also rejects categoryId: null. Strip null fields —
      // except spendDate, where null is a meaningful "clear the date".
      const cleaned: Record<string, unknown> = { id };
      for (const [k, v] of Object.entries(patch)) {
        if (k === "spendDate") { cleaned[k] = v ?? null; continue; }
        if (v !== null && v !== undefined) cleaned[k] = v;
      }
      await api.updateExpense(cleaned as Parameters<typeof api.updateExpense>[0]);
      await reload(ws.activeId);
      invalidateResources(["expenses"]);
    } catch (e) { actionError = (e as Error).message; }
  }

  async function addSavings(): Promise<void> {
    if (!ws.activeId) return;
    const balance = newSavBalance.trim() ? parseDollars(newSavBalance) : 0;
    const monthly = newSavMonthly.trim() ? parseDollars(newSavMonthly) : 0;
    if (!newSavLabel.trim() || balance === null || monthly === null) {
      actionError = "Need label + valid dollar amounts"; return;
    }
    // Optional 401k knobs — parse only when filled in. Pct is entered as
    // a percentage (e.g. "15" → 0.15); employer match value is entered as
    // either a percentage (when kind=pct_of_salary) or a dollar amount
    // (when kind=flat_annual_dollars).
    const pctNum = newSavPct.trim() ? Number(newSavPct) : NaN;
    const matchNum = newSavMatchValue.trim() ? Number(newSavMatchValue) : NaN;
    const payload: Parameters<typeof api.addSavings>[0] = {
      workspaceId: ws.activeId,
      label: newSavLabel.trim(),
      currentBalanceDollars: balance,
      monthlyContributionDollars: monthly,
      accountType: newSavType,
      filingRole: newSavRole,
    };
    if (Number.isFinite(pctNum)) {
      payload.contributionPctOfSalary = Math.max(0, Math.min(1, pctNum / 100));
    }
    if (newSavMatchKind !== "none") {
      payload.employerMatchKind = newSavMatchKind;
      if (Number.isFinite(matchNum)) {
        payload.employerMatchValue =
          newSavMatchKind === "pct_of_salary"
            ? Math.max(0, Math.min(1, matchNum / 100))
            : round2(matchNum); // annual dollars
      }
    }
    actionError = null;
    try {
      await api.addSavings(payload);
      newSavLabel = ""; newSavBalance = ""; newSavMonthly = ""; newSavType = "hysa";
      newSavRole = "primary"; newSavPct = ""; newSavMatchKind = "none"; newSavMatchValue = "";
      await reload(ws.activeId);
      invalidateResources(["savings", "takeHome", "retirement"]);
    } catch (e) { actionError = (e as Error).message; }
  }

  async function deleteSavings(id: number): Promise<void> {
    if (!ws.activeId) return;
    try {
      await api.deleteSavings(id);
      await reload(ws.activeId);
      invalidateResources(["savings", "takeHome", "retirement"]);
    } catch (e) { actionError = (e as Error).message; }
  }

  async function updateSavings(id: number, patch: Partial<SavingsItem>): Promise<void> {
    if (!ws.activeId) return;
    try {
      await api.updateSavings({ id, ...patch });
      await reload(ws.activeId);
      invalidateResources(["savings", "takeHome", "retirement"]);
    } catch (e) { actionError = (e as Error).message; }
  }

  // ── Duplicate cleanup (two-step: preview, then explicit removal) ──────
  let dedupBusy = $state(false);
  let dedupPreview = $state<DedupeResult | null>(null);
  let dedupNotice = $state<string | null>(null);

  async function findDuplicates(): Promise<void> {
    if (!ws.activeId) return;
    dedupBusy = true;
    dedupNotice = null;
    dedupPreview = null;
    try {
      const r = await api.dedupeExpenses({ workspaceId: ws.activeId, dryRun: true });
      if (r.duplicateCount === 0) {
        dedupNotice = "No duplicate budget items found.";
      } else {
        dedupPreview = r;
      }
    } catch (e) { actionError = (e as Error).message; }
    finally { dedupBusy = false; }
  }

  async function removeDuplicates(): Promise<void> {
    if (!ws.activeId || !dedupPreview) return;
    dedupBusy = true;
    try {
      const r = await api.dedupeExpenses({ workspaceId: ws.activeId });
      dedupNotice = `Removed ${r.removed} duplicate item${r.removed === 1 ? "" : "s"} (kept the oldest of each group).`;
      dedupPreview = null;
      await reload(ws.activeId);
      invalidateResources(["expenses"]);
    } catch (e) { actionError = (e as Error).message; }
    finally { dedupBusy = false; }
  }

  const wsName = $derived(ws.list.find((w) => w.id === ws.activeId)?.name ?? "—");
  const hasActiveFilters = $derived(
    expenseSearch.trim() !== "" ||
      expenseCategoryFilter !== null ||
      expenseFreqFilter !== null ||
      expenseDateFrom !== "" ||
      expenseDateTo !== "" ||
      expenseCostMin !== null ||
      expenseCostMax !== null
  );

  function clearFilters() {
    expenseSearch = "";
    expenseCategoryFilter = null;
    expenseFreqFilter = null;
    expenseDateFrom = "";
    expenseDateTo = "";
    expenseCostMin = null;
    expenseCostMax = null;
  }
</script>

<article class="ed-article">
  <PageHead
    section="Section II"
    kicker="The Ledger"
    title="Budget"
    rightLabel={wsName}
    byline="Every line you spend on, with its origin (statement / baseline / manual) shown alongside."
  />

  {#if actionError}
    <div class="bk-error-banner" data-testid="action-error" role="alert">
      <span><strong>Action failed.</strong>{actionError}</span>
    </div>
  {/if}
  {#if incomesError}
    <div class="bk-error-banner" data-testid="incomes-error" role="alert">
      <span><strong>Couldn't refresh incomes.</strong>{incomesError}</span>
    </div>
  {/if}
  {#if expensesError}
    <div class="bk-error-banner" data-testid="expenses-error" role="alert">
      <span><strong>Couldn't refresh expenses.</strong>{expensesError}</span>
    </div>
  {/if}
  {#if savingsError}
    <div class="bk-error-banner" data-testid="savings-error" role="alert">
      <span><strong>Couldn't refresh savings.</strong>{savingsError}</span>
    </div>
  {/if}

  {#if loading}
    <p class="bk-text" data-testid="loading">Loading…</p>
  {:else}
    <EdSection
      num={1}
      title="Incomes"
      deck="Gross annual figures, tax disposition, and filing role. Pretax buckets shrink the federal base before tax is computed."
    >
      <table class="bk-table" data-testid="incomes-table">
        <thead>
          <tr><th>Label</th><th>Role</th><th>Status</th><th class="bk-cell-num">Gross / year</th><th></th></tr>
        </thead>
        <tbody>
          {#each incomes as inc (inc.id)}
            <tr data-testid={`income-row-${inc.id}`}>
              <td>
                <CellEdit
                  value={inc.label}
                  ariaLabel={`Label for ${inc.label}`}
                  testid={`income-label-${inc.id}`}
                  onCommit={(v) => void updateIncome(inc.id, { label: v })}
                />
              </td>
              <td>
                <select
                  class="bk-select"
                  style="height: 26px"
                  value={inc.filingRole}
                  onchange={(e) => {
                    const v = (e.currentTarget as HTMLSelectElement).value as "primary" | "spouse";
                    void updateIncome(inc.id, { filingRole: v });
                  }}
                  aria-label={`Role for ${inc.label}`}
                >
                  <option value="primary">primary</option>
                  <option value="spouse">spouse</option>
                </select>
              </td>
              <td>
                <select
                  class="bk-select"
                  style="height: 26px"
                  value={inc.taxStatus}
                  onchange={(e) => {
                    const v = (e.currentTarget as HTMLSelectElement).value as Income["taxStatus"];
                    void updateIncome(inc.id, { taxStatus: v, isFederalIncomeTax: v === "taxed" });
                  }}
                  aria-label={`Tax status for ${inc.label}`}
                >
                  <option value="taxed">taxed (W-2)</option>
                  <option value="pretax">pretax</option>
                  <option value="posttax">posttax</option>
                  <option value="untaxable">untaxable</option>
                </select>
              </td>
              <td class="bk-cell-num">
                <CellEdit
                  value={inc.grossAnnualDollars.toFixed(2)}
                  display={formatDollars(inc.grossAnnualDollars)}
                  ariaLabel={`Gross annual for ${inc.label}`}
                  testid={`income-amount-${inc.id}`}
                  onCommit={(v) => {
                    const c = parseDollars(v);
                    if (c !== null) void updateIncome(inc.id, { grossAnnualDollars: c });
                  }}
                />
              </td>
              <td style="text-align: right">
                <button
                  type="button"
                  class="bk-iconbtn"
                  aria-label={`Delete ${inc.label}`}
                  data-testid={`delete-income-${inc.id}`}
                  onclick={() => void deleteIncome(inc.id)}
                ><Icon name="trash" size={14} /></button>
              </td>
            </tr>
          {/each}
          {#if incomes.length === 0}
            <tr><td colspan="5" style="padding: 24px; text-align: center; color: var(--text-3); font-style: italic">No incomes yet — add one below.</td></tr>
          {/if}
        </tbody>
        <tfoot>
          <tr style="background: var(--surface-2)">
            <td>
              <input
                class="bk-input"
                data-testid="new-income-label"
                bind:value={newIncLabel}
                placeholder="Salary — Acme"
                aria-label="New income label"
              />
            </td>
            <td>
              <select
                class="bk-select"
                data-testid="new-income-role"
                bind:value={newIncRole}
                aria-label="New income role"
                style="height: 30px"
              >
                <option value="primary">primary</option>
                <option value="spouse">spouse</option>
              </select>
            </td>
            <td>
              <select
                class="bk-select"
                data-testid="new-income-status"
                bind:value={newIncStatus}
                aria-label="New income tax status"
                style="height: 30px"
              >
                <option value="taxed">taxed (W-2)</option>
                <option value="pretax">pretax</option>
                <option value="posttax">posttax</option>
                <option value="untaxable">untaxable</option>
              </select>
            </td>
            <td>
              <input
                class="bk-input"
                data-testid="new-income-amount"
                bind:value={newIncDollars}
                placeholder="120000"
                style="text-align: right"
                aria-label="New income annual gross"
              />
            </td>
            <td>
              <button
                type="button"
                class="bk-btn bk-btn-primary bk-btn-sm"
                data-testid="add-income-btn"
                disabled={!newIncLabel.trim() || !newIncDollars.trim()}
                onclick={addIncome}
              ><Icon name="plus" size={12} /> Add</button>
            </td>
          </tr>
          <tr style="background: var(--surface-2)">
            <td colspan="3" style="font-style: italic; color: var(--text-2)">
              Total annual gross<FootnoteRef topic="income-total" n={FN["income-total"]} onopen={openFootnote} />
            </td>
            <td class="bk-cell-num"><span class="bk-num" style="font-weight: 600">{formatDollars(totalGrossAnnual)}</span></td>
            <td></td>
          </tr>
        </tfoot>
      </table>
    </EdSection>

    <PullQuote attribution="On marginal optimization">
      "Pretax buckets — 401k, HSA — leave the paycheck but lower the base. They are saved twice."
    </PullQuote>

    <EdSection
      num={2}
      title="Expenses"
      deck={`${filteredExpenses.length} of ${expenses.length} lines shown · ${formatDollarsWhole(filteredMonthly)} per month (frequency-converted)`}
    >
      <div class="bk-cta-strip" data-testid="expenses-import-cta">
        <span class="bk-text bk-text-3" style="flex: 1">
          Browse, preview, and import Chase / Amex statements on the Import tab.
        </span>
        <button
          type="button"
          class="bk-btn bk-btn-sm"
          data-testid="dedupe-find-btn"
          disabled={dedupBusy}
          onclick={() => void findDuplicates()}
          title="Scan this workspace for budget items with identical name, cost, frequency, and spend date"
        >
          {dedupBusy ? "Scanning…" : "Find duplicates"}
        </button>
        <a
          class="bk-btn bk-btn-primary bk-btn-sm"
          href="/library"
          data-testid="import-statements-btn"
        >
          <Icon name="plus" size={12} /> Import statements
        </a>
      </div>
      {#if dedupNotice}
        <div class="bk-progress-banner" role="status" data-testid="dedupe-notice">{dedupNotice}</div>
      {/if}
      {#if dedupPreview}
        <div
          class="bk-progress-banner"
          style="border-left-color: var(--warning); background: color-mix(in oklab, var(--warning) 6%, var(--surface))"
          role="status"
          data-testid="dedupe-preview"
        >
          <div style="flex: 1">
            <strong>{dedupPreview.duplicateCount}</strong> duplicate item{dedupPreview.duplicateCount === 1 ? "" : "s"}
            across <strong>{dedupPreview.groupCount}</strong> group{dedupPreview.groupCount === 1 ? "" : "s"}:
            {dedupPreview.groups.slice(0, 5).map((g) => `${g.label} (${g.removeIds.length}×)`).join(", ")}{dedupPreview.groups.length > 5 ? ", …" : ""}
            — removing keeps the oldest copy of each.
          </div>
          <button
            type="button"
            class="bk-btn bk-btn-sm"
            data-testid="dedupe-remove-btn"
            disabled={dedupBusy}
            onclick={() => void removeDuplicates()}
          >
            Remove duplicates
          </button>
          <button
            type="button"
            class="bk-btn bk-btn-sm"
            data-testid="dedupe-cancel-btn"
            onclick={() => { dedupPreview = null; }}
          >
            Keep everything
          </button>
        </div>
      {/if}
      <div class="bk-toolbar">
        <div class="bk-search">
          <Icon name="search" size={14} />
          <input
            class="bk-input"
            data-testid="expense-search"
            bind:value={expenseSearch}
            placeholder="Search expenses…"
            aria-label="Search expenses"
          />
        </div>
        <select
          class="bk-select"
          data-testid="expense-category-filter"
          value={expenseCategoryFilter ?? ""}
          onchange={(e) => {
            const v = (e.currentTarget as HTMLSelectElement).value;
            expenseCategoryFilter = v ? Number(v) : null;
          }}
          aria-label="Filter by category"
        >
          <option value="">All categories</option>
          {#each CATEGORIES as c (c.id)}
            <option value={c.id}>{c.name}</option>
          {/each}
        </select>
        <select
          class="bk-select"
          data-testid="expense-freq-filter"
          value={expenseFreqFilter ?? ""}
          onchange={(e) => {
            const v = (e.currentTarget as HTMLSelectElement).value as Frequency | "";
            expenseFreqFilter = v || null;
          }}
          aria-label="Filter by frequency"
        >
          <option value="">All frequencies</option>
          {#each (["weekly", "biweekly", "monthly", "quarterly", "annually", "one_time"] as Frequency[]) as f (f)}
            <option value={f}>{f}</option>
          {/each}
        </select>
        <div class="bk-filter-group" aria-label="Filter by date added">
          <span class="bk-filter-label">Added</span>
          <input
            type="date"
            class="bk-input bk-input-sm"
            data-testid="expense-date-from"
            bind:value={expenseDateFrom}
            aria-label="Filter expenses added on or after"
          />
          <span class="bk-filter-sep">→</span>
          <input
            type="date"
            class="bk-input bk-input-sm"
            data-testid="expense-date-to"
            bind:value={expenseDateTo}
            aria-label="Filter expenses added on or before"
          />
        </div>
        <div class="bk-filter-group" aria-label="Filter by amount">
          <span class="bk-filter-label">Cost</span>
          <input
            type="number"
            inputmode="decimal"
            step="0.01"
            min="0"
            class="bk-input bk-input-sm"
            data-testid="expense-cost-min"
            bind:value={expenseCostMin}
            placeholder="Min"
            style="width: 6em"
            aria-label="Filter expenses by minimum amount"
          />
          <span class="bk-filter-sep">→</span>
          <input
            type="number"
            inputmode="decimal"
            step="0.01"
            min="0"
            class="bk-input bk-input-sm"
            data-testid="expense-cost-max"
            bind:value={expenseCostMax}
            placeholder="Max"
            style="width: 6em"
            aria-label="Filter expenses by maximum amount"
          />
        </div>
        <div class="bk-filter-group" aria-label="Sort expenses">
          <span class="bk-filter-label">Sort</span>
          <select
            class="bk-select"
            data-testid="expense-sort-key"
            bind:value={expenseSortKey}
            aria-label="Sort expenses by"
            style="height: 30px"
          >
            <option value="label">Label</option>
            <option value="amount">Amount</option>
            <option value="monthly">Monthly</option>
            <option value="category">Category</option>
          </select>
          <button
            type="button"
            class="bk-btn bk-btn-sm"
            data-testid="expense-sort-dir"
            aria-label={expenseSortDir === "asc" ? "Sort ascending" : "Sort descending"}
            title={expenseSortDir === "asc" ? "Ascending — click for descending" : "Descending — click for ascending"}
            onclick={() => (expenseSortDir = expenseSortDir === "asc" ? "desc" : "asc")}
          >{expenseSortDir === "asc" ? "↑" : "↓"}</button>
        </div>
        <button
          type="button"
          class="bk-btn bk-btn-sm"
          class:bk-btn-primary={groupByMerchant}
          aria-pressed={groupByMerchant}
          data-testid="expense-group-merchant"
          title="Group same-merchant lines into one collapsible row (view only — your expenses aren't changed)"
          onclick={() => (groupByMerchant = !groupByMerchant)}
        >Group by merchant</button>
        {#if groupByMerchant}
          <button type="button" class="bk-btn bk-btn-sm bk-btn-ghost" data-testid="expense-expand-all" onclick={expandAllMerchants}>Expand all</button>
          <button type="button" class="bk-btn bk-btn-sm bk-btn-ghost" data-testid="expense-collapse-all" onclick={collapseAllMerchants}>Collapse all</button>
        {/if}
        {#if hasActiveFilters}
          <Chip onclick={clearFilters}>Clear <Icon name="close" size={12} /></Chip>
        {/if}
      </div>

      <table class="bk-table" data-testid="expenses-table">
        <thead>
          <tr>
            <th>Label</th>
            <th>Category</th>
            <th>Source</th>
            <th>Frequency</th>
            <th class="bk-cell-num">Amount</th>
            <th class="bk-cell-num">
              Monthly<FootnoteRef topic="freq-conversion" n={FN["freq-conversion"]} onopen={openFootnote} />
            </th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#snippet expenseRow(exp: Expense)}
            {@const monthly = freqToMonthlyDollars(exp.amountDollars, exp.frequency)}
            <tr data-testid={`expense-row-${exp.id}`}>
              <td>
                <CellEdit
                  value={exp.label}
                  ariaLabel={`Label for ${exp.label}`}
                  testid={`expense-label-${exp.id}`}
                  onCommit={(v) => void updateExpense(exp.id, { label: v })}
                />
              </td>
              <td>
                <select
                  class="bk-select"
                  style="height: 26px"
                  value={exp.categoryId ?? ""}
                  onchange={(e) => {
                    const v = (e.currentTarget as HTMLSelectElement).value;
                    void updateExpense(exp.id, { categoryId: v ? Number(v) : null });
                  }}
                  aria-label={`Category for ${exp.label}`}
                >
                  <option value="">—</option>
                  {#each CATEGORIES as c (c.id)}
                    <option value={c.id}>{c.name}</option>
                  {/each}
                </select>
              </td>
              <td><Badge source={exp.source}>{exp.source}</Badge></td>
              <td>
                <select
                  class="bk-select"
                  style="height: 26px"
                  value={exp.frequency}
                  onchange={(e) => {
                    const v = (e.currentTarget as HTMLSelectElement).value as Frequency;
                    void updateExpense(exp.id, v === "one_time" ? { frequency: v } : { frequency: v, spendDate: null });
                  }}
                  aria-label={`Frequency for ${exp.label}`}
                >
                  {#each (["weekly", "biweekly", "monthly", "quarterly", "annually", "one_time"] as Frequency[]) as f (f)}
                    <option value={f}>{f}</option>
                  {/each}
                </select>
              </td>
              <td class="bk-cell-num">
                <CellEdit
                  value={exp.amountDollars.toFixed(2)}
                  display={formatDollars(exp.amountDollars)}
                  ariaLabel={`Amount for ${exp.label}`}
                  testid={`expense-amount-${exp.id}`}
                  onCommit={(v) => {
                    const c = parseDollars(v);
                    if (c !== null) void updateExpense(exp.id, { amountDollars: c });
                  }}
                />
              </td>
              <td class="bk-cell-num">
                {#if exp.frequency === "one_time"}
                  <input
                    type="date"
                    class="bk-input"
                    style="height: 26px; padding: 0 4px"
                    value={exp.spendDate ?? ""}
                    aria-label={`Spend date for ${exp.label}`}
                    data-testid={`expense-date-${exp.id}`}
                    onchange={(e) => void updateExpense(exp.id, { spendDate: (e.currentTarget as HTMLInputElement).value || null })}
                  />
                {:else}
                  <span class="bk-text-3 bk-num">{formatDollars(monthly)}</span>
                {/if}
              </td>
              <td style="text-align: right">
                <button
                  type="button"
                  class="bk-iconbtn"
                  aria-label={`Delete ${exp.label}`}
                  data-testid={`delete-expense-${exp.id}`}
                  onclick={() => void deleteExpense(exp.id)}
                ><Icon name="trash" size={14} /></button>
              </td>
            </tr>
          {/snippet}
          {#if groupByMerchant}
            {#each merchantGroups as g (g.key)}
              {#if g.members.length > 1}
                <tr class="bk-mgroup" data-testid={`merchant-group-${g.key}`}>
                  <td>
                    <button
                      type="button"
                      class="bk-mgroup-toggle"
                      aria-expanded={expandedMerchants.has(g.key)}
                      data-testid={`merchant-toggle-${g.key}`}
                      onclick={() => toggleMerchant(g.key)}
                    >
                      <span class="bk-mgroup-caret" aria-hidden="true">{expandedMerchants.has(g.key) ? "▾" : "▸"}</span>
                      <span class="bk-mgroup-label">{g.label}</span>
                      <span class="bk-text-3" style="font-weight: 400">· {g.members.length} lines</span>
                    </button>
                  </td>
                  <td></td>
                  <td></td>
                  <td></td>
                  <td class="bk-cell-num"><span class="bk-text-3 bk-num">{formatDollars(g.total)}</span></td>
                  <td class="bk-cell-num"><span class="bk-num" title="Continuous monthly run-rate: recurring at their monthly rate; one-time amortized over 12 months">{formatDollars(g.monthlyAvg)}</span></td>
                  <td></td>
                </tr>
                {#if expandedMerchants.has(g.key)}
                  {#each g.members as exp (exp.id)}
                    {@render expenseRow(exp)}
                  {/each}
                {/if}
              {:else}
                {@render expenseRow(g.members[0]!)}
              {/if}
            {/each}
          {:else}
            {#each sortedExpenses as exp (exp.id)}
              {@render expenseRow(exp)}
            {/each}
          {/if}
          {#if filteredExpenses.length === 0}
            <tr>
              <td colspan="7" style="padding: 32px; text-align: center; color: var(--text-3); font-style: italic">
                {expenses.length === 0
                  ? "Nothing here yet. Add a line below."
                  : "No lines match these filters."}
              </td>
            </tr>
          {/if}
        </tbody>
        <tfoot>
          <tr style="background: var(--surface-2)">
            <td>
              <input
                class="bk-input"
                data-testid="new-expense-label"
                bind:value={newExpLabel}
                placeholder="Rent, Spotify, …"
                aria-label="New expense label"
              />
            </td>
            <td>
              <select class="bk-select" bind:value={newExpCat} aria-label="New expense category" style="height: 30px">
                <option value="">—</option>
                {#each CATEGORIES as c (c.id)}
                  <option value={c.id}>{c.name}</option>
                {/each}
              </select>
            </td>
            <td><Badge source="manual">manual</Badge></td>
            <td>
              <select
                class="bk-select"
                data-testid="new-expense-freq"
                bind:value={newExpFreq}
                aria-label="New expense frequency"
                style="height: 30px"
              >
                {#each (["weekly", "biweekly", "monthly", "quarterly", "annually", "one_time"] as Frequency[]) as f (f)}
                  <option value={f}>{f}</option>
                {/each}
              </select>
            </td>
            <td>
              <input
                class="bk-input"
                data-testid="new-expense-amount"
                bind:value={newExpDollars}
                placeholder="1850"
                style="text-align: right"
                aria-label="New expense amount"
              />
            </td>
            <td>
              {#if newExpFreq === "one_time"}
                <input
                  type="date"
                  class="bk-input"
                  data-testid="new-expense-date"
                  bind:value={newExpSpendDate}
                  aria-label="New one-time expense date"
                  style="height: 30px"
                />
              {/if}
            </td>
            <td>
              <button
                type="button"
                class="bk-btn bk-btn-primary bk-btn-sm"
                data-testid="add-expense-btn"
                disabled={!newExpLabel.trim() || !newExpDollars.trim()}
                onclick={addExpense}
              ><Icon name="plus" size={12} /> Add</button>
            </td>
          </tr>
        </tfoot>
      </table>
    </EdSection>

    <EdSection
      num={3}
      title="Annual fees"
      deck={`${annualFees.length} annual-cadence charge${annualFees.length === 1 ? "" : "s"} totaling ${formatDollarsWhole(totalAnnualFees)} per year — each pro-rated to monthly below.`}
    >
      {#if annualFees.length === 0}
        <p class="bk-text">No annual-cadence lines yet. They'll surface here once you mark a line as annually-recurring (or once statement import seeds them in M11).</p>
      {:else}
        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px">
          {#each annualFees as f (f.id)}
            {@const cat = categoryById(f.categoryId)}
            <div class="bk-card ed-bordered" style="display: flex; flex-direction: column; gap: 6px">
              <div class="bk-eyebrow" style="display: flex; gap: 6px; align-items: center">
                {#if cat}<span class="bk-cat-dot" style:background={cat.color}></span>{/if}
                {cat?.name ?? "Uncategorized"}
              </div>
              <div style="font-family: var(--font-display); font-size: 17px; font-weight: 500">{f.label}</div>
              <div class="bk-num" style="font-size: 22px; font-weight: 600; letter-spacing: -0.02em">{formatDollars(f.amountDollars)}</div>
              <div class="bk-text-3" style="font-size: 11px">
                = {formatDollars(round2(f.amountDollars / 12))} / month pro-rated<FootnoteRef topic="pro-rated" n={FN["pro-rated"]} onopen={openFootnote} />
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </EdSection>

    <EdSection
      num={4}
      title="Savings & investments"
      deck="HYSA, brokerage, 401k, Roth IRA, HSA — anything where money accumulates instead of leaves."
    >
      <table class="bk-table bk-table-savings" data-testid="savings-table">
        <colgroup>
          <col class="col-account" />
          <col class="col-type" />
          <col class="col-balance" />
          <col class="col-emp" />
          <col class="col-pct" />
          <col class="col-match" />
          <col class="col-monthly" />
          <col class="col-annual" />
          <col class="col-del" />
        </colgroup>
        <thead>
          <tr>
            <th>Account</th>
            <th>Type</th>
            <th class="bk-cell-num">Current balance</th>
            <th class="bk-cell-num">Employee $/mo</th>
            <th class="bk-cell-num">% of salary</th>
            <th>Employer match</th>
            <th class="bk-cell-num">Monthly add (eff.)</th>
            <th class="bk-cell-num">
              Annualized<FootnoteRef topic="annualized-savings" n={FN["annualized-savings"]} onopen={openFootnote} />
            </th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each savings as s (s.id)}
            {@const usingPct = s.contributionPctOfSalary !== null && s.contributionPctOfSalary !== 0}
            {@const effMonthly = effectiveMonthlyDollars(s)}
            <tr data-testid={`savings-row-${s.id}`}>
              <td style="font-family: var(--font-display); font-size: 15px">
                {s.label}
                <select
                  class="bk-select"
                  style="height: 22px; margin-top: 4px; font-size: 11px; display: block"
                  value={s.filingRole}
                  data-testid={`savings-role-${s.id}`}
                  onchange={(e) => {
                    const v = (e.currentTarget as HTMLSelectElement).value as "primary" | "spouse";
                    void updateSavings(s.id, { filingRole: v });
                  }}
                  aria-label={`Owner for ${s.label}`}
                  title="Which filer owns this account — spouse-owned 401k/Roth feed the spouse leg of take-home"
                >
                  <option value="primary">primary</option>
                  <option value="spouse">spouse</option>
                </select>
              </td>
              <td>
                <Badge>{s.accountType.replace(/_/g, " ")}</Badge>
                <select
                  class="bk-select"
                  style="height: 22px; margin-top: 4px; font-size: 11px; display: block"
                  value={resolveTreatment(s)}
                  data-testid={`savings-treatment-${s.id}`}
                  onchange={(e) => void updateSavings(s.id, { taxTreatment: (e.currentTarget as HTMLSelectElement).value as TaxTreatment })}
                  aria-label={`Tax treatment for ${s.label}`}
                  title={s.taxTreatment ? "Tax treatment (overridden — affects take-home)" : "Tax treatment, derived from account type. Change to override how it affects take-home."}
                >
                  <option value="payroll_pretax">Pre-tax payroll</option>
                  <option value="payroll_posttax">Roth payroll</option>
                  <option value="from_cash">From take-home</option>
                </select>
              </td>
              <td class="bk-cell-num">
                <CellEdit
                  value={s.currentBalanceDollars.toFixed(2)}
                  display={formatDollars(s.currentBalanceDollars)}
                  ariaLabel={`Balance for ${s.label}`}
                  testid={`savings-balance-${s.id}`}
                  onCommit={(v) => {
                    const c = parseDollars(v);
                    if (c !== null) void updateSavings(s.id, { currentBalanceDollars: c });
                  }}
                />
              </td>
              <td class="bk-cell-num">
                {#if usingPct}
                  <span class="bk-num bk-text-3" title="Overridden by % of salary">{formatDollars(s.monthlyContributionDollars)}</span>
                {:else}
                  <CellEdit
                    value={s.monthlyContributionDollars.toFixed(2)}
                    display={formatDollars(s.monthlyContributionDollars)}
                    ariaLabel={`Monthly for ${s.label}`}
                    testid={`savings-monthly-${s.id}`}
                    onCommit={(v) => {
                      const c = parseDollars(v);
                      if (c !== null) void updateSavings(s.id, { monthlyContributionDollars: c });
                    }}
                  />
                {/if}
              </td>
              <td class="bk-cell-num">
                <CellEdit
                  value={s.contributionPctOfSalary === null ? "" : (s.contributionPctOfSalary * 100).toFixed(2)}
                  display={s.contributionPctOfSalary === null || s.contributionPctOfSalary === 0
                    ? "—"
                    : `${(s.contributionPctOfSalary * 100).toFixed(2)}%`}
                  ariaLabel={`Percent of salary for ${s.label}`}
                  testid={`savings-pct-${s.id}`}
                  onCommit={(v) => {
                    const trimmed = v.trim();
                    if (trimmed === "") {
                      // Clear back to dollar-mode by setting pct to 0.
                      void updateSavings(s.id, { contributionPctOfSalary: 0 });
                      return;
                    }
                    const n = Number(trimmed.replace(/%/g, ""));
                    if (Number.isFinite(n)) {
                      void updateSavings(s.id, {
                        contributionPctOfSalary: Math.max(0, Math.min(1, n / 100)),
                      });
                    }
                  }}
                />
              </td>
              <td>
                <div style="display: flex; gap: 4px; align-items: center">
                  <select
                    class="bk-select"
                    style="height: 26px"
                    value={s.employerMatchKind}
                    onchange={(e) => {
                      const v = (e.currentTarget as HTMLSelectElement).value as EmployerMatchKind;
                      // Reset value when switching to/from 'none' so the
                      // editor's interpretation stays consistent.
                      const patch: Parameters<typeof api.updateSavings>[0] = {
                        id: s.id,
                        employerMatchKind: v,
                      };
                      if (v === "none") patch.employerMatchValue = null;
                      void updateSavings(s.id, patch);
                    }}
                    aria-label={`Employer match kind for ${s.label}`}
                    data-testid={`savings-match-kind-${s.id}`}
                  >
                    <option value="none">none</option>
                    <option value="pct_of_salary">% of salary</option>
                    <option value="flat_annual_dollars">$/year</option>
                  </select>
                  {#if s.employerMatchKind !== "none"}
                    <CellEdit
                      value={s.employerMatchValue === null
                        ? ""
                        : s.employerMatchKind === "pct_of_salary"
                          ? (s.employerMatchValue * 100).toFixed(2)
                          : s.employerMatchValue.toFixed(2)}
                      display={s.employerMatchValue === null
                        ? "—"
                        : s.employerMatchKind === "pct_of_salary"
                          ? `${(s.employerMatchValue * 100).toFixed(2)}%`
                          : formatDollars(s.employerMatchValue)}
                      ariaLabel={`Employer match value for ${s.label}`}
                      testid={`savings-match-value-${s.id}`}
                      onCommit={(v) => {
                        const trimmed = v.trim();
                        if (trimmed === "") {
                          void updateSavings(s.id, { employerMatchValue: null });
                          return;
                        }
                        const n = Number(trimmed.replace(/[$,%\s]/g, ""));
                        if (!Number.isFinite(n)) return;
                        const stored =
                          s.employerMatchKind === "pct_of_salary"
                            ? Math.max(0, Math.min(1, n / 100))
                            : round2(n);
                        void updateSavings(s.id, { employerMatchValue: stored });
                      }}
                    />
                  {/if}
                </div>
              </td>
              <td class="bk-cell-num">
                <span
                  class="bk-num"
                  style="font-weight: 600"
                  data-testid={`savings-eff-monthly-${s.id}`}
                >{formatDollarsWhole(effMonthly)}</span>
              </td>
              <td class="bk-cell-num"><span class="bk-num bk-text-3">{formatDollarsWhole(effMonthly * 12)}</span></td>
              <td style="text-align: right">
                <button
                  type="button"
                  class="bk-iconbtn"
                  aria-label={`Delete ${s.label}`}
                  data-testid={`delete-savings-${s.id}`}
                  onclick={() => void deleteSavings(s.id)}
                ><Icon name="trash" size={14} /></button>
              </td>
            </tr>
          {/each}
          {#if savings.length === 0}
            <tr><td colspan="9" style="padding: 24px; text-align: center; color: var(--text-3); font-style: italic">No savings accounts yet — add one below.</td></tr>
          {/if}
        </tbody>
        <tfoot>
          <tr style="background: var(--surface-2)">
            <td>
              <input
                class="bk-input"
                data-testid="new-savings-label"
                bind:value={newSavLabel}
                placeholder="Emergency HYSA"
                aria-label="New savings label"
              />
            </td>
            <td>
              <select
                class="bk-select"
                data-testid="new-savings-type"
                bind:value={newSavType}
                aria-label="New savings type"
                style="height: 30px"
              >
                <option value="hysa">hysa</option>
                <option value="brokerage">brokerage</option>
                <option value="roth_ira">roth_ira</option>
                <option value="traditional_401k">traditional_401k</option>
                <option value="roth_401k">roth_401k</option>
                <option value="hsa">hsa</option>
                <option value="other">other</option>
              </select>
              <select
                class="bk-select"
                data-testid="new-savings-role"
                bind:value={newSavRole}
                aria-label="New savings owner"
                style="height: 22px; margin-top: 4px; font-size: 11px; display: block"
              >
                <option value="primary">primary</option>
                <option value="spouse">spouse</option>
              </select>
            </td>
            <td>
              <input
                class="bk-input"
                data-testid="new-savings-balance"
                bind:value={newSavBalance}
                placeholder="$10000"
                style="text-align: right"
                aria-label="New savings balance"
              />
            </td>
            <td>
              <input
                class="bk-input"
                data-testid="new-savings-monthly"
                bind:value={newSavMonthly}
                placeholder="$500"
                style="text-align: right"
                aria-label="New savings monthly"
              />
            </td>
            <td>
              <input
                class="bk-input"
                data-testid="new-savings-pct"
                bind:value={newSavPct}
                placeholder="15"
                style="text-align: right"
                aria-label="New savings % of salary"
              />
            </td>
            <td>
              <div style="display: flex; gap: 4px; align-items: center">
                <select
                  class="bk-select"
                  data-testid="new-savings-match-kind"
                  bind:value={newSavMatchKind}
                  aria-label="New savings employer match kind"
                  style="height: 30px"
                >
                  <option value="none">none</option>
                  <option value="pct_of_salary">% of salary</option>
                  <option value="flat_annual_dollars">$/year</option>
                </select>
                {#if newSavMatchKind !== "none"}
                  <input
                    class="bk-input"
                    data-testid="new-savings-match-value"
                    bind:value={newSavMatchValue}
                    placeholder={newSavMatchKind === "pct_of_salary" ? "5" : "$3000"}
                    style="text-align: right; width: 7em"
                    aria-label="New savings employer match value"
                  />
                {/if}
              </div>
            </td>
            <td></td>
            <td></td>
            <td>
              <button
                type="button"
                class="bk-btn bk-btn-primary bk-btn-sm"
                data-testid="add-savings-btn"
                disabled={!newSavLabel.trim()}
                onclick={addSavings}
              ><Icon name="plus" size={12} /> Add</button>
            </td>
          </tr>
          {#if savings.length > 0}
            <tr style="background: var(--surface-2)">
              <td colspan="2" style="font-style: italic; color: var(--text-2)">Total holdings</td>
              <td class="bk-cell-num">
                <span class="bk-num" style="font-weight: 600">{formatDollarsWhole(savings.reduce((s, x) => s + x.currentBalanceDollars, 0))}</span>
                <FootnoteRef topic="savings-balance-total" n={FN["savings-balance-total"]} onopen={openFootnote} />
              </td>
              <td class="bk-cell-num">
                <span class="bk-num" style="font-weight: 600">{formatDollarsWhole(savings.reduce((s, x) => s + effectiveMonthlyDollars(x), 0))}</span>
                <FootnoteRef topic="savings-monthly-total" n={FN["savings-monthly-total"]} onopen={openFootnote} />
              </td>
              <td></td>
              <td></td>
              <td class="bk-cell-num">
                <span class="bk-num" style="font-weight: 600">{formatDollarsWhole(savings.reduce((s, x) => s + effectiveMonthlyDollars(x), 0))}</span>
              </td>
              <td class="bk-cell-num">
                <span class="bk-num" style="font-weight: 600">{formatDollarsWhole(savings.reduce((s, x) => s + effectiveMonthlyDollars(x) * 12, 0))}</span>
                <FootnoteRef topic="savings-annualized-total" n={FN["savings-annualized-total"]} onopen={openFootnote} />
              </td>
              <td></td>
            </tr>
          {/if}
        </tfoot>
      </table>
    </EdSection>

    <div class="ed-footnotes" data-testid="footnotes">
      <div><b>[{FN["income-total"]}] Total annual gross.</b> Σ income.grossAnnualDollars — every row in this table, regardless of tax status.</div>
      <div><b>[{FN["monthly-expenses"]}] Monthly (deck total).</b> Sum of every expense row's amount converted to monthly via the frequency rule.</div>
      <div><b>[{FN["freq-conversion"]}] Monthly column.</b> weekly × 52/12 · biweekly × 26/12 · monthly × 1 · quarterly ÷ 3 · annually ÷ 12 · one_time = 0.</div>
      <div><b>[{FN["annual-fees-total"]}] Total annual fees.</b> Σ amountDollars across rows where frequency = 'annually'.</div>
      <div><b>[{FN["pro-rated"]}] Pro-rated monthly.</b> annualFee.amountDollars ÷ 12.</div>
      <div><b>[{FN["savings-balance-total"]}] Total balance.</b> Σ savings.currentBalanceDollars.</div>
      <div><b>[{FN["savings-monthly-total"]}] Total monthly add.</b> Σ savings.monthlyContributionDollars.</div>
      <div><b>[{FN["annualized-savings"]}] Annualized column.</b> monthlyContributionDollars × 12 per row.</div>
      <div><b>[{FN["savings-annualized-total"]}] Total annualized.</b> Σ monthlyContributionDollars × 12 across all accounts.</div>
      <div style="margin-top: 8px">
        <b>On sources.</b>
        <Badge source="statement">statement</Badge> means the line was detected during PDF/XLSX import.
        <Badge source="baseline">baseline</Badge> is a soft floor inferred from category averages.
        <Badge source="manual">manual</Badge> is anything you added by hand.
      </div>
      <div><b>Inline editing.</b> Click any label or amount to edit. <span class="bk-kbd">⏎</span> commits, <span class="bk-kbd">esc</span> reverts.</div>
      <div style="margin-top: 6px"><em>Click any bracketed numeral to see the exact formula and trace it back to the raw inputs.</em></div>
    </div>
  {/if}
</article>

<style>
  /* Merchant-group header row (the collapsible "dropdown" for same-merchant
     lines). View-only grouping — see groupByMerchant in the script. */
  tr.bk-mgroup {
    background: var(--surface-2, rgba(255, 255, 255, 0.03));
  }
  .bk-mgroup-toggle {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    background: none;
    border: none;
    padding: 2px 0;
    color: inherit;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    text-align: left;
  }
  .bk-mgroup-caret {
    display: inline-block;
    width: 12px;
    color: var(--text-3, #888);
  }
  .bk-mgroup-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bk-mgroup-toggle:hover .bk-mgroup-label {
    text-decoration: underline;
  }
</style>
