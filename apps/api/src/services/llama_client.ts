// Thin client for an OpenAI-compatible /v1/chat/completions endpoint.
//
// Target: llama.cpp's `llama-server` (production), kobold.cpp (dev — running
// at LLAMA_SERVER_URL, default http://localhost:5001). Both speak the
// OpenAI Chat Completions wire format closely enough for our purposes.
//
// Caveat: kobold.cpp with jinja: false may not emit `tool_calls` cleanly.
// We surface the raw response so /api/chat can fall back to "chat-only" mode
// when no tool_calls show up after a system-prompt nudge.

import { Agent, fetch as undiciFetch } from "undici";
import type { JsonSchema, ToolDef } from "@budgetkit/core";

/** Timeout policy for llama-server HTTP. Must stay the single source of
 *  truth for both the chat-route AbortSignal wrappers and the undici
 *  Agent below — Node's default headersTimeout is 300s, and llama-server
 *  only writes response headers when a *blocking* completion finishes. */
export const LLAMA_CALL_BASE_TIMEOUT_MS = 60_000;
/** Per-reply-token allowance for blocking calls (~33 tok/s floor). */
export const LLAMA_MS_PER_REPLY_TOKEN = 30;
/** Streaming: max gap between chunks before the server is presumed dead. */
export const LLAMA_STREAM_IDLE_TIMEOUT_MS = 60_000;
/** Streaming: window for the FIRST chunk (prompt prefill). Matches the
 *  launcher's startup health deadline. */
export const LLAMA_STREAM_FIRST_CHUNK_TIMEOUT_MS = 180_000;
/** Reply budget the chat route actually requests. The blocking fetch
 *  dispatcher is sized for this so a 16k-token CPU completion cannot die
 *  at undici's 300s default. */
export const LLAMA_REPLY_TOKEN_CEILING = 16_384;

/** Wall-clock ceiling for a BLOCKING llama call expected to emit up to
 *  `maxTokens` reply tokens. */
export function llamaCallTimeoutMs(maxTokens: number): number {
  return LLAMA_CALL_BASE_TIMEOUT_MS + maxTokens * LLAMA_MS_PER_REPLY_TOKEN;
}

/** Options passed to the blocking-completion Agent. Exported so tests can
 *  assert the timeouts without poking undici internals. */
export const LLAMA_BLOCKING_FETCH_OPTIONS = {
  headersTimeout: llamaCallTimeoutMs(LLAMA_REPLY_TOKEN_CEILING),
  bodyTimeout: llamaCallTimeoutMs(LLAMA_REPLY_TOKEN_CEILING),
} as const;

/** Streaming Agent: wait for headers up to the first-chunk window, then
 *  do not cap the body — a healthy stream can outlive 300s. Liveness is
 *  the chat route's inter-chunk idle AbortSignal. */
export const LLAMA_STREAM_FETCH_OPTIONS = {
  headersTimeout: LLAMA_STREAM_FIRST_CHUNK_TIMEOUT_MS,
  bodyTimeout: 0,
} as const;

export const llamaBlockingDispatcher = new Agent(LLAMA_BLOCKING_FETCH_OPTIONS);
export const llamaStreamingDispatcher = new Agent(LLAMA_STREAM_FETCH_OPTIONS);

/** Fetch init for llama-server. Kept off DOM/`undici-types` `RequestInit` so
 *  the npm `undici` Agent (v7) does not collide with `@types/node`'s v6
 *  dispatcher types. Tests stub `fetch` and assert `dispatcher`. */
export interface LlamaFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  dispatcher?: Agent;
}

