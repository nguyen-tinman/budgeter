<script lang="ts">
  import {
    api,
    type RetirementProjection,
    type SensitivityGrid,
    type SensitivitySettings,
    type TakeHome,
    type Workspace,
  } from "$lib/api.js";
  import { workspaceState, refreshWorkspaces } from "$lib/workspace.svelte.js";
  import {
    formatDollars,
    formatDollarsWhole,
    monthlyExpenseTotal,
    parseDollars,
  } from "$lib/helpers.js";
  import { round2 } from "@budgetkit/core/money";
  import { setModal } from "$lib/appShellState.svelte.js";

  import PageHead from "$lib/components/PageHead.svelte";
  import EdSection from "$lib/components/EdSection.svelte";
  import PullQuote from "$lib/components/PullQuote.svelte";
  import Chip from "$lib/components/Chip.svelte";
  import Icon from "$lib/components/Icon.svelte";
  import HelpDot from "$lib/components/HelpDot.svelte";
  import FootnoteRef from "$lib/components/FootnoteRef.svelte";

  function openFootnote(topic: string) {
    setModal(`help-${topic}`);
  }

  // Stable footnote numbering — each topic always gets the same [N] on this
  // page, in order of first appearance. Click any bracketed numeral for the
  // exact formula + leaf-level source.
  const FN_ORDER = [
    "gross-taxed-annual",
    "federal-tax",
    "ca-tax",
    "fica",
    "monthly-expenses",
    "monthly-remaining",
    "delta-vs-base",
    "effective-rate",
    "compounded-30",
    "sensitivity",
    "roth-split",
    "retirement-annual",
    "retirement-pretax",
    "retirement-aftertax",
  ];
  const FN = Object.fromEntries(FN_ORDER.map((t, i) => [t, i + 1])) as Record<string, number>;

  const ws = workspaceState();

  // Workspaces to compare side-by-side; pre-select all.
  let selected = $state<Set<number>>(new Set());

  interface PerWs {
    takeHome: TakeHome | null;
    monthlyExp: number;
    remaining: number;
    error: string | null;
  }
  // Per-workspace slice. Mutating one key only re-renders that row in the
  // comparison table; rows for other workspaces stay mounted as-is.
  let perWs = $state<Record<number, PerWs>>({});

  // Sensitivity grid state. Defaults mirror the seeded ranges used before
  // per-workspace persistence existed; loadSensitivityForm() falls back to
  // these whenever a workspace has no saved sensitivity_settings row yet.
  const SENS_DEFAULTS = {
    primaryLow: "$50,000",
    primaryHigh: "$200,000",
    spouseLow: "$0",
    spouseHigh: "$100,000",
  } as const;
  let sensitivityPrimaryLow = $state<string>(SENS_DEFAULTS.primaryLow);
  let sensitivityPrimaryHigh = $state<string>(SENS_DEFAULTS.primaryHigh);
  let sensitivitySpouseLow = $state<string>(SENS_DEFAULTS.spouseLow);
  let sensitivitySpouseHigh = $state<string>(SENS_DEFAULTS.spouseHigh);
  let sensitivity = $state<SensitivityGrid | null>(null);
  let sensitivityError = $state<string | null>(null);
  let sensitivityBusy = $state(false);

  // Workspace-switch race guard. Each time the active workspace changes we
  // bump this counter and snapshot it locally inside the async load; a slow
  // load for workspace A that resolves AFTER the user switched to B sees a
  // stale generation and bails before mutating any shared state — so B's
  // freshly-loaded grid/projection can't be clobbered by A's late response.
  let wsGen = 0;

  // Retirement projection state.
  let retirementAge = $state("30");
  let retireAtAge = $state("65");
  let retirementInitial = $state("$0");
  let retirementGrowth = $state("0.07");
  let retirementRothSplit = $state("0.5");
  let retirementProjection = $state<RetirementProjection | null>(null);
  let retirementError = $state<string | null>(null);
  let retirementBusy = $state(false);

  $effect(() => {
    if (ws.list.length > 0 && selected.size === 0) {
      selected = new Set(ws.list.map((w) => w.id));
      void reloadAll();
    }
  });

  $effect(() => {
    // Re-run whenever the active workspace changes. Bump the generation FIRST
    // so any in-flight load for the previous workspace is invalidated, then
    // kick off the guarded load for the new one.
    const id = ws.activeId;
    if (id !== null) {
      const gen = ++wsGen;
      void loadActiveWorkspace(id, gen);
    }
  });

  // Per-workspace load orchestration (race-guarded). Restores BOTH the
  // retirement form + sensitivity ranges from the DB, then auto-runs each
  // result so the page shows last session's figures without a click:
  //   - retirement auto-runs only if a retirement_settings row exists
  //     (runRetirement swallows the "no settings" case to a blank state).
  //   - sensitivity auto-runs only if a sensitivity_settings row exists; with
  //     no saved row the grid stays blank until the user presses Recalculate.
  // `gen` is the wsGen snapshot at dispatch; every async step re-checks it and
  // bails the moment a newer workspace load has superseded this one.
  async function loadActiveWorkspace(id: number, gen: number): Promise<void> {
    const hadRetirement = await loadRetirementForm(id, gen);
    if (gen !== wsGen) return;
    const hadSensitivity = await loadSensitivityForm(id, gen);
    if (gen !== wsGen) return;
    if (hadRetirement) void runRetirement(id, gen);
    // Always render the grid on load: with a saved row we use its ranges, and
    // without one we fall back to SENS_DEFAULTS (set by loadSensitivityForm) so
    // the 5x5 grid shows immediately instead of staying blank until Recalculate.
    void runSensitivityCompute(id, gen);
  }

  // firstLoadDone gates the initial-mount skeleton ONLY. After the very first
  // population of perWs, every subsequent refresh leaves the existing
  // comparison rows in place — only the affected workspace's row mutates.
  let firstLoadDone = $state(false);

  // Per-workspace refresher. Updates ONLY the slice for `id` in `perWs` so
  // Svelte's diff swaps just that one row in the comparison table; rows for
  // other workspaces stay rendered the whole time.
  async function refreshWorkspaceRow(id: number): Promise<void> {
    try {
      const [incs, exps] = await Promise.all([api.listIncomes(id), api.listExpenses(id)]);
      const expMonthly = monthlyExpenseTotal(exps);
      let t: TakeHome | null = null;
      if (incs.some((i) => i.taxStatus === "taxed")) {
        t = await api.computeTakeHome(id);
      }
      perWs = {
        ...perWs,
        [id]: {
          takeHome: t,
          monthlyExp: expMonthly,
          remaining: t ? round2(t.monthlyTakeHomeDollars - expMonthly) : 0,
          error: null,
        },
      };
    } catch (e) {
      perWs = {
        ...perWs,
        [id]: { takeHome: null, monthlyExp: 0, remaining: 0, error: (e as Error).message },
      };
    }
  }

  // Initial-mount fan-out: refresh every selected workspace in parallel. No
  // global busy flag — each row's promise resolves independently and Svelte
  // swaps each row as its data lands.
  async function reloadAll(): Promise<void> {
    await Promise.all(Array.from(selected).map((id) => refreshWorkspaceRow(id)));
    if (!firstLoadDone) firstLoadDone = true;
  }

  function toggle(id: number): void {
    const next = new Set(selected);
    if (next.has(id)) {
      // De-select: drop the row entirely so the table re-flows without that
      // column. No fetch needed.
      next.delete(id);
      selected = next;
      const { [id]: _removed, ...rest } = perWs;
      perWs = rest;
    } else {
      // Select: add the workspace and fetch JUST its row. The other rows are
      // untouched in perWs, so they don't re-render.
      next.add(id);
      selected = next;
      void refreshWorkspaceRow(id);
    }
  }

  function wsName(id: number): string {
    return ws.list.find((w) => w.id === id)?.name ?? `#${id}`;
  }
  function wsKind(id: number): Workspace["kind"] | undefined {
    return ws.list.find((w) => w.id === id)?.kind;
  }

  // Compare rows with Δ-vs-Current.
  interface CompareRow extends PerWs { ws: Workspace; isBase: boolean; deltaRemaining: number }
  const compareRows = $derived<CompareRow[]>(((): CompareRow[] => {
    const ids = [...selected];
    const rows: CompareRow[] = [];
    for (const id of ids) {
      const w = ws.list.find((x) => x.id === id);
      const p = perWs[id];
      if (!w || !p) continue;
      rows.push({ ws: w, ...p, isBase: false, deltaRemaining: 0 });
    }
    const base = rows.find((r) => r.ws.kind === "current") ?? rows[0];
    return rows.map((r) => ({
      ...r,
      isBase: r === base,
      deltaRemaining: base ? round2(r.remaining - base.remaining) : 0,
    }));
  })());

  // Restore the retirement form from the DB. Returns true if a saved row
  // existed (so the caller knows to auto-run the projection). `gen` is the
  // wsGen snapshot; if a newer load supersedes this one mid-flight we bail
  // without touching the form fields.
  async function loadRetirementForm(id: number, gen: number): Promise<boolean> {
    try {
      const rs = await api.getRetirementSettings(id);
      if (gen !== wsGen) return false;
      if (rs) {
        retirementAge = String(rs.currentAge);
        retireAtAge = String(rs.retirementAge);
        retirementInitial = formatDollars(rs.initialBalanceDollars);
        retirementGrowth = String(rs.growthRate);
        retirementRothSplit = String(rs.rothSplitPct);
        return true;
      }
      retirementAge = "30"; retireAtAge = "65"; retirementInitial = "$0";
      retirementGrowth = "0.07"; retirementRothSplit = "0.5";
      retirementProjection = null;
      return false;
    } catch {
      if (gen !== wsGen) return false;
      retirementAge = "30"; retireAtAge = "65"; retirementInitial = "$0";
      retirementGrowth = "0.07"; retirementRothSplit = "0.5";
      retirementProjection = null;
      return false;
    }
  }

  // Restore the sensitivity-grid ranges from the DB. Returns true if a saved
  // row existed (so the caller auto-runs the grid). With no saved row the
  // inputs fall back to SENS_DEFAULTS and the grid stays blank until the user
  // presses Recalculate. Race-guarded via `gen` like loadRetirementForm.
  async function loadSensitivityForm(id: number, gen: number): Promise<boolean> {
    let ss: SensitivitySettings | null = null;
    try {
      ss = await api.getSensitivitySettings(id);
    } catch {
      ss = null;
    }
    if (gen !== wsGen) return false;
    if (ss) {
      sensitivityPrimaryLow = formatDollars(ss.primaryLowDollars);
      sensitivityPrimaryHigh = formatDollars(ss.primaryHighDollars);
      sensitivitySpouseLow = formatDollars(ss.spouseLowDollars);
      sensitivitySpouseHigh = formatDollars(ss.spouseHighDollars);
      return true;
    }
    sensitivityPrimaryLow = SENS_DEFAULTS.primaryLow;
    sensitivityPrimaryHigh = SENS_DEFAULTS.primaryHigh;
    sensitivitySpouseLow = SENS_DEFAULTS.spouseLow;
    sensitivitySpouseHigh = SENS_DEFAULTS.spouseHigh;
    sensitivity = null;
    return false;
  }

  // Parse + validate the four range inputs. Returns the cents tuple or null
  // (setting sensitivityError) on bad input. Shared by the compute-only and
  // persist-then-compute paths.
  function parseSensitivityRanges():
    | { pLo: number; pHi: number; sLo: number; sHi: number }
    | null {
    const pLo = parseDollars(sensitivityPrimaryLow);
    const pHi = parseDollars(sensitivityPrimaryHigh);
    const sLo = parseDollars(sensitivitySpouseLow);
    const sHi = parseDollars(sensitivitySpouseHigh);
    if (pLo === null || pHi === null || sLo === null || sHi === null) {
      sensitivityError = "Enter valid dollar amounts for all four ranges.";
      return null;
    }
    if (pLo >= pHi || sLo > sHi) {
      sensitivityError = "Range low must be < high.";
      return null;
    }
    return { pLo, pHi, sLo, sHi };
  }

  // Compute the grid for `id` WITHOUT persisting the ranges. Used by the
  // auto-run-on-load path (the ranges were just restored from the DB, so
  // re-persisting them would be redundant). Race-guarded via `gen`.
  async function runSensitivityCompute(id: number, gen: number): Promise<void> {
    const r = parseSensitivityRanges();
    if (!r) return;
    sensitivityError = null;
    sensitivityBusy = true;
    try {
      const grid = await api.computeSensitivity({
        workspaceId: id,
        primaryRangeDollars: [r.pLo, r.pHi],
        spouseRangeDollars: [r.sLo, r.sHi],
      });
      if (gen !== wsGen) return;
      sensitivity = grid;
    } catch (e) {
      if (gen !== wsGen) return;
      sensitivityError = (e as Error).message;
      sensitivity = null;
    } finally {
      if (gen === wsGen) sensitivityBusy = false;
    }
  }

  // User-initiated run (the Recalculate button). PERSISTS the ranges to the
  // DB first — analogous to saveAndRunRetirement — so a reload/navigate
  // restores them, THEN computes the grid. Uses the current wsGen so a
  // mid-run workspace switch can't clobber the new workspace's state.
  async function runSensitivity(): Promise<void> {
    const id = ws.activeId;
    if (id === null) return;
    const r = parseSensitivityRanges();
    if (!r) return;
    const gen = wsGen;
    sensitivityError = null;
    sensitivityBusy = true;
    try {
      await api.setSensitivitySettings({
        workspaceId: id,
        primaryLowDollars: r.pLo,
        primaryHighDollars: r.pHi,
        spouseLowDollars: r.sLo,
        spouseHighDollars: r.sHi,
      });
      const grid = await api.computeSensitivity({
        workspaceId: id,
        primaryRangeDollars: [r.pLo, r.pHi],
        spouseRangeDollars: [r.sLo, r.sHi],
      });
      if (gen !== wsGen) return;
      sensitivity = grid;
    } catch (e) {
      if (gen !== wsGen) return;
      sensitivityError = (e as Error).message;
      sensitivity = null;
    } finally {
      if (gen === wsGen) sensitivityBusy = false;
    }
  }

  async function saveAndRunRetirement(): Promise<void> {
    const id = ws.activeId;
    if (id === null) return;
    const cur = Number.parseInt(retirementAge, 10);
    const ret = Number.parseInt(retireAtAge, 10);
    const initDollars = parseDollars(retirementInitial);
    const growth = Number.parseFloat(retirementGrowth);
    const rothSplit = Number.parseFloat(retirementRothSplit);
    if (!Number.isFinite(cur) || !Number.isFinite(ret) || initDollars === null) {
      retirementError = "Enter valid numbers."; return;
    }
    if (ret <= cur) { retirementError = "Retirement age must be > current age."; return; }
    if (rothSplit < 0 || rothSplit > 1) { retirementError = "Roth split must be between 0 and 1."; return; }
    const gen = wsGen;
    retirementError = null;
    retirementBusy = true;
    try {
      await api.setRetirementSettings({
        workspaceId: id,
        currentAge: cur,
        retirementAge: ret,
        initialBalanceDollars: initDollars,
        growthRate: growth,
        rothSplitPct: rothSplit,
      });
      await runRetirement(id, gen);
    } catch (e) {
      if (gen === wsGen) retirementError = (e as Error).message;
    } finally {
      if (gen === wsGen) retirementBusy = false;
    }
  }

  // Compute + render the projection for `id`. Race-guarded via `gen`. The
  // "No retirement_settings" case is folded into a blank state (not an error)
  // so a workspace that never set retirement inputs shows the empty prompt.
  async function runRetirement(id: number, gen: number): Promise<void> {
    try {
      const proj = await api.computeRetirement(id);
      if (gen !== wsGen) return;
      retirementProjection = proj;
      retirementError = null;
    } catch (e) {
      if (gen !== wsGen) return;
      const msg = (e as Error).message;
      if (msg.includes("No retirement_settings")) {
        retirementProjection = null;
        retirementError = null;
      } else {
        retirementError = msg;
        retirementProjection = null;
      }
    }
  }

  // Color a sensitivity cell based on monthly-remaining sign and magnitude.
  function cellColor(cents: number, max: number): string {
    if (cents < 0) {
      const intensity = Math.min(1, Math.abs(cents) / Math.max(1, max));
      return `color-mix(in oklab, var(--negative) ${20 + intensity * 60}%, var(--surface))`;
    }
    const intensity = Math.min(1, cents / Math.max(1, max));
    return `color-mix(in oklab, var(--positive) ${10 + intensity * 50}%, var(--surface))`;
  }

  // Build SVG line-chart paths from year snapshots.
  const W = 720;
  const H = 260;
  function buildChart(p: RetirementProjection) {
    const yMax = Math.max(...p.years.map((y) => y.totalDollars), 1);
    const nYears = p.years.length;
    const stepX = nYears > 1 ? W / (nYears - 1) : 0;
    const toX = (i: number) => i * stepX;
    const toY = (cents: number) => H - (cents / yMax) * (H - 30) - 14;
    return {
      yMax,
      toX,
      toY,
      trad: p.years.map((y, i) => `${toX(i)},${toY(y.traditionalDollars)}`).join(" "),
      roth: p.years.map((y, i) => `${toX(i)},${toY(y.rothDollars)}`).join(" "),
      total: p.years.map((y, i) => `${toX(i)},${toY(y.totalDollars)}`).join(" "),
      areaPath: `M0,${H} ${p.years.map((y, i) => `L${toX(i)},${toY(y.totalDollars)}`).join(" ")} L${W},${H} Z`,
      annIdx: Math.floor(p.years.length / 2),
    };
  }
