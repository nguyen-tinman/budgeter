<script lang="ts">
  import type { CatalogueCandidate, CatalogueResult } from "$lib/api.js";
  import { formatDollars, freqToMonthlyDollars } from "$lib/helpers.js";
  import Icon from "$lib/components/Icon.svelte";

  interface Props {
    candidates: CatalogueCandidate[];
    summary: CatalogueResult["summary"] | null;
    /** Set of accepted candidate identities — candidateId values (H5). */
    acceptedKeys: Set<string>;
    busy: boolean;
    onaccept: (id: string) => void;
    onbulk: (next: Set<string>) => void;
    onsetcand: (next: CatalogueCandidate[]) => void;
    ongotobrowse: () => void;
    ongotoconfirm: () => void;
  }
  const {
    candidates, summary, acceptedKeys, busy,
    onaccept, onbulk, onsetcand, ongotobrowse, ongotoconfirm,
  }: Props = $props();

  let search = $state("");
  let reasonFilter = $state<"all" | "repeated" | "high_value" | "both">("all");
  let accountFilter = $state<string>("all");
  let freqFilter = $state<string>("all");
  let sortBy = $state<"amount" | "confidence" | "occurrences" | "label" | "lastSeen">("amount");
  let sortDir = $state<"asc" | "desc">("desc");

  const filtered = $derived.by(() => {
    const q = search.trim().toLowerCase();
    return candidates.filter((c) => {
      if (q && !c.label.toLowerCase().includes(q)) return false;
      if (reasonFilter !== "all" && c.seedReason !== reasonFilter) return false;
      if (accountFilter !== "all" && c.sourceAccount !== accountFilter) return false;
      if (freqFilter !== "all" && c.frequency !== freqFilter) return false;
      return true;
    });
  });

  const sorted = $derived.by(() => {
    const arr = [...filtered];
    const dir = sortDir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      let av: number | string, bv: number | string;
      switch (sortBy) {
        case "confidence":  av = a.cadenceConfidence ?? -1; bv = b.cadenceConfidence ?? -1; break;
        case "occurrences": av = a.occurrences; bv = b.occurrences; break;
        case "label":       av = a.label; bv = b.label; break;
        case "lastSeen":    av = a.lastSeen; bv = b.lastSeen; break;
        default:            av = a.amountDollars; bv = b.amountDollars;
      }
      return av > bv ? dir : av < bv ? -dir : 0;
    });
    return arr;
  });

  const acceptedCands = $derived(
    candidates.filter((c) => acceptedKeys.has(c.candidateId)),
  );
  const acceptedMonthly = $derived(
    acceptedCands.reduce((s, c) => s + freqToMonthlyDollars(c.amountDollars, c.frequency), 0),
  );

  const bulkActions = [
    { label: "High confidence (≥85%)", match: (c: CatalogueCandidate) => (c.cadenceConfidence ?? 0) >= 0.85 },
    { label: "All recurring",          match: (c: CatalogueCandidate) => c.seedReason === "repeated" || c.seedReason === "both" },
    { label: "Annual fees only",       match: (c: CatalogueCandidate) => !!c.feeKind && c.frequency === "annually" },
    { label: "Just Amex Gold",         match: (c: CatalogueCandidate) => c.sourceAccount === "amex_gold" },
    { label: "Just Amex Platinum",     match: (c: CatalogueCandidate) => c.sourceAccount === "amex_plat" },
    { label: "Just Chase",             match: (c: CatalogueCandidate) => c.sourceAccount === "chase" },
  ];

  function applyBulk(action: typeof bulkActions[number]): void {
    // H1: UNION with the existing selection rather than replacing it. The
    // chips operate on the currently *filtered* list, so a plain replace would
    // silently drop everything the user accepted outside the active filter.
    // "Clear all" remains the only way to empty the set (see the markup).
    onbulk(new Set([...acceptedKeys, ...filtered.filter(action.match).map((c) => c.candidateId)]));
  }

  function confTone(c?: number): "low" | "med" | "high" {
    if (c == null) return "low";
    if (c >= 0.85) return "high";
    if (c >= 0.7) return "med";
    return "low";
  }

  const accountOptions = $derived(
    Array.from(new Set(candidates.map((c) => c.sourceAccount))).sort(),
  );
  const freqOptions = $derived(
    Array.from(new Set(candidates.map((c) => c.frequency))).sort(),
  );
</script>

