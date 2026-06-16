<script lang="ts">
  import type { TrendsMonth } from "$lib/api.js";

  interface Series {
    key: string;
    name: string;
    color: string;
    values: number[];
    /** Optional second line for the same category, drawn dashed (the collapsed
     *  "monthly average" baseline in "Both" view). When present, `values` is the
     *  actual spend and `avg` is the average to compare against. */
    avg?: number[];
  }

  interface Props {
    x: TrendsMonth[];
    categorySeries: Series[];
    overlaySeries: Series[];
    mode: "absolute" | "percent" | "stacked";
    /** When mode === "percent", divide each value by this same-month series. */
    incomeSeries: number[];
    /** Index of the currently-hovered month, or null. */
    hoverIdx: number | null;
    onhover?: (i: number | null, clientX: number, clientY: number) => void;
  }
  const { x, categorySeries, overlaySeries, mode, incomeSeries, hoverIdx, onhover }: Props = $props();

  const W = 1000;
  const H = 360;
  const PAD = { t: 12, r: 80, b: 28, l: 64 };
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;

  const stacked = $derived(mode === "stacked");
  const percent = $derived(mode === "percent");
  const N = $derived(x.length);
  const stepX = $derived(N > 1 ? innerW / (N - 1) : 0);

  function transform(v: number, i: number): number {
    if (percent) {
      // A $0 take-home month has no meaningful "% of income"; yield 0 rather
      // than dividing by a 1-cent floor (which would produce ~1,000,000%).
      const denom = incomeSeries[i] ?? 0;
      return denom > 0 ? v / denom : 0;
    }
    return v;
  }

  const stackedValues = $derived.by(() => {
    if (!stacked) return [];
    return x.map((_, i) => categorySeries.reduce((s, c) => s + (c.values[i] ?? 0), 0));
  });

  const yMax = $derived.by(() => {
    const visible: number[] = [];
    if (stacked) {
      stackedValues.forEach((v, i) => visible.push(transform(v, i)));
    } else {
      categorySeries.forEach((c) => {
        c.values.forEach((v, i) => visible.push(transform(v, i)));
        c.avg?.forEach((v, i) => visible.push(transform(v, i)));
      });
    }
    overlaySeries.forEach((o) => o.values.forEach((v, i) => visible.push(transform(v, i))));
    return Math.max(...visible, 1) * 1.1;
  });

  function xPos(i: number): number { return PAD.l + i * stepX; }
  function yPos(v: number): number { return PAD.t + innerH - (v / yMax) * innerH; }

  function pathFor(values: number[]): string {
    if (values.length === 0) return "";
    // With a single data point stepX is 0, so a lone "M" segment is invisible.
    // Draw a short horizontal stub so the point is still discernible.
    if (values.length === 1) {
      const y = yPos(transform(values[0]!, 0));
      return `M${xPos(0)},${y} L${xPos(0) + 6},${y}`;
    }
    return values.map((v, i) => `${i === 0 ? "M" : "L"}${xPos(i)},${yPos(transform(v, i))}`).join(" ");
  }

  const stackPaths = $derived.by(() => {
    if (!stacked || N < 2) return [] as Array<{ color: string; path: string; name: string }>;
    let acc = new Array(N).fill(0) as number[];
    return categorySeries.map((c) => {
      const top = c.values.map((v, i) => acc[i]! + v);
      const path =
        "M" + top.map((v, i) => `${xPos(i)},${yPos(transform(v, i))}`).join(" L") +
        " L" + xPos(N - 1) + "," + yPos(transform(acc[N - 1]!, N - 1)) +
        " L" + [...acc].reverse().map((v, idx) => `${xPos(N - 1 - idx)},${yPos(transform(v, N - 1 - idx))}`).join(" L") +
        " Z";
      acc = top;
      return { color: c.color, path, name: c.name };
    });
  });

  const yTicks = $derived.by(() => {
    if (percent) return [0, 0.25, 0.5, 0.75, 1.0].filter((v) => v <= yMax);
    const target = 5;
    const raw = yMax / target;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const ratio = raw / pow;
    const step = pow * (ratio > 5 ? 10 : ratio > 2 ? 5 : ratio > 1 ? 2 : 1);
    const ticks: number[] = [];
    for (let v = 0; v <= yMax; v += step) ticks.push(v);
    return ticks;
  });

  function fmtY(v: number): string {
    if (percent) return `${(v * 100).toFixed(0)}%`;
    if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}k`;
    return `$${v.toFixed(0)}`;
  }

  const xTicks = $derived(
    x.map((m, i) => ({ i, label: m.short, year: m.year })).filter((_, i) => i % 3 === 0 || i === N - 1)
  );

  let svgEl: SVGSVGElement | null = $state(null);

  function handleMove(e: MouseEvent): void {
    if (!svgEl) return;
    // With fewer than two points stepX is 0; mapping a cursor x to an index
    // would divide by zero (→ Infinity/NaN). Nothing to hover in that case.
    if (N < 2 || stepX === 0) return;
    const pt = svgEl.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svgEl.getScreenCTM();
    if (!ctm) return;
    const local = pt.matrixTransform(ctm.inverse());
    const i = Math.round((local.x - PAD.l) / stepX);
    if (i >= 0 && i < N) onhover?.(i, e.clientX, e.clientY);
    else onhover?.(null, e.clientX, e.clientY);
  }

  function handleLeave(): void { onhover?.(null, 0, 0); }

  function fmtMoney(dollars: number): string {
    return `$${dollars.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  }

  // Screen-reader summary: latest value per visible series (categories first,
  // then overlays). For % mode the value is shown as a share of income.
  const srSummary = $derived.by(() => {
    const idx = N - 1;
    if (idx < 0) return [] as Array<{ name: string; value: string; overlay: boolean }>;
    const fmt = (raw: number): string =>
      percent ? `${(transform(raw, idx) * 100).toFixed(0)}% of income` : fmtMoney(raw);
    return [
      ...categorySeries.map((c) => ({ name: c.name, value: fmt(c.values[idx] ?? 0), overlay: false })),
      ...overlaySeries.map((o) => ({ name: o.name, value: fmt(o.values[idx] ?? 0), overlay: true })),
    ];
  });

  const latestMonthLabel = $derived(N > 0 ? (x[N - 1]?.label ?? "") : "");
