<script lang="ts">
  import { HELP_TOPICS } from "$lib/helpers.js";

  interface Props {
    topic: keyof typeof HELP_TOPICS;
    n: number | string;
    onopen?: (topic: string) => void;
  }
  const { topic, n, onopen }: Props = $props();

  const def = $derived(HELP_TOPICS[topic]);

  // Rendered as an inline <span role="button">, NOT a <button>: buttons are
  // atomic inline boxes, which gives the line breaker a break opportunity on
  // either side even with no whitespace \u2014 orphaning "[n]" (or the trailing
  // period) onto its own line. A plain inline span flows with the text, and
  // the U+2060 word joiners glue it to the adjacent characters.
</script>

{"\u2060"}<span
  role="button"
  tabindex="0"
  class="ed-foot-ref"
  aria-label={`Footnote ${n}: ${def?.title ?? topic}`}
  title={def?.title ?? topic}
  onclick={() => onopen?.(topic)}
  onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onopen?.(topic); } }}
>[{n}]</span>{"\u2060"}