</script>

<article class="ed-article">
  <PageHead
    section="Section IV"
    kicker="The Field Guide"
    title="What if"
    rightLabel="Planning"
    byline="Scenarios, sensitivities, and a year-by-year retirement projection. Every figure recomputes live as you edit the underlying budget."
  />

  <p class="ed-lede">
    <em>Scenarios are sandboxes</em> — clones of <strong>Current</strong> where you can model a move, a raise, or a new fixed cost without disturbing the original ledger. Toggle any to include or exclude it from the comparison below.
  </p>

  <EdSection
    num={1}
    title="Scenarios, side-by-side"
    deck="Tax-aware comparison across selected workspaces. Bottom row shows the delta against the base workspace (Current)."
  >
    <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 18px" data-testid="ws-toggles">
      {#each ws.list as w (w.id)}
        <Chip
          on={selected.has(w.id)}
          onclick={() => toggle(w.id)}
          ariaLabel={`Toggle ${w.name}`}
        >
          <span class="bk-ws-dot" style:background={w.kind === "current" ? "var(--accent)" : "var(--info)"}></span>
          <span data-testid={`ws-toggle-${w.id}`}>{w.name}</span>
          <span class="bk-text-3" style="margin-left: 4px">· {w.kind}</span>
        </Chip>
      {/each}
      <button class="bk-btn bk-btn-sm" onclick={() => setModal("new-scenario")}>
        <Icon name="plus" size={12} /> New scenario
      </button>
    </div>

    {#if !firstLoadDone}
      <p class="bk-text">Loading workspaces…</p>
    {:else if compareRows.length === 0}
      <p class="bk-text">Select at least one workspace.</p>
    {:else}
      <table class="bk-table" data-testid="comparison-table">
        <thead>
          <tr>
            <th>Metric</th>
            {#each compareRows as r (r.ws.id)}
              <th class="bk-cell-num" data-testid={`ws-header-${r.ws.id}`}>
                {r.ws.name}{#if r.isBase}<span
                  style="margin-left: 6px; font-style: italic; color: var(--text-3); font-weight: 400"
                  title="The 'Current' workspace — every scenario row's Δ vs base is measured against this column."
                >(base = Current)</span>{/if}
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="color: var(--text-2)">
              Gross combined<FootnoteRef topic="gross-taxed-annual" n={FN["gross-taxed-annual"]} onopen={openFootnote} />
            </td>
            {#each compareRows as r (r.ws.id)}
              <td class="bk-cell-num" data-testid={`row-gross-${r.ws.id}`}>
                <span class="bk-num">{r.takeHome ? formatDollars(r.takeHome.grossCombinedDollars) : "—"}</span>
              </td>
            {/each}
          </tr>
          <tr>
            <td style="color: var(--text-2)">
              Federal tax<FootnoteRef topic="federal-tax" n={FN["federal-tax"]} onopen={openFootnote} />
            </td>
            {#each compareRows as r (r.ws.id)}
              <td class="bk-cell-num" data-testid={`row-fed-${r.ws.id}`}>
                <span class="bk-num">{r.takeHome ? formatDollars(-r.takeHome.federalTaxDollars) : "—"}</span>
              </td>
            {/each}
          </tr>
          <tr>
            <td style="color: var(--text-2)">
              State (CA) tax<FootnoteRef topic="ca-tax" n={FN["ca-tax"]} onopen={openFootnote} />
            </td>
            {#each compareRows as r (r.ws.id)}
              <td class="bk-cell-num" data-testid={`row-ca-${r.ws.id}`}>
                <span class="bk-num">{r.takeHome ? formatDollars(-r.takeHome.caTaxDollars) : "—"}</span>
              </td>
            {/each}
          </tr>
          <tr>
            <td style="color: var(--text-2)">
              FICA<FootnoteRef topic="fica" n={FN["fica"]} onopen={openFootnote} />
            </td>
            {#each compareRows as r (r.ws.id)}
              <td class="bk-cell-num"><span class="bk-num">{r.takeHome ? formatDollars(-r.takeHome.ficaDollars) : "—"}</span></td>
            {/each}
          </tr>
          <tr>
            <td style="color: var(--text-2)">
              Monthly expenses<FootnoteRef topic="monthly-expenses" n={FN["monthly-expenses"]} onopen={openFootnote} />
            </td>
            {#each compareRows as r (r.ws.id)}
              <td class="bk-cell-num"><span class="bk-num">{formatDollars(-r.monthlyExp)}</span></td>
            {/each}
          </tr>
          <tr style="background: var(--surface-2)">
            <td style="font-family: var(--font-display); font-weight: 600">
              Monthly remaining<FootnoteRef topic="monthly-remaining" n={FN["monthly-remaining"]} onopen={openFootnote} />
            </td>
            {#each compareRows as r (r.ws.id)}
              <td class="bk-cell-num" data-testid={`row-monthly-${r.ws.id}`}>
                <span
                  class="bk-num"
                  style="font-weight: 600; font-size: 15px"
                  style:color={r.remaining < 0 ? "var(--negative)" : "var(--positive)"}
                >{r.takeHome ? formatDollars(r.remaining) : "—"}</span>
              </td>
            {/each}
          </tr>
          <tr>
            <td style="font-style: italic; color: var(--text-3)">
              Δ vs base<FootnoteRef topic="delta-vs-base" n={FN["delta-vs-base"]} onopen={openFootnote} />
            </td>
            {#each compareRows as r (r.ws.id)}
              <td class="bk-cell-num">
                {#if r.isBase}
                  <span class="bk-text-3">—</span>
                {:else}
                  <span
                    class="bk-num"
                    style:color={r.deltaRemaining >= 0 ? "var(--positive)" : "var(--negative)"}
                  >{formatDollars(r.deltaRemaining, { withSign: true })}</span>
                {/if}
              </td>
            {/each}
          </tr>
          <tr>
            <td>
              Effective rate<FootnoteRef topic="effective-rate" n={FN["effective-rate"]} onopen={openFootnote} />
            </td>
            {#each compareRows as r (r.ws.id)}
              <td class="bk-cell-num"><span class="bk-num">{r.takeHome ? `${(r.takeHome.effectiveTaxRate * 100).toFixed(1)}%` : "—"}</span></td>
            {/each}
          </tr>
        </tbody>
      </table>
    {/if}
  </EdSection>

  {#if compareRows.length >= 2}
    {@const best = [...compareRows].sort((a, b) => b.remaining - a.remaining)[0]}
    {#if best && !best.isBase && best.deltaRemaining > 0}
      {@const compounded30 = round2(best.deltaRemaining * 12 * 30 * 1.07)}
      <PullQuote attribution="Scenario math, this workspace">
        "A {formatDollarsWhole(best.deltaRemaining)}/mo delta on <em>{best.ws.name}</em> compounds to ~{formatDollarsWhole(compounded30)}<FootnoteRef topic="compounded-30" n={FN["compounded-30"]} onopen={openFootnote} /> by retirement at 7%."
      </PullQuote>
    {/if}
  {/if}

  <EdSection
    num={2}
    title="Sensitivity grid"
    deck="A 5×5 sweep of monthly remaining across primary × spouse annual gross. Red cells = expenses outpace take-home; green = surplus. Every cell uses the same formula — click for the breakdown."
  >
    <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: end; margin-bottom: 12px">
      <label class="bk-field" style="min-width: 110px">
        <span class="bk-field-label">Primary low</span>
        <input class="bk-input" data-testid="sens-primary-low" bind:value={sensitivityPrimaryLow} />
      </label>
      <label class="bk-field" style="min-width: 110px">
        <span class="bk-field-label">Primary high</span>
        <input class="bk-input" data-testid="sens-primary-high" bind:value={sensitivityPrimaryHigh} />
      </label>
      <label class="bk-field" style="min-width: 110px">
        <span class="bk-field-label">Spouse low</span>
        <input class="bk-input" data-testid="sens-spouse-low" bind:value={sensitivitySpouseLow} />
      </label>
      <label class="bk-field" style="min-width: 110px">
        <span class="bk-field-label">Spouse high</span>
        <input class="bk-input" data-testid="sens-spouse-high" bind:value={sensitivitySpouseHigh} />
      </label>
      <button
        type="button"
        class="bk-btn"
        data-testid="sens-recalc"
        disabled={sensitivityBusy}
        onclick={runSensitivity}
      >{sensitivityBusy ? "Computing…" : "Recalculate"}</button>
    </div>

    {#if sensitivityError}
      <p class="bk-text" style="color: var(--negative)" data-testid="sens-error">{sensitivityError}</p>
    {/if}

    {#if sensitivity}
      {@const maxAbs = Math.max(...sensitivity.grid.flat().map((v) => Math.abs(v)), 1)}
      <div style="display: flex; justify-content: flex-end; margin-bottom: 6px">
        <span class="bk-text-3" style="font-size: 12px; font-style: italic">
          Each cell<FootnoteRef topic="sensitivity" n={FN["sensitivity"]} onopen={openFootnote} /> = takeHome(primary, spouse) − monthly expenses
        </span>
      </div>
      <div style="overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius-sm)">
        <table class="bk-table" style="min-width: 540px" data-testid="sens-grid">
          <thead>
            <tr>
              <th style="color: var(--text-3); text-align: right; border-right: 1px solid var(--border)">primary &nbsp;\&nbsp; spouse →</th>
              {#each sensitivity.spouseAxisDollars as s (s)}
                <th class="bk-cell-num" data-testid={`sens-col-${s}`}><span class="bk-num">{formatDollarsWhole(s)}</span></th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each sensitivity.grid as row, i (i)}
              <tr>
                <th
                  style="text-align: right; color: var(--text-2); border-right: 1px solid var(--border)"
                  data-testid={`sens-row-${sensitivity.primaryAxisDollars[i]}`}
                >
                  <span class="bk-num">{formatDollarsWhole(sensitivity.primaryAxisDollars[i] ?? 0)}</span>
                </th>
                {#each row as cell, j (j)}
                  <td
                    class="bk-cell-num bk-num"
                    data-testid={`sens-cell-${i}-${j}`}
                    data-cents={cell}
                    style="text-align: center; font-weight: 600; border-left: 1px solid var(--border)"
                    style:background-color={cellColor(cell, maxAbs)}
                  >{formatDollarsWhole(cell)}</td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <div class="bk-text-3" style="margin-top: 10px; font-size: 12px; font-style: italic">
        Uses this workspace's expenses, tax settings, and pretax buckets.
      </div>
    {:else if !sensitivityBusy}
      <p class="bk-text" data-testid="sens-empty">Pick an active workspace (top right) and press Recalculate.</p>
    {/if}
  </EdSection>

  <EdSection
    num={3}
    title="Retirement projection"
    deck="Year-by-year balance growth from current age to retirement age. Contributions sum from this workspace's 401k / Roth-IRA / Roth-401k buckets."
  >
    <div style="display: grid; grid-template-columns: repeat(5, 1fr) auto; gap: 10px; margin-bottom: 22px; align-items: end">
      <label class="bk-field"><span class="bk-field-label">Current age</span>
        <input class="bk-input" data-testid="ret-current-age" bind:value={retirementAge} />
      </label>
      <label class="bk-field"><span class="bk-field-label">Retire at</span>
        <input class="bk-input" data-testid="ret-retire-age" bind:value={retireAtAge} />
      </label>
      <label class="bk-field"><span class="bk-field-label">Initial balance</span>
        <input class="bk-input" data-testid="ret-initial" bind:value={retirementInitial} />
      </label>
      <label class="bk-field"><span class="bk-field-label">Growth rate</span>
        <input class="bk-input" data-testid="ret-growth" bind:value={retirementGrowth} />
      </label>
      <label class="bk-field">
        <span class="bk-field-label">
          Roth split<FootnoteRef topic="roth-split" n={FN["roth-split"]} onopen={openFootnote} />
        </span>
        <input class="bk-input" data-testid="ret-roth-split" bind:value={retirementRothSplit} />
      </label>
      <button
        type="button"
        class="bk-btn bk-btn-primary"
        data-testid="ret-save"
        disabled={retirementBusy}
        onclick={saveAndRunRetirement}
      >{retirementBusy ? "Saving…" : "Save & project"}</button>
    </div>

    {#if retirementError}
      <p class="bk-text" style="color: var(--negative)" data-testid="ret-error">{retirementError}</p>
    {/if}

    {#if retirementProjection}
      {@const chart = buildChart(retirementProjection)}
      {@const annY = retirementProjection.years[chart.annIdx]}
      <div style="display: grid; grid-template-columns: repeat(3, 1fr); border-top: 1px solid var(--text); border-bottom: 1px solid var(--text); margin-bottom: 22px">
        <div style="padding: 18px 20px; border-right: 1px solid var(--border)" data-testid="ret-annual-contrib">
          <div class="ed-money-label">
            Annual contribution<FootnoteRef topic="retirement-annual" n={FN["retirement-annual"]} onopen={openFootnote} />
          </div>
          <div class="ed-money-val" style="font-size: 32px">{formatDollars(retirementProjection.annualContributionDollars)}</div>
        </div>
        <div style="padding: 18px 20px; border-right: 1px solid var(--border)" data-testid="ret-pretax">
          <div class="ed-money-label">
            Pre-tax @ retirement<FootnoteRef topic="retirement-pretax" n={FN["retirement-pretax"]} onopen={openFootnote} />
          </div>
          <div class="ed-money-val" style="font-size: 32px">{formatDollarsWhole(retirementProjection.preTaxAtRetirementDollars)}</div>
        </div>
        <div style="padding: 18px 20px" data-testid="ret-aftertax">
          <div class="ed-money-label">
            After-tax @ retirement<FootnoteRef topic="retirement-aftertax" n={FN["retirement-aftertax"]} onopen={openFootnote} />
          </div>
          <div class="ed-money-val" style="font-size: 32px; color: var(--positive)">{formatDollarsWhole(retirementProjection.afterTaxAtRetirementDollars)}</div>
        </div>
      </div>

      <div style="position: relative">
        <svg
          viewBox={`0 0 ${W} ${H + 36}`}
          style="width: 100%; height: auto; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm)"
          aria-label="Retirement balance projection over time"
          data-testid="ret-chart"
          data-pretax-cents={retirementProjection.preTaxAtRetirementDollars}
          data-aftertax-cents={retirementProjection.afterTaxAtRetirementDollars}
          data-y-max={chart.yMax}
        >
          {#each [0.25, 0.5, 0.75, 1] as f (f)}
            {@const y = H - f * (H - 30) - 14}
            <line x1="0" x2={W} y1={y} y2={y} stroke="var(--border)" stroke-dasharray="2 4" />
            <text x={W - 6} y={y - 4} fill="var(--text-3)" font-size="11" text-anchor="end" font-family="var(--font-num)">
              {formatDollarsWhole(chart.yMax * f)}
            </text>
          {/each}
          <path d={chart.areaPath} fill="var(--accent)" opacity="0.10" />
          <polyline class="line" points={chart.trad} fill="none" stroke="var(--warning)" stroke-width="2" />
          <polyline class="line" points={chart.roth} fill="none" stroke="var(--info)" stroke-width="2" />
          <polyline class="line" points={chart.total} fill="none" stroke="var(--positive)" stroke-width="2.5" />
          {#if annY}
            <g>
              <circle cx={chart.toX(chart.annIdx)} cy={chart.toY(annY.totalDollars)} r="5" fill="var(--positive)" stroke="var(--bg)" stroke-width="2" />
              <line
                x1={chart.toX(chart.annIdx)} x2={chart.toX(chart.annIdx)}
                y1={chart.toY(annY.totalDollars) - 6} y2={chart.toY(annY.totalDollars) - 50}
                stroke="var(--text-2)" stroke-dasharray="2 3"
              />
              <text x={chart.toX(chart.annIdx)} y={chart.toY(annY.totalDollars) - 56} fill="var(--text)" font-size="13" font-family="var(--font-display)" text-anchor="middle">
                age {annY.age}
              </text>
              <text x={chart.toX(chart.annIdx)} y={chart.toY(annY.totalDollars) - 70} fill="var(--text-2)" font-size="11" font-family="var(--font-num)" text-anchor="middle">
                {formatDollarsWhole(annY.totalDollars)}
              </text>
            </g>
          {/if}
          <text x="6" y={H + 22} fill="var(--text-3)" font-size="11" font-family="var(--font-num)">
            age {retirementProjection.years[0]?.age}
          </text>
          <text x={W - 6} y={H + 22} fill="var(--text-3)" font-size="11" font-family="var(--font-num)" text-anchor="end">
            age {retirementProjection.years[retirementProjection.years.length - 1]?.age}
          </text>
        </svg>
      </div>

      <div style="display: flex; gap: 18px; margin-top: 12px; font-size: 12px; color: var(--text-2)">
        <span style="display: flex; align-items: center; gap: 6px"><i style="width: 14px; height: 2px; background: var(--positive); display: inline-block"></i>Total balance</span>
        <span style="display: flex; align-items: center; gap: 6px"><i style="width: 14px; height: 2px; background: var(--warning); display: inline-block"></i>Traditional (pre-tax)</span>
        <span style="display: flex; align-items: center; gap: 6px"><i style="width: 14px; height: 2px; background: var(--info); display: inline-block"></i>Roth (post-tax)</span>
      </div>
    {:else if !retirementBusy}
      <p class="bk-text" data-testid="ret-empty">No projection yet — set values above and press Save &amp; project.</p>
    {/if}
  </EdSection>

  <div class="ed-footnotes" data-testid="footnotes">
    <div><b>[{FN["gross-taxed-annual"]}] Annual gross (taxed).</b> Σ income.grossAnnualDollars where taxStatus='taxed', per workspace.</div>
    <div><b>[{FN["federal-tax"]}] Federal tax.</b> Progressive bracket math on (taxedGross − pretax) using 2025 federal brackets at this workspace's filing status.</div>
    <div><b>[{FN["ca-tax"]}] CA state tax.</b> CA progressive brackets + CA-SDI surcharge on the same base.</div>
    <div><b>[{FN["fica"]}] FICA.</b> grossTaxed × 7.65% (6.2% SS + 1.45% Medicare).</div>
    <div><b>[{FN["monthly-expenses"]}] Monthly expenses.</b> Σ freqToMonthly(expense) per workspace.</div>
    <div><b>[{FN["monthly-remaining"]}] Monthly remaining.</b> monthlyTakeHome − monthlyExpenses per workspace.</div>
    <div><b>[{FN["delta-vs-base"]}] Δ vs base.</b> thisWorkspace.monthlyRemaining − baseWorkspace.monthlyRemaining (base = Current).</div>
    <div><b>[{FN["effective-rate"]}] Effective rate.</b> (fed + ca + fica + caSdi) ÷ grossTaxed annual.</div>
    <div><b>[{FN["compounded-30"]}] 30-year compounded delta.</b> Δ_monthly × 12 × 30 × 1.07 — rough projection at 7%.</div>
    <div><b>[{FN["sensitivity"]}] Sensitivity cells.</b> For each (primary, spouse) pair: computeTakeHome(...) − monthlyExpenses.</div>
    <div><b>[{FN["roth-split"]}] Roth split.</b> Fraction of new contributions routed to Roth (post-tax) vs Traditional (pre-tax).</div>
    <div><b>[{FN["retirement-annual"]}] Annual retirement contribution.</b> Σ savings.monthlyContributionDollars (401k / Roth IRA / Roth 401k rows) × 12.</div>
    <div><b>[{FN["retirement-pretax"]}] Pre-tax @ retirement.</b> Initial balance compounded for (retirementAge − currentAge) years at growthRate, plus annual contribution per year (split traditional/roth by rothSplitPct).</div>
    <div><b>[{FN["retirement-aftertax"]}] After-tax @ retirement.</b> preTax − (traditionalBalance × ~22% effective-rate proxy). Replace with bracket math at retirement age when it ships.</div>
    <div style="margin-top: 8px"><em>Click any bracketed numeral to see the exact formula and trace it back to the raw inputs.</em></div>
  </div>
</article>
