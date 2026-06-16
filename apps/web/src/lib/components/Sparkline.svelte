<script lang="ts">
  interface Props {
    data: number[];
    color?: string;
    height?: number;
  }
  const { data, color = "var(--accent)", height = 36 }: Props = $props();

  const w = 100;
  const h = $derived(height);
  const min = $derived(data.length ? Math.min(...data) : 0);
  const max = $derived(data.length ? Math.max(...data) : 1);
  const range = $derived((max - min) || 1);
  const stepX = $derived(data.length > 1 ? w / (data.length - 1) : 0);

  const points = $derived(
    data.map((d, i) => `${i * stepX},${h - ((d - min) / range) * (h - 4) - 2}`)
  );
  const linePath = $derived(points.length ? `M${points.join(" L")}` : "");
  const areaPath = $derived(points.length ? `${linePath} L${w},${h} L0,${h} Z` : "");
</script>

{#if data.length < 2}
  <div class="bk-spark-empty" style:height={`${height}px`}></div>
{:else}
  <svg
    class="bk-spark"
    viewBox={`0 0 ${w} ${h}`}
    preserveAspectRatio="none"
    style:height={`${height}px`}
    aria-hidden="true"
  >
    <path d={areaPath} fill={color} opacity="0.12" />
    <path d={linePath} fill="none" stroke={color} stroke-width="1.8" />
  </svg>
{/if}

<style>
  .bk-spark { width: 100%; }
  .bk-spark-empty { width: 100%; }
</style>
