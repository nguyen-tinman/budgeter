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

describe("llama client health — llama-server vs kobold", () => {
  function healthClient(
    respond: (url: string) => { status: number; body?: string },
  ): { client: ReturnType<typeof createLlamaClient>; urls: string[] } {
    const urls: string[] = [];
    const client = createLlamaClient("http://127.0.0.1:8090", async (url) => {
      urls.push(String(url));
      const { status, body } = respond(String(url));
      return new Response(body ?? "", { status });
    });
    return { client, urls };
  }

  it("treats /health 503 as not ready even when GET / is 200", async () => {
    const { client, urls } = healthClient((url) => {
      if (url.endsWith("/health")) {
        return {
          status: 503,
          body: JSON.stringify({ error: { message: "Loading model" } }),
        };
      }
      return { status: 200, body: "<html>llama.cpp</html>" };
    });
    const h = await client.health();
    expect(h.ok).toBe(false);
    expect(h.status).toBe(503);
    expect(urls).toEqual(["http://127.0.0.1:8090/health"]);
  });

  it("treats /health 200 as ready", async () => {
    const { client, urls } = healthClient((url) => {
      if (url.endsWith("/health")) return { status: 200, body: '{"status":"ok"}' };
      return { status: 500 };
    });
    const h = await client.health();
    expect(h).toEqual({ ok: true, status: 200 });
    expect(urls).toEqual(["http://127.0.0.1:8090/health"]);
  });

  it("falls back to GET / when /health is missing (kobold)", async () => {
    const { client, urls } = healthClient((url) => {
      if (url.endsWith("/health")) return { status: 404 };
      return { status: 200, body: "kobold" };
    });
    const h = await client.health();
    expect(h).toEqual({ ok: true, status: 200 });
    expect(urls).toEqual(["http://127.0.0.1:8090/health", "http://127.0.0.1:8090"]);
  });
});
