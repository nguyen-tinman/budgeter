// Shared "is the local assistant actually usable?" state — the on-disk model
// registry (/api/llama/models), the one-click setup pipeline
// (/api/llama/setup/status) and the last-seen llama-server reachability from
// ChatPanel's own poll. Lives outside any component so the chat panel, the
// nav badge and (indirectly) the Setup page all read one answer.
//
// No timer of its own: ChatPanel's existing status poll drives
// refreshAssistantSetup() — every 4s while the assistant isn't ready, and at
// 1s while a download is running (matching the Setup page's poll rate).

import { api, type LlamaModelsResponse, type SetupStatus } from "$lib/api.js";

/**
 * What the user can actually do with the assistant right now:
 *  - `unknown`      — we don't know yet (API unreachable / not polled). Callers
 *                     MUST fall back to their previous behavior: never claim
 *                     "not set up" on missing data.
 *  - `not_set_up`   — no model GGUF is on disk; a one-time download is needed.
 *  - `downloading`  — the setup pipeline is running.
 *  - `stopped`      — a model is present but llama-server isn't reachable.
 *  - `ready`        — model present and server reachable.
 */
export type AssistantMode = "unknown" | "not_set_up" | "downloading" | "stopped" | "ready";

interface AssistantSetupState {
  models: LlamaModelsResponse | null;
  setup: SetupStatus | null;
  /** Last reachability answer from GET /api/chat/status; null until polled. */
  serverOk: boolean | null;
  /** Last user-initiated setup/start failure, surfaced next to the CTA. */
  actionError: string | null;
  /** True while a setup/start POST is in flight (disables the CTA button). */
  busy: boolean;
}

const state = $state<AssistantSetupState>({
  models: null,
  setup: null,
  serverOk: null,
  actionError: null,
  busy: false,
});

export function assistantSetupState(): AssistantSetupState {
  return state;
}

/** Pull the model registry + setup pipeline status in parallel. Failures leave
 *  the corresponding slice null, which collapses the mode to `unknown` — the
 *  "API is down, don't guess" case. */
export async function refreshAssistantSetup(): Promise<void> {
  if (typeof window === "undefined") return;
  const [models, setup] = await Promise.all([
    api.llama.models().catch(() => null),
    api.llama.setupStatus().catch(() => null),
  ]);
  state.models = models;
  state.setup = setup;
}

/** Fed by ChatPanel's existing /api/chat/status poll. */
export function noteChatStatus(ok: boolean | null): void {
  state.serverOk = ok;
}

export function assistantMode(): AssistantMode {
  // A running pipeline wins: we know a download is in flight even if the
  // models endpoint hiccups on the same tick.
  if (state.setup?.overall === "running") return "downloading";
  if (!state.models) return "unknown";
  if (!state.models.models.some((m) => m.present)) return "not_set_up";
  if (state.serverOk === null) return "unknown";
  return state.serverOk ? "ready" : "stopped";
}

/** Kick off the one-click download pipeline. A 409 (`already_running` from
 *  /setup, `setup_in_progress` from the guarded routes) is NOT an error — a
 *  download is exactly what we wanted. Returns false only on a real failure. */
export async function startAssistantSetup(model?: string): Promise<boolean> {
  state.actionError = null;
  state.busy = true;
  try {
    const r = (await api.llama.setupStart(model ? { model } : undefined)) as {
      ok?: boolean;
      error?: string;
      message?: string;
      state?: SetupStatus;
    };
    if (r?.state) state.setup = r.state;
    if (r?.ok === false && r.error !== "already_running" && r.error !== "setup_in_progress") {
      state.actionError = r.message ?? r.error ?? "Setup could not be started.";
      return false;
    }
    await refreshAssistantSetup();
    return true;
  } catch (e) {
    state.actionError = (e as Error).message;
    return false;
  } finally {
    state.busy = false;
  }
}

/** Launch llama-server onto the already-downloaded model. */
export async function startAssistantServer(): Promise<boolean> {
  state.actionError = null;
  state.busy = true;
  try {
    const r = (await api.llama.start()) as {
      ok?: boolean;
      status?: string;
      error?: string | null;
      state?: SetupStatus;
    };
    // Guarded 409 while a download runs — treat as "downloading", not an error.
    if (r?.error === "setup_in_progress") {
      if (r.state) state.setup = r.state;
      return true;
    }
    if (r?.status === "error" || r?.ok === false) {
      state.actionError = r.error ?? "The assistant server could not be started.";
      return false;
    }
    await refreshAssistantSetup();
    return true;
  } catch (e) {
    state.actionError = (e as Error).message;
    return false;
  } finally {
    state.busy = false;
  }
}

export function clearAssistantSetupError(): void {
  state.actionError = null;
}
