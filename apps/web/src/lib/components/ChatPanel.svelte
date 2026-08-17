<script lang="ts">
  import Icon from "./Icon.svelte";
  import StatusDot from "./StatusDot.svelte";
  import { api, type ChatPendingAction, type ChatSendResponse, type ChatClassifyResponse, type ClassifyRecommendation } from "$lib/api.js";
  import { refreshWorkspaces, workspaceState } from "$lib/workspace.svelte.js";
  import { invalidateResources, type ResourceName } from "$lib/appShellState.svelte.js";
  import {
    assistantMode,
    assistantSetupState,
    noteChatStatus,
    refreshAssistantSetup,
    startAssistantServer,
    startAssistantSetup,
  } from "$lib/assistantSetup.svelte.js";
  import { onDestroy, onMount, tick } from "svelte";

  interface ChatMessage {
    role: "user" | "assistant" | "system";
    text: string;
    /** Tool chips. `count` folds consecutive identical calls, so a model that
     *  retries one tool twenty times reads as "20× set_custom_page" instead of
     *  twenty separate blocks. Absent count means one. */
    tools?: Array<{ name: string; count?: number }>;
    /** Marks this message as a system-emitted compaction notice rather than
     *  a regular system error. Rendered with subtler styling. */
    compactionNotice?: boolean;
    /** Feature A: when present, this assistant turn proposed mutating actions
     *  that need the user's explicit Approve/Reject before they run. */
    pendingActions?: ChatPendingAction[];
    /** Set once the user resolves the pending actions so the controls hide. */
    pendingResolved?: "approved" | "rejected" | null;
    /** Set when the user hit Stop mid-stream: the partial text is kept and a
     *  subtle "stopped" affordance is rendered under the bubble. */
    stopped?: boolean;
    /** One completed step of a multi-step task, frozen in place while the turn
     *  continues. Kept distinct from the final answer so the user can watch
     *  progress accumulate; the final bubble is the one that answers. */
    step?: boolean;
    /** What the model is doing while there's nothing to show yet:
     *  "processing" = evaluating the prompt (prefill), no tokens produced yet;
     *  "thinking"   = generating hidden reasoning tokens.
     *  Cleared at the first visible answer token. The two are separate because
     *  a long prefill on a local model otherwise looks identical to a stall. */
    phase?: "processing" | "thinking";
    /** /classify review list: the AI's proposed category changes, each with a
     *  per-row accept flag. Rendered as an interactive accept/deny block; only
     *  accepted rows are written when the user clicks Apply. */
    recommendations?: Array<ClassifyRecommendation & { accepted: boolean }>;
    /** Set once the user resolves the recommendations so the controls hide. */
    recommendationsResolved?: "applied" | "dismissed" | null;
    /** Rows actually written when applied (for the resolved status line). */
    recommendationsApplied?: number;
    /** Attaches a one-click recovery button to a mapped assistant-unavailable
     *  message: run the model download, or start the local server. */
    setupCta?: "setup" | "start";
    /** Raw `code: message` from the server, kept in the bubble's title so the
     *  friendly copy doesn't cost us debuggability. */
    raw?: string;
  }

  interface Props {
    onclose: () => void;
  }
  const { onclose }: Props = $props();

  const ws = workspaceState();

  const SLASH_COMMANDS = [
    { name: "/clear",        desc: "Start a new chat (forgets history)" },
    { name: "/workspaces",   desc: "List all workspaces (Current + scenarios)" },
    { name: "/scenario new", desc: "Create a what-if scenario from active workspace" },
    { name: "/expenses",     desc: "List all expenses in the active workspace" },
    { name: "/classify",     desc: "Categorize every expense with the AI, one at a time" },
    { name: "/add expense",  desc: "Add a recurring expense" },
    { name: "/incomes",      desc: "List all incomes" },
    { name: "/take-home",    desc: "Compute take-home for the active workspace" },
    { name: "/sensitivity",  desc: "Run a 5×5 sensitivity grid" },
    { name: "/retire",       desc: "Project retirement balance year-by-year" },
    { name: "/compare",      desc: "Compare scenarios side-by-side" },
    { name: "/page",         desc: "Have the assistant design the /custom page" },
    { name: "/help",         desc: "Show available slash commands" },
  ];

  /** What /page drops into the composer. It is a prefill, not a command: the
   *  user finishes the sentence with what they actually want drawn, and the
   *  model takes it from there via get_custom_page / set_custom_page. */
  const PAGE_PREFILL = "Update the Custom page: ";

  let input = $state("");
  let busy = $state(false);
  /** True while a live streaming bubble is on screen (thinking or tokens), so
   *  the generic "· · ·" waiting indicator is suppressed to avoid a duplicate. */
  let streaming = $state(false);
  /** Controller for the in-flight chat request. Held so the Stop button can
   *  abort the SSE fetch (and thereby the server-side generation). Null when
   *  no request is running. */
  let activeController = $state<AbortController | null>(null);
  let log = $state<ChatMessage[]>([]);
  let chatStatus = $state<{ baseUrl: string; ok: boolean; httpStatus: number; backendMode?: string } | null>(null);
  let logEl: HTMLDivElement | null = $state(null);
  let inputEl: HTMLTextAreaElement | null = $state(null);
  let slashIdx = $state(0);
  /** Server-emitted dense summary of older turns, kept across calls so the
   *  model retains context after auto-compaction. Cleared by /clear and
   *  the "New chat" button. Updated when a response carries a `compaction`
   *  field. */
  let priorSummary = $state<string | null>(null);

  /** Undo stack state. The server snapshots at the START of each user turn, so
   *  one step here rewinds one thing the user asked for — however many
   *  assistant turns and tool calls that took. */
  let undoAvailable = $state(0);
  let undoDepth = $state(10);
  let undoLabel = $state("");
  let undoBusy = $state(false);

  async function refreshUndo(): Promise<void> {
    try {
      const r = await api.undo.list();
      undoAvailable = r.available ?? 0;
      undoDepth = r.depth ?? undoDepth;
      undoLabel = r.snapshots?.[0]?.label ?? "";
    } catch {
      // Undo is an affordance, not a dependency: if the API is unreachable the
      // button simply stays disabled rather than the panel erroring.
      undoAvailable = 0;
    }
  }

  async function undoLastTurn(): Promise<void> {
    if (undoBusy || undoAvailable === 0) return;
    // Undo restores a point in TIME, so it also drops anything edited by hand
    // since then. Say that plainly before doing it — it is the one way this
    // control can surprise someone.
    const what = undoLabel ? `"${undoLabel}"` : "the last change";
    if (
      !confirm(
        `Undo ${what}?\n\nThis restores your data to just before that message — ` +
          `any changes made since then, including edits you made yourself, are reverted.`,
      )
    ) {
      return;
    }
    undoBusy = true;
    try {
      const r = await api.undo.apply();
      if (!r.ok) {
        log = [...log, { role: "system", text: `Undo failed: ${r.message || r.error || "unknown"}` }];
        return;
      }
      // The server returns every cached resource name; a restore can change any
      // of them, so nothing here tries to narrow the list.
      invalidateResources((r.affectedResources ?? []) as ResourceName[]);
      await refreshWorkspaces();
      log = [...log, {
        role: "system",
        text: `Undid ${what}. ${r.remaining ?? 0} step${(r.remaining ?? 0) === 1 ? "" : "s"} left.`,
      }];
    } catch (e) {
      log = [...log, { role: "system", text: `Undo failed: ${(e as Error).message}` }];
    } finally {
      undoBusy = false;
      await refreshUndo();
      void scrollToBottom();
    }
  }

  const slashOpen = $derived(input.trim().startsWith("/"));
  const filteredSlash = $derived(
    slashOpen
      ? SLASH_COMMANDS.filter((c) => {
          const q = input.trim().toLowerCase();
          return c.name.toLowerCase().startsWith(q) || c.desc.toLowerCase().includes(q.slice(1));
        })
      : []
  );

  // The first two are orientation prompts: a brand-new user's problem is
  // "what is this thing for?", not "which of these four budget questions".
  const SUGGESTED = [
    "What can you do?",
    "/help",
    "What's my monthly remaining?",
    "Build a custom chart of my spending",
    "Compare Current vs other workspaces",
    "Show subs I should cancel",
    "Project my retirement to age 65",
  ];

  /** Refresh the llama-server reachability indicator. Called once on mount
   *  and then on a short interval so the dot flips green within ~4s of the
   *  user starting llama-server externally. Polling is cheap (single GET to
   *  the API which forwards a tiny health request). */
  async function refreshChatStatus(): Promise<void> {
    try {
      chatStatus = await api.chat.status();
    } catch {
      chatStatus = { baseUrl: "(unknown)", ok: false, httpStatus: 0 };
    }
    noteChatStatus(chatStatus?.ok ?? null);
  }

  let statusPollHandle: ReturnType<typeof setInterval> | null = null;
  /** 1s tick counter; the reachability poll only fires every 4th tick so the
   *  original 4s cadence is preserved. */
  let pollTicks = 0;

  /** One poll step. Reachability stays on its 4s beat; the setup/model state
   *  refreshes on the same 4s beat while the assistant isn't ready, and every
   *  second while a download is running (same rate as the Setup page) so the
   *  inline progress bar moves. */
  async function pollTick(): Promise<void> {
    pollTicks += 1;
    const slow = pollTicks % 4 === 0;
    const m = assistantMode();
    if (slow) await refreshChatStatus();
    if (m === "downloading" || (slow && m !== "ready")) {
      await refreshAssistantSetup();
    }
  }

  onMount(async () => {
    await restoreLog();
    await refreshChatStatus();
    await refreshAssistantSetup();
    await refreshUndo();
    // Tick every 1s. Stops on component teardown (onDestroy below).
    statusPollHandle = setInterval(() => {
      void pollTick();
    }, 1000);
  });

  onDestroy(() => {
    if (statusPollHandle !== null) {
      clearInterval(statusPollHandle);
      statusPollHandle = null;
    }
  });

  const setupState = assistantSetupState();
  /** `unknown | not_set_up | downloading | stopped | ready` — drives the header
   *  copy, the empty state and which CTA (if any) sits above the composer. */
  const mode = $derived(assistantMode());
  const statusLabel = $derived(
    mode === "not_set_up" ? "not set up"
    : mode === "downloading" ? "downloading model…"
    : mode === "stopped" ? "stopped"
    : mode === "ready" ? "ready"
    // unknown: fall back to the pre-existing reachability-only copy.
    : chatStatus ? (chatStatus.ok ? "ready" : "offline") : "connecting…",
  );
  const statusDot = $derived(
    mode === "downloading" ? "starting"
    : mode === "ready" ? "ready"
    : mode === "unknown" ? (chatStatus ? (chatStatus.ok ? "ready" : "stopped") : "starting")
    : "stopped",
  );
  /** The step whose progress we render inline: step 2 once step 1 is done. */
  const setupStep = $derived(
    setupState.setup
      ? (setupState.setup.step1.status === "done" ? setupState.setup.step2 : setupState.setup.step1)
      : null,
  );
  const setupStepIndex = $derived(setupState.setup?.step1.status === "done" ? 2 : 1);

  /** Turn a raw server error code into copy a first-time user can act on, plus
   *  (when applicable) the one-click recovery this panel can run itself. */
  function mapChatError(code: string | undefined, message: string | undefined): {
    text: string;
    setupCta?: "setup" | "start";
  } {
    if (code === "llm_unreachable") {
      if (mode === "not_set_up") {
        return {
          text: "The assistant isn't set up yet — it runs a local model that needs a one-time download.",
          setupCta: "setup",
        };
      }
      if (mode === "downloading") {
        return { text: "The local model is still downloading — I'll be able to answer as soon as it finishes." };
      }
      // `stopped`, or `unknown` (we couldn't read the model/setup state): say
      // only what we know — the server isn't answering — and offer to start it.
      return { text: "I couldn't reach the local model server.", setupCta: "start" };
    }
    if (code === "setup_in_progress" || code === "already_running") {
      return { text: "A model download is in progress — try again once it finishes." };
    }
    return { text: `error: ${code ?? "unknown"}: ${message ?? ""}` };
  }

  async function scrollToBottom() {
    await tick();
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  }

  /** Reset the local log + the (currently no-op) server-side state. Backs
   *  both the /clear slash command and the "New chat" header button. Also
   *  drops the priorSummary so the next turn starts with no folded
   *  context — otherwise the model would still carry the prior
   *  conversation's substance after a "New chat" click. */
  async function newChat() {
    if (busy) return;
    log = [];
    input = "";
    priorSummary = null;
    try {
      await api.chat.clear();
    } catch {
      // Best-effort: a flaky connection must not leave the UI stuck. The local
      // log is already empty; the stored copy is overwritten by the next
      // persistLog() anyway.
    }
  }

  /** Load the stored transcript on mount. The conversation outlives a reload,
   *  a navigation, and an API restart — only "New chat" ends it. */
  async function restoreLog(): Promise<void> {
    try {
      const r = await api.chat.log();
      if (!r?.ok || !Array.isArray(r.messages) || r.messages.length === 0) return;
      // Only seed an untouched panel: a slow response must never clobber
      // something the user has already typed and sent.
      if (log.length > 0) return;
      log = r.messages.map((m) => ({ ...m }));
      priorSummary = r.priorSummary && r.priorSummary.length > 0 ? r.priorSummary : null;
      await scrollToBottom();
    } catch {
      // A missing/failed transcript is not worth an error bubble — the user
      // just gets a fresh panel.
    }
  }

  /** Persist what is currently on screen. Called when a turn settles, not per
   *  token: mid-stream the bubble is rewritten on every delta, and storing
   *  those would be hundreds of writes per reply for no benefit. */
  function persistLog(): void {
    const messages = log
      .filter((m) => m.text.length > 0 || (m.tools?.length ?? 0) > 0)
      .map((m) => ({
        role: m.role,
        text: m.text,
        ...(m.tools && m.tools.length > 0 ? { tools: m.tools } : {}),
        ...(m.step ? { step: true } : {}),
        ...(m.stopped ? { stopped: true } : {}),
        ...(m.compactionNotice ? { compactionNotice: true } : {}),
      }));
    // Fire-and-forget: persistence must never block or break a reply.
    void api.chat.saveLog(messages, priorSummary).catch(() => {});
  }

  /** Snapshot the user+assistant turns we forward as `history` (excludes the
   *  new line, which goes in `message`). System notices are dropped. */
  function historySnapshot(): Array<{ role: "user" | "assistant"; text: string }> {
    return log
      .filter(
        (m): m is ChatMessage & { role: "user" | "assistant" } =>
          (m.role === "user" || m.role === "assistant") && m.text.length > 0,
      )
      .map((m) => ({ role: m.role, text: m.text }));
  }

  /** Apply the terminal payload (from `done`, non-stream `send`, or fallback).
   *  Handles compaction notice, pendingActions, tool-result invalidation. */
  async function applyDone(
    r: ChatSendResponse,
    streamedText: string,
    /** Tool calls already rendered on per-step bubbles (see onStep). The
     *  terminal payload lists every call the whole turn made, so without this
     *  the final message repeats every chip the user already watched appear. */
    alreadyShownTools = 0,
  ): Promise<void> {
    const remainingTools = Array.isArray(r.toolCalls)
      ? foldTools(r.toolCalls.slice(alreadyShownTools))
      : undefined;
    if (!r.ok) {
      const mapped = mapChatError(r.error, r.message);
      log = [...log, {
        role: "system",
        text: mapped.text,
        setupCta: mapped.setupCta,
        raw: `${r.error ?? "unknown"}: ${r.message ?? ""}`,
      }];
      return;
    }
    // Surface a compaction notice before the assistant turn, and persist the
    // new summary so the next turn carries the folded context forward.
    if (r.compaction) {
      priorSummary = r.compaction.summary;
      log = [...log, {
        role: "system",
        text: `[summarized ${r.compaction.droppedCount} earlier turns]`,
        compactionNotice: true,
      }];
    }
    if (r.pendingActions && r.pendingActions.length > 0) {
      // Feature A: the assistant wants to mutate state. Show Approve/Reject
      // instead of executing. No assistant text is rendered (it's empty until
      // the user decides).
      log = [...log, {
        role: "assistant",
        text: r.assistantText && r.assistantText.length > 0 ? r.assistantText : "I'd like to make the following change(s):",
        tools: remainingTools && remainingTools.length > 0 ? remainingTools : undefined,
        pendingActions: r.pendingActions,
        pendingResolved: null,
      }];
    } else {
      // Normal assistant reply. Prefer the streamed text we already rendered;
      // fall back to the terminal assistantText (covers the non-stream path).
      const text = r.assistantText && r.assistantText.length > 0 ? r.assistantText : streamedText;
      const tools = remainingTools && remainingTools.length > 0 ? remainingTools : undefined;
      // A turn whose every tool call was already rendered as a step, and which
      // ended without text, has nothing left to say — appending a bubble for it
      // just paints an empty box under the run. The server now guarantees text
      // in that case (see the silent-turn recovery in chat.ts); this is the
      // second line of defence, and it also covers a stream the user stopped.
      if (text.length > 0 || tools) {
        log = [...log, { role: "assistant", text, tools }];
      }
    }
    await refreshWorkspaces();
    if (Array.isArray(r.affectedResources) && r.affectedResources.length > 0) {
      invalidateResources(r.affectedResources);
    }
  }

  /** Fold consecutive identical tool names into counted chips. */
  function foldTools(names: Array<{ name: string; count?: number }>): Array<{ name: string; count?: number }> {
    const out: Array<{ name: string; count?: number }> = [];
    for (const t of names) {
      const prev = out[out.length - 1];
      if (prev && prev.name === t.name) prev.count = (prev.count ?? 1) + (t.count ?? 1);
      else out.push({ name: t.name, count: t.count });
    }
    return out;
  }

  /** True when `m` is an action-only bubble whose entire tool list is repeats of
   *  `name` — i.e. the bubble a new step of the same tool should merge into
   *  rather than stack beneath. */
  function absorbsTool(m: ChatMessage | undefined, name: string): boolean {
    return !!m && actionsOnly(m) && m.tools!.length === 1 && m.tools![0]!.name === name;
  }

  /** A step that ran tools without saying anything — e.g. the model calling
   *  compute_retirement twice in a row. It carries a single chip, so the bubble
   *  chrome around it is pure overhead; rendered flush instead (see the
   *  data-actions-only rule in editorial.css). */
  function actionsOnly(m: ChatMessage): boolean {
    return (
      m.role === "assistant" &&
      !m.text &&
      !m.phase &&
      !m.pendingActions &&
      (m.tools?.length ?? 0) > 0
    );
  }

  /** True when an error originates from the user hitting Stop (the abort path)
   *  rather than a genuine network/stream failure. AbortError is what fetch and
   *  ReadableStream readers throw when their signal is aborted. */
  function isAbortError(e: unknown): boolean {
    return e instanceof DOMException
      ? e.name === "AbortError"
      : (e as { name?: string } | null)?.name === "AbortError";
  }

  /** Core turn driver. `approvedActions` is set on the approval round-trip;
   *  the user-visible message + history are reused from the original turn. */
  async function runTurn(
    msg: string,
    history: Array<{ role: "user" | "assistant"; text: string }>,
    approvedActions?: Array<{ id?: string; toolName: string; args?: unknown }>,
  ): Promise<void> {
    busy = true;
    // One controller per turn; Stop aborts it, which cancels the SSE fetch and
    // (via the dropped connection) the server-side generation.
    const controller = new AbortController();
    activeController = controller;
    // Live-streaming assistant bubble: created lazily on the first delta so a
    // pure-tool-call turn doesn't render an empty bubble.
    let streamIdx = -1;
    let streamedText = "";
    let shownToolCount = 0;
    const ensureStreamBubble = () => {
      if (streamIdx === -1) {
        log = [...log, { role: "assistant", text: "" }];
        streamIdx = log.length - 1;
      }
      streaming = true;
    };
    try {
      let final: ChatSendResponse | null = null;
      try {
        await api.chat.sendStream(
          msg,
          { workspaceId: ws.activeId ?? undefined, history, priorSummary: priorSummary ?? undefined, approvedActions },
          {
            onProcessing: () => {
              // Prefill: the model is busy on the prompt and has produced
              // nothing yet. Shown until the first reasoning or answer token.
              ensureStreamBubble();
              if (streamedText.length === 0) log[streamIdx]!.phase = "processing";
              void scrollToBottom();
            },
            onThinking: (active) => {
              ensureStreamBubble();
              // Reasoning tokens ARE being produced — supersedes "processing",
              // and only until visible answer text exists.
              log[streamIdx]!.phase =
                active && streamedText.length === 0 ? "thinking" : undefined;
              void scrollToBottom();
            },
            onDelta: (text) => {
              ensureStreamBubble();
              streamedText += text;
              log[streamIdx]!.text = streamedText;
              // First visible token ends both waiting phases.
              log[streamIdx]!.phase = undefined;
              void scrollToBottom();
            },
            onTool: () => {
              // A tool call ends the current waiting phase too.
              if (streamIdx !== -1) log[streamIdx]!.phase = undefined;
            },
            onStep: (step) => {
              // Freeze this step as its own bubble and start a fresh one for the
              // next turn, so a multi-step task reads as visible progress rather
              // than a single message that rewrites itself at the end. Steps
              // carry their own tool chips; applyDone therefore renders only the
              // tools it hasn't already shown (see shownTools).
              const text = step.text || streamedText;
              const tools = foldTools(step.tools.map((name) => ({ name })));
              // A silent step repeating the tool the previous bubble already
              // shows folds into it, so a retry loop grows a counter rather
              // than the log.
              const mergeIdx = streamIdx === -1 ? log.length - 1 : streamIdx - 1;
              if (text.length === 0 && tools.length === 1 && absorbsTool(log[mergeIdx], tools[0]!.name)) {
                const chip = log[mergeIdx]!.tools![0]!;
                chip.count = (chip.count ?? 1) + (tools[0]!.count ?? 1);
                if (streamIdx !== -1) log.splice(streamIdx, 1);
                shownToolCount += step.tools.length;
                streamIdx = -1;
                streamedText = "";
                return;
              }
              if (streamIdx !== -1) {
                log[streamIdx]!.text = text;
                log[streamIdx]!.phase = undefined;
                log[streamIdx]!.step = true;
                log[streamIdx]!.tools = tools;
              } else if (text.length > 0 || tools.length > 0) {
                log = [...log, { role: "assistant", text, step: true, tools }];
              }
              shownToolCount += step.tools.length;
              // Next turn streams into a new bubble.
              streamIdx = -1;
              streamedText = "";
            },
            onApplied: (p) => {
              // An auto-applied mutation already committed server-side. Fire the
              // invalidation NOW rather than waiting for `done`, so the affected
              // page (today: /custom) repaints while the model is still talking.
              // applyDone repeats this from the terminal payload; refetches are
              // idempotent and generation-guarded.
              if (p.affectedResources.length > 0) invalidateResources(p.affectedResources);
            },
            onDone: (f) => { final = f; },
            onError: (e) => { final = e; },
          },
          controller.signal,
        );
      } catch (e) {
        // User-initiated Stop: keep whatever already streamed, finalize the
        // bubble in place (don't drop it / don't run applyDone), and exit
        // without surfacing an error. The server sees the dropped connection
        // and stops generating.
        if (isAbortError(e) || controller.signal.aborted) {
          if (streamIdx !== -1) {
            log[streamIdx]!.stopped = true;
          } else {
            // Aborted before any token arrived — leave a minimal stopped marker
            // so the turn isn't silently empty.
            log = [...log, { role: "assistant", text: "", stopped: true }];
          }
          return;
        }
        // Streaming connection failed before any event → fall back to the
        // non-streaming endpoint so the user still gets a reply. Pass the same
        // signal so Stop still cancels the fallback request.
        final = await api.chat.send(msg, {
          workspaceId: ws.activeId ?? undefined,
          history,
          priorSummary: priorSummary ?? undefined,
          approvedActions,
        }, controller.signal);
      }
      // Drop the live bubble; applyDone re-renders the authoritative turn
      // (with tool chips / pending actions / final text).
      if (streamIdx !== -1) {
        log = log.filter((_, i) => i !== streamIdx);
      }
      if (final) {
        await applyDone(final, streamedText, shownToolCount);
      } else {
        log = [...log, { role: "system", text: "error: stream ended without a result" }];
      }
    } catch (e) {
      // Catch a Stop that landed on the non-streaming fallback too.
      if (isAbortError(e) || controller.signal.aborted) {
        if (streamIdx !== -1) log[streamIdx]!.stopped = true;
      } else {
        log = [...log, { role: "system", text: `network: ${(e as Error).message}` }];
      }
    } finally {
      busy = false;
      streaming = false;
      activeController = null;
      // The server took an undo point when this turn started, so the count on
      // the button is stale until now.
      void refreshUndo();
      void scrollToBottom();
      // Turn settled (answered, errored, or stopped) — store what is rendered.
      persistLog();
    }
  }

  /** Driver for the /classify command. Streams the server-side per-line
   *  classification loop (POST /api/chat/classify) into ONE growing assistant
   *  bubble — a header, then "label → category" per expense, then a summary.
   *  Unlike runTurn this never goes through the model's tool loop: the server
   *  orchestrates the for-loop and we just render the streamed lines, so the
   *  streamed text IS the final bubble (no drop-and-re-render via applyDone).
   *  Stop preserves partial text + persisted rows; Stop aborts via the dropped
   *  connection, exactly like runTurn. */
  async function runClassify(): Promise<void> {
    const workspaceId = ws.activeId;
    if (workspaceId == null) {
      log = [...log, { role: "system", text: "Select a workspace before running /classify." }];
      void scrollToBottom();
      return;
    }
    busy = true;
    const controller = new AbortController();
    activeController = controller;
    let streamIdx = -1;
    let streamedText = "";
    const ensureStreamBubble = () => {
      if (streamIdx === -1) {
        log = [...log, { role: "assistant", text: "" }];
        streamIdx = log.length - 1;
      }
      streaming = true;
    };
    try {
      let done: ChatClassifyResponse | null = null;
      let errored: ChatClassifyResponse | null = null;
      try {
        await api.chat.classifyStream(
          { workspaceId },
          {
            onDelta: (text) => {
              ensureStreamBubble();
              streamedText += text;
              log[streamIdx]!.text = streamedText;
              void scrollToBottom();
            },
            onDone: (f) => { done = f; },
            onError: (e) => { errored = e; },
          },
          controller.signal,
        );
      } catch (e) {
        // User-initiated Stop: keep whatever already streamed (and the rows
        // already written server-side), mark the bubble stopped, exit clean.
        if (isAbortError(e) || controller.signal.aborted) {
          if (streamIdx !== -1) log[streamIdx]!.stopped = true;
          else log = [...log, { role: "assistant", text: "", stopped: true }];
          return;
        }
        log = [...log, { role: "system", text: `network: ${(e as Error).message}` }];
        return;
      }
      // `done`/`errored` are set inside the stream callbacks; cast past TS's
      // closure-blind flow narrowing (which otherwise collapses them to `never`).
      const errResult = errored as ChatClassifyResponse | null;
      if (errResult) {
        const mapped = mapChatError(errResult.error, errResult.message);
        log = [
          ...log,
          {
            role: "system",
            text: mapped.text,
            setupCta: mapped.setupCta,
            raw: `${errResult.error ?? "unknown"}: ${errResult.message ?? ""}`,
          },
        ];
        return;
      }
      // Nothing was written — attach the review list to the streamed bubble,
      // which collapses to a one-line summary. applyRecommendations() commits
      // whatever the user accepts.
      const doneResult = done as ChatClassifyResponse | null;
      const recs = doneResult?.recommendations ?? [];
      if (streamIdx !== -1) {
        if (recs.length > 0) {
          const correct = (doneResult?.examined ?? 0) - recs.length;
          log[streamIdx]!.text =
            `${recs.length} suggested ${recs.length === 1 ? "change" : "changes"}` +
            `${correct > 0 ? ` · ${correct} already correct` : ""}`;
          log[streamIdx]!.recommendations = recs.map((r) => ({ ...r, accepted: true }));
        } else if ((doneResult?.total ?? 0) === 0) {
          log[streamIdx]!.text = "No expenses to review in this workspace.";
        } else {
          log[streamIdx]!.text = "All expenses already look well-categorized — no changes suggested.";
        }
      }
    } finally {
      busy = false;
      streaming = false;
      activeController = null;
      void scrollToBottom();
      persistLog();
    }
  }

  /** Stop button: cancel the in-flight request. The partial assistant text is
   *  preserved by runTurn's abort handling; busy/streaming state clears in its
   *  finally block, re-enabling the composer. */
  function stop() {
    activeController?.abort();
  }

  async function send(textOverride?: string) {
    const msg = (textOverride ?? input).trim();
    if (!msg || busy) return;
    // Intercept /clear so the server doesn't process it as a chat message.
    if (msg === "/clear") {
      input = "";
      await newChat();
      return;
    }
    // Intercept /help: the command list lives in this component (SLASH_COMMANDS)
    // and the server has no /help handler, so answering locally is both exact
    // and instant — and it works before the local model is even downloaded.
    if (msg === "/help") {
      input = "";
      log = [
        ...log,
        { role: "user", text: msg },
        {
          role: "system",
          text:
            "Commands:\n" +
            SLASH_COMMANDS.map((c) => `${c.name} — ${c.desc}`).join("\n") +
            "\nOr just describe what you want in plain English.",
        },
      ];
      void scrollToBottom();
      return;
    }
    // Intercept /page: there is no server-side handler and nothing to answer —
    // it seeds the composer with the opening of a Custom-page request so the
    // user only has to describe the chart. Same client-side interception shape
    // as /help, but it hands the turn back to the user instead of replying.
    if (msg === "/page") {
      input = PAGE_PREFILL;
      void tick().then(() => {
        inputEl?.focus();
        inputEl?.setSelectionRange(PAGE_PREFILL.length, PAGE_PREFILL.length);
      });
      return;
    }
    // Intercept /classify — it runs a dedicated server-side per-line loop
    // (POST /api/chat/classify), not a model turn. Echo the command as a user
    // line, then drive the classify stream.
    if (msg === "/classify") {
      input = "";
      log = [...log, { role: "user", text: msg }];
      void scrollToBottom();
      await runClassify();
      return;
    }
    input = "";
    // Snapshot history BEFORE appending the new user line.
    const history = historySnapshot();
    log = [...log, { role: "user", text: msg }];
    void scrollToBottom();
    await runTurn(msg, history);
  }

  /** Feature A: approve a single pending action (or all of them) and re-run
   *  the turn so the server executes ONLY the approved tools and the model
   *  reacts to the results. */
  async function approveActions(msgIdx: number, action?: ChatPendingAction) {
    if (busy) return;
    const m = log[msgIdx];
    if (!m || !m.pendingActions || m.pendingResolved) return;
    const toApprove = action ? [action] : m.pendingActions;
    // Mark resolved so the controls hide; remaining (un-approved) actions in a
    // per-action approval are implicitly rejected by not being re-sent.
    log[msgIdx]!.pendingResolved = "approved";
    const approvedActions = toApprove.map((a) => ({ id: a.id, toolName: a.toolName, args: a.args }));
    // The follow-up message is a short confirmation; the server re-runs the
    // model after executing the approved tools. History excludes nothing
    // special — applyDone appended the assistant pending turn as text.
    const history = historySnapshot();
    await runTurn("Approved. Please proceed.", history, approvedActions);
  }

  /** Feature A: reject all pending actions for a message. Tells the model they
   *  were declined so it can offer an alternative. */
  async function rejectActions(msgIdx: number) {
    if (busy) return;
    const m = log[msgIdx];
    if (!m || !m.pendingActions || m.pendingResolved) return;
    log[msgIdx]!.pendingResolved = "rejected";
    const history = historySnapshot();
    await runTurn("I declined those changes. Don't make them.", history);
  }

  /** /classify review: flip one recommendation's accept flag. */
  function toggleRecommendation(msgIdx: number, recIdx: number) {
    const m = log[msgIdx];
    if (!m?.recommendations || m.recommendationsResolved) return;
    const rec = m.recommendations[recIdx];
    if (rec) rec.accepted = !rec.accepted;
  }

  /** /classify review: accept-all / clear-all the accept flags. */
  function setAllRecommendations(msgIdx: number, accepted: boolean) {
    const m = log[msgIdx];
    if (!m?.recommendations || m.recommendationsResolved) return;
    for (const rec of m.recommendations) rec.accepted = accepted;
  }

  /** /classify review: commit the accepted rows via /classify/apply, then
   *  invalidate so Budget/Library/Trends refresh. Empty selection → dismiss. */
  async function applyRecommendations(msgIdx: number) {
    if (busy) return;
    const m = log[msgIdx];
    if (!m?.recommendations || m.recommendationsResolved) return;
    const changes = m.recommendations
      .filter((r) => r.accepted)
      .map((r) => ({ id: r.id, categoryId: r.recommendedCategoryId }));
    if (changes.length === 0) {
      dismissRecommendations(msgIdx);
      return;
    }
    busy = true;
    try {
      const res = await api.chat.classifyApply({ changes });
      if (res.ok) {
        if (res.affectedResources && res.affectedResources.length > 0) {
          invalidateResources(res.affectedResources);
        }
        log[msgIdx]!.recommendationsResolved = "applied";
        log[msgIdx]!.recommendationsApplied = res.updated ?? changes.length;
      } else {
        log = [...log, { role: "system", text: `error: ${res.message ?? "apply failed"}` }];
      }
    } catch (e) {
      log = [...log, { role: "system", text: `network: ${(e as Error).message}` }];
    } finally {
      busy = false;
    }
  }

  /** /classify review: discard the recommendations without writing anything. */
  function dismissRecommendations(msgIdx: number) {
    const m = log[msgIdx];
    if (!m?.recommendations || m.recommendationsResolved) return;
    log[msgIdx]!.recommendationsResolved = "dismissed";
  }

  function onKey(e: KeyboardEvent) {
    if (slashOpen && filteredSlash.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); slashIdx = Math.min(filteredSlash.length - 1, slashIdx + 1); return; }
      if (e.key === "ArrowUp")   { e.preventDefault(); slashIdx = Math.max(0, slashIdx - 1); return; }
      if (e.key === "Tab")       { e.preventDefault(); const pick = filteredSlash[slashIdx]; if (pick) input = pick.name + " "; return; }
      if (e.key === "Escape")    { input = ""; return; }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }
