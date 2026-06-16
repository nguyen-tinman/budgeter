<script lang="ts">
  import { HELP_TOPICS } from "$lib/helpers.js";

  interface Props {
    topic: keyof typeof HELP_TOPICS;
    n: number | string;
    onopen?: (topic: string) => void;
  }
  const { topic, n, onopen }: Props = $props();

  const def = $derived(HELP_TOPICS[topic]);
</script>

<button
  type="button"
  class="ed-foot-ref"
  aria-label={`Footnote ${n}: ${def?.title ?? topic}`}
  title={def?.title ?? topic}
  onclick={() => onopen?.(topic)}
  onkeydown={(e) => { if (e.key === "Enter") onopen?.(topic); }}
>[{n}]</button>
