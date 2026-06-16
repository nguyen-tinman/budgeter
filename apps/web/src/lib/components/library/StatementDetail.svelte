<script lang="ts">
  import { onMount } from "svelte";
  import type { StatementFileRich } from "$lib/api.js";
  import Icon from "$lib/components/Icon.svelte";

  interface Props {
    file: StatementFileRich;
    isSelected: boolean;
    onclose: () => void;
    ontoggleselect: () => void;
    onignore: (relativePath: string, ignored: boolean) => void;
  }
  const { file, isSelected, onclose, ontoggleselect, onignore }: Props = $props();

  function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1_048_576) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1_048_576).toFixed(1)} MB`;
  }

  // ── Dialog a11y (H7) ─────────────────────────────────────────────────
  // Focus management: move focus into the dialog on mount, trap Tab inside it,
  // close on Escape, and restore focus to whatever was focused before open.
  let dialogEl = $state<HTMLDivElement | null>(null);
  let closeBtn = $state<HTMLButtonElement | null>(null);

  onMount(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeBtn?.focus();
    return () => {
      // Restore focus on close if the prior element is still in the document.
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  });

  function focusables(): HTMLElement[] {
    if (!dialogEl) return [];
    return Array.from(
      dialogEl.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null || el === document.activeElement);
  }

  function onkeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      onclose();
      return;
    }
    if (e.key !== "Tab") return;
    const items = focusables();
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey) {
      if (active === first || !dialogEl?.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      e.preventDefault();
      first.focus();
    }
  }
</script>

<div
  class="lib-detail"
  role="dialog"
  aria-modal="true"
  aria-label="Statement details"
  data-testid="lib-detail"
  tabindex="-1"
  bind:this={dialogEl}
  {onkeydown}
>
  <div class="lib-detail-hd">
    <div style="flex: 1; min-width: 0">
      <div class="bk-eyebrow">{file.issuerLabel}</div>
      <div style="font-family: var(--font-display); font-size: 18px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
        {file.fileName}
      </div>
    </div>
    <button class="bk-iconbtn" aria-label="Close" bind:this={closeBtn} onclick={onclose}>
      <Icon name="close" size={16} />
    </button>
  </div>
  <div class="lib-detail-body">
    <div class="bk-eyebrow" style="margin-bottom: 8px">Metadata</div>
    <table class="bk-table">
      <tbody>
        <tr><td>Path</td><td><span class="bk-mono" style="font-size: 12px">{file.relativePath}</span></td></tr>
        <tr><td>Period</td><td>{file.periodLabel ?? "—"}</td></tr>
        <tr><td>Size</td><td>{fmtBytes(file.sizeBytes)}</td></tr>
        <tr><td>Status</td><td>{file.status}</td></tr>
        <tr><td>Transactions</td><td>{file.txnCount.toLocaleString()}</td></tr>
        <tr><td>Last imported</td><td>{file.parsedAt ? new Date(file.parsedAt).toLocaleString() : "—"}</td></tr>
        <tr><td>Ignored</td><td>{file.ignored ? "yes" : "no"}</td></tr>
      </tbody>
    </table>
    <div class="bk-toolbar" style="margin-top: 18px">
      <button
        type="button"
        class="bk-btn bk-btn-sm"
        onclick={ontoggleselect}
      >
        {isSelected ? "Deselect" : "Select for preview"}
      </button>
      <button
        type="button"
        class="bk-btn bk-btn-sm bk-btn-ghost"
        onclick={() => onignore(file.relativePath, !file.ignored)}
      >
        {file.ignored ? "Restore" : "Ignore"}
      </button>
    </div>
  </div>
</div>
