// Prompt-prefix slot KV cache. No GGUF: cache-key tests are pure, and
// warmup/save/restore talk to a stub LlamaClient.

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { ALL_TOOLS } from "@budgetkit/core";
import {
  createLlamaClient,
  toolsToOpenAi,
  type ChatRequest,
  type ChatResponse,
  type LlamaClient,
  type SlotSaveRestoreResult,
} from "../src/services/llama_client.js";
import {
  buildStaticPrefixWarmupRequest,
  cacheMetaMatches,
  ensurePromptPrefixCached,
  promptCacheIdentity,
  promptCacheKey,
  readPromptCacheMeta,
  warmupPromptBytes,
  writePromptCacheMeta,
  SLOT_CACHE_FILENAME,
  WARMUP_TAIL_USER,
  type PromptCacheProfile,
} from "../src/services/llama_prompt_cache.js";
import {
  buildArgs,
  defaultProfile,
  LlamaLauncher,
} from "../src/services/llama_launcher.js";
import {
  wrappedSystemPrompt,
  chatRequestOptions,
  buildContextMessage,
  CONTEXT_MESSAGE_ROLE,
} from "../src/routes/chat.js";

const SYSTEM = "<SYSTEM_PROMPT>\nrules\n</SYSTEM_PROMPT>";

const DEFAULTS: Omit<ChatRequest, "messages"> = {
  tool_choice: "auto",
  temperature: 0.6,
  max_tokens: 16384,
  chat_template_kwargs: { enable_thinking: true },
};

function profile(cacheDir: string, overrides: Partial<PromptCacheProfile> = {}): PromptCacheProfile {
  return {
    modelPath: "/models/Qwen3.5-2B-Q5_K_S.gguf",
    ctxSize: 131072,
    cacheType: "q8_0",
    specType: "draft-mtp",
    specDraftNMax: 8,
    slotSavePath: cacheDir,
    ...overrides,
  };
}

function tmpCache(): string {
  return mkdtempSync(join(tmpdir(), "budgetkit-prompt-cache-"));
}

function okChat(): ChatResponse {
  return {
    id: "warmup",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "." } }],
  };
}

function stubClient(opts: {
  chat?: (req: ChatRequest) => Promise<ChatResponse>;
  save?: (filename: string) => Promise<SlotSaveRestoreResult>;
  restore?: (filename: string) => Promise<SlotSaveRestoreResult>;
}): LlamaClient {
  return {
    baseUrl: "stub://",
    chat: opts.chat ?? (async () => okChat()),
    health: async () => ({ ok: true, status: 200 }),
    saveSlot: opts.save
      ? async (_id, filename) => opts.save!(filename)
      : undefined,
    restoreSlot: opts.restore
      ? async (_id, filename) => opts.restore!(filename)
      : undefined,
  };
}

