<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { api, type TrendsResult, type TrendsMonth } from "$lib/api.js";
  import { workspaceState } from "$lib/workspace.svelte.js";
  import { onInvalidate, type ResourceName } from "$lib/appShellState.svelte.js";
  import { loadTrendsSettings, saveTrendsSettings } from "$lib/trendsSettings.svelte.js";
  import { formatDollars, formatDollarsWhole } from "$lib/helpers.js";
  import { rollingAverage, yoyDelta, sumSeries } from "$lib/trendsMath.js";

  import PageHead from "$lib/components/PageHead.svelte";
  import TrendsChart from "$lib/components/TrendsChart.svelte";

  const ws = workspaceState();

  let trends = $state<TrendsResult | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  let wsGen = 0;

  async function refreshTrends(): Promise<void> {
    if (ws.activeId == null) return;
    const gen = ++wsGen;
    loading = true;
    loadError = null;
    try {
      const r = await api.computeExpenseTrends({ workspaceId: ws.activeId, months: 24 });
      if (gen !== wsGen) return;
      trends = r;
    } catch (e) {
      if (gen !== wsGen) return;
      loadError = (e as Error).message;
    } finally {
      if (gen === wsGen) loading = false;
    }
  }

  $effect(() => {
    if (ws.activeId != null) void refreshTrends();
  });

  // Refresh on any data change that the chart reflects: expenses/statements feed
  // the per-category series, and incomes/savings/take-home/retirement feed the
  // overlay lines. Budget-page edits now broadcast these, so the chart stays live.
  const TRENDS_INVALIDATORS: ResourceName[] = [
    "expenses", "statements", "incomes", "savings", "takeHome", "retirement",
  ];
  let dispose: (() => void) | null = null;
  onMount(() => {
    dispose = onInvalidate((r) => {
      if (TRENDS_INVALIDATORS.includes(r)) void refreshTrends();
    });
  });
  onDestroy(() => { dispose?.(); });

  // ── Reactive derivations ─────────────────────────────────────────────
  const allCatKeys = $derived(trends ? Object.keys(trends.categories) : []);
  // Seed control state from persisted settings; categories are applied once
  // `trends` loads (intersected with the current workspace) in catsSeeded below.
  const saved = loadTrendsSettings();
  let activeCats = $state<Set<string>>(new Set(saved.activeCats));
  let activeOverlays = $state<Set<string>>(new Set(saved.activeOverlays));
  let windowMonths = $state(saved.windowMonths);
  let mode = $state<"absolute" | "percent" | "stacked">(saved.mode);

  // Seed activeCats exactly once per workspace — default = top 4 by latest
  // value. Guarding on a dedicated `catsSeeded` flag (rather than
  // `activeCats.size > 0`) means clearing via the "None" button STICKS instead
  // of immediately re-seeding.
  let catsSeeded = $state(false);
  $effect(() => {
    if (!trends || catsSeeded) return;
    const present = allCatKeys;
    // Restore saved categories that still exist in this workspace; otherwise
    // fall back to the top-4 by latest value.
    const savedValid = (saved.activeCats ?? []).filter((k) => present.includes(k));
    if (savedValid.length > 0) {
      activeCats = new Set(savedValid);
    } else {
      const ranked = present
        .map((k) => ({ k, v: trends!.categories[k]!.series.at(-1) ?? 0 }))
        .sort((a, b) => b.v - a.v)
        .slice(0, 4)
        .map((x) => x.k);
      activeCats = new Set(ranked.length > 0 ? ranked : present.slice(0, 4));
    }
    catsSeeded = true;
  });

  // On workspace switch, clear the selection and re-arm seeding so the new
  // workspace gets its own top-4 default.
  $effect(() => {
    ws.activeId; // track
    activeCats = new Set();
    catsSeeded = false;
  });

  // Persist plot settings whenever a control changes (after initial seeding, so
  // we don't clobber saved categories with the empty pre-seed state).
  $effect(() => {
    if (!catsSeeded) return;
    saveTrendsSettings({
      windowMonths,
      mode,
      activeCats: [...activeCats],
      activeOverlays: [...activeOverlays],
    });
  });

  function toggleCat(key: string): void {
    const n = new Set(activeCats);
    n.has(key) ? n.delete(key) : n.add(key);
    activeCats = n;
  }
  function toggleOverlay(key: string): void {
    const n = new Set(activeOverlays);
    n.has(key) ? n.delete(key) : n.add(key);
    activeOverlays = n;
  }
  function selectAllCats(): void { activeCats = new Set(allCatKeys); }
  function clearAllCats(): void { activeCats = new Set(); }
  function onlyEssentials(): void {
    const want = new Set(["housing", "Housing", "Utilities", "Insurance", "Rent", "Food", "Health"].map((s) => s.toLowerCase()));
    activeCats = new Set(
      allCatKeys.filter((k) => trends && want.has(trends.categories[k]!.name.toLowerCase())),
    );
  }
  function onlyDiscretionary(): void {
    const want = new Set(["entertainment", "subscriptions", "restaurants", "discretionary"]);
    activeCats = new Set(
      allCatKeys.filter((k) => trends && want.has(trends.categories[k]!.name.toLowerCase())),
    );
  }

  const categorySeries = $derived.by(() => {
    if (!trends) return [] as Array<{ key: string; name: string; color: string; values: number[]; raw: number[] }>;
    return allCatKeys
      .filter((k) => activeCats.has(k))
      .map((k) => {
        const c = trends!.categories[k]!;
        return {
          key: k,
          name: c.name,
          color: c.color,
          values: rollingAverage(c.series, windowMonths),
          raw: c.series,
        };
      });
  });

  const overlaySeries = $derived.by(() => {
    if (!trends) return [] as Array<{ key: string; name: string; color: string; values: number[] }>;
    return Object.entries(trends.overlays)
      .filter(([k]) => activeOverlays.has(k))
      .map(([k, o]) => ({
        key: k,
        name: o.name,
        color: o.color,
        values: rollingAverage(o.series, windowMonths),
      }));
  });

  const incomeSmoothed = $derived(
    trends ? rollingAverage(trends.overlays.takeHome.series, windowMonths) : [],
  );

  const totalExpenses = $derived.by(() => {
    if (!trends) return [];
    const xs = allCatKeys.filter((k) => activeCats.has(k)).map((k) => trends!.categories[k]!.series);
    return rollingAverage(sumSeries(xs), windowMonths);
  });

  // ── Per-category analytics ────────────────────────────────────────────
  // Budget-relevant stats for each ACTIVE expense type: its latest monthly
  // amount, share of the active categories' total this month, and the peak
  // month (driven by one-time spikes in the budget-driven series).
  interface CategoryInsight {
    key: string;
    name: string;
    color: string;
    monthly: number;
    share: number;
    peakVal: number;
    peakLabel: string;
  }
  const categoryInsights = $derived.by<CategoryInsight[]>(() => {
    if (!trends) return [];
    const xs = trends.x;
    const active = allCatKeys.filter((k) => activeCats.has(k));
    const lastIdx = xs.length - 1;
    const activeTotalLatest = active.reduce((s, k) => s + (trends!.categories[k]!.series[lastIdx] ?? 0), 0);
    return active.map((k) => {
      const c = trends!.categories[k]!;
      let peakIdx = -1;
      let peakVal = 0;
      c.series.forEach((v, i) => {
        if (v > peakVal) { peakVal = v; peakIdx = i; }
      });
      const monthly = c.series[lastIdx] ?? 0;
      return {
        key: k,
        name: c.name,
        color: c.color,
        monthly,
        share: activeTotalLatest > 0 ? monthly / activeTotalLatest : 0,
        peakVal,
        peakLabel: peakIdx >= 0 ? (xs[peakIdx]?.label ?? "—") : "—",
      };
    });
  });

  const latestTotal = $derived(totalExpenses.at(-1) ?? 0);
  const yearAgo = $derived(
    totalExpenses.length >= 13 ? totalExpenses[totalExpenses.length - 13] ?? null : null,
  );
  const yoy = $derived(yearAgo != null && yearAgo > 0 ? (latestTotal - yearAgo) / yearAgo : null);
  const allTimeMax = $derived(totalExpenses.length > 0 ? Math.max(...totalExpenses) : 0);
  const allTimeMaxIdx = $derived(totalExpenses.indexOf(allTimeMax));
  const monthsX: TrendsMonth[] = $derived(trends?.x ?? []);

  // Latest savings rate = (savings + retirement) / takeHome
  const latestSavingsRate = $derived.by(() => {
    if (!trends) return 0;
    const idx = trends.x.length - 1;
    const inc = trends.overlays.takeHome.series[idx] || 0;
    if (inc === 0) return 0;
    const sav = trends.overlays.savings.series[idx] || 0;
    const ret = trends.overlays.retirement.series[idx] || 0;
    return (sav + ret) / inc;
  });

  // Hover tooltip state.
  let hoverIdx = $state<number | null>(null);
  let hoverX = $state(0);
  let hoverY = $state(0);
  let chartWrapEl: HTMLDivElement | null = $state(null);

  function onHover(i: number | null, cx: number, cy: number): void {
    hoverIdx = i;
    hoverX = cx;
    hoverY = cy;
  }

  // Position the follow-cursor tooltip, flipping it above / left of the cursor
  // when anchoring below/right would run it off the chart area. Anchoring the
  // far edge (bottom/right) keeps it on-screen regardless of the tooltip's
  // height — important now that it can carry a tall "top non-recurring" list.
  const tooltipPos = $derived.by(() => {
    if (hoverIdx == null || !chartWrapEl) return null;
    const rect = chartWrapEl.getBoundingClientRect();
    const xRel = hoverX - rect.left;
    const yRel = hoverY - rect.top;
    const flipUp = yRel > rect.height * 0.5;
    const flipLeft = xRel > rect.width * 0.62;
    return {
      left: flipLeft ? null : xRel + 14,
      right: flipLeft ? rect.width - xRel + 14 : null,
      top: flipUp ? null : yRel + 14,
      bottom: flipUp ? rect.height - yRel + 14 : null,
    };
  });

  const tooltipRows = $derived.by(() => {
    if (hoverIdx == null) return [];
    // Categories sort by THIS month's spend, greatest first (the order can
    // differ month to month); ties keep the canonical category order (stable
    // sort). Overlays (take-home) stay pinned after the categories.
    const cats = categorySeries
      .map((c) => ({ name: c.name, color: c.color, val: c.values[hoverIdx!] ?? 0, overlay: false }))
      .sort((a, b) => b.val - a.val);
    return [
      ...cats,
      ...overlaySeries.map((o) => ({ name: o.name, color: o.color, val: o.values[hoverIdx!] ?? 0, overlay: true })),
    ];
  });

  const tooltipTotal = $derived(
    hoverIdx == null ? 0 : categorySeries.reduce((s, c) => s + (c.values[hoverIdx!] ?? 0), 0),
  );

  // One-time budget items dated in the hovered month, with a running cumulative
  // (last row's cumulative = sum of the items shown).
  const tooltipOneTime = $derived.by(() => {
    if (hoverIdx == null || !trends) return [];
    let cum = 0;
    return (trends.topOneTime?.[hoverIdx] ?? []).map((it) => {
      cum += it.amount;
      return { ...it, cumulative: cum };
    });
  });

  const isEmpty = $derived(
    !!trends &&
    Object.values(trends.categories).every((c) => c.series.every((v) => v === 0)),
  );

  // [H4] A line/area chart needs at least two points to draw anything.
  const tooFewPoints = $derived(monthsX.length < 2);

  // [H2] In % mode, months with $0 take-home can't yield a meaningful share;
  // the chart renders them as 0. Surface a note when that applies.
  const hasZeroIncomeMonth = $derived(
    mode === "percent" && incomeSmoothed.some((v) => v <= 0),
  );
