<script lang="ts">
  interface Props {
    tip: string;
    onclick?: () => void;
  }
  const { tip, onclick }: Props = $props();
</script>

<button
  type="button"
  class="bk-help"
  aria-label={`What is this? ${tip}`}
  title={tip}
  onclick={() => onclick?.()}
>?</button>
