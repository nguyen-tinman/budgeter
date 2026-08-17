// Two-step "set up local LLM" pipeline. Driven by POST /api/llama/setup;
// progress is queryable via GET /api/llama/setup/status. Holds in-memory
// state via setup_progress.ts so frontends can poll without subscribing.
//
// Step 1: Download + extract llama.cpp release zip for the host platform.
// Step 2: Download the model GGUF from a configured URL.
//
// The pipeline is idempotent: if the binary or GGUF already exists, the
// respective step is skipped (and reported as "done" instantly).

import { existsSync, statSync, openSync, readSync, closeSync, unlinkSync } from "node:fs";
import {
  beginRun,
  beginStep1,
  updateStep1,
  finishStep1,
  failStep1,
  beginStep2,
  updateStep2,
  finishStep2,
  failStep2,
  finishRun,
  isRunning,
  snapshot,
} from "./setup_progress.js";
import { updateLlama } from "./llama_updater.js";
import { downloadFile } from "./model_downloader.js";
import {
  findInstalledLlamaServer,
  fromProjectRoot,
  hasVulkanBackend,
  MODEL_REGISTRY,
  modelById,
  resetGpuCache,
} from "./llama_launcher.js";

/** Default model id — the bundled Qwen3.5-2B-MTP. The URL + on-disk path are
 *  resolved from the launcher's MODEL_REGISTRY so the download source has a
 *  single source of truth shared with detection/selection. */
const DEFAULT_MODEL_ID = MODEL_REGISTRY[0]!.id;
/** Where the llama.cpp release archive lands + extracts. */
const DEFAULT_BIN_DIR = "bin/llama-cpp";

export interface OrchestrateOptions {
  /** Which registered model to download (defaults to the 2B). Resolved to a
   *  trusted URL + path via MODEL_REGISTRY — callers never supply raw URLs. */
  modelId?: string;
  modelUrl?: string;
  modelRelPath?: string;
  binDirRelPath?: string;
  /** Override fetcher for tests. */
  fetcher?: typeof fetch;
  /** Override updateLlama for tests. */
  llamaUpdater?: typeof updateLlama;
  /** Override downloadFile for tests. */
  downloader?: typeof downloadFile;
}

/** Kick off the setup pipeline. Returns immediately with the initial
 *  state; progress is tracked via setup_progress.snapshot(). */
export function startSetup(opts: OrchestrateOptions = {}): {
  ok: boolean;
  alreadyRunning: boolean;
} {
  if (isRunning()) {
    return { ok: false, alreadyRunning: true };
  }
  beginRun();
  // Fire and forget — never throw out to the caller. Errors land in the
  // progress state.
  void runPipeline(opts).catch((err) => {
    // Defensive: any unhandled throw should leave the state in error mode.
    const msg = err instanceof Error ? err.message : String(err);
    failStep2(`unexpected error: ${msg}`);
  });
  return { ok: true, alreadyRunning: false };
}

