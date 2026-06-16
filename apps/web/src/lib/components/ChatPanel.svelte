<script lang="ts">
  import Icon from "./Icon.svelte";
  import StatusDot from "./StatusDot.svelte";
  import { api, type ChatPendingAction, type ChatSendResponse, type ChatClassifyResponse, type ClassifyRecommendation } from "$lib/api.js";
  import { refreshWorkspaces, workspaceState } from "$lib/workspace.svelte.js";
  import { invalidateResources } from "$lib/appShellState.svelte.js";
  import { onDestroy, onMount, tick } from "svelte";

  interface ChatMessage {
    role: "user" | "assistant" | "system";
    text: string;
    tools?: Array<{ name: string }>;
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
    /** True while the model is reasoning (chain-of-thought is hidden). Renders
     *  an animated "Thinking…" placeholder until the first visible answer
     *  token arrives, at which point it's cleared. */
    thinking?: boolean;
    /** /classify review list: the AI's proposed category changes, each with a
     *  per-row accept flag. Rendered as an interactive accept/deny block; only
     *  accepted rows are written when the user clicks Apply. */
    recommendations?: Array<ClassifyRecommendation & { accepted: boolean }>;
    /** Set once the user resolves the recommendations so the controls hide. */
    recommendationsResolved?: "applied" | "dismissed" | null;
    /** Rows actually written when applied (for the resolved status line). */
    recommendationsApplied?: number;
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
    { name: "/help",         desc: "Show available slash commands" },
  ];

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

  const slashOpen = $derived(input.trim().startsWith("/"));
  const filteredSlash = $derived(
    slashOpen
      ? SLASH_COMMANDS.filter((c) => {
          const q = input.trim().toLowerCase();
          return c.name.toLowerCase().startsWith(q) || c.desc.toLowerCase().includes(q.slice(1));
        })
      : []
  );

  const SUGGESTED = [
    "What's my monthly remaining?",
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
  }

  let statusPollHandle: ReturnType<typeof setInterval> | null = null;

  onMount(async () => {
    await refreshChatStatus();
    // Poll every 4s. Stops on component teardown (onDestroy below).
    statusPollHandle = setInterval(() => {
      void refreshChatStatus();
    }, 4000);
  });

  onDestroy(() => {
    if (statusPollHandle !== null) {
      clearInterval(statusPollHandle);
      statusPollHandle = null;
    }
  });

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
      // Server-side clear is best-effort — no state today; ignore network
      // errors so a flaky connection doesn't leave the UI in a stuck state.
    }
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
  async function applyDone(r: ChatSendResponse, streamedText: string): Promise<void> {
    if (!r.ok) {
      log = [...log, { role: "system", text: `error: ${r.error ?? "unknown"}: ${r.message ?? ""}` }];
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
        tools: Array.isArray(r.toolCalls) ? r.toolCalls : undefined,
        pendingActions: r.pendingActions,
        pendingResolved: null,
      }];
    } else {
      // Normal assistant reply. Prefer the streamed text we already rendered;
      // fall back to the terminal assistantText (covers the non-stream path).
      log = [...log, {
        role: "assistant",
        text: r.assistantText && r.assistantText.length > 0 ? r.assistantText : streamedText,
        tools: Array.isArray(r.toolCalls) ? r.toolCalls : undefined,
      }];
    }
    await refreshWorkspaces();
    if (Array.isArray(r.affectedResources) && r.affectedResources.length > 0) {
      invalidateResources(r.affectedResources);
    }
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
            onThinking: (active) => {
              ensureStreamBubble();
              // Show "Thinking…" only until visible answer text exists.
              log[streamIdx]!.thinking = active && streamedText.length === 0;
              void scrollToBottom();
            },
            onDelta: (text) => {
              ensureStreamBubble();
              streamedText += text;
              log[streamIdx]!.text = streamedText;
              // First visible token ends the reasoning phase.
              log[streamIdx]!.thinking = false;
              void scrollToBottom();
            },
            onTool: () => {
              // A tool call ends the current reasoning phase too.
              if (streamIdx !== -1) log[streamIdx]!.thinking = false;
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
        await applyDone(final, streamedText);
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
      void scrollToBottom();
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
        log = [
          ...log,
          { role: "system", text: `error: ${errResult.error ?? "unknown"}: ${errResult.message ?? ""}` },
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
        {#if chatStatus}
          <StatusDot status={chatStatus.ok ? "ready" : "stopped"} />
          <span data-testid="chat-status">{chatStatus.ok ? "ready" : "offline"} · {chatStatus.baseUrl}</span>
        {:else}
          <StatusDot status="starting" />
          <span>connecting…</span>
        {/if}
      </div>
    </div>
    <button
      class="bk-iconbtn"
      aria-label="New chat (clear history)"
      title="New chat"
      data-testid="chat-new"
      disabled={busy || log.length === 0}
      onclick={() => void newChat()}
    >
      <Icon name="refresh" size={14} />
    </button>
    <button class="bk-iconbtn" aria-label="Close chat panel" data-testid="chat-toggle" onclick={onclose}>
      <Icon name="close" size={14} />
    </button>
  </div>

  <div class="bk-chat-log" bind:this={logEl} role="log" aria-live="polite" data-testid="chat-log">
    {#if log.length === 0}
      <div class="bk-msg" data-role="system">I'm your budget assistant. Try /help, or just describe what you want.</div>
    {/if}
    {#each log as m, i (i)}
      <div
        class="bk-msg"
        data-role={m.role}
        data-compaction={m.compactionNotice ? "true" : undefined}
        data-testid={`chat-msg-${i}`}
      >
        {#if m.thinking && !m.text}
          <span class="bk-thinking" data-testid={`chat-thinking-${i}`} aria-label="Assistant is thinking">Thinking<span class="bk-thinking-dots" aria-hidden="true"></span></span>
        {:else}
          {m.text}
        {/if}
        {#if m.stopped}
          <div class="bk-msg-stopped" data-testid={`chat-stopped-${i}`}>⏹ stopped</div>
        {/if}
        {#if m.tools && m.tools.length > 0}
          <div class="bk-msg-tool" aria-label="Tool calls used">
            {m.tools.map((t) => `→ ${t.name}`).join("   ")}
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

  {#if log.length === 0}
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
