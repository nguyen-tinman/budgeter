// Boot-time static-prefix warmup + on-disk llama-server slot KV.
//
// The chat prompt's HEAD is static: tagged SYSTEM_PROMPT + the full tool
// catalog (serialized by Qwen's chat template). Workspace data and the user
// message sit at the TAIL, so llama.cpp's RAM prefix cache can keep the head
// across turns — until the process dies. This module prefills that head once
// after llama-server is healthy, then POST /slots/0?action=save so the next
// process can restore it instead of paying ~2 minutes of CPU prefill.
//
// Confirmed against llama-server b10456 `--help` and tools/server:
//   --slot-save-path PATH   directory for slot KV (must already exist)
//   POST /slots/{id}?action=save|restore   body { "filename": "<basename>" }

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { ALL_TOOLS } from "@budgetkit/core";
import {
  toolsToOpenAi,
  type ChatRequest,
  type LlamaClient,
} from "./llama_client.js";

/** Basename written under `--slot-save-path`. Must pass llama.cpp's
 *  `fs_validate_filename` (no path separators). */
export const SLOT_CACHE_FILENAME = "prefix.slot.bin";
export const PROMPT_CACHE_META_FILENAME = "prefix.meta.json";

/** Dummy user turn appended AFTER the static single-system prefix. A real
 *  /api/chat request diverges here (workspace/page/guide sit in a non-system
 *  tail), so llama.cpp still shares system + tools. */
export const WARMUP_TAIL_USER = ".";

/** Slot 0 is the only slot (`nParallel: 1`). */
export const PROMPT_CACHE_SLOT_ID = 0;

/** First-turn CPU prefill of the ~16k-token static prefix measured ~141s.
 *  240s leaves headroom without hanging a wedged server forever. */
export const PROMPT_PREFIX_WARMUP_TIMEOUT_MS = 240_000;

export interface PromptCacheProfile {
  modelPath: string;
  ctxSize: number;
  cacheType?: string;
  specType?: string;
  specDraftNMax?: number;
  slotSavePath: string;
}

export interface PromptCacheIdentity {
  promptBytes: string;
  modelPath: string;
  ctxSize: number;
  cacheType: string;
  specType: string;
  specDraftNMax: number;
}

export interface PromptCacheMeta {
  version: 1;
  key: string;
  modelPath: string;
  ctxSize: number;
  cacheType: string;
  specType: string;
  specDraftNMax: number;
  promptSha256: string;
  slotFile: string;
}

export type PromptCacheAction = "restored" | "warmed" | "skipped";

export interface PromptCacheResult {
  action: PromptCacheAction;
  reason?: string;
}

/** Fields that change the chat-template token stream (the cached prefix).
 *  Sampler knobs are omitted — they do not affect prompt KV. */
export function warmupPromptBytes(req: ChatRequest): string {
  return JSON.stringify({
    messages: req.messages,
    tools: req.tools,
    tool_choice: req.tool_choice,
    chat_template_kwargs: req.chat_template_kwargs,
  });
}

export function promptCacheIdentity(
  profile: PromptCacheProfile,
  promptBytes: string,
): PromptCacheIdentity {
  return {
    promptBytes,
    modelPath: resolvePath(profile.modelPath),
    ctxSize: profile.ctxSize,
    cacheType: profile.cacheType ?? "f16",
    specType: profile.specType && profile.specType !== "none" ? profile.specType : "none",
    specDraftNMax: profile.specDraftNMax ?? 0,
  };
}

/** Hash of prompt bytes + model + ctx + KV cache type + spec settings that
 *  change the KV layout (MTP adds a nextn attention layer). */
export function promptCacheKey(identity: PromptCacheIdentity): string {
  const canonical = [
    "v1",
    identity.promptBytes,
    identity.modelPath,
    String(identity.ctxSize),
    identity.cacheType,
    identity.specType,
    String(identity.specDraftNMax),
  ].join("\0");
  return createHash("sha256").update(canonical).digest("hex");
}

export function cacheMetaMatches(
  meta: PromptCacheMeta | null,
  identity: PromptCacheIdentity,
): boolean {
  if (!meta || meta.version !== 1) return false;
  return meta.key === promptCacheKey(identity);
}