describe("promptCacheKey", () => {
  const base = promptCacheIdentity(profile("/cache"), "PROMPT-BYTES");

  it("is stable for identical prompt + model + ctx + cache type + spec", () => {
    expect(promptCacheKey(base)).toBe(promptCacheKey({ ...base }));
    expect(promptCacheKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the warmup prompt bytes change", () => {
    const other = { ...base, promptBytes: "PROMPT-BYTES-CHANGED" };
    expect(promptCacheKey(other)).not.toBe(promptCacheKey(base));
    expect(cacheMetaMatches({ ...metaFor(base), key: promptCacheKey(base) }, other)).toBe(false);
  });

  it("changes when the model path, ctx, cache type, or spec settings change", () => {
    const key = promptCacheKey(base);
    expect(promptCacheKey({ ...base, modelPath: "/models/other.gguf" })).not.toBe(key);
    expect(promptCacheKey({ ...base, ctxSize: 8192 })).not.toBe(key);
    expect(promptCacheKey({ ...base, cacheType: "f16" })).not.toBe(key);
    expect(promptCacheKey({ ...base, specType: "none" })).not.toBe(key);
    expect(promptCacheKey({ ...base, specDraftNMax: 2 })).not.toBe(key);
  });

  it("treats a missing meta file as no restore", () => {
    expect(cacheMetaMatches(null, base)).toBe(false);
  });

  it("resolves model paths so equivalent paths share a key", () => {
    const a = promptCacheIdentity(profile("/cache", { modelPath: "/models/./m.gguf" }), "p");
    const b = promptCacheIdentity(profile("/cache", { modelPath: "/models/m.gguf" }), "p");
    expect(promptCacheKey(a)).toBe(promptCacheKey(b));
  });
});

function metaFor(identity: ReturnType<typeof promptCacheIdentity>) {
  return {
    version: 1 as const,
    key: promptCacheKey(identity),
    modelPath: identity.modelPath,
    ctxSize: identity.ctxSize,
    cacheType: identity.cacheType,
    specType: identity.specType,
    specDraftNMax: identity.specDraftNMax,
    promptSha256: "x",
    slotFile: SLOT_CACHE_FILENAME,
  };
}

describe("buildStaticPrefixWarmupRequest", () => {
  it("puts wrappedSystemPrompt at the head and the dummy user after the static prefix", () => {
    const req = buildStaticPrefixWarmupRequest(wrappedSystemPrompt(), chatRequestOptions());
    expect(req.messages[0]).toEqual({ role: "system", content: wrappedSystemPrompt() });
    expect(req.messages.at(-1)).toEqual({ role: "user", content: WARMUP_TAIL_USER });
    expect(req.messages).toHaveLength(2);
    expect(JSON.stringify(req)).not.toContain("WORKSPACE_DATA");
    expect(JSON.stringify(req)).not.toContain("PRIOR_CONVERSATION_SUMMARY");
  });

  it("uses the same tools payload and chat-template kwargs as /api/chat", () => {
    const req = buildStaticPrefixWarmupRequest(wrappedSystemPrompt(), chatRequestOptions());
    expect(req.tools).toEqual(toolsToOpenAi(ALL_TOOLS));
    expect(req.tool_choice).toBe("auto");
    expect(req.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(req.temperature).toBe(0.6);
    expect(req.max_tokens).toBe(1);
  });

  it("leading system + tools + kwargs is a prefix of a live history with a context block", () => {
    // Qwen 3.5 merges messages[0]+messages[1] when both are system and, with
    // tools, emits one system block (catalog first, then merged_system). A
    // first turn always has a context block (page status at minimum). If that
    // block stays system-role, the live turn extends the warmed system
    // instead of appending after <|im_end|>.
    const warmup = buildStaticPrefixWarmupRequest(wrappedSystemPrompt(), chatRequestOptions());
    const context = buildContextMessage({
      workspaceSummary:
        "You are the user's local budget assistant. Here is the CURRENT workspace state:\nWorkspace #1 Current rent $2000",
      customPageStatus: null,
      customPageAuthoring: "CUSTOM PAGE AUTHORING GUIDE — render contract",
    });
    expect(context).toMatch(/WORKSPACE_DATA|CUSTOM_PAGE_STATUS|CUSTOM_PAGE_AUTHORING/);

    const liveHistory = [
      { role: "system" as const, content: wrappedSystemPrompt() },
      { role: CONTEXT_MESSAGE_ROLE, content: context },
      { role: "user" as const, content: "hi" },
    ];

    expect(liveHistory[0]).toEqual(warmup.messages[0]);
    expect(liveHistory.filter((m) => m.role === "system")).toHaveLength(1);
    expect(liveHistory[1]?.role).not.toBe("system");
    expect(warmup.tools).toEqual(toolsToOpenAi(ALL_TOOLS));
    expect(warmup.chat_template_kwargs).toEqual(chatRequestOptions().chat_template_kwargs);
    expect(JSON.stringify(warmup.messages[0])).not.toContain("WORKSPACE_DATA");
    expect(JSON.stringify(warmup.messages[0])).not.toContain("CUSTOM_PAGE");
  });
});

describe("ensurePromptPrefixCached", () => {
  it("warms with max_tokens=1 and saves the slot when no cache exists", async () => {
    const dir = tmpCache();
    const chats: ChatRequest[] = [];
    let saved: string | undefined;
    try {
      const result = await ensurePromptPrefixCached({
        profile: profile(dir),
        getSystemPrompt: () => SYSTEM,
        getRequestDefaults: () => DEFAULTS,
        client: stubClient({
          chat: async (req) => {
            chats.push(req);
            return okChat();
          },
          save: async (filename) => {
            saved = filename;
            writeFileSync(join(dir, filename), "kv");
            return { id_slot: 0, filename, n_saved: 16000 };
          },
        }),
      });
      expect(result.action).toBe("warmed");
      expect(chats).toHaveLength(1);
      expect(chats[0]!.messages[0]!.content).toBe(SYSTEM);
      expect(chats[0]!.messages[1]!.content).toBe(WARMUP_TAIL_USER);
      expect(chats[0]!.max_tokens).toBe(1);
      expect(saved).toBe(SLOT_CACHE_FILENAME);
      const meta = readPromptCacheMeta(dir);
      expect(meta?.key).toBe(
        promptCacheKey(promptCacheIdentity(profile(dir), warmupPromptBytes(chats[0]!))),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restores a matching cache and does not re-warm", async () => {
    const dir = tmpCache();
    try {
      const req = buildStaticPrefixWarmupRequest(SYSTEM, DEFAULTS);
      const identity = promptCacheIdentity(profile(dir), warmupPromptBytes(req));
      writeFileSync(join(dir, SLOT_CACHE_FILENAME), "kv");
      writePromptCacheMeta(dir, identity);
      let restored = false;
      const result = await ensurePromptPrefixCached({
        profile: profile(dir),
        getSystemPrompt: () => SYSTEM,
        getRequestDefaults: () => DEFAULTS,
        client: stubClient({
          chat: async () => {
            throw new Error("warmup should not run");
          },
          restore: async (filename) => {
            restored = true;
            expect(filename).toBe(SLOT_CACHE_FILENAME);
            return { id_slot: 0, filename, n_restored: 16000 };
          },
        }),
      });
      expect(result.action).toBe("restored");
      expect(restored).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a cache whose prompt hash / model / ctx / cache type mismatch and re-warms", async () => {
    const dir = tmpCache();
    try {
      writeFileSync(join(dir, SLOT_CACHE_FILENAME), "old-kv");
      writePromptCacheMeta(
        dir,
        promptCacheIdentity(profile(dir, { cacheType: "f16" }), "OTHER-PROMPT"),
      );
      let warmed = false;
      const result = await ensurePromptPrefixCached({
        profile: profile(dir),
        getSystemPrompt: () => SYSTEM,
        getRequestDefaults: () => DEFAULTS,
        client: stubClient({
          chat: async () => {
            warmed = true;
            return okChat();
          },
          restore: async () => {
            throw new Error("must not restore a mismatched key");
          },
          save: async (filename) => {
            writeFileSync(join(dir, filename), "new-kv");
            return { id_slot: 0, filename, n_saved: 10 };
          },
        }),
      });
      expect(result.action).toBe("warmed");
      expect(warmed).toBe(true);
      const meta = JSON.parse(readFileSync(join(dir, "prefix.meta.json"), "utf8"));
      expect(meta.cacheType).toBe("q8_0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("logs-and-continues when warmup throws (chat still works)", async () => {
    const dir = tmpCache();
    try {
      const result = await ensurePromptPrefixCached({
        profile: profile(dir),
        getSystemPrompt: () => SYSTEM,
        getRequestDefaults: () => DEFAULTS,
        client: stubClient({
          chat: async () => {
            throw new Error("connection reset");
          },
        }),
      });
      expect(result.action).toBe("skipped");
      expect(result.reason).toMatch(/warmup failed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("LlamaLauncher — prompt-prefix cache at start", () => {
  function fakeProc() {
    return Object.assign(new EventEmitter(), {
      pid: 4242,
      killed: false,
      kill: () => true,
      stderr: new EventEmitter(),
      stdout: new EventEmitter(),
    });
  }

  it("does not warm or restore until health() reports ready", async () => {
    const dir = tmpCache();
    let healthCalls = 0;
    let chatCalls = 0;
    let restoreCalls = 0;
    try {
      const launcher = new LlamaLauncher({
        binPath: process.execPath,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        spawnFn: (() => fakeProc()) as any,
        portProbe: async () => true,
        promptCache: {
          getSystemPrompt: () => SYSTEM,
          getRequestDefaults: () => DEFAULTS,
        },
        client: {
          baseUrl: "stub://",
          health: async () => {
            healthCalls++;
            if (healthCalls < 3) return { ok: false, status: 503 };
            return { ok: true, status: 200 };
          },
          chat: async () => {
            chatCalls++;
            return okChat();
          },
          restoreSlot: async (filename) => {
            restoreCalls++;
            return { id_slot: 0, filename, n_restored: 1 };
          },
          saveSlot: async (_id, filename) => {
            writeFileSync(join(dir, filename), "kv");
            return { id_slot: 0, filename, n_saved: 1 };
          },
        },
      });
      const r = await launcher.start({
        ...defaultProfile(),
        modelPath: "/m.gguf",
        slotSavePath: dir,
      });
      expect(r.status).toBe("ready");
      expect(healthCalls).toBeGreaterThanOrEqual(3);
      expect(chatCalls).toBe(1);
      expect(restoreCalls).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts ready even when warmup fails, and still passed --slot-save-path", async () => {
    const dir = tmpCache();
    const spawnedArgs: string[][] = [];
    try {
      const launcher = new LlamaLauncher({
        binPath: process.execPath,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        spawnFn: ((_bin: string, args: string[]) => {
          spawnedArgs.push(args);
          return fakeProc();
        }) as any,
        portProbe: async () => true,
        promptCache: {
          getSystemPrompt: () => SYSTEM,
          getRequestDefaults: () => DEFAULTS,
        },
        client: stubClient({
          chat: async () => {
            throw new Error("not used");
          },
        }),
      });
      const r = await launcher.start({
        ...defaultProfile(),
        modelPath: "/m.gguf",
        slotSavePath: dir,
      });
      expect(r.status).toBe("ready");
      expect(existsSync(dir)).toBe(true);
      const i = spawnedArgs[0]!.indexOf("--slot-save-path");
      expect(spawnedArgs[0]![i + 1]).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restores a matching on-disk slot after health instead of warming", async () => {
    const dir = tmpCache();
    try {
      const req = buildStaticPrefixWarmupRequest(SYSTEM, DEFAULTS);
      writeFileSync(join(dir, SLOT_CACHE_FILENAME), "kv");
      writePromptCacheMeta(
        dir,
        promptCacheIdentity(
          profile(dir, { modelPath: "/m.gguf" }),
          warmupPromptBytes(req),
        ),
      );
      let restoreCalls = 0;
      let chatCalls = 0;
      const launcher = new LlamaLauncher({
        binPath: process.execPath,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        spawnFn: (() => fakeProc()) as any,
        portProbe: async () => true,
        promptCache: {
          getSystemPrompt: () => SYSTEM,
          getRequestDefaults: () => DEFAULTS,
        },
        client: stubClient({
          chat: async () => {
            chatCalls++;
            return okChat();
          },
          restore: async (filename) => {
            restoreCalls++;
            return { id_slot: 0, filename, n_restored: 99 };
          },
        }),
      });
      const r = await launcher.start({
        ...defaultProfile(),
        modelPath: "/m.gguf",
        slotSavePath: dir,
        ctxSize: 131072,
        cacheType: "q8_0",
        specType: "draft-mtp",
        specDraftNMax: 8,
      });
      expect(r.status).toBe("ready");
      expect(restoreCalls).toBe(1);
      expect(chatCalls).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createLlamaClient — slot save/restore HTTP", () => {
  it("POSTs /slots/{id}?action=save|restore with { filename }", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response(
        JSON.stringify({ id_slot: 0, filename: "prefix.slot.bin", n_saved: 4, n_restored: 4 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const client = createLlamaClient("http://127.0.0.1:8090", fetcher);
    await client.saveSlot!(0, "prefix.slot.bin");
    await client.restoreSlot!(0, "prefix.slot.bin");
    expect(calls[0]!.url).toBe("http://127.0.0.1:8090/slots/0?action=save");
    expect(calls[1]!.url).toBe("http://127.0.0.1:8090/slots/0?action=restore");
    expect(JSON.parse(calls[0]!.body)).toEqual({ filename: "prefix.slot.bin" });
    expect(JSON.parse(calls[1]!.body)).toEqual({ filename: "prefix.slot.bin" });
  });
});

describe("buildArgs — default slot-save path", () => {
  it("includes the project data/llama-prompt-cache directory by default", () => {
    const args = buildArgs(defaultProfile());
    const i = args.indexOf("--slot-save-path");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]!.replace(/\\/g, "/")).toMatch(/data\/llama-prompt-cache$/);
  });
});
