// In-memory progress state for the two-step local-LLM setup pipeline:
//   1. Download + extract llama.cpp
//   2. Download the model GGUF
//
// Singleton, owned by the api process. Survives request-to-request but
// not across restarts — by design; if the api dies mid-download the user
// just clicks the button again.

export type StepStatus = "pending" | "running" | "done" | "error";

export interface StepState {
  name: string;
  status: StepStatus;
  /** 0..100. For "done" steps this is 100. For "pending" 0. */
  percent: number;
  bytesDone: number;
  bytesTotal: number;
  message?: string;
}

export interface SetupState {
  overall: "idle" | "running" | "done" | "error";
  step1: StepState;
  step2: StepState;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

function initialStep(name: string): StepState {
  return { name, status: "pending", percent: 0, bytesDone: 0, bytesTotal: 0 };
}

function initialState(): SetupState {
  return {
    overall: "idle",
    step1: initialStep("Download + extract llama.cpp"),
    step2: initialStep("Download model GGUF"),
    startedAt: null,
    finishedAt: null,
    error: null,
  };
}

let state: SetupState = initialState();

export function snapshot(): SetupState {
  // Deep clone the steps so callers can't mutate our state.
  return {
    ...state,
    step1: { ...state.step1 },
    step2: { ...state.step2 },
  };
}

export function reset(): void {
  state = initialState();
}

export function beginRun(): void {
  state = initialState();
  state.overall = "running";
  state.startedAt = new Date().toISOString();
}

export function beginStep1(message?: string): void {
  state.step1.status = "running";
  state.step1.percent = 0;
  state.step1.bytesDone = 0;
  state.step1.bytesTotal = 0;
  if (message !== undefined) state.step1.message = message;
}

export function updateStep1(progress: {
  bytesDone?: number;
  bytesTotal?: number;
  percent?: number;
  message?: string;
}): void {
  if (progress.bytesDone !== undefined) state.step1.bytesDone = progress.bytesDone;
  if (progress.bytesTotal !== undefined) state.step1.bytesTotal = progress.bytesTotal;
  if (progress.percent !== undefined) state.step1.percent = progress.percent;
  if (progress.message !== undefined) state.step1.message = progress.message;
  if (state.step1.percent === undefined || isNaN(state.step1.percent)) {
    state.step1.percent =
      state.step1.bytesTotal > 0
        ? Math.min(100, Math.round((state.step1.bytesDone * 100) / state.step1.bytesTotal))
        : 0;
  }
}

export function finishStep1(message?: string): void {
  state.step1.status = "done";
  state.step1.percent = 100;
  if (message !== undefined) state.step1.message = message;
}

export function failStep1(error: string): void {
  state.step1.status = "error";
  state.step1.message = error;
  state.overall = "error";
  state.error = `step1: ${error}`;
  state.finishedAt = new Date().toISOString();
}

export function beginStep2(message?: string): void {
  state.step2.status = "running";
  state.step2.percent = 0;
  state.step2.bytesDone = 0;
  state.step2.bytesTotal = 0;
  if (message !== undefined) state.step2.message = message;
}

export function updateStep2(progress: {
  bytesDone?: number;
  bytesTotal?: number;
  percent?: number;
  message?: string;
}): void {
  if (progress.bytesDone !== undefined) state.step2.bytesDone = progress.bytesDone;
  if (progress.bytesTotal !== undefined) state.step2.bytesTotal = progress.bytesTotal;
  if (progress.percent !== undefined) state.step2.percent = progress.percent;
  if (progress.message !== undefined) state.step2.message = progress.message;
  if (state.step2.percent === undefined || isNaN(state.step2.percent)) {
    state.step2.percent =
      state.step2.bytesTotal > 0
        ? Math.min(100, Math.round((state.step2.bytesDone * 100) / state.step2.bytesTotal))
        : 0;
  }
}

export function finishStep2(message?: string): void {
  state.step2.status = "done";
  state.step2.percent = 100;
  if (message !== undefined) state.step2.message = message;
}

export function failStep2(error: string): void {
  state.step2.status = "error";
  state.step2.message = error;
  state.overall = "error";
  state.error = `step2: ${error}`;
  state.finishedAt = new Date().toISOString();
}

export function finishRun(): void {
  state.overall = "done";
  state.finishedAt = new Date().toISOString();
}

export function isRunning(): boolean {
  return state.overall === "running";
}
