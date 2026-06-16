<script lang="ts">
  import { onMount } from "svelte";

  interface Props {
    workspaceName?: string;
  }
  const { workspaceName }: Props = $props();

  // Defer date/time derivation to onMount so SSR and the first client paint
  // agree. If we call `new Date()` at module top, the SSR HTML carries the
  // server's wall-clock and the client immediately hydrates to a different
  // string — visible flicker and a hydration mismatch warning. Initial render
  // shows em-dashes; the real values land on mount.
  let date = $state("—");
  let vol = $state("—");

  function weekOfYear(d: Date): number {
    const start = new Date(d.getFullYear(), 0, 1);
    const days = Math.floor((d.getTime() - start.getTime()) / 86_400_000);
    return Math.max(1, Math.ceil((days + start.getDay() + 1) / 7));
  }

  onMount(() => {
    const now = new Date();
    date = now.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    vol = `Vol. ${now.getFullYear()} · Wk ${weekOfYear(now)}`;
  });
</script>

<div class="ed-masthead">
  <div class="ed-mast-meta">
    <span>{vol}</span>
    <span>{date}</span>
    <span>Workspace · {workspaceName ?? "—"}</span>
  </div>
  <h1 class="ed-mast-title">BudgetKit</h1>
  <div class="ed-mast-sub">A personal financial chronicle, edited from your own ledger</div>
</div>