async function runPipeline(opts: OrchestrateOptions): Promise<void> {
  // Resolve the model from the registry by id (defaulting to the 2B). An
  // unknown id falls back to the default so a bad caller value can't break
  // the pipeline. Explicit modelUrl/modelRelPath still win (tests use them).
  const spec = modelById(opts.modelId ?? DEFAULT_MODEL_ID) ?? MODEL_REGISTRY[0]!;
  const binDirAbs = fromProjectRoot(opts.binDirRelPath ?? DEFAULT_BIN_DIR);
  const modelAbsPath = fromProjectRoot(
    opts.modelRelPath ?? `data/models/${spec.fileName}`,
  );
  const modelUrl = opts.modelUrl ?? spec.url;

  // Step 1: download + extract llama.cpp. Skip only if the binary is
  // already present AND the install ships the Vulkan backend (Vulkan is
  // our default — a CPU-only binary forces a re-download so the launcher
  // can offload to GPU. The launcher itself falls back to CPU at runtime
  // if no compatible device is found, so we don't lose the CPU path).
  const existingBin = findInstalledLlamaServer();
  if (existingBin && hasVulkanBackend()) {
    beginStep1("Already installed (Vulkan)");
    updateStep1({ bytesDone: 1, bytesTotal: 1, percent: 100 });
    finishStep1(`Found existing Vulkan-capable binary at ${existingBin}`);
    // A /models probe may have run before this binary existed (or before a
    // Vulkan build replaced a CPU-only one). Forget that reading so the next
    // recommendation / launchProfile() call re-probes.
    resetGpuCache();
  } else {
    if (existingBin) {
      beginStep1("Replacing CPU-only binary with Vulkan build…");
    } else {
      beginStep1("Querying GitHub for latest release…");
    }
    try {
      const updater = opts.llamaUpdater ?? updateLlama;
      await updater({
        destDir: binDirAbs,
        fetcher: opts.fetcher,
        onDownloadProgress: (p) => {
          updateStep1({
            bytesDone: p.bytesDone,
            bytesTotal: p.bytesTotal,
            percent: p.percent,
            message: `Downloading… ${formatBytes(p.bytesDone)} / ${
              p.bytesTotal > 0 ? formatBytes(p.bytesTotal) : "?"
            }`,
          });
        },
        onExtractStart: () => {
          updateStep1({ message: "Extracting archive…", percent: 100 });
        },
        onExtractDone: () => {
          updateStep1({ message: "Extracted", percent: 100 });
        },
      });
      finishStep1("Installed");
      resetGpuCache();
    } catch (err) {
      failStep1(err instanceof Error ? err.message : String(err));
      return;
    }
  }

  // Step 2: download GGUF (skip only if already present + non-trivial size
  // + has the GGUF magic bytes). The naive `size > 0` check accepted
  // truncated downloads, error-page HTML saved with .gguf extension, and
  // half-finished interrupted streams. Validating the magic + a sensible
  // floor catches all three without hashing the whole 1.3 GB file.
  if (existsSync(modelAbsPath) && looksLikeValidGGUF(modelAbsPath)) {
    const size = statSync(modelAbsPath).size;
    beginStep2("Already downloaded");
    updateStep2({ bytesDone: size, bytesTotal: size, percent: 100 });
    finishStep2(`Found existing GGUF (${formatBytes(size)}) at ${modelAbsPath}`);
    finishRun();
    return;
  }
  // If a file exists but failed validation, remove it so the rename in the
  // downloader doesn't accumulate aside copies, and so subsequent runs
  // don't keep skipping a broken file.
  if (existsSync(modelAbsPath)) {
    try {
      unlinkSync(modelAbsPath);
    } catch {
      /* fall through */
    }
  }
  beginStep2("Starting download…");
  try {
    const downloader = opts.downloader ?? downloadFile;
    await downloader(modelUrl, modelAbsPath, {
      fetcher: opts.fetcher,
      onProgress: (p) => {
        updateStep2({
          bytesDone: p.bytesDone,
          bytesTotal: p.bytesTotal,
          percent: p.percent,
          message: `Downloading… ${formatBytes(p.bytesDone)} / ${
            p.bytesTotal > 0 ? formatBytes(p.bytesTotal) : "?"
          }`,
        });
      },
    });
    finishStep2("Downloaded");
    finishRun();
  } catch (err) {
    failStep2(err instanceof Error ? err.message : String(err));
  }
}

/** Cheap GGUF sanity check: file must start with the 4-byte magic "GGUF"
 *  AND be larger than a trivial-error-page threshold (50 KB). Catches:
 *    - truncated downloads (size or magic missing)
 *    - HTML error pages saved as .gguf (no magic)
 *    - empty / placeholder files (under threshold)
 *  Does NOT verify the file end — full SHA-256 would catch silent
 *  mid-file corruption but at the cost of reading the whole 1.3 GB on
 *  every setup call. Magic + size floor is a pragmatic middle ground. */
export function looksLikeValidGGUF(path: string): boolean {
  const MIN_SIZE = 50 * 1024;
  try {
    if (statSync(path).size < MIN_SIZE) return false;
  } catch {
    return false;
  }
  let fd = -1;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(4);
    const n = readSync(fd, buf, 0, 4, 0);
    if (n !== 4) return false;
    // GGUF magic: ASCII 'G','G','U','F' (0x47 0x47 0x55 0x46)
    return buf[0] === 0x47 && buf[1] === 0x47 && buf[2] === 0x55 && buf[3] === 0x46;
  } catch {
    return false;
  } finally {
    if (fd >= 0) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function getSetupStatus() {
  return snapshot();
}
