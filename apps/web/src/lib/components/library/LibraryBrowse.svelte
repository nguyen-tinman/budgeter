<script lang="ts">
  import type { StatementFileRich } from "$lib/api.js";
  import Icon from "$lib/components/Icon.svelte";

  type Issuer = "chase" | "amex_gold" | "amex_plat" | "unknown";
  type StatusFilter = "all" | "parsed" | "unparsed" | "error" | "ignored";
  type PeriodFilter = "all" | "30d" | "90d" | "6mo" | "12mo";
  type SortKey = "period" | "txns" | "issuer" | "size";

  interface Props {
    files: StatementFileRich[];
    selectedIds: Set<string>;
    /** When true, statements are visually grouped by issuer with sub-headers.
     *  When false, they render as one flat list sorted by `sortBy`. */
    grouped: boolean;
    /** Issuers currently visible — clicking a chip toggles membership. */
    issuerFilter: Set<Issuer>;
    statusFilter: StatusFilter;
    periodFilter: PeriodFilter;
    search: string;
    sortBy: SortKey;
    sortDir: "asc" | "desc";
    busy: boolean;
    onselect: (id: string) => void;
    onselectall: () => void;
    onclear: () => void;
    onselectissuer: (issuer: Issuer) => void;
    onsetgrouped: (next: boolean) => void;
    onsetissuerfilter: (next: Set<Issuer>) => void;
    onsetstatus: (next: StatusFilter) => void;
    onsetperiod: (next: PeriodFilter) => void;
    onsetsearch: (next: string) => void;
    onsetsortby: (next: SortKey) => void;
    onsetsortdir: (next: "asc" | "desc") => void;
    onpreview: () => void;
    ondetail: (id: string) => void;
    onignore: (relativePath: string, ignored: boolean) => void;
  }
  const {
    files, selectedIds, grouped,
    issuerFilter, statusFilter, periodFilter, search, sortBy, sortDir, busy,
    onselect, onselectall, onclear, onselectissuer,
    onsetgrouped, onsetissuerfilter, onsetstatus, onsetperiod, onsetsearch,
    onsetsortby, onsetsortdir,
    onpreview, ondetail, onignore,
  }: Props = $props();

  function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1_048_576) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1_048_576).toFixed(1)} MB`;
  }

  const ALL_ISSUERS: Issuer[] = ["chase", "amex_gold", "amex_plat", "unknown"];
  const ISSUER_LABELS: Record<Issuer, string> = {
    chase: "Chase",
    amex_gold: "Amex Gold",
    amex_plat: "Amex Platinum",
    unknown: "Unknown",
  };

  function issuerCount(iss: Issuer): number {
    return files.filter((f) => f.issuer === iss).length;
  }

  function toggleIssuer(iss: Issuer): void {
    const n = new Set(issuerFilter);
    n.has(iss) ? n.delete(iss) : n.add(iss);
    onsetissuerfilter(n);
  }

  // ── Filter pipeline ──────────────────────────────────────────────────
  // MUST STAY IN SYNC with computeVisibleIds() in routes/library/+page.svelte
  // (same predicate, including the null-periodEnd handling under a cutoff).
  const filtered = $derived.by(() => {
    const q = search.trim().toLowerCase();
    const cutoffs: Record<PeriodFilter, number | undefined> = {
      all: undefined,
      "30d":  Date.now() - 30  * 86_400_000,
      "90d":  Date.now() - 90  * 86_400_000,
      "6mo":  Date.now() - 180 * 86_400_000,
      "12mo": Date.now() - 365 * 86_400_000,
    };
    const cutoff = cutoffs[periodFilter];
    return files.filter((s) => {
      if (!issuerFilter.has(s.issuer)) return false;
      if (statusFilter === "parsed"   && s.status !== "parsed") return false;
      if (statusFilter === "unparsed" && s.status === "parsed") return false;
      if (statusFilter === "error"    && !s.hasErrors) return false;
      if (statusFilter === "ignored"  && !s.ignored) return false;
      if (statusFilter === "all"      && s.ignored) return false;
      // Under an active period cutoff, EXCLUDE files with no parsed periodEnd
      // (can't prove they fall inside the window). Must match +page.svelte.
      if (cutoff && (!s.periodEnd || new Date(s.periodEnd).getTime() < cutoff)) return false;
      if (q && !s.fileName.toLowerCase().includes(q) &&
              !s.issuerLabel.toLowerCase().includes(q) &&
              !(s.periodLabel ?? "").toLowerCase().includes(q)) return false;
      return true;
    });
  });

  const sorted = $derived.by(() => {
    const arr = [...filtered];
    const dir = sortDir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      let av: number | string, bv: number | string;
      switch (sortBy) {
        case "txns":   av = a.txnCount;    bv = b.txnCount; break;
        case "issuer": av = a.issuerLabel; bv = b.issuerLabel; break;
        case "size":   av = a.sizeBytes;   bv = b.sizeBytes; break;
        default:       av = a.periodEnd ?? "";    bv = b.periodEnd ?? "";
      }
      return av > bv ? dir : av < bv ? -dir : 0;
    });
    return arr;
  });

  const groupedByIssuer = $derived.by(() => {
    if (!grouped) return null;
    const m = new Map<Issuer, StatementFileRich[]>();
    for (const iss of ALL_ISSUERS) m.set(iss, []);
    for (const f of sorted) m.get(f.issuer)?.push(f);
    return m;
  });

  const selectedCount = $derived(
    sorted.filter((s) => selectedIds.has(s.id)).length,
  );
  const selectedTxns = $derived(
    files.filter((s) => selectedIds.has(s.id)).reduce((sum, s) => sum + s.txnCount, 0),
  );
</script>

<!-- Toolbar -->
<div class="lib-toolbar" data-testid="lib-browse-toolbar">
  <div class="bk-search" style="flex: 1; min-width: 220px">
    <Icon name="search" size={14} />
    <input
      class="bk-input"
      type="search"
      placeholder="Search statement files, issuer, or period…"
      value={search}
      data-testid="lib-search"
      oninput={(e) => onsetsearch((e.currentTarget as HTMLInputElement).value)}
    />
  </div>

  <select
    class="bk-select"
    value={statusFilter}
    data-testid="lib-status-filter"
    onchange={(e) => onsetstatus((e.currentTarget as HTMLSelectElement).value as StatusFilter)}
  >
    <option value="all">All status</option>
    <option value="parsed">Parsed</option>
    <option value="unparsed">Unparsed</option>
    <option value="error">With errors</option>
    <option value="ignored">Ignored only</option>
  </select>

  <select
    class="bk-select"
    value={periodFilter}
    data-testid="lib-period-filter"
    onchange={(e) => onsetperiod((e.currentTarget as HTMLSelectElement).value as PeriodFilter)}
  >
    <option value="all">All periods</option>
    <option value="30d">Last 30 days</option>
    <option value="90d">Last 90 days</option>
    <option value="6mo">Last 6 months</option>
    <option value="12mo">Last 12 months</option>
  </select>

  <select
    class="bk-select"
    value={sortBy}
    data-testid="lib-sort-by"
    onchange={(e) => onsetsortby((e.currentTarget as HTMLSelectElement).value as SortKey)}
  >
    <option value="period">Sort: Period</option>
    <option value="txns">Sort: Txn count</option>
    <option value="issuer">Sort: Issuer</option>
    <option value="size">Sort: File size</option>
  </select>

  <button
    type="button"
    class="bk-iconbtn"
    aria-label={`Sort direction ${sortDir}`}
    title={`Sort ${sortDir === "asc" ? "ascending" : "descending"}`}
    onclick={() => onsetsortdir(sortDir === "asc" ? "desc" : "asc")}
  >
    {sortDir === "asc" ? "↑" : "↓"}
  </button>

  <span style="flex: 1"></span>

  <div class="lib-segmented" role="group" aria-label="Grouping">
    <button
      type="button"
      aria-pressed={grouped}
      data-testid="lib-grouped-on"
      onclick={() => onsetgrouped(true)}
    >Grouped</button>
    <button
      type="button"
      aria-pressed={!grouped}
      data-testid="lib-grouped-off"
      onclick={() => onsetgrouped(false)}
    >Flat</button>
  </div>
</div>

<!-- Issuer chip row (hide/show + bulk select) -->
<div class="bk-toolbar" style="margin-bottom: 14px" data-testid="lib-issuers">
  <span class="bk-eyebrow">Issuers</span>
  <div class="lib-issuer-chips">
    {#each ALL_ISSUERS as iss (iss)}
      {@const cnt = issuerCount(iss)}
      {#if cnt > 0}
        <button
          type="button"
          class="lib-issuer-chip"
          aria-pressed={issuerFilter.has(iss)}
          data-testid={`lib-issuer-${iss}`}
          onclick={() => toggleIssuer(iss)}
          title={issuerFilter.has(iss) ? `Hide ${ISSUER_LABELS[iss]}` : `Show ${ISSUER_LABELS[iss]}`}
        >
          {ISSUER_LABELS[iss]}
          <span class="lib-issuer-count">{cnt}</span>
        </button>
      {/if}
    {/each}
  </div>
  <span style="flex: 1"></span>
  <button type="button" class="bk-btn bk-btn-sm bk-btn-ghost" onclick={onselectall}>
    Select all visible
  </button>
  <button type="button" class="bk-btn bk-btn-sm bk-btn-ghost" onclick={onclear} disabled={selectedIds.size === 0}>
    Clear
  </button>
</div>

<!-- Selection summary + Preview CTA -->
<div
  class="bk-toolbar"
  style="margin-bottom: 14px; padding: 10px 14px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface)"
  data-testid="lib-selection-bar"
>
  <span class="bk-text" style="flex: 1">
    <strong>{selectedCount}</strong> file{selectedCount === 1 ? "" : "s"} selected ·
    <span class="bk-num">{selectedTxns.toLocaleString()}</span> transactions
  </span>
  <button
    type="button"
    class="bk-btn bk-btn-primary bk-btn-sm"
    data-testid="lib-preview-btn"
    disabled={selectedCount === 0 || busy}
    onclick={onpreview}
  >
    Preview candidates →
  </button>
</div>

<!-- The list -->
{#if sorted.length === 0}
  <div class="lib-empty">No statements match these filters.</div>
{:else if grouped && groupedByIssuer}
  {#each ALL_ISSUERS as iss (iss)}
    {@const rows = groupedByIssuer.get(iss) ?? []}
    {#if rows.length > 0}
      <div class="lib-group" data-testid={`lib-group-${iss}`}>
        <div class="lib-group-hd">
          <div class="lib-group-title">{ISSUER_LABELS[iss]}</div>
          <div class="lib-group-meta">{rows.length} file{rows.length === 1 ? "" : "s"}</div>
          <div class="lib-group-action">
            <button
              type="button"
              class="bk-btn bk-btn-sm bk-btn-ghost"
              onclick={() => onselectissuer(iss)}
            >
              Select all
            </button>
          </div>
        </div>
        {#each rows as f (f.id)}
          {@const sel = selectedIds.has(f.id)}
          <div
            class="lib-row"
            role="button"
            tabindex="0"
            data-selected={sel ? "true" : "false"}
            data-ignored={f.ignored ? "true" : "false"}
            data-testid={`lib-row-${f.id}`}
            onclick={() => onselect(f.id)}
            ondblclick={() => ondetail(f.id)}
            onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onselect(f.id); } }}
          >
            <span class="lib-cb">
              {#if sel}<Icon name="check" size={12} />{/if}
            </span>
            <div class="lib-name">
              <div class="lib-name-main">{f.fileName}</div>
              <div class="lib-name-meta">
                <span>{f.periodLabel ?? "—"}</span>
                <span>{fmtBytes(f.sizeBytes)}</span>
                <span>{f.relativePath}</span>
              </div>
            </div>
            <div class="lib-num">{f.txnCount.toLocaleString()}</div>
            <div class="lib-num-sub">{f.parsedAt ? new Date(f.parsedAt).toLocaleDateString() : "—"}</div>
            <div class="lib-status" data-status={f.status}>
              <span class="lib-status-dot"></span>{f.status}
            </div>
            <div></div>
            <span class="lib-actions">
              <button
                type="button"
                class="bk-iconbtn"
                aria-label={f.ignored ? `Restore ${f.fileName}` : `Ignore ${f.fileName}`}
                title={f.ignored ? "Restore" : "Ignore"}
                onclick={(e) => { e.stopPropagation(); onignore(f.relativePath, !f.ignored); }}
              >
                <Icon name={f.ignored ? "eye" : "eye-off"} size={14} />
              </button>
            </span>
          </div>
        {/each}
      </div>
    {/if}
  {/each}
{:else}
  <!-- Flat list -->
  <div data-testid="lib-flat-list">
    {#each sorted as f (f.id)}
      {@const sel = selectedIds.has(f.id)}
      <div
        class="lib-row"
        role="button"
        tabindex="0"
        data-selected={sel ? "true" : "false"}
        data-ignored={f.ignored ? "true" : "false"}
        data-testid={`lib-row-${f.id}`}
        onclick={() => onselect(f.id)}
        ondblclick={() => ondetail(f.id)}
        onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onselect(f.id); } }}
      >
        <span class="lib-cb">
          {#if sel}<Icon name="check" size={12} />{/if}
        </span>
        <div class="lib-name">
          <div class="lib-name-main">{f.fileName}</div>
          <div class="lib-name-meta">
            <span>{f.issuerLabel}</span>
            <span>{f.periodLabel ?? "—"}</span>
            <span>{fmtBytes(f.sizeBytes)}</span>
          </div>
        </div>
        <div class="lib-num">{f.txnCount.toLocaleString()}</div>
        <div class="lib-num-sub">{f.parsedAt ? new Date(f.parsedAt).toLocaleDateString() : "—"}</div>
        <div class="lib-status" data-status={f.status}>
          <span class="lib-status-dot"></span>{f.status}
        </div>
        <div></div>
        <span class="lib-actions">
          <button
            type="button"
            class="bk-iconbtn"
            aria-label={f.ignored ? `Restore ${f.fileName}` : `Ignore ${f.fileName}`}
            title={f.ignored ? "Restore" : "Ignore"}
            onclick={(e) => { e.stopPropagation(); onignore(f.relativePath, !f.ignored); }}
          >
            <Icon name={f.ignored ? "eye" : "eye-off"} size={14} />
          </button>
        </span>
      </div>
    {/each}
  </div>
{/if}