</script>

<aside class="bk-chat" aria-label="Budget assistant" data-testid="chat-panel">
  <div class="bk-chat-hd">
    <span
      style="width: 26px; height: 26px; display: grid; place-items: center; border-radius: 8px; background: var(--accent); color: var(--accent-fg)"
      aria-hidden="true"
    >
      <Icon name="sparkles" size={14} />
    </span>
    <div style="flex: 1; display: flex; flex-direction: column; gap: 2px">
      <strong style="font-size: 13px">Assistant</strong>
      <div class="bk-text-3" style="font-size: 11px; display: flex; gap: 6px; align-items: center">
        <StatusDot status={statusDot} />
        <span data-testid="chat-status" data-mode={mode} title={chatStatus ? chatStatus.baseUrl : undefined}>
          {statusLabel}
        </span>
      </div>
    </div>
    <button
      class="bk-iconbtn"
      aria-label={undoAvailable > 0
        ? `Undo the last change${undoLabel ? `: ${undoLabel}` : ""} (${undoAvailable} step${undoAvailable === 1 ? "" : "s"} available)`
        : "Undo the last change (nothing to undo)"}
      title={undoAvailable > 0
        ? `Undo "${undoLabel}" — reverts everything since that message (${undoAvailable} of ${undoDepth} steps kept)`
        : "Nothing to undo yet"}
      data-testid="chat-undo"
      data-available={undoAvailable}
      disabled={busy || undoBusy || undoAvailable === 0}
      onclick={() => void undoLastTurn()}
    >
      <Icon name="undo" size={14} />
    </button>
    <!-- Labelled and bordered on purpose: as a bare icon button its arrow read
         as a mirror image of Undo, and the two do very different things. -->
    <button
      class="bk-btn bk-btn-sm"
      aria-label="New chat (clear history)"
      title="New chat"
      data-testid="chat-new"
      disabled={busy || log.length === 0}
      onclick={() => void newChat()}
    >
      New chat
    </button>
    <button class="bk-iconbtn" aria-label="Close chat panel" data-testid="chat-toggle" onclick={onclose}>
      <Icon name="close" size={14} />
    </button>
  </div>

  <div class="bk-chat-log" bind:this={logEl} role="log" aria-live="polite" data-testid="chat-log">
    {#if log.length === 0 && (mode === "ready" || mode === "unknown")}
      <div class="bk-msg" data-role="system">I'm your budget assistant. Try /help, or just describe what you want.</div>
    {/if}
    {#each log as m, i (i)}
      <div
        class="bk-msg"
        data-role={m.role}
        data-compaction={m.compactionNotice ? "true" : undefined}
        data-step={m.step ? "true" : undefined}
        {...actionsOnly(m) ? { "data-actions-only": "true" } : {}}
        data-testid={`chat-msg-${i}`}
        title={m.raw}
      >
        {#if m.phase && !m.text}
          <span
            class="bk-thinking"
            data-phase={m.phase}
            data-testid={`chat-${m.phase}-${i}`}
            aria-label={m.phase === "processing"
              ? "Assistant is reading the conversation"
              : "Assistant is thinking"}
          >{m.phase === "processing" ? "Processing" : "Thinking"}<span class="bk-thinking-dots" aria-hidden="true"></span></span>
        {:else if m.text}
          <span class="bk-msg-text">{m.text}</span>
        {/if}
        {#if m.stopped}
          <div class="bk-msg-stopped" data-testid={`chat-stopped-${i}`}>⏹ stopped</div>
        {/if}
        {#if m.setupCta}
          <div class="bk-pending-actions" style="justify-content: flex-start">
            {#if m.setupCta === "setup"}
              <button
                class="bk-btn bk-btn-sm bk-btn-primary"
                data-testid={`chat-msg-setup-${i}`}
                disabled={setupState.busy}
                onclick={() => void startAssistantSetup()}
              ><Icon name="download" size={12} /> Set up local LLM</button>
            {:else}
              <button
                class="bk-btn bk-btn-sm bk-btn-primary"
                data-testid={`chat-msg-start-${i}`}
                disabled={setupState.busy}
                onclick={() => void startAssistantServer()}
              ><Icon name="play" size={12} /> Start assistant</button>
            {/if}
            <a class="bk-btn bk-btn-sm" href="/setup" data-testid={`chat-msg-setup-link-${i}`}>Open Setup</a>
          </div>
        {/if}
        {#if m.tools && m.tools.length > 0}
          <div class="bk-msg-tool" aria-label="Tool calls used">
            {m.tools.map((t) => `→ ${(t.count ?? 1) > 1 ? `${t.count}× ` : ""}${t.name}`).join("   ")}
          </div>
        {/if}
        {#if m.pendingActions && m.pendingActions.length > 0}
          <div class="bk-pending" data-testid={`chat-pending-${i}`} data-resolved={m.pendingResolved ?? undefined}>
            {#each m.pendingActions as a (a.id)}
              <div class="bk-pending-row">
                <span class="bk-pending-summary">{a.summary}</span>
                {#if !m.pendingResolved}
                  <button
                    class="bk-btn bk-btn-sm bk-btn-primary"
                    data-testid={`chat-approve-${a.id}`}
                    disabled={busy}
                    onclick={() => void approveActions(i, a)}
                  >Approve</button>
                {/if}
              </div>
            {/each}
            {#if m.pendingResolved === "approved"}
              <div class="bk-pending-status">Approved</div>
            {:else if m.pendingResolved === "rejected"}
              <div class="bk-pending-status">Rejected</div>
            {:else}
              <div class="bk-pending-actions">
                {#if m.pendingActions.length > 1}
                  <button
                    class="bk-btn bk-btn-sm bk-btn-primary"
                    data-testid={`chat-approve-all-${i}`}
                    disabled={busy}
                    onclick={() => void approveActions(i)}
                  >Approve all</button>
                {/if}
                <button
                  class="bk-btn bk-btn-sm bk-btn-danger"
                  data-testid={`chat-reject-${i}`}
                  disabled={busy}
                  onclick={() => void rejectActions(i)}
                >Reject</button>
              </div>
            {/if}
          </div>
        {/if}
        {#if m.recommendations && m.recommendations.length > 0}
          {@const recs = m.recommendations}
          <div class="bk-pending" data-testid={`chat-recs-${i}`} data-resolved={m.recommendationsResolved ?? undefined}>
            {#each recs as rec, j (rec.id)}
              <label class="bk-pending-row">
                <input
                  type="checkbox"
                  checked={rec.accepted}
                  disabled={busy || !!m.recommendationsResolved}
                  data-testid={`chat-rec-${i}-${rec.id}`}
                  onchange={() => toggleRecommendation(i, j)}
                />
                <span class="bk-pending-summary">
                  {rec.label}: {rec.currentCategoryName ?? "uncategorized"} → {rec.recommendedCategoryName}
                </span>
              </label>
            {/each}
            {#if m.recommendationsResolved === "applied"}
              <div class="bk-pending-status">Applied {m.recommendationsApplied} change{m.recommendationsApplied === 1 ? "" : "s"}</div>
            {:else if m.recommendationsResolved === "dismissed"}
              <div class="bk-pending-status">Dismissed</div>
            {:else}
              <div class="bk-pending-actions">
                <button
                  class="bk-btn bk-btn-sm bk-btn-primary"
                  data-testid={`chat-recs-apply-${i}`}
                  disabled={busy || recs.every((r) => !r.accepted)}
                  onclick={() => void applyRecommendations(i)}
                >Apply {recs.filter((r) => r.accepted).length} selected</button>
                {#if recs.length > 1}
                  <button
                    class="bk-btn bk-btn-sm"
                    data-testid={`chat-recs-all-${i}`}
                    disabled={busy}
                    onclick={() => setAllRecommendations(i, !recs.every((r) => r.accepted))}
                  >{recs.every((r) => r.accepted) ? "Clear all" : "Accept all"}</button>
                {/if}
                <button
                  class="bk-btn bk-btn-sm bk-btn-danger"
                  data-testid={`chat-recs-dismiss-${i}`}
                  disabled={busy}
                  onclick={() => dismissRecommendations(i)}
                >Dismiss</button>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
    {#if busy && !streaming}
      <div class="bk-msg" data-role="assistant"><span aria-hidden="true">· · ·</span></div>
    {/if}
  </div>

  <!-- Below the log, above the composer: either the one-click setup path (when
       the assistant can't answer yet) or the suggested prompts (when it can).
       The composer itself stays enabled in every mode. -->
  {#if mode === "not_set_up"}
    <div class="bk-suggest">
      <div class="bk-cta-strip" style="flex-direction: column; align-items: stretch; gap: 8px; margin: 0" data-testid="chat-setup-cta">
        <div style="display: flex; align-items: center; gap: 8px">
          <Icon name="sparkles" size={14} />
          <strong style="font-size: 13px">Set up the assistant</strong>
        </div>
        <div class="bk-text-3" style="font-size: 12px">
          The assistant runs a local model — a one-time ~1.3&nbsp;GB download. Nothing leaves your machine.
        </div>
        <div class="bk-text-3" style="font-size: 12px">
          Then you can ask things like “what can you do”, categorize expenses, or fetch tax tables.
        </div>
        {#if setupState.actionError}
          <div class="bk-error-banner" style="margin: 0" data-testid="chat-setup-error">{setupState.actionError}</div>
        {/if}
        <div style="display: flex; align-items: center; gap: 8px">
          <button
            class="bk-btn bk-btn-sm bk-btn-primary"
            data-testid="chat-setup-start"
            disabled={setupState.busy}
            onclick={() => void startAssistantSetup()}
          ><Icon name="download" size={12} /> {setupState.busy ? "Starting…" : "Set up local LLM"}</button>
          <a class="bk-btn bk-btn-sm" href="/setup" data-testid="chat-setup-link">Options &amp; details →</a>
        </div>
      </div>
    </div>
  {:else if mode === "downloading"}
    <div class="bk-suggest">
      <div class="bk-progress-banner" style="flex-direction: column; align-items: stretch; gap: 8px; margin: 0" data-testid="chat-setup-progress">
        <div style="display: flex; align-items: center; gap: 10px">
          <span class="bk-spinner" aria-hidden="true"></span>
          <span style="flex: 1; font-size: 12.5px">
            Step {setupStepIndex} of 2 · {setupStep?.name ?? "Setting up…"}
          </span>
          <span class="bk-num" style="font-size: 12px" data-testid="chat-setup-percent">{setupStep?.percent ?? 0}%</span>
        </div>
        <div class="bk-progress" data-status={setupStep?.status}><i style:width="{setupStep?.percent ?? 0}%"></i></div>
        {#if setupStep?.message}
          <div class="bk-text-3" style="font-size: 11px" data-testid="chat-setup-message">{setupStep.message}</div>
        {/if}
        <a class="bk-btn bk-btn-sm" href="/setup" style="align-self: flex-start" data-testid="chat-setup-link">Details →</a>
      </div>
    </div>
  {:else if mode === "stopped"}
    <div class="bk-suggest">
      <div class="bk-cta-strip" style="flex-direction: column; align-items: stretch; gap: 8px; margin: 0" data-testid="chat-assistant-cta">
        <div class="bk-text-3" style="font-size: 12px">
          The model is downloaded, but the local assistant server isn’t running.
        </div>
        {#if setupState.actionError}
          <div class="bk-error-banner" style="margin: 0" data-testid="chat-assistant-error">{setupState.actionError}</div>
        {/if}
        <div style="display: flex; align-items: center; gap: 8px">
          <button
            class="bk-btn bk-btn-sm bk-btn-primary"
            data-testid="chat-assistant-start"
            disabled={setupState.busy}
            onclick={() => void startAssistantServer()}
          ><Icon name="play" size={12} /> {setupState.busy ? "Starting…" : "Start assistant"}</button>
          <a class="bk-btn bk-btn-sm" href="/setup" data-testid="chat-assistant-link">Open Setup</a>
        </div>
      </div>
    </div>
  {:else if log.length === 0}
    <div class="bk-suggest">
      <div class="bk-eyebrow" style="margin-bottom: 4px">Try asking</div>
      {#each SUGGESTED as p (p)}
        <button class="bk-suggest-chip" onclick={() => void send(p)}>{p}</button>
      {/each}
    </div>
  {/if}

  <div class="bk-chat-input-wrap">
    {#if slashOpen && filteredSlash.length > 0}
      <div class="bk-slash-pop" role="listbox" aria-label="Slash command suggestions">
        {#each filteredSlash as c, i (c.name)}
          <button
            data-on={i === slashIdx}
            role="option"
            aria-selected={i === slashIdx}
            onmouseenter={() => (slashIdx = i)}
            onclick={() => { input = c.name + " "; inputEl?.focus(); }}
          >
            <span class="bk-slash-name">{c.name}</span>
            <span class="bk-slash-desc">{c.desc}</span>
          </button>
        {/each}
      </div>
    {/if}
    <textarea
      bind:this={inputEl}
      class="bk-chat-input"
      data-testid="chat-input"
      placeholder="Ask anything, or type / for commands…"
      bind:value={input}
      onkeydown={onKey}
      rows={1}
      aria-label="Message the assistant"
    ></textarea>
    <div style="display: flex; align-items: center; gap: 8px">
      <div class="bk-slash-hint">
        <span class="bk-kbd">/</span><span>for commands · <span class="bk-kbd">⏎</span> to send</span>
      </div>
      {#if busy}
        <button
          class="bk-btn bk-btn-danger bk-btn-sm"
          data-testid="chat-stop"
          onclick={stop}
          aria-label="Stop generating"
          title="Stop generating"
        >
          <Icon name="stop" size={12} /> Stop
        </button>
      {:else}
        <button
          class="bk-btn bk-btn-primary bk-btn-sm"
          data-testid="chat-send"
          disabled={!input.trim()}
          onclick={() => void send()}
          aria-label="Send message"
        >
          <Icon name="send" size={12} /> Send
        </button>
      {/if}
    </div>
  </div>
</aside>

<style>
  /* "Thinking…" placeholder shown while the model reasons (chain-of-thought is
     hidden). Muted + italic to read as transient status, with an animated
     ellipsis. */
  .bk-thinking {
    font-style: italic;
    opacity: 0.7;
  }
  .bk-thinking-dots::after {
    content: "";
    animation: bk-think-dots 1.4s steps(1, end) infinite;
  }
  @keyframes bk-think-dots {
    0%   { content: ""; }
    25%  { content: "."; }
    50%  { content: ".."; }
    75%  { content: "..."; }
    100% { content: ""; }
  }
  @media (prefers-reduced-motion: reduce) {
    .bk-thinking-dots::after {
      content: "…";
      animation: none;
    }
  }
</style>