</script>

<svg
  bind:this={svgEl}
  class="trends-chart"
  viewBox="0 0 {W} {H}"
  role="img"
  aria-label="Rolling-average expense chart by category"
  onmousemove={handleMove}
  onmouseleave={handleLeave}
>
  <title>Rolling-average expense chart by category</title>
  <g class="grid">
    {#each yTicks as t (t)}
      <line x1={PAD.l} x2={W - PAD.r} y1={yPos(t)} y2={yPos(t)} />
    {/each}
  </g>
  <g class="axis">
    {#each yTicks as t (t)}
      <text x={PAD.l - 8} y={yPos(t) + 4} text-anchor="end">{fmtY(t)}</text>
    {/each}
  </g>

  <g class="axis">
    {#each xTicks as t (t.i)}
      <g>
        <text x={xPos(t.i)} y={H - PAD.b + 14} text-anchor="middle">{t.label}</text>
        {#if t.label === "Jan"}
          <text x={xPos(t.i)} y={H - PAD.b + 26} text-anchor="middle" opacity="0.6">
            '{String(t.year % 100).padStart(2, "0")}
          </text>
        {/if}
      </g>
    {/each}
  </g>

  {#if stacked}
    {#each stackPaths as s (s.name)}
      <path d={s.path} fill={s.color} opacity={0.85} />
    {/each}
  {/if}

  {#if !stacked}
    {#each categorySeries as c (c.key)}
      {#if c.avg}
        <!-- Collapsed monthly-average baseline (dashed) for "Both" view. -->
        <path d={pathFor(c.avg)} fill="none" stroke={c.color} stroke-width="1.5" stroke-dasharray="2 4" opacity="0.5" />
      {/if}
      <path d={pathFor(c.values)} class="line" stroke={c.color} />
    {/each}
  {/if}

  {#each overlaySeries as o (o.key)}
    <path d={pathFor(o.values)} class="line overlay" stroke={o.color} />
  {/each}

  {#if !stacked}
    {#each [...categorySeries, ...overlaySeries].slice(0, 8) as s (`lbl-${s.key}`)}
      {@const lastVal = s.values[N - 1] ?? 0}
      {@const ly = yPos(transform(lastVal, N - 1))}
      <text class="label-end" x={W - PAD.r + 6} y={ly + 4} fill={s.color}>{s.name}</text>
    {/each}
  {/if}

  {#if hoverIdx != null}
    <g>
      <line class="crosshair" x1={xPos(hoverIdx)} x2={xPos(hoverIdx)} y1={PAD.t} y2={H - PAD.b} />
      {#if !stacked}
        {#each categorySeries as c (c.key)}
          <circle class="dot" cx={xPos(hoverIdx)} cy={yPos(transform(c.values[hoverIdx] ?? 0, hoverIdx))} r="3.5" stroke={c.color} />
        {/each}
      {/if}
      {#each overlaySeries as o (`hv-${o.key}`)}
        <circle class="dot" cx={xPos(hoverIdx)} cy={yPos(transform(o.values[hoverIdx] ?? 0, hoverIdx))} r="3.5" stroke={o.color} />
      {/each}
    </g>
  {/if}
</svg>

<!-- Visually-hidden data summary for screen-reader users. -->
<table
  style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0"
>
  <caption>Latest {percent ? "percent of income" : "monthly"} value per visible series{latestMonthLabel ? ` (${latestMonthLabel})` : ""}</caption>
  <thead>
    <tr><th scope="col">Series</th><th scope="col">Latest value</th></tr>
  </thead>
  <tbody>
    {#each srSummary as row (`${row.overlay ? "ov" : "cat"}-${row.name}`)}
      <tr>
        <th scope="row">{row.name}{row.overlay ? " (overlay)" : ""}</th>
        <td>{row.value}</td>
      </tr>
    {/each}
  </tbody>
</table>
