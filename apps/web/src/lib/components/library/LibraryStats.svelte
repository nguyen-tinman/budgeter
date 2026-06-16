<script lang="ts">
  import type { StatementFileRich } from "$lib/api.js";

  interface Props {
    files: StatementFileRich[];
  }
  const { files }: Props = $props();

  function relTime(iso: string | null): string {
    if (!iso) return "—";
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
    return d.toLocaleDateString();
  }

  const total = $derived(files.length);
  const parsed = $derived(files.filter((f) => f.status === "parsed").length);
  const totalTxns = $derived(files.reduce((s, f) => s + f.txnCount, 0));
  const lastImport = $derived(
    files
      .filter((f) => f.parsedAt)
      .map((f) => f.parsedAt!)
      .sort()
      .at(-1) ?? null,
  );
  const errCount = $derived(files.filter((f) => f.hasErrors).length);
  const issuersCount = $derived(new Set(files.map((f) => f.issuer)).size);
</script>

<div class="lib-stats" data-testid="lib-stats">
  <div class="lib-stat">
    <div class="lib-stat-label">Files indexed</div>
    <div class="lib-stat-val">{total}</div>
    <div class="lib-stat-sub">across {issuersCount} source{issuersCount === 1 ? "" : "s"}</div>
  </div>
  <div class="lib-stat">
    <div class="lib-stat-label">Parsed</div>
    <div class="lib-stat-val">
      {parsed} <span class="bk-text-3" style="font-size: 14px; font-family: var(--font-num)">/ {total}</span>
    </div>
    <div class="lib-stat-sub">{errCount} with errors</div>
  </div>
  <div class="lib-stat">
    <div class="lib-stat-label">Transactions</div>
    <div class="lib-stat-val bk-num">{totalTxns.toLocaleString()}</div>
    <div class="lib-stat-sub">total across parsed files</div>
  </div>
  <div class="lib-stat">
    <div class="lib-stat-label">Last import</div>
    <div class="lib-stat-val" style="font-size: 22px">{relTime(lastImport)}</div>
    <div class="lib-stat-sub">{lastImport ? new Date(lastImport).toLocaleString() : "—"}</div>
  </div>
</div>