export function readPromptCacheMeta(cacheDir: string): PromptCacheMeta | null {
  const path = resolvePath(cacheDir, PROMPT_CACHE_META_FILENAME);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PromptCacheMeta;
    if (parsed?.version !== 1 || typeof parsed.key !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writePromptCacheMeta(cacheDir: string, identity: PromptCacheIdentity): void {
  const meta: PromptCacheMeta = {
    version: 1,
    key: promptCacheKey(identity),
    modelPath: identity.modelPath,
    ctxSize: identity.ctxSize,
    cacheType: identity.cacheType,
    specType: identity.specType,
    specDraftNMax: identity.specDraftNMax,
    promptSha256: createHash("sha256").update(identity.promptBytes).digest("hex"),
    slotFile: SLOT_CACHE_FILENAME,
  };
  writeFileSync(
    resolvePath(cacheDir, PROMPT_CACHE_META_FILENAME),
    JSON.stringify(meta, null, 2),
    "utf8",
  );
}

/**
 * Warmup completion whose prefix is the same functions a real chat turn uses:
 * exactly one leading `system` (`wrappedSystemPrompt()`) + `toolsToOpenAi(ALL_TOOLS)`
 * + the chat route's template kwargs. No workspace/page/guide — those are
 * volatile and live in a non-system tail so Qwen cannot merge them into the
 * warmed system block. `requestDefaults` is `chatRequestOptions()` in production.
 */
export function buildStaticPrefixWarmupRequest(
  systemPrompt: string,
  requestDefaults: Omit<ChatRequest, "messages">,
): ChatRequest {
  return {
    ...requestDefaults,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: WARMUP_TAIL_USER },
    ],
    tools: toolsToOpenAi(ALL_TOOLS),
    max_tokens: 1,
  };
}

async function defaultSystemPrompt(): Promise<string> {
  const { wrappedSystemPrompt } = await import("../routes/chat.js");
  return wrappedSystemPrompt();
}

async function defaultRequestDefaults(): Promise<Omit<ChatRequest, "messages">> {
  const { chatRequestOptions } = await import("../routes/chat.js");
  return chatRequestOptions();
}

export async function ensurePromptPrefixCached(opts: {
  client: LlamaClient;
  profile: PromptCacheProfile;
  getSystemPrompt?: () => string | Promise<string>;
  getRequestDefaults?: () => Omit<ChatRequest, "messages"> | Promise<Omit<ChatRequest, "messages">>;
}): Promise<PromptCacheResult> {
  const cacheDir = opts.profile.slotSavePath;
  try {
    mkdirSync(cacheDir, { recursive: true });
  } catch (err) {
    return { action: "skipped", reason: `mkdir failed: ${(err as Error).message}` };
  }

  let req: ChatRequest;
  try {
    const systemPrompt = await (opts.getSystemPrompt ?? defaultSystemPrompt)();
    const defaults = await (opts.getRequestDefaults ?? defaultRequestDefaults)();
    req = buildStaticPrefixWarmupRequest(systemPrompt, defaults);
  } catch (err) {
    return { action: "skipped", reason: `warmup request: ${(err as Error).message}` };
  }

  const identity = promptCacheIdentity(opts.profile, warmupPromptBytes(req));
  const slotPath = resolvePath(cacheDir, SLOT_CACHE_FILENAME);
  const meta = readPromptCacheMeta(cacheDir);
  const canRestore =
    existsSync(slotPath) && cacheMetaMatches(meta, identity) && !!opts.client.restoreSlot;

  if (canRestore) {
    try {
      const restored = await opts.client.restoreSlot!(
        PROMPT_CACHE_SLOT_ID,
        SLOT_CACHE_FILENAME,
      );
      if ((restored.n_restored ?? 0) > 0) {
        return { action: "restored" };
      }
      return await warmAndSave(opts.client, req, cacheDir, identity, "restore returned n_restored=0");
    } catch (err) {
      return await warmAndSave(
        opts.client,
        req,
        cacheDir,
        identity,
        `restore failed: ${(err as Error).message}`,
      );
    }
  }

  const why = !existsSync(slotPath)
    ? "no slot file"
    : !cacheMetaMatches(meta, identity)
      ? "cache key mismatch"
      : "client has no restoreSlot";
  return warmAndSave(opts.client, req, cacheDir, identity, why);
}

async function warmAndSave(
  client: LlamaClient,
  req: ChatRequest,
  cacheDir: string,
  identity: PromptCacheIdentity,
  reason: string,
): Promise<PromptCacheResult> {
  try {
    await client.chat(req, AbortSignal.timeout(PROMPT_PREFIX_WARMUP_TIMEOUT_MS));
  } catch (err) {
    return { action: "skipped", reason: `warmup failed (${reason}): ${(err as Error).message}` };
  }
  if (!client.saveSlot) {
    return { action: "warmed", reason: `${reason}; RAM-only (no saveSlot)` };
  }
  try {
    const saved = await client.saveSlot(PROMPT_CACHE_SLOT_ID, SLOT_CACHE_FILENAME);
    if ((saved.n_saved ?? 1) <= 0) {
      return { action: "warmed", reason: `${reason}; save returned n_saved=0` };
    }
    writePromptCacheMeta(cacheDir, identity);
    return { action: "warmed", reason };
  } catch (err) {
    return { action: "warmed", reason: `${reason}; save failed: ${(err as Error).message}` };
  }
}