</script>

<article class="ed-article">
  <PageHead
    section="Section V"
    kicker="The Long View"
    title="Trends"
    rightLabel="Trends"
    byline="Rolling-average expenses by category over the last 24 months. Toggle categories in or out of the chart, lay take-home / savings / 401k on top, and watch how habits shift."
  />

  {#if loadError}
    <div class="bk-error-banner" role="alert" data-testid="trends-error">
      {loadError}
    </div>
  {/if}

  <!-- Summary strip -->
  <div class="trends-summary">
    <div class="trends-summary-cell">
      <div class="trends-summary-label">This month</div>
      <div class="trends-summary-val bk-num">{formatDollarsWhole(latestTotal)}</div>
      <div class="trends-summary-sub">
        {activeCats.size} categor{activeCats.size === 1 ? "y" : "ies"}
        · {windowMonths === 1 ? "raw monthly" : `${windowMonths}mo rolling avg`}
      </div>
    </div>
    <div class="trends-summary-cell">
      <div class="trends-summary-label">YoY change</div>
      <div
        class="trends-summary-val bk-num"
        style:color={yoy == null ? "var(--text-3)" : yoy > 0 ? "var(--negative)" : "var(--positive)"}
      >
        {yoy == null ? "—" : `${yoy > 0 ? "+" : ""}${(yoy * 100).toFixed(1)}%`}
      </div>
      <div class="trends-summary-sub">vs same month last year</div>
    </div>
    <div class="trends-summary-cell">
      <div class="trends-summary-label">Peak month</div>
      <div class="trends-summary-val bk-num">{formatDollarsWhole(allTimeMax)}</div>
      <div class="trends-summary-sub">{monthsX[allTimeMaxIdx]?.label ?? "—"}</div>
    </div>
    <div class="trends-summary-cell">
      <div class="trends-summary-label">Savings rate</div>
      <div class="trends-summary-val bk-num" style="color: var(--positive)">
        {(latestSavingsRate * 100).toFixed(0)}%
      </div>
      <div class="trends-summary-sub">brokerage + 401k + HSA / take-home</div>
    </div>
  </div>

  <!-- Chart controls -->
  <div class="trends-toolbar" role="toolbar" aria-label="Chart controls">
    <div class="group">
      <span class="lbl">Rolling window</span>
      <button
        type="button"
        class="bk-iconbtn"
        aria-label="Smaller window"
        disabled={windowMonths <= 1}
        onclick={() => (windowMonths = Math.max(1, windowMonths - 1))}
      >−</button>
      <input
        type="range"
        min="1"
        max="24"
        step="1"
        value={windowMonths}
        oninput={(e) => (windowMonths = parseInt((e.currentTarget as HTMLInputElement).value, 10))}
        aria-label="Rolling-average window in months"
        data-testid="trends-window-slider"
        style="width: 140px"
      />
      <button
        type="button"
        class="bk-iconbtn"
        aria-label="Larger window"
        disabled={windowMonths >= 24}
        onclick={() => (windowMonths = Math.min(24, windowMonths + 1))}
      >+</button>
      <span style="font-family: var(--font-num); font-size: 12px; min-width: 80px; color: var(--text-2)">
        {windowMonths === 1 ? "no smoothing" : `${windowMonths} months`}
      </span>
    </div>
    <div class="group">
      <span class="lbl">Presets</span>
      <div class="trends-seg" role="group" aria-label="Window preset">
        {#each [{v:1,l:"Raw"},{v:3,l:"3mo"},{v:6,l:"6mo"},{v:12,l:"12mo"}] as o (o.v)}
          <button
            type="button"
            aria-pressed={windowMonths === o.v}
            data-testid={`trends-preset-${o.v}`}
            onclick={() => (windowMonths = o.v)}
          >{o.l}</button>
        {/each}
      </div>
    </div>
    <div class="group">
      <span class="lbl">View</span>
      <div class="trends-seg" role="group" aria-label="Chart mode">
        <button type="button" aria-pressed={mode === "absolute"} data-testid="trends-mode-lines" onclick={() => (mode = "absolute")}>Lines</button>
        <button type="button" aria-pressed={mode === "stacked"}  data-testid="trends-mode-stacked" onclick={() => (mode = "stacked")}>Stacked</button>
        <button type="button" aria-pressed={mode === "percent"}  data-testid="trends-mode-percent" onclick={() => (mode = "percent")}>% of income</button>
      </div>
    </div>
    <span style="flex: 1"></span>
    <div class="group">
      <span class="lbl">Categories</span>
      <button type="button" class="bk-btn bk-btn-sm bk-btn-ghost" onclick={onlyEssentials}>Essentials</button>
      <button type="button" class="bk-btn bk-btn-sm bk-btn-ghost" onclick={onlyDiscretionary}>Discretionary</button>
      <button type="button" class="bk-btn bk-btn-sm bk-btn-ghost" onclick={selectAllCats}>All</button>
      <button type="button" class="bk-btn bk-btn-sm bk-btn-ghost" onclick={clearAllCats}>None</button>
    </div>
  </div>

  <!-- Overlay toggles -->
  {#if trends}
    <div>
      <div class="bk-eyebrow" style="margin-bottom: 8px">Compare to (overlay on chart)</div>
      <div class="trends-overlays">
        {#each Object.entries(trends.overlays) as [k, o] (k)}
          {@const latest = o.series.at(-1) ?? 0}
          <button
            type="button"
            class="trends-overlay-chip"
            aria-pressed={activeOverlays.has(k)}
            data-testid={`trends-overlay-${k}`}
            onclick={() => toggleOverlay(k)}
            style:color={activeOverlays.has(k) ? o.color : undefined}
          >
            <span class="ov-swatch"></span>
            <span>{o.name}</span>
            <span class="ov-meta">{formatDollars(latest)}/mo</span>
          </button>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Chart -->
  <div class="trends-chart-wrap" bind:this={chartWrapEl} data-testid="trends-chart-wrap">
    {#if loading}
      <!-- [GR-U12] Show a loading state during refresh/workspace switch rather
           than flashing the previous workspace's chart. -->
      <div class="trends-empty" data-testid="trends-loading">Loading…</div>
    {:else if isEmpty}
      <div class="trends-empty">
        <div style="margin-bottom: 10px">No budget expenses yet.</div>
        <a href="/budget" class="bk-btn bk-btn-sm bk-btn-primary" data-testid="trends-empty-cta">
          Open the Budget →
        </a>
      </div>
    {:else if tooFewPoints}
      <!-- [H4] One month (or none) can't form a trend line. -->
      <div class="trends-empty" data-testid="trends-too-few">
        Not enough history to chart a trend yet — at least two months of data are needed.
      </div>
    {:else if trends}
      {#if hasZeroIncomeMonth}
        <div
          class="bk-text-3"
          data-testid="trends-percent-note"
          style="font-size: 12px; margin-bottom: 8px"
        >
          % of income hidden for months with $0 take-home.
        </div>
      {/if}
      <TrendsChart
        x={monthsX}
        categorySeries={categorySeries}
        overlaySeries={overlaySeries}
        mode={mode}
        incomeSeries={incomeSmoothed}
        hoverIdx={hoverIdx}
        onhover={onHover}
      />
      {#if hoverIdx != null && tooltipPos}
        <div
          class="trends-tooltip"
          style:left={tooltipPos.left == null ? null : `${tooltipPos.left}px`}
          style:right={tooltipPos.right == null ? null : `${tooltipPos.right}px`}
          style:top={tooltipPos.top == null ? null : `${tooltipPos.top}px`}
          style:bottom={tooltipPos.bottom == null ? null : `${tooltipPos.bottom}px`}
        >
          <div class="tt-month">{monthsX[hoverIdx]?.label ?? ""}</div>
          {#each tooltipRows as r, idx (idx)}
            <div class="tt-row">
              <span class="tt-dot" style:background={r.color} style:opacity={r.overlay ? 0.7 : 1}></span>
              <span class="tt-name">
                {r.name}
                {#if r.overlay}<span style="color: var(--text-3); font-style: italic; margin-left: 4px">(overlay)</span>{/if}
              </span>
              <span class="tt-val">{formatDollars(r.val)}</span>
            </div>
          {/each}
          <div class="tt-total">
            <span>Expenses total</span>
            <span class="bk-num" style="font-style: normal; color: var(--text)">{formatDollars(tooltipTotal)}</span>
          </div>
          {#if tooltipOneTime.length > 0}
            <div class="tt-nr">
              <div class="tt-subhead">One-time items this month · this / running</div>
              {#each tooltipOneTime as it, i (i)}
                <div class="tt-nr-row">
                  <span class="tt-dot" style:background={it.color}></span>
                  <span class="tt-name">{it.label}</span>
                  <span class="tt-val">{formatDollars(it.amount)}</span>
                  <span class="tt-cum">{formatDollars(it.cumulative)}</span>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
      {#if categorySeries.length === 0 && overlaySeries.length === 0}
        <div class="trends-empty">Toggle a category below or pick a preset to begin.</div>
      {/if}
    {/if}
  </div>

  <!-- Per-category analytics -->
  {#if trends && !isEmpty && categoryInsights.length > 0}
    <div>
      <div class="bk-eyebrow" style="margin-bottom: 8px">
        Category insights
        <span style="font-weight: 400; text-transform: none; letter-spacing: 0; color: var(--text-3)">— per expense type, budgeted monthly</span>
      </div>
      <div class="trends-insights" data-testid="trends-insights">
        {#each categoryInsights as ins (ins.key)}
          <div class="trends-insight-card" style:border-left-color={ins.color} data-testid={`trends-insight-${ins.key}`}>
            <div class="ti-name" style:color={ins.color}>{ins.name}</div>
            <div class="ti-grid">
              <div class="ti-stat">
                <span class="ti-lbl">Monthly</span>
                <span class="ti-val bk-num">{formatDollarsWhole(ins.monthly)}</span>
              </div>
              <div class="ti-stat">
                <span class="ti-lbl">Share</span>
                <span class="ti-val bk-num">{(ins.share * 100).toFixed(0)}%</span>
              </div>
              <div class="ti-stat">
                <span class="ti-lbl">Peak</span>
                <span class="ti-val bk-num">{formatDollarsWhole(ins.peakVal)} <span class="bk-text-3" style="font-size: 10px">{ins.peakLabel}</span></span>
              </div>
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Category legend -->
  {#if trends && !isEmpty}
    <div>
      <div class="bk-eyebrow" style="margin-bottom: 8px">Categories — click to toggle</div>
      <div class="trends-legend">
        {#each allCatKeys as k (k)}
          {@const c = trends.categories[k]!}
          {@const smoothed = rollingAverage(c.series, windowMonths)}
          {@const latest = smoothed.at(-1) ?? 0}
          {@const yoyVal = yoyDelta(smoothed)}
          {@const active = activeCats.has(k)}
          <button
            type="button"
            class="trends-legend-row"
            aria-pressed={active}
            data-testid={`trends-legend-${k}`}
            onclick={() => toggleCat(k)}
            style:color={c.color}
          >
            <span class="swatch" style:background={active ? c.color : undefined}></span>
            <span class="name">{c.name}</span>
            <span class="avg">{formatDollarsWhole(latest)}<span class="bk-text-3" style="font-size: 10px; margin-left: 2px">/mo</span></span>
            {#if yoyVal != null}
              <span class="yoy {yoyVal > 0.02 ? 'pos' : yoyVal < -0.02 ? 'neg' : ''}">
                {yoyVal > 0 ? "+" : ""}{(yoyVal * 100).toFixed(0)}%
              </span>
            {:else}
              <span class="yoy">—</span>
            {/if}
          </button>
        {/each}
      </div>
    </div>
  {/if}

  {#if (trends?.undatedOneTimeCount ?? 0) > 0}
    <p class="bk-text-3" style="font-size: 12px; margin-top: 8px" data-testid="trends-undated-note">
      {trends!.undatedOneTimeCount} one-time expense{trends!.undatedOneTimeCount === 1 ? "" : "s"} have no spend month and are not shown
      {#if (trends!.undatedOneTimeLabels ?? []).length > 0}
        ({trends!.undatedOneTimeLabels.slice(0, 5).join(", ")}{trends!.undatedOneTimeCount > 5 ? ", …" : ""})
      {/if}
      — <a href="/budget" style="color: var(--accent)">set one in Budget</a>.
    </p>
  {/if}

  <div class="ed-footnotes">
    <div>
      <b>Rolling window.</b> Sets how many months feed each point's average.
      <em>Raw (1)</em> shows unsmoothed monthly totals; <em>3–6mo</em> hides short-term noise;
      <em>12mo</em> shows long secular drift.
    </div>
    <div>
      <b>Stacked vs lines.</b> Stacked area shows how the spend mix composes total expense; lines
      compare categories against each other. <em>% of income</em> divides every series by take-home
      in the same month.
    </div>
    <div>
      <b>Overlay simplification.</b> Take-home / savings / retirement overlays are held constant
      from the current workspace — historical per-month take-home would need snapshotted tax tables.
      The category series come from your budget — recurring lines as flat monthly-equivalents,
      one-time items on their spend date.
    </div>
  </div>
</article>

<style>
  /* Per-category analytics cards. */
  .trends-insights {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 10px;
  }
  .trends-insight-card {
    border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
    border-left-width: 3px;
    border-radius: 8px;
    padding: 10px 12px;
    background: var(--surface-2, rgba(255, 255, 255, 0.02));
  }
  .ti-name {
    font-weight: 600;
    font-size: 13px;
    margin-bottom: 8px;
  }
  .ti-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px 12px;
  }
  .ti-stat {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .ti-lbl {
    font-size: 10px;
    color: var(--text-3, #888);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .ti-val {
    font-size: 14px;
  }
</style>
