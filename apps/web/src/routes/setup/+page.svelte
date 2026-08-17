<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import {
    api,
    type LlamaStatus,
    type SetupStatus,
    type LlamaModelsResponse,
    type TaxTable,
  } from "$lib/api.js";
  import { CATEGORIES } from "$lib/helpers.js";
  import { setShellPref } from "$lib/appShellState.svelte.js";

  import PageHead from "$lib/components/PageHead.svelte";
  import EdSection from "$lib/components/EdSection.svelte";
  import StatusDot from "$lib/components/StatusDot.svelte";
  import Badge from "$lib/components/Badge.svelte";
  import Icon from "$lib/components/Icon.svelte";

  let llama = $state<LlamaStatus | null>(null);
  let llamaError = $state<string | null>(null);
  let llamaBusy = $state(false);

  let setup = $state<SetupStatus | null>(null);
  let setupError = $state<string | null>(null);
  let setupPoll: ReturnType<typeof setInterval> | null = null;
  /** Which model id the active/most-recent setup download targeted (for the
   *  per-model "Downloading…" label). */
  let setupModelId = $state<string | null>(null);

  let models = $state<LlamaModelsResponse | null>(null);
  let modelError = $state<string | null>(null);
  /** No GGUF on disk yet ⇒ the one-click setup IS the primary action here. */
  const anyModelPresent = $derived(!!models?.models.some((m) => m.present));

  // Tax-table state: sourced ENTIRELY from list_tax_tables (the DB), never
  // hardcoded. The dropdowns enumerate only the (year, jurisdiction, filing)
  // combinations that actually exist; the bracket table renders from the
  // matching DB row. When the chosen combo is absent, we surface the
  // assistant fetch-and-import flow as the call to action.
  let taxTables = $state<TaxTable[]>([]);
  let taxTablesError = $state<string | null>(null);
  let taxTablesLoaded = $state(false);

  let taxYear = $state<number | null>(null);
  // jurisdiction is the real axis the DB indexes on ('federal' | 'ca'), not a
  // free-text US state — the engine + schema only model federal + California.
  let taxJurisdiction = $state<"federal" | "ca">("federal");
  let filingStatus = $state<"single" | "mfj">("mfj");

  /** Prompt copied to the assistant for the fetch-and-import flow. */
  let copiedPrompt = $state(false);
  let copyHandle: ReturnType<typeof setTimeout> | null = null;

  async function refreshTaxTables(): Promise<void> {
    try {
      const r = await api.listTaxTables();
      taxTables = r.tables;
      taxTablesError = null;
      // Seed the dropdowns from real data: prefer the latest year present,
      // and a jurisdiction/filing that actually exists for it.
      if (taxYear === null && r.years.length > 0) {
        taxYear = r.years[r.years.length - 1]!;
      }
      // If the current jurisdiction/filing/year combo isn't present but some
      // row is, snap to the first available so the table isn't blank on load.
      if (taxYear !== null && !taxTables.some((t) => t.year === taxYear)) {
        const firstForJurisdiction = taxTables.find((t) => t.jurisdiction === taxJurisdiction);
        taxYear = (firstForJurisdiction ?? taxTables[0])?.year ?? taxYear;
      }
    } catch (e) {
      taxTablesError = (e as Error).message;
    } finally {
      taxTablesLoaded = true;
    }
  }

  async function refreshLlama(): Promise<void> {
    try {
      llama = await api.llama.status();
      llamaError = null;
    } catch (e) {
      llamaError = (e as Error).message;
    }
  }

  async function refreshModels(): Promise<void> {
    try {
      models = await api.llama.models();
      modelError = null;
    } catch (e) {
      modelError = (e as Error).message;
    }
  }

  async function refreshSetup(): Promise<void> {
    try {
      setup = await api.llama.setupStatus();
      if (setup.overall !== "running" && setupPoll) {
        clearInterval(setupPoll);
        setupPoll = null;
        if (setup.overall === "done") {
          await refreshLlama();
          // A new GGUF may now be present — refresh the picker so the newly
          // downloaded model shows as available and selectable.
          await refreshModels();
        }
      }
    } catch (e) {
      setupError = (e as Error).message;
    }
  }

  /** Download a specific registered model (defaults to the 2B if unset). */
  async function startSetup(modelId?: string): Promise<void> {
    setupError = null;
    setupModelId = modelId ?? null;
    try {
      const r = await api.llama.setupStart(modelId ? { model: modelId } : undefined);
      setup = r.state;
      if (!setupPoll) setupPoll = setInterval(refreshSetup, 1000);
    } catch (e) {
      setupError = (e as Error).message;
    }
  }

  /** Switch inference onto a downloaded model: persists it + restarts. */
  async function selectModel(modelId: string): Promise<void> {
    modelError = null;
    llamaBusy = true;
    try {
      await api.llama.select(modelId);
      await Promise.all([refreshLlama(), refreshModels()]);
    } catch (e) {
      modelError = (e as Error).message;
    } finally {
      llamaBusy = false;
    }
  }

  async function actLlama(action: "start" | "stop" | "restart"): Promise<void> {
    llamaBusy = true;
    try {
      await api.llama[action]();
      await refreshLlama();
    } catch (e) {
      llamaError = (e as Error).message;
    } finally {
      llamaBusy = false;
    }
  }

  async function updateLlama(): Promise<void> {
    llamaBusy = true;
    try {
      const r = await api.llama.update({ dryRun: true });
      llamaError = `Update check (dry-run): tag=${r.tag} asset=${r.assetName}`;
    } catch (e) {
      llamaError = `Update failed: ${(e as Error).message}`;
    } finally {
      llamaBusy = false;
    }
  }

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  onMount(() => {
    void refreshLlama();
    void refreshModels();
    void refreshTaxTables();
    void refreshSetup().then(() => {
      if (setup && setup.overall === "running" && !setupPoll) {
        setupPoll = setInterval(refreshSetup, 1000);
      }
    });
  });

  onDestroy(() => {
    if (setupPoll) clearInterval(setupPoll);
    if (copyHandle) clearTimeout(copyHandle);
  });

  // ---- Derived dropdown options + selected row, ALL from real DB rows. ----
  const availableYears = $derived(
    [...new Set(taxTables.map((t) => t.year))].sort((a, b) => a - b),
  );
  /** Jurisdictions present for the chosen year. */
  const availableJurisdictions = $derived(
    [...new Set(taxTables.filter((t) => t.year === taxYear).map((t) => t.jurisdiction))],
  );
  /** Filing statuses present for the chosen year + jurisdiction. */
  const availableFilings = $derived(
    [
      ...new Set(
        taxTables
          .filter((t) => t.year === taxYear && t.jurisdiction === taxJurisdiction)
          .map((t) => t.filing),
      ),
    ],
  );
  /** The DB row matching the current (year, jurisdiction, filing), or null. */
  const selectedTable = $derived(
    taxTables.find(
      (t) => t.year === taxYear && t.jurisdiction === taxJurisdiction && t.filing === filingStatus,
    ) ?? null,
  );

  const JURISDICTION_LABELS: Record<"federal" | "ca", string> = {
    federal: "Federal",
    ca: "California (FTB)",
  };
  const FILING_LABELS: Record<"single" | "mfj", string> = {
    single: "Single",
    mfj: "Married filing jointly",
  };

  function fmtMoney(n: number): string {
    return `$${Math.round(n).toLocaleString("en-US")}`;
  }

  /** Render a DB bracket row's range as a human string ($lo — $hi / $lo +). */
  function bracketRange(brackets: TaxTable["brackets"], idx: number): string {
    const lo = idx === 0 ? 0 : (brackets[idx - 1]!.upTo ?? 0) + 1;
    const cur = brackets[idx]!;
    if (cur.upTo === null) return `${fmtMoney(lo)} +`;
    return `${fmtMoney(lo)} — ${fmtMoney(cur.upTo)}`;
  }

  /** Build the assistant prompt for fetching+importing a missing combo. */
  function buildImportPrompt(): string {
    const source = taxJurisdiction === "federal" ? "irs" : "ca_ftb";
    const filingLabel = FILING_LABELS[filingStatus];
    return (
      `Fetch the ${taxYear} ${JURISDICTION_LABELS[taxJurisdiction]} tax brackets and standard deduction for ${filingLabel} filers, ` +
      `then import them. Use fetch_tax_source_by_year with source="${source}" and year=${taxYear}, ` +
      `parse the official numbers, preview them with import_tax_table dryRun:true, and write them after I confirm.`
    );
  }

  /** F3d: deep-link the fetch-and-import flow into the assistant. There is no
   *  global "send to chat" channel today, so we open the chat panel and copy a
   *  prefilled prompt to the clipboard for the user to paste (a copy-to-chat
   *  affordance, the documented fallback when no programmatic-prompt mechanism
   *  exists). */
  async function sendToAssistant(): Promise<void> {
    setShellPref("chatOpen", true);
    try {
      await navigator.clipboard.writeText(buildImportPrompt());
      copiedPrompt = true;
      if (copyHandle) clearTimeout(copyHandle);
      copyHandle = setTimeout(() => (copiedPrompt = false), 4000);
    } catch {
      // Clipboard may be unavailable (insecure context / denied permission).
      // The prompt is still shown in the textarea below for manual copy.
      copiedPrompt = false;
    }
  }
