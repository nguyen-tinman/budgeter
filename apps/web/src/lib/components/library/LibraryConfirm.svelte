<script lang="ts">
  import type { CatalogueCandidate, StatementFileRich, Workspace } from "$lib/api.js";
  import { formatDollars, freqToMonthlyDollars } from "$lib/helpers.js";

  interface Props {
    acceptedCands: CatalogueCandidate[];
    selectedFiles: StatementFileRich[];
    workspace: Workspace | null;
    busy: boolean;
    oncommit: () => void;
    onback: () => void;
  }
  const { acceptedCands, selectedFiles, workspace, busy, oncommit, onback }: Props = $props();

  const acceptedMonthly = $derived(
    acceptedCands.reduce((s, c) => s + freqToMonthlyDollars(c.amountDollars, c.frequency), 0),
  );

  const byCategory = $derived.by(() => {
    const m = new Map<string, { count: number; monthly: number }>();
    for (const c of acceptedCands) {
      const k = c.category || "Uncategorized";
      const cur = m.get(k) ?? { count: 0, monthly: 0 };
      cur.count += 1;
      cur.monthly += freqToMonthlyDollars(c.amountDollars, c.frequency);
      m.set(k, cur);
    }
    return Array.from(m.entries())
      .map(([category, v]) => ({ category, ...v }))
      .sort((a, b) => b.monthly - a.monthly);
  });
</script>

<div class="ed-cols" data-cols="2" style="gap: 22px">
  <div>
    <div class="bk-eyebrow" style="margin-bottom: 8px">Source statements</div>
    <table class="bk-table" data-testid="confirm-files">
      <thead>
        <tr><th>File</th><th>Issuer</th><th class="bk-cell-num">Transactions</th></tr>
      </thead>
      <tbody>
        {#each selectedFiles as f (f.id)}
          <tr>
            <td><span class="bk-mono" style="font-size: 12px">{f.fileName}</span></td>
            <td>{f.issuerLabel}</td>
            <td class="bk-cell-num">{f.txnCount.toLocaleString()}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    <p class="bk-text-3" style="font-size: 12px; margin-top: 8px; font-style: italic">
      {selectedFiles.length} file{selectedFiles.length === 1 ? "" : "s"} contribute candidates.
    </p>
  </div>
  <div>
    <div class="bk-eyebrow" style="margin-bottom: 8px">By category</div>
    <table class="bk-table" data-testid="confirm-categories">
      <thead>
        <tr><th>Category</th><th class="bk-cell-num">Lines</th><th class="bk-cell-num">Monthly</th></tr>
      </thead>
      <tbody>
        {#each byCategory as g (g.category)}
          <tr>
            <td>{g.category}</td>
            <td class="bk-cell-num">{g.count}</td>
            <td class="bk-cell-num">{formatDollars(g.monthly)}</td>
          </tr>
        {/each}
      </tbody>
      <tfoot>
        <tr>
          <td><strong>Total</strong></td>
          <td class="bk-cell-num"><strong>{acceptedCands.length}</strong></td>
          <td class="bk-cell-num"><strong>{formatDollars(acceptedMonthly)}</strong></td>
        </tr>
      </tfoot>
    </table>
  </div>
</div>

<div
  class="bk-toolbar"
  style="margin-top: 22px; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface)"
>
  <div style="flex: 1">
    <div class="bk-eyebrow">Committing to</div>
    <div class="bk-text" style="font-family: var(--font-display); font-size: 18px; margin-top: 4px">
      {workspace?.name ?? "—"}
      <span class="bk-text-3" style="font-style: italic; font-size: 13px; margin-left: 8px">
        ({workspace?.kind ?? ""})
      </span>
    </div>
  </div>
  <button type="button" class="bk-btn bk-btn-ghost bk-btn-sm" onclick={onback} disabled={busy}>
    ← Back to preview
  </button>
  <button
    type="button"
    class="bk-btn bk-btn-primary bk-btn-sm"
    data-testid="lib-commit-btn"
    disabled={busy || acceptedCands.length === 0 || workspace == null}
    onclick={oncommit}
  >
    {busy ? "Committing…" : `Commit ${acceptedCands.length} line${acceptedCands.length === 1 ? "" : "s"}`}
  </button>
</div>
