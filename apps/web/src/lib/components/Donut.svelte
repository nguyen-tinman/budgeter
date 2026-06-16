<script lang="ts">
  interface Slice { value: number; color: string }
  interface Props {
    slices: Slice[];
    size?: number;
  }
  const { slices, size = 120 }: Props = $props();

  const total = $derived(slices.reduce((s, x) => s + x.value, 0) || 1);
  const r = $derived(size / 2 - 8);
  const cx = $derived(size / 2);
  const cy = $derived(size / 2);
  const C = $derived(2 * Math.PI * r);

  function dashFor(i: number): { dash: string; offset: number } {
    let offset = 0;
    for (let k = 0; k < i; k++) offset += (slices[k]!.value / total) * C;
    const len = (slices[i]!.value / total) * C;
    return { dash: `${len} ${C - len}`, offset };
  }
</script>

<svg
  width={size}
  height={size}
  viewBox={`0 0 ${size} ${size}`}
  aria-hidden="true"
>
  {#each slices as s, i (i)}
    {@const d = dashFor(i)}
    <circle
      cx={cx}
      cy={cy}
      r={r}
      fill="none"
      stroke={s.color}
      stroke-width="12"
      stroke-dasharray={d.dash}
      stroke-dashoffset={-d.offset}
      transform={`rotate(-90 ${cx} ${cy})`}
    />
  {/each}
</svg>
