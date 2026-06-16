<script lang="ts">
  interface Props {
    num: number;
    title: string;
    deck?: string;
    children?: import("svelte").Snippet;
  }
  const { num, title, deck, children }: Props = $props();

  const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
  const roman = $derived(ROMAN[num - 1] ?? String(num));
</script>

<section class="ed-section" aria-labelledby={`ed-sec-${num}`}>
  <div class="ed-section-num" aria-hidden="true">{roman}.</div>
  <div class="ed-section-body">
    <h2 id={`ed-sec-${num}`}>{title}</h2>
    {#if deck}
      <div class="ed-section-deck">{deck}</div>
    {/if}
    {#if children}{@render children()}{/if}
  </div>
</section>
