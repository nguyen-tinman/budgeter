<script lang="ts">
  interface Props {
    source?: string;
    tone?: "positive" | "negative" | "warning";
    children?: import("svelte").Snippet;
  }
  const { source, tone, children }: Props = $props();
</script>

<span class="bk-badge" data-source={source} data-tone={tone}>
  {#if children}{@render children()}{/if}
</span>