function defaultLlamaFetch(url: string, init?: LlamaFetchInit): Promise<Response> {
  return undiciFetch(url, {
    method: init?.method,
    headers: init?.headers,
    body: init?.body,
    signal: init?.signal,
    dispatcher: init?.dispatcher ?? llamaBlockingDispatcher,
  }) as unknown as Promise<Response>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: Array<{
    type: "function";
    function: { name: string; description: string; parameters: JsonSchema };
  }>;
  tool_choice?: "auto" | "none" | "required";
  temperature?: number;
  max_tokens?: number;
  stop?: string[];
  /**
   * llama.cpp GBNF grammar. A non-OpenAI extension that llama-server reads as a
   * top-level field and uses to constrain decoding so the reply is guaranteed
   * to match the grammar. We use it to force the model to emit exactly one of a
   * fixed enum of strings (e.g. the canonical budget category names) — the key
   * reliability lever when classifying with a small local model. Ignored by
   * servers that don't support it (kobold dev), so callers must still tolerate
   * an unconstrained reply and fuzzy-match it.
   */
  grammar?: string;
  /**
   * llama-server / Qwen-style chat-template controls. The Qwen3 Jinja template
   * supports `enable_thinking`. The chat bridge runs the user-facing turn with
   * `enable_thinking: true` for better reasoning, then HIDES the chain-of-thought
   * from the user: reasoning arrives either in a separate `reasoning_content`
   * field (never forwarded) or inline as <think>…</think> in `content` (stripped
   * by think_filter). Internal meta-calls (summarization/recompression) pass
   * `enable_thinking: false` since they only compress, not reason. Other callers
   * may pass their own kwargs without us hardcoding the policy here.
   */
  chat_template_kwargs?: Record<string, unknown>;
}

export interface ChatChoice {
  index: number;
  finish_reason: string | null;
  message: ChatMessage;
}

