<script lang="ts">
  interface Props {
    attribution?: string;
    children?: import("svelte").Snippet;
  }
  const { attribution, children }: Props = $props();
</script>

<div class="ed-pullquote">
  {#if children}{@render children()}{/if}
  {#if attribution}<span class="ed-pullquote-attr">— {attribution}</span>{/if}
</div>