{#if summary}
  <div class="lib-summary-grid" data-testid="lib-preview-summary">
    <div class="lib-summary-cell">
      <div class="lib-summary-label">Transactions</div>
      <div class="lib-summary-val bk-num">{summary.totalTxns.toLocaleString()}</div>
    </div>
    <div class="lib-summary-cell">
      <div class="lib-summary-label">Unique merchants</div>
      <div class="lib-summary-val bk-num">{summary.uniqueMerchants}</div>
    </div>
    <div class="lib-summary-cell">
      <div class="lib-summary-label">Candidates</div>
      <div class="lib-summary-val bk-num">{candidates.length}</div>
    </div>
    <div class="lib-summary-cell">
      <div class="lib-summary-label">Recurring</div>
      <div class="lib-summary-val bk-num">{summary.recurringCount}</div>
    </div>
    <div class="lib-summary-cell">
      <div class="lib-summary-label">Annual fees</div>
      <div class="lib-summary-val bk-num">{summary.annualFeeCount}</div>
    </div>
    <div class="lib-summary-cell">
      <div class="lib-summary-label">Categorized</div>
      <div class="lib-summary-val bk-num">{(summary.categorizedRate * 100).toFixed(0)}%</div>
    </div>
  </div>
{/if}

<div class="lib-bulk-chips" data-testid="lib-bulk-chips">
  <span class="bk-eyebrow" style="margin-right: 4px">Quick select</span>
  {#each bulkActions as a (a.label)}
    {@const cnt = filtered.filter(a.match).length}
    <button
      type="button"
      class="lib-bulk-chip"
      onclick={() => applyBulk(a)}
      disabled={cnt === 0}
    >
      {a.label}
      <span class="lib-bulk-count">{cnt}</span>
    </button>
  {/each}
  <button type="button" class="lib-bulk-chip" onclick={() => onbulk(new Set())}>
    Clear all
  </button>
</div>

<div class="lib-toolbar" style="position: static; padding: 8px 0; margin-bottom: 14px">
  <div class="bk-search" style="flex: 1; min-width: 220px">
    <Icon name="search" size={14} />
    <input
      class="bk-input"
      type="search"
      placeholder="Search candidate label…"
      bind:value={search}
    />
  </div>
  <select class="bk-select" bind:value={reasonFilter}>
    <option value="all">All reasons</option>
    <option value="repeated">Repeated</option>
    <option value="high_value">High value</option>
    <option value="both">Both</option>
  </select>
  <select class="bk-select" bind:value={accountFilter}>
    <option value="all">All accounts</option>
    {#each accountOptions as a (a)}<option value={a}>{a}</option>{/each}
  </select>
  <select class="bk-select" bind:value={freqFilter}>
    <option value="all">All frequencies</option>
    {#each freqOptions as f (f)}<option value={f}>{f}</option>{/each}
  </select>
  <select class="bk-select" bind:value={sortBy}>
    <option value="amount">Sort: Amount</option>
    <option value="confidence">Sort: Confidence</option>
    <option value="occurrences">Sort: Occurrences</option>
    <option value="label">Sort: Label</option>
    <option value="lastSeen">Sort: Last seen</option>
  </select>
  <button
    type="button"
    class="bk-iconbtn"
    onclick={() => (sortDir = sortDir === "asc" ? "desc" : "asc")}
  >{sortDir === "asc" ? "↑" : "↓"}</button>
</div>

<div data-testid="lib-cand-list">
  {#each sorted as c (c.candidateId)}
    {@const k = c.candidateId}
    {@const sel = acceptedKeys.has(k)}
    {@const monthly = freqToMonthlyDollars(c.amountDollars, c.frequency)}
    <button
      type="button"
      class="lib-cand-row"
      data-selected={sel ? "true" : "false"}
      data-testid={`lib-cand-${k}`}
      onclick={() => onaccept(k)}
    >
      <span class="lib-cb">
        {#if sel}<Icon name="check" size={12} />{/if}
      </span>
      <div class="lib-cand-name">
        <div class="lib-cand-label">{c.label}</div>
        <div class="lib-cand-meta">
          <span>{c.sourceAccount}</span>
          <span>{c.category}</span>
          <span>{c.occurrences}×</span>
        </div>
      </div>
      <div class="lib-num">{formatDollars(c.amountDollars)}</div>
      <div class="bk-text" style="font-size: 12px; color: var(--text-2)">{c.frequency}</div>
      <div class="lib-num">{formatDollars(monthly)}/mo</div>
      <div>
        <span class="lib-reason" data-reason={c.seedReason}>{c.seedReason}</span>
      </div>
      <div class="lib-conf">
        <div class="lib-conf-bar" data-tone={confTone(c.cadenceConfidence)}>
          <i style:width="{((c.cadenceConfidence ?? 0) * 100).toFixed(0)}%"></i>
        </div>
        <span class="lib-conf-num">{c.cadenceConfidence != null ? `${(c.cadenceConfidence * 100).toFixed(0)}%` : "—"}</span>
      </div>
      <div class="bk-text-3" style="font-size: 11px">{c.feeKind ?? ""}</div>
    </button>
  {/each}
</div>

<!-- Sticky footer with selection totals + next CTA -->
<div class="lib-footer" data-testid="lib-preview-footer">
  <div class="lib-footer-stat">
    <span class="label">Selected</span>
    <span class="val bk-num">{acceptedCands.length} / {candidates.length}</span>
  </div>
  <span class="lib-footer-sep"></span>
  <div class="lib-footer-stat">
    <span class="label">Monthly equiv.</span>
    <span class="val bk-num">{formatDollars(acceptedMonthly)}</span>
  </div>
  <span class="lib-footer-sep"></span>
  <div class="lib-footer-stat">
    <span class="label">Annual</span>
    <span class="val bk-num">{formatDollars(acceptedMonthly * 12)}</span>
  </div>
  <span style="flex: 1"></span>
  <button type="button" class="bk-btn bk-btn-ghost bk-btn-sm" onclick={ongotobrowse}>
    ← Back to browse
  </button>
  <button
    type="button"
    class="bk-btn bk-btn-primary bk-btn-sm"
    data-testid="lib-confirm-btn"
    disabled={acceptedCands.length === 0 || busy}
    onclick={ongotoconfirm}
  >
    Review &amp; commit →
  </button>
</div>
