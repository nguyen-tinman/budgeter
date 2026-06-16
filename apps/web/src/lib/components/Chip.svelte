<script lang="ts">
  interface Props {
    on?: boolean;
    onclick?: () => void;
    ariaLabel?: string;
    children?: import("svelte").Snippet;
  }
  const { on = false, onclick, ariaLabel, children }: Props = $props();
</script>

<button
  type="button"
  class="bk-chip"
  data-on={on || undefined}
  aria-pressed={on}
  aria-label={ariaLabel}
  onclick={() => onclick?.()}
>
  {#if children}{@render children()}{/if}
</button>
