<script lang="ts">
  interface Props {
    value: string;
    onCommit: (next: string) => void;
    ariaLabel: string;
    display?: string;
    testid?: string;
  }
  const { value, onCommit, ariaLabel, display, testid }: Props = $props();

  let editing = $state(false);
  let draft = $state("");
  let inputEl: HTMLInputElement | null = $state(null);

  $effect(() => {
    if (!editing) draft = value;
  });

  $effect(() => {
    if (editing && inputEl) inputEl.focus();
  });

  function commit() {
    editing = false;
    if (draft !== value) onCommit(draft);
  }

  function cancel() {
    draft = value;
    editing = false;
  }
</script>

{#if editing}
  <input
    bind:this={inputEl}
    type="text"
    class="bk-input bk-cell-edit-input"
    bind:value={draft}
    aria-label={ariaLabel}
    data-testid={testid}
    onblur={commit}
    onkeydown={(e) => {
      if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
      if (e.key === "Escape") cancel();
    }}
  />
{:else}
  <button
    type="button"
    class="bk-cell-edit"
    aria-label={`Edit ${ariaLabel}`}
    data-testid={testid}
    onclick={() => (editing = true)}
  >{display ?? value}</button>
{/if}
