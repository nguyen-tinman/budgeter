<script lang="ts">
  // Host side of the /custom sandbox. Owns the iframe, the postMessage
  // handshake, the render watchdog, and the auto-height — nothing else in the
  // app touches the untrusted render code.
  //
  // Containment (see customHarness.ts for the harness half):
  //   · sandbox="allow-scripts" and NOTHING ELSE — no allow-same-origin, so the
  //     frame runs on an opaque origin: no cookies, no storage, no reach into
  //     this document. No allow-forms / allow-popups / allow-top-navigation.
  //   · srcdoc carries a CSP meta that blocks all network access.
  //   · Inbound messages are accepted only from the LIVE iframe's contentWindow,
  //     only from origin "null" (what an opaque origin reports), and only when
  //     the nonce matches the payload we last posted.
  //   · {#key nonce} re-mounts the iframe for every payload, which is the only
  //     reliable way to kill timers or a runaway loop from a previous render.
  //
  // FRAME RESOLUTION (B1). The live iframe is found by querying a STABLE
  // container that lives outside the keyed block — deliberately not `bind:this`
  // on the iframe itself. A `bind:this` inside {#key} is not dependable here:
  // the outgoing block's binding cleanup nulls the variable, and depending on
  // create/destroy ordering it can null it *after* the incoming element has
  // already assigned it, leaving the reference dead for the rest of the frame's
  // life. That silently drops bk:ready, so the payload is never posted and the
  // watchdog fires on a frame that was in fact healthy. The container ref is
  // created once with the component and is never torn down by a remount, so
  // querying it at message time always yields whichever iframe is actually in
  // the DOM right now.
  import { onDestroy, onMount } from "svelte";
  import { dev } from "$app/environment";
  import { HARNESS_HTML } from "$lib/customHarness.js";
  import { createHeightThrottle } from "$lib/heightThrottle.js";

  interface Props {
    /** Body of `function (root, data, bk)` — assistant-authored, untrusted. */
    render: string;
    /** Query results keyed by query id; a failed query is `{ error }`. */
    data: Record<string, unknown>;
    /** CSS custom properties copied out of the host's computed theme. */
    theme: Record<string, string>;
    title: string;
    workspaceId: number | null;
    palette: Array<{ id: number; name: string; color: string }>;
    /** Bumped by the page for every new payload; drives the remount. */
    nonce: number;
    /** Render threw, or the watchdog fired. The page surfaces the text so the
     *  user can relay it to the assistant. */
    onrendererror: (message: string) => void;
    /** Outcome of each render cycle, reported so the page can forward it to the
     *  server — that is the only way the assistant ever learns whether the
     *  definition it wrote actually draws. Distinguishes code that threw
     *  (`render_error`) from a sandbox that never completed the handshake
     *  (`sandbox_failed`), because those need different fixes. */
    onoutcome?: (o: { state: "ok" | "render_error" | "sandbox_failed"; message?: string }) => void;
  }
  const {
    render,
    data,
    theme,
    title,
    workspaceId,
    palette,
    nonce,
    onrendererror,
    onoutcome,
  }: Props = $props();

  /** No bk:done and no bk:error within this budget → assume a runaway loop and
   *  unmount. Removing the frame from the DOM is the only way to stop a busy
   *  script (sandboxed frames share this tab's event loop). */
  const WATCHDOG_MS = 5000;

  /** Handshake progress, mirrored onto the container as `data-state` so it is
   *  observable from outside — svelte-check and unit tests cannot see a
   *  postMessage handshake, so this is the seam an in-browser test asserts on
   *  instead of sniffing messages. */
  type HandshakeState =
    | "waiting-ready"
    | "rendering"
    | "done"
    | "error"
    | "failed-start"
    | "post-failed"
    | "timeout";

  let containerEl = $state<HTMLDivElement | null>(null);
  let height = $state(240);
  /** The nonce whose frame the watchdog unmounted. Stored as a nonce rather
   *  than a boolean so a NEW nonce restores the frame in the same render pass —
   *  a boolean had to be reset from an $effect, which re-added the element a
   *  microtask later and widened the window in which the frame reference was
   *  wrong. */
  let killedNonce = $state<number | null>(null);
  let handshake = $state<HandshakeState>("waiting-ready");

  const frameVisible = $derived(killedNonce !== nonce);

  // Per-cycle bookkeeping. Plain (non-reactive) on purpose: these are written
  // from $effect bodies and message handlers, and must never re-trigger them.
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  /** The nonce for which bk:ready has been received. Distinguishes "the sandbox
   *  never started" from "the render never finished" in the watchdog copy. */
  let readyNonce: number | null = null;
  /** Height gating (clamp + post-render throttle) lives in a plain module so
   *  its timing can be unit-tested with fake timers — Chrome throttles
   *  background-tab timers, so browser automation cannot exercise it. */
  const heightThrottle = createHeightThrottle({
    apply: (px) => {
      height = px;
    },
  });

  /** The iframe currently in the DOM, or null. See FRAME RESOLUTION above. */
  function liveFrame(): HTMLIFrameElement | null {
    return containerEl?.querySelector<HTMLIFrameElement>("iframe") ?? null;
  }

  function clearWatchdog(): void {
    if (watchdog !== null) {
      clearTimeout(watchdog);
      watchdog = null;
    }
  }

  function armWatchdog(forNonce: number): void {
    clearWatchdog();
    watchdog = setTimeout(() => {
      watchdog = null;
      if (forNonce !== nonce) return;
      // Two very different failures, two very different messages. Blaming a
      // nonexistent infinite loop when the sandbox never even started sends the
      // user (and the assistant) hunting in the render code for nothing.
      const neverStarted = readyNonce !== nonce;
      handshake = neverStarted ? "failed-start" : "timeout";
      killedNonce = forNonce;
      if (dev) {
        console.warn(
          `[CustomSandbox] nonce ${forNonce} timed out in state "${handshake}"` +
            (neverStarted
              ? " — no bk:ready was received, so the harness never handshook with the host."
              : " — bk:ready arrived but the render never reported done or error."),
        );
      }
      onoutcome?.({
        state: "sandbox_failed",
        message: neverStarted
          ? "the sandbox never completed its handshake (no bk:ready)"
          : "the render did not finish within 5s and was stopped (possible infinite loop)",
      });
      onrendererror(
        neverStarted
          ? "The custom page sandbox did not start. This is an app problem rather than something wrong with the page code — reloading usually clears it."
          : "The custom page did not finish rendering within 5s (possible infinite loop). It was stopped.",
      );
    }, WATCHDOG_MS);
  }


  /** Post the render payload into the live frame. Returns whether it went out.
   *
   *  Safe to call more than once for the same nonce: the harness clears its root
   *  and re-runs, so a duplicate costs one wasted render and nothing else. That
   *  tolerance is what lets the `load` fallback below be unconditional about
   *  correctness.
   *
   *  SNAPSHOTTING (B2). postMessage structured-clones its argument, and a Svelte
   *  5 $state proxy is NOT cloneable — posting one throws DataCloneError. The
   *  page's `data` and `theme` props are both backed by $state, so the whole
   *  outbound payload is passed through $state.snapshot() to turn any proxy
   *  (however deeply nested) into plain data. Snapshotting the WHOLE payload
   *  rather than the two known-proxied fields is deliberate: it is the boundary,
   *  so it stays correct if a future field or caller passes reactive state
   *  without anyone remembering this constraint. Doing it here rather than in
   *  the page is the same argument one level up — every present and future
   *  caller of this component is covered by construction.
   *
   *  Never throws to its caller: a throw escaping into the message handler would
   *  skip the watchdog arming below it and leave the handshake hung with no
   *  visible failure, which is exactly the silent-failure shape that has cost us
   *  audit rounds. Any failure is surfaced through onrendererror and data-state. */
  function postRender(): boolean {
    const win = liveFrame()?.contentWindow;
    if (!win) return false;
    try {
      // targetOrigin "*": an opaque-origin frame cannot be addressed by origin.
      // The payload is the user's own data, already rendered in this tab.
      const payload = $state.snapshot({
        type: "bk:render",
        nonce,
        render,
        data,
        meta: { title, workspaceId, palette, theme },
      });
      win.postMessage(payload, "*");
      return true;
    } catch (e) {
      // Cancel the in-flight watchdog so its (wrong) "timed out" verdict cannot
      // later overwrite this specific, accurate one.
      clearWatchdog();
      handshake = "post-failed";
      const detail = (e as Error)?.message ?? String(e);
      onoutcome?.({ state: "sandbox_failed", message: `could not deliver the render payload — ${detail}` });
      if (dev) {
        console.warn(`[CustomSandbox] nonce ${nonce}: could not post the render payload — ${detail}`);
      }
      onrendererror(
        `The custom page could not be handed to its sandbox (${detail}). This is an app problem rather than something wrong with the page code.`,
      );
      return false;
    }
  }

  /** Fallback path. If bk:ready never reached us, the frame's own load event
   *  still proves the srcdoc document (and therefore its inline script) is up,
   *  so we post anyway. Skipped once ready has arrived for this nonce, since
   *  the ready path already posted. A load event for the transient about:blank
   *  document is harmless here — the message lands in a document with no
   *  listener and is dropped, and the real ready still posts afterwards. */
  function onFrameLoad(): void {
    if (readyNonce === nonce) return;
    postRender();
  }

  function onMessage(ev: MessageEvent): void {
    const frame = liveFrame();
    if (!frame || ev.source !== frame.contentWindow) return;
    // Opaque origins serialize as the string "null"; belt-and-braces on top of
    // the source identity check above.
    if (ev.origin !== "null") return;
    const msg = ev.data as { type?: string; nonce?: number; px?: number; message?: string } | null;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "bk:ready") {
      readyNonce = nonce;
      // Only claim "rendering" (and re-arm, so the render gets a full budget
      // rather than the remains of the handshake's) if the payload actually went
      // out. A failed post has already set its own state and surfaced the
      // reason; overwriting that with "rendering" would hide it and leave the
      // watchdog to blame the render code for a host-side failure.
      if (postRender()) {
        handshake = "rendering";
        armWatchdog(nonce);
      }
      return;
    }
    // Everything else is tied to a specific payload; drop stale replies.
    if (msg.nonce !== nonce) return;
    if (msg.type === "bk:height") {
      const px = Number(msg.px);
      if (Number.isFinite(px)) heightThrottle.offer(px);
    } else if (msg.type === "bk:done") {
      clearWatchdog();
      heightThrottle.markRenderDone();
      handshake = "done";
      onoutcome?.({ state: "ok" });
    } else if (msg.type === "bk:error") {
      clearWatchdog();
      handshake = "error";
      const text = String(msg.message ?? "The page code threw an error.");
      onoutcome?.({ state: "render_error", message: text });
      onrendererror(text);
    }
  }

  onMount(() => {
    window.addEventListener("message", onMessage);
  });
  onDestroy(() => {
    window.removeEventListener("message", onMessage);
    clearWatchdog();
    heightThrottle.reset();
  });

  // A new payload starts a fresh cycle. This only resets bookkeeping and arms
  // the watchdog — it deliberately does NOT touch what is mounted, because the
  // template restores the frame for a new nonce on its own (see killedNonce).
  // Arming here covers the handshake as well as the render, so a frame that
  // never reports bk:ready is surfaced instead of sitting silently blank.
  $effect(() => {
    nonce;
    handshake = "waiting-ready";
    readyNonce = null;
    heightThrottle.reset();
    armWatchdog(nonce);
  });
</script>

<div
  bind:this={containerEl}
  class="custom-sandbox-host"
  data-testid="custom-sandbox-host"
  data-state={handshake}
  data-nonce={nonce}
>
  {#key nonce}
    {#if frameVisible}
      <iframe
        class="custom-sandbox-frame"
        sandbox="allow-scripts"
        srcdoc={HARNESS_HTML}
        title="Custom page canvas"
        data-testid="custom-sandbox"
        style:height={`${height}px`}
        onload={onFrameLoad}
      ></iframe>
    {/if}
  {/key}
</div>

<style>
  .custom-sandbox-host {
    display: block;
    width: 100%;
  }
  .custom-sandbox-frame {
    display: block;
    width: 100%;
    border: 0;
    background: transparent;
    /* Height is driven by the harness's bk:height messages. */
    transition: height 0.12s ease-out;
  }
  @media (prefers-reduced-motion: reduce) {
    .custom-sandbox-frame {
      transition: none;
    }
  }
</style>
