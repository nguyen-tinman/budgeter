// First test in @budgetkit/web. It covers the one piece of the /custom sandbox
// that browser automation provably cannot reach: the post-render height
// throttle. Chrome throttles timers in a background tab, so the message flood
// the throttle defends against never materializes in a driven tab — fake timers
// are the only way to observe the behaviour at all.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createHeightThrottle,
  HEIGHT_THROTTLE_MS,
  HEIGHT_MIN_PX,
  HEIGHT_MAX_PX,
} from "../src/lib/heightThrottle.js";

/** Collect every height that actually took effect. */
function makeSink() {
  const applied: number[] = [];
  return { applied, apply: (px: number) => applied.push(px) };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createHeightThrottle — before the render reports done", () => {
  it("applies every height immediately, so first paint sizes correctly", () => {
    const sink = makeSink();
    const t = createHeightThrottle({ apply: sink.apply });

    t.offer(300);
    t.offer(420);
    t.offer(555);

    // No timer advance at all: these must already have landed.
    expect(sink.applied).toEqual([300, 420, 555]);
  });

  it("clamps to the harness's bounds in the immediate path", () => {
    const sink = makeSink();
    const t = createHeightThrottle({ apply: sink.apply });

    t.offer(10);
    t.offer(99999);

    expect(sink.applied).toEqual([HEIGHT_MIN_PX, HEIGHT_MAX_PX]);
  });
});

describe("createHeightThrottle — after the render reports done", () => {
  it("collapses a flood inside one window to a single apply, carrying the last value", () => {
    const sink = makeSink();
    const t = createHeightThrottle({ apply: sink.apply });
    t.markRenderDone();

    // The abuse case: render code left a setInterval hammering the height.
    for (let i = 0; i < 50; i++) t.offer(300 + i);

    // Nothing applied yet — the whole burst is still pending.
    expect(sink.applied).toEqual([]);

    vi.advanceTimersByTime(HEIGHT_THROTTLE_MS);

    // At most one apply for the window, and it is the TRAILING value, so the
    // final size is never stale.
    expect(sink.applied).toEqual([349]);
  });

  it("schedules ONE timer for a whole flood, not one per message", () => {
    const sink = makeSink();
    const t = createHeightThrottle({ apply: sink.apply });
    t.markRenderDone();

    for (let i = 0; i < 50; i++) t.offer(300 + i);

    // Asserted on the timer count rather than on what was applied, and that is
    // the point: without the in-flight guard, all 50 messages each schedule
    // their own timer, yet the applied OUTPUT is still a single 349 because the
    // trailing edge dedupes against the last applied value. The pressure the
    // guard actually removes — N pending timers per burst — is invisible in the
    // output and only observable here. (Found by mutation-testing this file: an
    // output-only version of this suite passed with the guard deleted.)
    expect(vi.getTimerCount()).toBe(1);
  });

  it("holds the trailing value until the window elapses", () => {
    const sink = makeSink();
    const t = createHeightThrottle({ apply: sink.apply });
    t.markRenderDone();

    t.offer(400);
    vi.advanceTimersByTime(HEIGHT_THROTTLE_MS - 1);
    expect(sink.applied).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(sink.applied).toEqual([400]);
  });

  it("allows one apply per window across successive windows", () => {
    const sink = makeSink();
    const t = createHeightThrottle({ apply: sink.apply });
    t.markRenderDone();

    t.offer(300);
    t.offer(310);
    vi.advanceTimersByTime(HEIGHT_THROTTLE_MS);
    t.offer(320);
    t.offer(330);
    vi.advanceTimersByTime(HEIGHT_THROTTLE_MS);

    expect(sink.applied).toEqual([310, 330]);
  });

  it("does not re-apply a height that is already in effect", () => {
    const sink = makeSink();
    const t = createHeightThrottle({ apply: sink.apply });

    t.offer(480); // immediate path
    t.markRenderDone();
    t.offer(480); // same value again, now throttled
    vi.advanceTimersByTime(HEIGHT_THROTTLE_MS);

    expect(sink.applied).toEqual([480]);
  });

  it("still lets legitimate resizes through — throttled, not ignored", () => {
    const sink = makeSink();
    const t = createHeightThrottle({ apply: sink.apply });
    t.markRenderDone();

    // A window resize long after the render finished must still resize the frame.
    vi.advanceTimersByTime(60_000);
    t.offer(900);
    vi.advanceTimersByTime(HEIGHT_THROTTLE_MS);

    expect(sink.applied).toEqual([900]);
  });

  it("clamps in the throttled path too", () => {
    const sink = makeSink();
    const t = createHeightThrottle({ apply: sink.apply });
    t.markRenderDone();

    t.offer(1);
    vi.advanceTimersByTime(HEIGHT_THROTTLE_MS);
    t.offer(50_000);
    vi.advanceTimersByTime(HEIGHT_THROTTLE_MS);

    expect(sink.applied).toEqual([HEIGHT_MIN_PX, HEIGHT_MAX_PX]);
  });
});

describe("createHeightThrottle — reset (per-nonce remount and teardown)", () => {
  it("drops pending work so a stale height cannot land on the new payload", () => {
    const sink = makeSink();
    const t = createHeightThrottle({ apply: sink.apply });
    t.markRenderDone();

    t.offer(700); // queued for the trailing edge
    t.reset(); // new nonce arrives before the window closes
    vi.advanceTimersByTime(HEIGHT_THROTTLE_MS * 4);

    expect(sink.applied).toEqual([]);
  });

  it("returns to immediate mode, so the next payload's first paint is not delayed", () => {
    const sink = makeSink();
    const t = createHeightThrottle({ apply: sink.apply });
    t.markRenderDone();
    t.reset();

    t.offer(640);

    // No timer advance: reset must have cleared the done flag.
    expect(sink.applied).toEqual([640]);
  });

  it("leaves no timer behind after teardown", () => {
    const sink = makeSink();
    const t = createHeightThrottle({ apply: sink.apply });
    t.markRenderDone();
    t.offer(700);

    t.reset();

    expect(vi.getTimerCount()).toBe(0);
  });
});
