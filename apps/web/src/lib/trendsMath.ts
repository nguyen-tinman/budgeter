// Pure helpers for the /trends page.

/** Trailing rolling average. window=1 returns the input unchanged. */
export function rollingAverage(series: number[], window: number): number[] {
  if (window <= 1) return series.slice();
  return series.map((_, i) => {
    const start = Math.max(0, i - window + 1);
    const slice = series.slice(start, i + 1);
    return Math.round(slice.reduce((a, b) => a + b, 0) / slice.length);
  });
}

/** Year-over-year delta for the latest value vs the same month a year ago.
 *
 *  Requires at least 13 entries: the latest value lives at index `length - 1`
 *  and the same calendar month one year prior lives at index `length - 13`
 *  (12 months back is inclusive of both endpoints, so the span is 13 entries,
 *  NOT 12). A 12-entry series only reaches `length - 13 === -1`, which is not a
 *  valid same-month pair, so the `< 13` guard is intentional and not an
 *  off-by-one. Returns null when the series is too short or the prior value is
 *  non-positive. */
export function yoyDelta(series: number[]): number | null {
  if (series.length < 13) return null;
  const last = series[series.length - 1]!;
  const yoy = series[series.length - 13]!;
  if (yoy <= 0) return null;
  return (last - yoy) / yoy;
}

/** Sum N series elementwise into one. Inputs may differ in length; the result
 *  spans the longest input and treats missing entries as 0. */
export function sumSeries(serieses: number[][]): number[] {
  if (serieses.length === 0) return [];
  const len = Math.max(...serieses.map((s) => s.length));
  const out = new Array(len).fill(0) as number[];
  for (const s of serieses) {
    for (let i = 0; i < len; i++) out[i] += s[i] ?? 0;
  }
  return out;
}
