// Llama HTTP client — dispatcher timeouts. No live llama-server: we stub
// fetch and assert the Agent the client attaches, plus the options that
// Agent was constructed with.

import { describe, it, expect } from "vitest";
import { Agent } from "undici";
import {
  createLlamaClient,
  llamaCallTimeoutMs,
  llamaBlockingDispatcher,
  llamaStreamingDispatcher,
  LLAMA_BLOCKING_FETCH_OPTIONS,
  LLAMA_STREAM_FETCH_OPTIONS,
  LLAMA_CALL_BASE_TIMEOUT_MS,
  LLAMA_MS_PER_REPLY_TOKEN,
  LLAMA_REPLY_TOKEN_CEILING,
  LLAMA_STREAM_FIRST_CHUNK_TIMEOUT_MS,
  type LlamaFetchInit,
} from "../src/services/llama_client.js";

const UNDICI_DEFAULT_HEADERS_TIMEOUT_MS = 300_000;

function okChatResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "stub",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "ok" },
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function okStreamResponse(): Response {
  return new Response("data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("llama client fetch timeouts", () => {
  it("sizes the blocking Agent past undici's 300s default, matching the chat policy", () => {
    expect(LLAMA_BLOCKING_FETCH_OPTIONS.headersTimeout).toBe(
      LLAMA_CALL_BASE_TIMEOUT_MS + LLAMA_REPLY_TOKEN_CEILING * LLAMA_MS_PER_REPLY_TOKEN,
    );
    expect(LLAMA_BLOCKING_FETCH_OPTIONS.headersTimeout).toBe(llamaCallTimeoutMs(16_384));
    expect(LLAMA_BLOCKING_FETCH_OPTIONS.headersTimeout).toBeGreaterThan(
      UNDICI_DEFAULT_HEADERS_TIMEOUT_MS,
    );
    expect(LLAMA_BLOCKING_FETCH_OPTIONS.bodyTimeout).toBe(
      LLAMA_BLOCKING_FETCH_OPTIONS.headersTimeout,
    );
    expect(llamaBlockingDispatcher).toBeInstanceOf(Agent);
  });

  it("does not cap a streaming body at 300s — idle-chunk timeout owns liveness", () => {
    expect(LLAMA_STREAM_FETCH_OPTIONS.headersTimeout).toBe(LLAMA_STREAM_FIRST_CHUNK_TIMEOUT_MS);
    expect(LLAMA_STREAM_FETCH_OPTIONS.bodyTimeout).toBe(0);
    expect(llamaStreamingDispatcher).toBeInstanceOf(Agent);
  });

  it("attaches the blocking Agent on chat()", async () => {
    let init: LlamaFetchInit | undefined;
    const client = createLlamaClient("http://127.0.0.1:9", async (_url, options) => {
      init = options;
      return okChatResponse();
    });
    await client.chat({ messages: [{ role: "user", content: "hi" }], max_tokens: 16_384 });
    expect(init?.dispatcher).toBe(llamaBlockingDispatcher);
  });

  it("attaches the streaming Agent on chatStream()", async () => {
    let init: LlamaFetchInit | undefined;
    const client = createLlamaClient("http://127.0.0.1:9", async (_url, options) => {
      init = options;
      return okStreamResponse();
    });
    const chunks: unknown[] = [];
    for await (const chunk of client.chatStream!({
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }
    expect(init?.dispatcher).toBe(llamaStreamingDispatcher);
    expect(chunks).toEqual([]);
  });
});
