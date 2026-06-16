<script lang="ts">
  import { onMount } from "svelte";

  interface Props {
    onclose: () => void;
    align?: "top" | "center";
    children?: import("svelte").Snippet;
  }
  const { onclose, align = "top", children }: Props = $props();

  let containerEl: HTMLDivElement | null = $state(null);

  onMount(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onclose();
    }
    document.addEventListener("keydown", onKey);
    setTimeout(() => {
      const focusable = containerEl?.querySelector<HTMLElement>(
        'input, button, textarea, select, [tabindex]:not([tabindex="-1"])'
      );
      focusable?.focus();
    }, 10);
    return () => {
      document.removeEventListener("keydown", onKey);
      prevFocus?.focus?.();
    };
  });
</script>

<div
  class="bk-overlay"
  data-align={align}
  role="presentation"
  onclick={onclose}
  onkeydown={(e) => { if (e.key === "Escape") onclose(); }}
>
  <div
    bind:this={containerEl}
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
  >
    {#if children}{@render children()}{/if}
  </div>
</div>
