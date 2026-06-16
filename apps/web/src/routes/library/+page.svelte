<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import {
    api,
    type CatalogueCandidate,
    type CatalogueResult,
    type StatementFileRich,
  } from "$lib/api.js";
  import { workspaceState } from "$lib/workspace.svelte.js";
  import { invalidateResources, onInvalidate } from "$lib/appShellState.svelte.js";

  import PageHead from "$lib/components/PageHead.svelte";
  import LibraryStats from "$lib/components/library/LibraryStats.svelte";
  import LibraryPhases from "$lib/components/library/LibraryPhases.svelte";
  import LibraryBrowse from "$lib/components/library/LibraryBrowse.svelte";
  import LibraryPreview from "$lib/components/library/LibraryPreview.svelte";
  import LibraryConfirm from "$lib/components/library/LibraryConfirm.svelte";
  import StatementDetail from "$lib/components/library/StatementDetail.svelte";

  type Phase = "browse" | "preview" | "confirm";
  type Issuer = "chase" | "amex_gold" | "amex_plat" | "unknown";

  const ws = workspaceState();

  // ── Server state ─────────────────────────────────────────────────────
  let files = $state<StatementFileRich[]>([]);
  let filesLoading = $state(true);
  let filesError = $state<string | null>(null);

  let preview = $state<CatalogueResult | null>(null);
  let previewLoading = $state(false);

  let commitBusy = $state(false);
  let commitError = $state<string | null>(null);
  let lastCommitCount = $state<number | null>(null);
  let lastCommitErrors = $state<CatalogueResult["parseErrors"]>([]);
  let lastCommitDups = $state<NonNullable<CatalogueResult["skippedDuplicates"]>>([]);
  // Inline notice for non-error feedback (e.g. ignore-not-applicable). Distinct
  // from filesError/commitError so it can use a neutral tone.
  let filesNotice = $state<string | null>(null);

  // ── Phase machine + selection state ──────────────────────────────────
  let phase = $state<Phase>("browse");
  let selectedIds = $state<Set<string>>(new Set());
  // Holds candidate identities (candidateId, H5) for rows the user accepted.
  // Translated back into candidateKey() wire-format strings at commit time —
  // the server still filters by ${label}|${sourceAccount}|${amountDollars}|${frequency}.
  let acceptedKeys = $state<Set<string>>(new Set());
  let detailId = $state<string | null>(null);

  // ── Workspace-switch correctness (C4) ────────────────────────────────
  // Generation counter so a refreshFiles() resolving after the user switched
  // workspaces can't clobber the newer workspace's file list.
  let wsGen = 0;

  // ── Browse filters / view state ──────────────────────────────────────
  let grouped = $state(true);
  let issuerFilter = $state<Set<Issuer>>(new Set(["chase", "amex_gold", "amex_plat", "unknown"]));
  let statusFilter = $state<"all" | "parsed" | "unparsed" | "error" | "ignored">("all");
  let periodFilter = $state<"all" | "30d" | "90d" | "6mo" | "12mo">("all");
  let search = $state("");
  let sortBy = $state<"period" | "txns" | "issuer" | "size">("period");
  let sortDir = $state<"asc" | "desc">("desc");

  // ── Loaders ──────────────────────────────────────────────────────────
  async function refreshFiles(): Promise<void> {
    const gen = ++wsGen;
    filesLoading = true;
    filesError = null;
    try {
      const r = await api.listStatementsRich();
      if (gen !== wsGen) return;
      files = r.files;
    } catch (e) {
      if (gen !== wsGen) return;
      filesError = (e as Error).message;
    } finally {
      if (gen === wsGen) filesLoading = false;
    }
  }

  async function runPreview(): Promise<void> {
    if (selectedIds.size === 0) return;
    const paths = files.filter((f) => selectedIds.has(f.id)).map((f) => f.relativePath);
    previewLoading = true;
    commitError = null;
    // Re-entering preview with a fresh selection: the prior commit banner is
    // stale (OP-W03). Clear it so a "Committed N" / "No new lines" note can't
    // linger over a new candidate set.
    lastCommitCount = null;
    lastCommitErrors = [];
    lastCommitDups = [];
    try {
      const r = await api.catalogueExpenses({
        statementPaths: paths,
        commit: false,
      });
      preview = r;
      // Seed acceptedKeys with high-signal defaults: recurring + fees. Identity
      // is the stable candidateId (H5), not candidateKey().
      acceptedKeys = new Set(
        r.candidates
          .filter((c) => c.seedReason === "repeated" || c.seedReason === "both" || c.feeKind)
          .map((c) => c.candidateId),
      );
      phase = "preview";
    } catch (e) {
      commitError = (e as Error).message;
    } finally {
      previewLoading = false;
    }
  }

  async function commit(): Promise<void> {
    if (!preview || acceptedKeys.size === 0) return;
    if (ws.activeId == null) {
      commitError = "No active workspace — pick one before committing.";
      return;
    }
    const paths = files.filter((f) => selectedIds.has(f.id)).map((f) => f.relativePath);
    // Send the stable candidateId values directly (H5). The server accepts
    // either candidateId or the legacy candidateKey; candidateId is
    // collision-safe, so no translation back to ${label}|... is needed.
    const acceptedIds = Array.from(acceptedKeys);
    commitBusy = true;
    commitError = null;
    try {
      const r = await api.catalogueExpenses({
        statementPaths: paths,
        workspaceId: ws.activeId,
        commit: true,
        acceptedKeys: acceptedIds,
      });
      lastCommitCount = r.committedIds?.length ?? 0;
      lastCommitErrors = r.parseErrors ?? [];
      lastCommitDups = r.skippedDuplicates ?? [];
      invalidateResources(["expenses", "statements"]);
      // Reset the workflow.
      phase = "browse";
      selectedIds = new Set();
      acceptedKeys = new Set();
      preview = null;
      await refreshFiles();
    } catch (e) {
      commitError = (e as Error).message;
    } finally {
      commitBusy = false;
    }
  }

  async function ignoreStatement(relativePath: string, ignored: boolean): Promise<void> {
    filesNotice = null;
    try {
      const { updated } = await api.ignoreStatement(relativePath, ignored);
      // The server only flips the flag on statements it has actually imported;
      // an un-imported file returns updated === false. Surface that (C2-UI).
      if (!updated) {
        filesNotice = "Only imported statements can be hidden.";
      }
      await refreshFiles();
    } catch (e) {
      filesError = (e as Error).message;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────
  function toggleSelect(id: string): void {
    const n = new Set(selectedIds);
    n.has(id) ? n.delete(id) : n.add(id);
    selectedIds = n;
  }

  function selectAllVisible(): void {
    const visible = computeVisibleIds();
    const n = new Set(selectedIds);
    visible.forEach((id) => n.add(id));
    selectedIds = n;
  }

  function clearSelection(): void {
    selectedIds = new Set();
  }

  function selectByIssuer(iss: Issuer): void {
    // One pass: select every non-ignored file for this issuer (H8). The prior
    // double-pass also re-added ignored files via the second, unfiltered pass.
    const n = new Set(selectedIds);
    files.filter((f) => f.issuer === iss && !f.ignored).forEach((f) => n.add(f.id));
    selectedIds = n;
  }

  // Mirror LibraryBrowse's filter pipeline so "select all visible" matches
  // what the user actually sees. Kept inline to avoid an extra util module
  // for a single derivation. MUST STAY IN SYNC with the `filtered` $derived in
  // LibraryBrowse.svelte — including the null-periodEnd semantics below.
  function computeVisibleIds(): string[] {
    const q = search.trim().toLowerCase();
    const cutoffs: Record<typeof periodFilter, number | undefined> = {
      all: undefined,
      "30d":  Date.now() - 30  * 86_400_000,
      "90d":  Date.now() - 90  * 86_400_000,
      "6mo":  Date.now() - 180 * 86_400_000,
      "12mo": Date.now() - 365 * 86_400_000,
    };
    const cutoff = cutoffs[periodFilter];
    return files
      .filter((s) => {
        if (!issuerFilter.has(s.issuer)) return false;
        if (statusFilter === "parsed"   && s.status !== "parsed") return false;
        if (statusFilter === "unparsed" && s.status === "parsed") return false;
        if (statusFilter === "error"    && !s.hasErrors) return false;
        if (statusFilter === "ignored"  && !s.ignored) return false;
        if (statusFilter === "all"      && s.ignored) return false;
        // Under an active period cutoff, EXCLUDE files with no parsed periodEnd
        // (can't prove they fall inside the window). Must match LibraryBrowse.
        if (cutoff && (!s.periodEnd || new Date(s.periodEnd).getTime() < cutoff)) return false;
        if (q && !s.fileName.toLowerCase().includes(q) &&
                !s.issuerLabel.toLowerCase().includes(q) &&
                !(s.periodLabel ?? "").toLowerCase().includes(q)) return false;
        return true;
      })
      .map((s) => s.id);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────
  // Reset the import state machine and refetch whenever the active workspace
  // changes (C4). Without this, workspace-A candidates could be committed into
  // workspace-B after a switch mid-flight. Owns the initial load too (mirrors
  // trends/+page.svelte) — no separate refreshFiles() in onMount.
  $effect(() => {
    if (ws.activeId != null) {
      phase = "browse";
      selectedIds = new Set();
      acceptedKeys = new Set();
      preview = null;
      lastCommitCount = null;
      lastCommitErrors = [];
      lastCommitDups = [];
      void refreshFiles();
    }
  });

  let dispose: (() => void) | null = null;
  onMount(() => {
    dispose = onInvalidate((r) => {
      if (r === "statements" || r === "expenses") void refreshFiles();
    });
  });
  onDestroy(() => { dispose?.(); });

  // Derived data for child components.
  const previewCount = $derived(preview ? preview.candidates.length : null);
  const confirmCount = $derived(
    phase === "browse" ? null : acceptedKeys.size,
  );
  const detailFile = $derived(detailId ? files.find((f) => f.id === detailId) ?? null : null);
  const selectedFiles = $derived(files.filter((f) => selectedIds.has(f.id)));
  const activeWorkspace = $derived(ws.list.find((w) => w.id === ws.activeId) ?? null);
  const acceptedCandidates = $derived(
    preview ? preview.candidates.filter((c) => acceptedKeys.has(c.candidateId)) : [],
  );
</script>

<article class="ed-article">
  <PageHead
    section="Section III"
    kicker="Import"
    title="Import statements"
    rightLabel={activeWorkspace?.name ?? ""}
    byline="All Chase & Amex statements indexed under ./statements/. Hide issuers you don't want to see, pick the months to ingest, preview detected expense candidates, then commit only the rows you trust to the active workspace."
  />

  {#if filesError}
    <div class="bk-error-banner" role="alert" data-testid="lib-files-error">{filesError}</div>
  {/if}
  {#if commitError}
    <div class="bk-error-banner" role="alert" data-testid="lib-commit-error">{commitError}</div>
  {/if}
  {#if filesNotice}
    <div
      class="bk-progress-banner"
      style="border-left-color: var(--warning); background: color-mix(in oklab, var(--warning) 6%, var(--surface))"
      role="status"
      data-testid="lib-files-notice"
    >
      {filesNotice}
    </div>
  {/if}
  {#if lastCommitCount != null}
    {#if lastCommitCount === 0}
      <!-- OP-W03: 0 commits is not a success — use the warning tone, not green. -->
      <div
        class="bk-progress-banner"
        style="border-left-color: var(--warning); background: color-mix(in oklab, var(--warning) 6%, var(--surface))"
        role="status"
        data-testid="lib-commit-success"
      >
        No new lines committed to <strong>{activeWorkspace?.name ?? ""}</strong>
        (the selected candidates may already exist there).
      </div>
    {:else}
      <div
        class="bk-progress-banner"
        style="border-left-color: var(--positive)"
        role="status"
        data-testid="lib-commit-success"
      >
        Committed <strong>{lastCommitCount}</strong> new expense line{lastCommitCount === 1 ? "" : "s"} to
        <strong>{activeWorkspace?.name ?? ""}</strong>.
      </div>
    {/if}
    {#if lastCommitDups.length > 0}
      <div
        class="bk-progress-banner"
        style="border-left-color: var(--warning); background: color-mix(in oklab, var(--warning) 6%, var(--surface))"
        role="status"
        data-testid="lib-commit-duplicates"
      >
        <strong>{lastCommitDups.length}</strong> duplicate{lastCommitDups.length === 1 ? "" : "s"} skipped —
        an item with the same name, cost, and date is already in the budget:
        {lastCommitDups.slice(0, 5).map((d) => d.label).join(", ")}{lastCommitDups.length > 5 ? ", …" : ""}
      </div>
    {/if}
    {#if lastCommitErrors.length > 0}
      <div class="bk-error-banner" role="alert" data-testid="lib-commit-parse-errors">
        <div>
          <strong>{lastCommitErrors.length}</strong>
          row{lastCommitErrors.length === 1 ? "" : "s"} could not be imported:
          <ul style="margin: 4px 0 0; padding-left: 18px">
            {#each lastCommitErrors as pe (pe.path + pe.error)}
              <li><span class="bk-mono" style="font-size: 12px">{pe.path}</span> — {pe.error}</li>
            {/each}
          </ul>
        </div>
      </div>
    {/if}
  {/if}

  <LibraryStats files={files} />
  <LibraryPhases
    phase={phase}
    onphase={(p) => (phase = p)}
    browseCount={files.length}
    previewCount={previewCount}
    confirmCount={confirmCount}
  />

  {#if phase === "browse"}
    {#if filesLoading && files.length === 0}
      <div class="lib-empty">Indexing statements…</div>
    {:else}
      <LibraryBrowse
        files={files}
        selectedIds={selectedIds}
        grouped={grouped}
        issuerFilter={issuerFilter}
        statusFilter={statusFilter}
        periodFilter={periodFilter}
        search={search}
        sortBy={sortBy}
        sortDir={sortDir}
        busy={previewLoading}
        onselect={toggleSelect}
        onselectall={selectAllVisible}
        onclear={clearSelection}
        onselectissuer={selectByIssuer}
        onsetgrouped={(v) => (grouped = v)}
        onsetissuerfilter={(s) => (issuerFilter = s)}
        onsetstatus={(s) => (statusFilter = s)}
        onsetperiod={(p) => (periodFilter = p)}
        onsetsearch={(s) => (search = s)}
        onsetsortby={(k) => (sortBy = k)}
        onsetsortdir={(d) => (sortDir = d)}
        onpreview={runPreview}
        ondetail={(id) => (detailId = id)}
        onignore={ignoreStatement}
      />
    {/if}
  {/if}

  {#if phase === "preview" && preview}
    <LibraryPreview
      candidates={preview.candidates}
      summary={preview.summary}
      acceptedKeys={acceptedKeys}
      busy={commitBusy || previewLoading}
      onaccept={(k) => {
        const n = new Set(acceptedKeys);
        n.has(k) ? n.delete(k) : n.add(k);
        acceptedKeys = n;
      }}
      onbulk={(s) => (acceptedKeys = s)}
      onsetcand={(c: CatalogueCandidate[]) => (preview = preview ? { ...preview, candidates: c } : preview)}
      ongotobrowse={() => (phase = "browse")}
      ongotoconfirm={() => (phase = "confirm")}
    />
  {:else if phase === "preview"}
    <!-- H3: preview cleared mid-flight (e.g. workspace switch). Don't render a
         blank screen — show why and offer a way back. -->
    {#if previewLoading}
      <div class="lib-empty">Detecting expense candidates…</div>
    {:else}
      <div class="lib-empty">
        No candidate preview is loaded.
        <button type="button" class="bk-btn bk-btn-sm bk-btn-ghost" onclick={() => (phase = "browse")}>
          ← Back to browse
        </button>
      </div>
    {/if}
  {/if}

  {#if phase === "confirm" && preview}
    <LibraryConfirm
      acceptedCands={acceptedCandidates}
      selectedFiles={selectedFiles}
      workspace={activeWorkspace}
      busy={commitBusy}
      oncommit={commit}
      onback={() => (phase = "preview")}
    />
  {:else if phase === "confirm"}
    <!-- H3: confirm phase with no preview loaded. -->
    {#if previewLoading}
      <div class="lib-empty">Detecting expense candidates…</div>
    {:else}
      <div class="lib-empty">
        Nothing to confirm — the candidate preview is no longer available.
        <button type="button" class="bk-btn bk-btn-sm bk-btn-ghost" onclick={() => (phase = "browse")}>
          ← Back to browse
        </button>
      </div>
    {/if}
  {/if}

  {#if detailFile && phase === "browse"}
    <StatementDetail
      file={detailFile}
      isSelected={selectedIds.has(detailFile.id)}
      onclose={() => (detailId = null)}
      ontoggleselect={() => { if (detailFile) toggleSelect(detailFile.id); detailId = null; }}
      onignore={ignoreStatement}
    />
  {/if}
</article>
