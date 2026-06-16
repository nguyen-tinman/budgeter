<script lang="ts">
  interface Props {
    status?: string;
  }
  const { status }: Props = $props();

  const color = $derived(
    status === "ready" || status === "done" || status === "external" ? "var(--positive)" :
    status === "starting" || status === "running" ? "var(--warning)" :
    status === "error" ? "var(--negative)" : "var(--text-3)"
  );
</script>

<span
  class="status-dot"
  style:background={color}
  aria-hidden="true"
></span>

<style>
  .status-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: 0 0 auto;
  }
</style>