export interface ChatResponse {
  id: string;
  model?: string;
  choices: ChatChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/**
 * One streamed chunk from llama-server's SSE `chat.completion.chunk` stream
 * (OpenAI-compatible). Each event carries a `delta` rather than a full
 * `message`. We model only the fields the chat bridge consumes:
 *   - `delta.content` — incremental assistant text tokens.
 *   - `delta.tool_calls` — incremental tool-call construction. The `index`
 *     groups fragments of the same call across chunks; `function.name`
 *     arrives once and `function.arguments` streams in pieces.
 *   - `finish_reason` — "stop" | "tool_calls" | "length" on the terminal chunk.
 */
export interface ChatStreamChunkChoice {
  index: number;
  finish_reason: string | null;
  delta: {
    role?: string;
    content?: string | null;
    /** Qwen "thinking" chain-of-thought, streamed separately from `content`
     *  when the server runs in separated-reasoning mode (the default). The
     *  chat bridge never forwards this text to the user — it only uses its
     *  presence to signal that the model is mid-reasoning ("Thinking…"). */
    reasoning_content?: string | null;
    tool_calls?: Array<{
      index: number;
      id?: string;
      type?: "function";
      function?: { name?: string; arguments?: string };
    }>;
  };
}

export interface ChatStreamChunk {
  id: string;
  model?: string;
  choices: ChatStreamChunkChoice[];
}

/** Result of POST /slots/{id}?action=save|restore (llama-server b10456). */
export interface SlotSaveRestoreResult {
  id_slot: number;
  filename: string;
  n_saved?: number;
  n_restored?: number;
  n_written?: number;
  n_read?: number;
}

export interface LlamaClient {
  baseUrl: string;
  chat: (req: ChatRequest, signal?: AbortSignal) => Promise<ChatResponse>;
  /**
   * Streaming variant of `chat`. Yields OpenAI-compatible
   * `chat.completion.chunk` objects as llama-server emits them over SSE
   * ({ stream: true }). Optional so existing stub clients in tests that only
   * implement `chat` still satisfy the interface; the chat route falls back
   * to non-streaming when `chatStream` is undefined.
   */
  chatStream?: (
    req: ChatRequest,
    signal?: AbortSignal,
  ) => AsyncIterable<ChatStreamChunk>;
  health: (signal?: AbortSignal) => Promise<{ ok: boolean; status: number }>;
  /**
   * Persist slot KV to `--slot-save-path` / `filename`. Optional so test stubs
   * that only implement `chat`/`health` still typecheck; production
   * `createLlamaClient` always provides both slot methods.
   */
  saveSlot?: (
    idSlot: number,
    filename: string,
    signal?: AbortSignal,
  ) => Promise<SlotSaveRestoreResult>;
  restoreSlot?: (
    idSlot: number,
    filename: string,
    signal?: AbortSignal,
  ) => Promise<SlotSaveRestoreResult>;
}

export function defaultLlamaUrl(): string {
  // Default now points at the in-app llama-server (M8b launcher), port 8090.
  // (8080 is often held by Windows services on this box; defaultProfile()
  // sets the same port.) The old kobold.cpp dev override (5001) is still
  // respected via the LLAMA_SERVER_URL env var if you need to bounce back.
  return process.env.LLAMA_SERVER_URL ?? "http://127.0.0.1:8090";
}

/**
 * Create a default HTTP-backed client. `fetcher` is parameterizable so tests
 * can stub the network without monkey-patching globalThis.fetch.
 *
 * Default fetch is undici's, not globalThis.fetch, so the Agent's
 * headersTimeout/bodyTimeout actually apply. Node's built-in fetch uses a
 * different undici copy and would ignore an npm-undici Agent.
 */
export function createLlamaClient(
  baseUrl: string = defaultLlamaUrl(),
  fetcher: (url: string, init?: LlamaFetchInit) => Promise<Response> = defaultLlamaFetch,
): LlamaClient {
  return {
    baseUrl,
    async chat(req, signal) {
      const url = `${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
      const res = await fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
        signal,
        dispatcher: llamaBlockingDispatcher,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`llama chat failed: ${res.status} ${text.slice(0, 200)}`);
      }
      return (await res.json()) as ChatResponse;
    },
    async *chatStream(req, signal) {
      const url = `${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
      const res = await fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ ...req, stream: true }),
        signal,
        dispatcher: llamaStreamingDispatcher,
      });
      if (!res.ok || !res.body) {
        const text = res.body ? await res.text().catch(() => "") : "";
        throw new Error(`llama chat stream failed: ${res.status} ${text.slice(0, 200)}`);
      }
      // Parse the SSE byte stream into `data:` events. llama-server frames each
      // chunk as `data: {json}\n\n` and terminates with `data: [DONE]`. We
      // buffer across reads because a single JSON event can split across TCP
      // chunks; only emit once we've seen the `\n\n` event delimiter.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // Events are delimited by a blank line.
          let sep: number;
          while ((sep = buf.indexOf("\n\n")) !== -1) {
            const rawEvent = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            // An event may carry multiple `data:` lines; concatenate them.
            const dataLines = rawEvent
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart());
            if (dataLines.length === 0) continue;
            const payload = dataLines.join("");
            if (payload === "[DONE]") return;
            try {
              yield JSON.parse(payload) as ChatStreamChunk;
            } catch {
              // Skip malformed keep-alive / partial frames; the buffer logic
              // above should prevent this, but a defensive skip is cheaper
              // than aborting the whole stream on one bad line.
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    },
    async health(signal) {
      try {
        // llama-server exposes /health; kobold.cpp exposes /api/v1/info — we
        // probe /health first and fall back to a HEAD on the root.
        const tries = [`${baseUrl.replace(/\/+$/, "")}/health`, baseUrl];
        for (const u of tries) {
          const res = await fetcher(u, { signal, method: "GET" });
          if (res.ok) return { ok: true, status: res.status };
        }
        return { ok: false, status: 0 };
      } catch {
        return { ok: false, status: 0 };
      }
    },
    async saveSlot(idSlot, filename, signal) {
      return slotAction(baseUrl, fetcher, idSlot, "save", filename, signal);
    },
    async restoreSlot(idSlot, filename, signal) {
      return slotAction(baseUrl, fetcher, idSlot, "restore", filename, signal);
    },
  };
}

/**
 * llama-server b10456: POST /slots/{id_slot}?action=save|restore with
 * `{ filename }` (basename only; the file lands under `--slot-save-path`).
 */
async function slotAction(
  baseUrl: string,
  fetcher: typeof fetch,
  idSlot: number,
  action: "save" | "restore",
  filename: string,
  signal?: AbortSignal,
): Promise<SlotSaveRestoreResult> {
  const url = `${baseUrl.replace(/\/+$/, "")}/slots/${idSlot}?action=${action}`;
  const res = await fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`llama slot ${action} failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as SlotSaveRestoreResult;
}

/**
 * Convert a `ToolDef` to the OpenAI `tools` schema. The LLM sees only the
 * input schema — output schema stays local to our registry.
 */
export function toolsToOpenAi(tools: ToolDef[]): NonNullable<ChatRequest["tools"]> {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}
