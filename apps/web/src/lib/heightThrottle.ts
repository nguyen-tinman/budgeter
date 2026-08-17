// Clock-driven height gating for the /custom sandbox iframe.
//
// Extracted from CustomSandbox.svelte so the timing behaviour can be exercised
// with fake timers. It is a real browser-timing concern that cannot be observed
// from automation — Chrome throttles background-tab timers, so the message
// flood this defends against never materializes in a driven tab — which makes a
// unit test the only practical gate on it.
//
// The rule it encodes: while the first render is still settling, every reported
// height is applied immediately, so the frame sizes correctly on first paint.
// Once the render has reported done, heights are collapsed to at most one apply
// per throttle window (trailing edge, so the final value always lands).
//
// Throttled rather than ignored after done, deliberately: post-render height
// changes are legitimate — the charts are viewBox-scaled, so a window resize
// genuinely changes content height, and dropping those updates would clip the
// page. Throttling still defuses the abuse case, where render code leaves a
// setInterval mutating the DOM and floods height messages to thrash layout in
// the parent.

/** Collapse window for post-render height updates. */
export const HEIGHT_THROTTLE_MS = 250;
/** Clamp bounds, mirroring the harness's own clamp on the reporting side. */
export const HEIGHT_MIN_PX = 200;
export const HEIGHT_MAX_PX = 4000;

export interface HeightThrottle {
  /** Report a height. Applied at once while settling, throttled after
   *  markRenderDone(). Values are clamped before anything else. */
  offer(px: number): void;
  /** The render reported done — switch to throttled mode. */
  markRenderDone(): void;
  /** New payload, or teardown: drop pending work and return to immediate mode.
   *  Does NOT forget the last applied height, because the element keeps its
   *  size across a remount. */
  reset(): void;
}

export interface HeightThrottleOptions {
  /** Called when a height should actually take effect. */
  apply: (px: number) => void;
  throttleMs?: number;
  min?: number;
  max?: number;
  /** Injectable for tests that want to avoid fake timers; defaults to the
   *  ambient timer functions. */
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

export function createHeightThrottle(options: HeightThrottleOptions): HeightThrottle {
  const throttleMs = options.throttleMs ?? HEIGHT_THROTTLE_MS;
  const min = options.min ?? HEIGHT_MIN_PX;
  const max = options.max ?? HEIGHT_MAX_PX;
  const setTimer = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimeoutFn ?? ((h) => clearTimeout(h));

  let renderDone = false;
  let pending: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Last value handed to `apply`. Tracked so the trailing edge can skip a
   *  no-op re-apply, matching the original inline behaviour, which compared the
   *  pending value against the height already in effect. */
  let lastApplied: number | null = null;

  return {
    offer(px: number): void {
      const clamped = Math.max(min, Math.min(max, px));
      if (!renderDone) {
        // Immediate path applies unconditionally — first paint must size the
        // frame even if the value happens to repeat.
        lastApplied = clamped;
        options.apply(clamped);
        return;
      }
      pending = clamped;
      if (timer !== null) return;
      timer = setTimer(() => {
        timer = null;
        const next = pending;
        pending = null;
        if (next !== null && next !== lastApplied) {
          lastApplied = next;
          options.apply(next);
        }
      }, throttleMs);
    },

    markRenderDone(): void {
      renderDone = true;
    },

    reset(): void {
      renderDone = false;
      pending = null;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    },
  };
}