</script>

<article class="ed-article">
  <PageHead
    section="Section VII"
    kicker="The Workshop"
    title="System"
    rightLabel="Setup"
    byline="Local assistant, database, and tax tables. Everything below lives on this machine — nothing leaves it. Statement imports moved to the Import tab."
  />

  <EdSection
    num={1}
    title="Local assistant"
    deck="Conversational interface to your budget. Runs on llama.cpp; takes a one-time download to set up."
  >
    <div data-testid="llama-panel">
      <div
        style="display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 18px; border-bottom: 1px solid var(--border); padding-bottom: 14px"
        data-testid="llama-status"
      >
        {#if llama}
          <div style="display: flex; gap: 10px; align-items: center">
            <StatusDot status={llama.status} />
            <span style="font-family: var(--font-display); font-size: 22px; font-weight: 500">{llama.status}</span>
          </div>
          <span class="ed-stat-inline">
            <span class="label">Backend</span>
            <span class="val" data-testid="llama-backend">{llama.backendMode}</span>
          </span>
          <span class="ed-stat-inline">
            <span class="label">Port</span>
            <span class="val bk-num" style="font-size: 18px">{llama.url.split(":").pop()}</span>
          </span>
          {#if llama.pid !== null}
            <span class="ed-stat-inline">
              <span class="label">PID</span>
              <span class="val bk-num" style="font-size: 18px">{llama.pid}</span>
            </span>
          {/if}
          {#if llama.external}
            <Badge>external</Badge>
          {/if}
        {:else if llamaError}
          <p class="bk-text" style="color: var(--negative); margin: 0">{llamaError}</p>
        {:else}
          <p class="bk-text" style="margin: 0">Loading status…</p>
        {/if}
      </div>

      {#if llama?.backendWarning}
        <p class="bk-text" style="color: var(--warning); margin: -8px 0 14px; font-size: 13px" data-testid="llama-backend-warning">{llama.backendWarning}</p>
      {/if}
      {#if llama?.action}
        <!-- The launcher ran out of rungs: every model on disk needs a GPU and
             the GPU is unavailable. Offer the one download that fixes it rather
             than leaving the user to read a stderr tail. -->
        <div
          data-testid="llama-action"
          style="display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin: 0 0 14px; padding: 12px 14px; border: 1px solid var(--warning); border-radius: 10px"
        >
          <p class="bk-text" style="margin: 0; flex: 1; min-width: 260px; font-size: 13px">{llama.action.message}</p>
          <button
            type="button"
            class="bk-btn bk-btn-sm"
            data-testid="llama-action-install"
            disabled={setup?.overall === "running"}
            onclick={() => startSetup(llama!.action!.modelId)}
          >
            <Icon name="download" size={12} />
            {setup?.overall === "running" ? "Downloading…" : `Install ${llama.action.label}`}
          </button>
        </div>
      {:else if llama?.error}
        <p class="bk-text" style="color: var(--negative); margin: 0 0 14px" data-testid="llama-error">{llama.error}</p>
      {/if}

      <div class="bk-toolbar" style="margin-bottom: 18px">
        <button class="bk-btn bk-btn-sm" data-testid="llama-start" disabled={llamaBusy} onclick={() => actLlama("start")}>
          <Icon name="play" size={12} /> Start
        </button>
        <button class="bk-btn bk-btn-sm" data-testid="llama-stop" disabled={llamaBusy} onclick={() => actLlama("stop")}>
          <Icon name="stop" size={12} /> Stop
        </button>
        <button class="bk-btn bk-btn-sm" data-testid="llama-restart" disabled={llamaBusy} onclick={() => actLlama("restart")}>
          <Icon name="refresh" size={12} /> Restart
        </button>
        <button class="bk-btn bk-btn-sm" data-testid="llama-update" disabled={llamaBusy} onclick={updateLlama}>
          <Icon name="refresh" size={12} /> Check for update
        </button>
        <button class="bk-btn bk-btn-sm bk-btn-ghost" data-testid="llama-refresh" onclick={refreshLlama}>Refresh status</button>
      </div>

      <div data-testid="model-picker" style="margin-bottom: 22px; border-bottom: 1px solid var(--border); padding-bottom: 18px">
        <div class="bk-eyebrow" style="margin-bottom: 10px">Model</div>
        {#if modelError}
          <p class="bk-text" style="color: var(--negative); margin: 0 0 10px" data-testid="model-error">{modelError}</p>
        {/if}
        {#if models}
          <div style="display: flex; flex-direction: column; gap: 10px">
            {#each models.models as m (m.id)}
              <div
                data-testid={`model-row-${m.id}`}
                data-present={m.present}
                data-selected={models.selected === m.id}
                style="display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 10px 14px; border: 1px solid var(--border); border-radius: 10px; background: {models.selected === m.id ? 'var(--surface)' : 'transparent'}"
              >
                <label style="display: inline-flex; align-items: center; gap: 10px; cursor: {m.present ? 'pointer' : 'not-allowed'}; flex: 1; min-width: 240px">
                  <input
                    type="radio"
                    name="llama-model"
                    value={m.id}
                    checked={models.selected === m.id}
                    disabled={!m.present || llamaBusy}
                    data-testid={`model-select-${m.id}`}
                    onchange={() => selectModel(m.id)}
                  />
                  <span>
                    <span style="font-family: var(--font-display); font-size: 16px; font-weight: 500">{m.label}</span>
                    {#if m.sizeRank > 1}<Badge>smarter</Badge>{:else}<Badge>lighter</Badge>{/if}
                    {#if models.recommended === m.id}<Badge>recommended</Badge>{/if}
                    <span class="bk-text-3" style="display: block; font-size: 12px; margin-top: 2px">{m.blurb}</span>
                  </span>
                </label>
                {#if m.present}
                  <span class="ed-stat-inline" data-testid={`model-present-${m.id}`}>
                    <span class="val" style="color: var(--positive)">downloaded</span>
                  </span>
                {:else}
                  <button
                    type="button"
                    class="bk-btn bk-btn-sm"
                    data-testid={`model-download-${m.id}`}
                    disabled={setup?.overall === "running"}
                    onclick={() => startSetup(m.id)}
                  >
                    <Icon name="download" size={12} />
                    {setup?.overall === "running" && setupModelId === m.id ? "Downloading…" : `Download (${m.label})`}
                  </button>
                {/if}
              </div>
            {/each}
          </div>
          {#if models.recommendedReason}
            <p class="bk-text-3" style="font-size: 12px; margin-top: 10px" data-testid="model-recommendation">
              {models.recommendedReason}
            </p>
          {/if}
          <p class="bk-text-3" style="font-size: 12px; margin-top: 6px; font-style: italic">
            Selecting a downloaded model restarts the assistant onto it and remembers it for next launch. If both are present, the larger (smarter) model is the default.
          </p>
        {:else}
          <p class="bk-text" style="margin: 0">Loading models…</p>
        {/if}
      </div>

      <div class="ed-cols" data-cols="2">
        <div data-testid="setup-pane">
          <div class="bk-eyebrow" style="margin-bottom: 10px; display: inline-flex; align-items: center; gap: 6px">
            <Icon name="sparkles" size={13} /> One-click setup
          </div>
          <p class="bk-text" style="margin-bottom: 14px">
            Downloads the latest llama.cpp build (Vulkan-preferred, CUDA / CPU fallback), then the bundled Qwen3.5‑2B‑MTP GGUF. Re-runs are idempotent — skips anything already on disk. Use the per-model Download buttons above to also fetch the smarter 4B.
          </p>

          {#if setup}
            <div style="display: flex; flex-direction: column; gap: 10px" data-testid="setup-steps">
              {#each [setup.step1, setup.step2] as step, i (i)}
                <div style="margin-bottom: 6px" data-testid={`setup-step-${i + 1}`} data-status={step.status}>
                  <div style="display: flex; gap: 8px; align-items: baseline; font-size: 12px; margin-bottom: 4px">
                    <span class="bk-text-3" style="font-style: italic">Step {i + 1}</span>
                    <span style="flex: 1; font-family: var(--font-display); font-size: 14px">{step.name}</span>
                    <span class="bk-num" data-testid={`setup-step-${i + 1}-percent`}>{step.percent}%</span>
                  </div>
                  <div class="bk-progress" data-status={step.status}><i style:width="{step.percent}%"></i></div>
                  {#if step.message}
                    <div class="bk-text-3" style="font-size: 11px; margin-top: 4px" data-testid={`setup-step-${i + 1}-message`}>{step.message}</div>
                  {/if}
                  {#if step.bytesTotal > 0 && step.status !== "done"}
                    <div class="bk-text-3 bk-num" style="font-size: 11px">
                      {formatBytes(step.bytesDone)} / {formatBytes(step.bytesTotal)}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
            {#if setup.overall === "done"}
              <p class="bk-text" style="color: var(--positive); margin-top: 8px" data-testid="setup-done">
                All set. Click Start to launch llama-server.
              </p>
            {:else if setup.overall === "error"}
              <p class="bk-text" style="color: var(--negative); margin-top: 8px" data-testid="setup-overall-error">{setup.error}</p>
            {/if}
          {/if}

          {#if setupError}
            <p class="bk-text" style="color: var(--negative); margin: 8px 0" data-testid="setup-error">{setupError}</p>
          {/if}

          <button
            type="button"
            class="bk-btn bk-btn-sm {anyModelPresent ? '' : 'bk-btn-primary'}"
            style="margin-top: 10px"
            data-testid="setup-start"
            disabled={setup?.overall === "running"}
            onclick={() => startSetup()}
          >
            <Icon name={anyModelPresent ? "refresh" : "download"} size={12} />
            {setup?.overall === "running" ? "Running…" : setup?.overall === "done" ? "Re-run setup" : "Set up local LLM"}
          </button>
          {#if setup?.overall === "error" || setup?.overall === "done"}
            <button
              type="button"
              class="bk-btn bk-btn-sm"
              style="margin-top: 10px; margin-left: 8px"
              data-testid="setup-reset"
              onclick={async () => {
                setupError = null;
                try {
                  await api.llama.setupReset();
                  await refreshSetup();
                } catch (e) {
                  setupError = (e as Error).message;
                }
              }}
              title="Clear the finished/failed setup state so the pipeline can be re-run from scratch"
            >
              Reset setup state
            </button>
          {/if}
        </div>
        <div>
          <div class="bk-eyebrow" style="margin-bottom: 10px">Tips</div>
          <p class="bk-text" style="margin-bottom: 8px">
            Sampler + binary settings (temperature, top‑K, top‑P, context length, GPU layers, etc.) come from <code class="bk-mono">llama_profiles</code> and are editable via the API.
          </p>
          <p class="bk-text">
            In dev mode (<code class="bk-mono">LLAMA_SERVER_URL</code> set) the launcher reports "external" and won't spawn a subprocess.
          </p>
          <p class="bk-text" style="margin-top: 8px">
            A live activity log lands with M11 — for now, check <code class="bk-mono">./data/llama-server.log</code> directly.
          </p>
          <p class="bk-text" style="margin-top: 8px">
            If setup wedges mid-run (stuck on "running"), force-reset it:
            <code class="bk-mono">POST /api/llama/setup/reset</code> with <code class="bk-mono">{'{'}"force":true{'}'}</code>.
          </p>
        </div>
      </div>
    </div>
  </EdSection>

  <EdSection
    num={2}
    title="Database backup & restore"
    deck="Versioned .db bundles with SHA-256 manifests. Imports auto-backup the live DB to ./data/backups before swapping."
  >
    <p class="bk-text">
      <strong>Export</strong> writes a versioned <code class="bk-mono">.db</code> + sidecar JSON manifest under <code class="bk-mono">./data/exports/</code>.
      <strong>Import</strong> validates the manifest (schema_version, SHA-256, size), auto-backs up the current DB to
      <code class="bk-mono">./data/backups/</code>, then atomically swaps via rename-aside.
    </p>
    <p class="bk-text" style="margin-top: 8px">
      Use the CLIs for now: <code class="bk-mono">pnpm --filter @budgetkit/api db:export</code> and
      <code class="bk-mono">db:import &lt;bundle&gt;</code>. UI lands with M11.
    </p>
  </EdSection>

  <EdSection
    num={3}
    title="Tax tables"
    deck="Brackets the app actually has on hand. The dropdowns list only the years, jurisdictions, and filing statuses present in the database; values below come straight from those rows."
  >
    <div data-testid="tax-tables-panel">
      {#if taxTablesError}
        <p class="bk-text" style="color: var(--negative); margin: 0 0 14px" data-testid="tax-tables-error">{taxTablesError}</p>
      {:else if !taxTablesLoaded}
        <p class="bk-text" style="margin: 0">Loading tax tables…</p>
      {:else if taxTables.length === 0}
        <p class="bk-text" data-testid="tax-tables-empty">
          No tax tables are loaded yet. Use the assistant to fetch and import a year — pick a year, jurisdiction, and filing status once tables exist, or ask the assistant directly: "Fetch the 2025 federal tax brackets from the IRS and import them."
        </p>
      {:else}
        <div class="ed-cols" data-cols="2">
          <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; align-content: start">
            <label class="bk-field">
              <span class="bk-field-label">Tax year</span>
              <select class="bk-select" data-testid="tax-year-select" bind:value={taxYear}>
                {#each availableYears as y (y)}<option value={y}>{y}</option>{/each}
              </select>
            </label>
            <label class="bk-field">
              <span class="bk-field-label">Jurisdiction</span>
              <select class="bk-select" data-testid="tax-jurisdiction-select" bind:value={taxJurisdiction}>
                {#each availableJurisdictions as j (j)}<option value={j}>{JURISDICTION_LABELS[j]}</option>{/each}
              </select>
            </label>
            <label class="bk-field">
              <span class="bk-field-label">Filing status</span>
              <select class="bk-select" data-testid="tax-filing-select" bind:value={filingStatus}>
                {#each availableFilings as f (f)}<option value={f}>{FILING_LABELS[f]}</option>{/each}
              </select>
            </label>
          </div>
          <div>
            {#if selectedTable}
              <div class="bk-eyebrow" style="margin-bottom: 10px">
                {selectedTable.year} {JURISDICTION_LABELS[selectedTable.jurisdiction]} brackets · {FILING_LABELS[selectedTable.filing]}
              </div>
              <table class="bk-table" data-testid="tax-bracket-table">
                <tbody>
                  {#each selectedTable.brackets as b, i (i)}
                    <tr>
                      <td class="bk-num" style="font-weight: 600; color: var(--accent)">{(b.rate * 100).toFixed(b.rate * 100 % 1 === 0 ? 0 : 1)}%</td>
                      <td class="bk-num">{bracketRange(selectedTable.brackets, i)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
              <p class="bk-text-3" style="margin-top: 8px; font-size: 12px">
                Standard deduction: <span class="bk-num">{fmtMoney(selectedTable.standardDeductionDollars)}</span>
              </p>
            {:else}
              <div class="bk-eyebrow" style="margin-bottom: 10px">Not loaded</div>
              <p class="bk-text" data-testid="tax-bracket-missing">
                No brackets for {taxYear} {JURISDICTION_LABELS[taxJurisdiction]} ({FILING_LABELS[filingStatus]}) are loaded yet.
                Have the assistant fetch them from the official source and import them — it predicts the IRS/FTB page for the year, parses the brackets, previews them for your confirmation, then writes the row.
              </p>
              <button
                type="button"
                class="bk-btn bk-btn-sm bk-btn-primary"
                style="margin-top: 10px"
                data-testid="tax-fetch-cta"
                onclick={() => void sendToAssistant()}
              >
                <Icon name="sparkles" size={12} />
                {copiedPrompt ? "Copied — paste into the assistant →" : `Fetch ${taxYear} from ${taxJurisdiction === "federal" ? "IRS" : "FTB"} via the assistant`}
              </button>
              <p class="bk-text-3" style="margin-top: 8px; font-size: 12px; font-style: italic">
                Opens the assistant and copies a ready-to-send prompt to your clipboard. Paste it into the chat and confirm the preview to write the row.
              </p>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  </EdSection>

  <EdSection
    num={4}
    title="Categories"
    deck={`${CATEGORIES.length} active. Recurring detection will reuse these for auto-categorization.`}
  >
    <div style="display: flex; flex-wrap: wrap; gap: 8px">
      {#each CATEGORIES as c (c.id)}
        <span
          style="display: inline-flex; align-items: center; gap: 8px; padding: 6px 14px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--border); font-size: 13px; font-family: var(--font-display)"
        >
          <span style:background={c.color} style="width: 9px; height: 9px; border-radius: 50%"></span>
          {c.name}
        </span>
      {/each}
    </div>
    <p class="bk-text-3" style="margin-top: 12px; font-size: 12px; font-style: italic">
      Category editor lands with M11; for now this is the seeded set.
    </p>
  </EdSection>

  <div class="ed-footnotes">
    <div>
      <b>Privacy.</b> Personal financial data lives in
      <code>./data/budgetkit.db</code>, which is git-ignored. The assistant runs locally; no statement contents leave this machine.
    </div>
    <div>
      <b>External assistant.</b> If you set <code>LLAMA_SERVER_URL</code>, the launcher reports "external" and won't spawn a subprocess — useful for dev mode.
    </div>
  </div>
</article>
