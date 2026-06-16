// llama-server subprocess lifecycle. Dev-mode override: if
// LLAMA_SERVER_URL is set (e.g. http://localhost:5001 for the user's
// running kobold.cpp), the launcher reports status "external" and skips
// spawn — the chat bridge always talks to whatever URL is resolved.
//
// Testability: `spawnFn` is injectable so tests don't shell out to a real
// binary. Production passes child_process.spawn.

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { cpus } from "node:os";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { createLlamaClient, type LlamaClient } from "./llama_client.js";

/**
 * Find the BudgetKit project root by walking up from this source file until
 * we find `pnpm-workspace.yaml`. Cached for the process lifetime.
 *
 * Robust to: arbitrary cwd, dev vs. built dist, monorepo nesting, packaged
 * binaries. Fails loudly if the marker can't be located so we don't
 * silently mis-resolve model paths.
 */
let _projectRoot: string | null = null;
function projectRoot(): string {
  if (_projectRoot) return _projectRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolvePath(dir, "pnpm-workspace.yaml"))) {
      _projectRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `projectRoot(): walked up 10 levels from ${fileURLToPath(import.meta.url)} and never found pnpm-workspace.yaml`,
  );
}

/** Resolve a path that is conceptually relative to the project root, no
 *  matter where the process was launched from. */
export function fromProjectRoot(relative: string): string {
  return resolvePath(projectRoot(), relative);
}

/** Canonical list of places we look for the llama-server binary. Shared
 *  by the launcher's resolveBin() and the setup orchestrator's
 *  skip-if-already-installed check so the two never disagree. */
export function llamaBinCandidates(): string[] {
  return [
    fromProjectRoot("bin/llama-cpp/llama-server.exe"),
    fromProjectRoot("bin/llama-cpp/llama-server"),
    fromProjectRoot("apps/api/bin/llama-cpp/llama-server.exe"),
    fromProjectRoot("apps/api/bin/llama-cpp/llama-server"),
  ];
}

/** Return the first existing candidate path, or null. */
export function findInstalledLlamaServer(): string | null {
  for (const c of llamaBinCandidates()) if (existsSync(c)) return c;
  return null;
}

/**
 * Registry of selectable local models. Each entry is a logical model the user
 * can download + run. `id` is the stable key persisted as last-used (see the
 * app_settings `llama.lastModelId` row); `fileName` is the GGUF basename under
 * data/models/; `url` is the trusted download source the setup orchestrator
 * streams from; `sizeRank` orders models smallest→largest so default selection
 * can prefer the larger ("smarter") model when more than one is present.
 *
 * The 2B is the default/smaller bundled model. The 4B is the heavier "smarter"
 * option — same 128k context, fully GPU-offloaded (nGpuLayers:99), relying on
 * the launcher's Vulkan→CPU fallback if VRAM can't hold it.
 */
export interface ModelSpec {
  id: string;
  label: string;
  /** GGUF basename under data/models/. */
  fileName: string;
  /** Trusted download URL (used by the setup orchestrator). */
  url: string;
  /** Smaller number = smaller model. Larger = "smarter". */
  sizeRank: number;
  /** Short note surfaced in the Setup UI. */
  blurb: string;
  /** Speculative-decoding mode this GGUF supports. The 2B-MTP build ships
   *  packed MTP heads (draft-mtp self-draft); the plain 4B GGUF does not, so
   *  it runs without speculation ("none"). */
  specType: NonNullable<LlamaProfile["specType"]>;
}

export const MODEL_REGISTRY: ModelSpec[] = [
  {
    id: "qwen3.5-2b",
    label: "Qwen 3.5 2B",
    fileName: "Qwen3.5-2B-Q5_K_S.gguf",
    url: "https://huggingface.co/unsloth/Qwen3.5-2B-MTP-GGUF/resolve/main/Qwen3.5-2B-Q5_K_S.gguf?download=true",
    sizeRank: 1,
    blurb: "Default. ~1.3 GB. Fast, light on VRAM; ships MTP self-draft heads.",
    specType: "draft-mtp",
  },
  {
    id: "qwen3.5-4b",
    label: "Qwen 3.5 4B",
    fileName: "Qwen3.5-4B-UD-Q5_K_XL.gguf",
    url: "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-UD-Q5_K_XL.gguf?download=true",
    sizeRank: 2,
    // VRAM note: 4B weights (~3 GB) + 128k f16 KV-cache is materially heavier
    // than the 2B. We keep nGpuLayers:99 (full offload) and lean on the
    // existing Vulkan→CPU fallback if the GPU can't allocate.
    blurb: "Smarter. ~3 GB. Heavier on VRAM at 128k context; falls back to CPU if it won't fit.",
    // Plain 4B GGUF — no packed MTP heads, so no self-draft speculation.
    specType: "none",
  },
];

/** Look up a model spec by id. */
export function modelById(id: string): ModelSpec | undefined {
  return MODEL_REGISTRY.find((m) => m.id === id);
}

/** Absolute path where a model's GGUF lives (or would live) on disk. */
export function modelPathFor(spec: ModelSpec): string {
  return fromProjectRoot(`data/models/${spec.fileName}`);
}

/**
 * Detect which registered model GGUFs are present in data/models/.
 *
 * `existsFn` is injectable so tests can assert detection/selection without the
 * real (multi-GB) files on disk. Production uses node:fs existsSync.
 */
export function detectModels(
  existsFn: (path: string) => boolean = existsSync,
): Array<{ spec: ModelSpec; present: boolean }> {
  return MODEL_REGISTRY.map((spec) => ({
    spec,
    present: existsFn(modelPathFor(spec)),
  }));
}

/**
 * Pure default-selection policy. Given which models are present and the
 * persisted last-used id, decide which model id to launch:
 *   1. If the last-used model is present, prefer it (sticky across sessions).
 *   2. Otherwise pick the LARGEST present model (highest sizeRank — "smarter").
 *   3. If nothing is present, return null (nothing to launch).
 */
export function selectModelId(
  detected: Array<{ spec: ModelSpec; present: boolean }>,
  lastUsedId: string | null,
): string | null {
  const present = detected.filter((d) => d.present);
  if (present.length === 0) return null;
  if (lastUsedId && present.some((d) => d.spec.id === lastUsedId)) {
    return lastUsedId;
  }
  const largest = present.reduce((a, b) =>
    b.spec.sizeRank > a.spec.sizeRank ? b : a,
  );
  return largest.spec.id;
}

// ---------------------------------------------------------------------------
// Port selection (C4). The default profile pins port 8090; if another process
// squats on it llama-server dies with an opaque bind error. We probe before
// spawning and walk forward up to PORT_WALK_RANGE consecutive ports
// (8090–8095 for the default), and the CHOSEN port propagates automatically:
// it lands on this.profile, so resolveUrl() → /api/llama/status and the chat
// bridge's currentLlamaUrl() (routes/llama.ts) all report the live URL.
// ---------------------------------------------------------------------------

/** How many consecutive ports start() will try, beginning at profile.port. */
export const PORT_WALK_RANGE = 6;

/** True when nothing is currently bound to 127.0.0.1:port. Uses an
 *  exclusive ephemeral bind-and-release probe. */
export function isPortFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => {
      srv.close(() => resolve(true));
    });
  });
}

/** First free port in [startPort, startPort + attempts), or null when the
 *  whole range is occupied. `probe` is injectable for tests. */
export async function findFreePort(
  startPort: number,
  attempts: number = PORT_WALK_RANGE,
  probe: (port: number) => Promise<boolean> = isPortFree,
): Promise<number | null> {
  for (let p = startPort; p < startPort + attempts; p++) {
    if (await probe(p)) return p;
  }
  return null;
}

/** Heuristic: does the stderr tail show llama-server failing to BIND its
 *  HTTP port (vs. model-load / backend errors)? Used to catch the narrow
 *  race where the pre-spawn probe said free but another process grabbed the
 *  port before llama-server bound it. */
export function isPortBindFailure(stderr: string): boolean {
  if (!stderr) return false;
  const hits = [
    /couldn'?t bind/i,
    /failed to bind/i,
    /bind.*(failed|error)/i,
    /address already in use/i,
    /EADDRINUSE/i,
    /socket.*already in use/i,
  ];
  return hits.some((re) => re.test(stderr));
}

export type LlamaStatus = "stopped" | "starting" | "ready" | "error" | "external";

/** Which compute backend the running server is using. Surfaced in the API
 *  status response so the UI can show "GPU (Vulkan)" or "CPU (fallback)". */
export type BackendMode = "vulkan" | "cpu" | "cpu-fallback" | "unknown";

/** Return true if the installed binary ships the Vulkan backend (ggml-vulkan.dll
 *  on Windows, libggml-vulkan.so on Linux). Used by the setup orchestrator to
 *  decide whether the currently-installed bin satisfies "prefer Vulkan". */
export function hasVulkanBackend(): boolean {
  const bin = findInstalledLlamaServer();
  if (!bin) return false;
  const binDir = dirname(bin);
  const candidates = [
    resolvePath(binDir, "ggml-vulkan.dll"),
    resolvePath(binDir, "libggml-vulkan.so"),
    resolvePath(binDir, "libggml-vulkan.dylib"),
  ];
  return candidates.some((p) => existsSync(p));
}

export interface LlamaProfile {
  modelPath: string;
  port: number;
  ctxSize: number;
  nGpuLayers: number;
  nThreads?: number;
  batchSize: number;
  flashAttn: boolean;
  useMmap: boolean;
  useMlock: boolean;
  /**
   * Speculative decoding mode. Passed to llama-server as `--spec-type <v>`.
   * Notable values:
   *   - "draft-mtp"      — use the model's packed-in Multi-Token Prediction
   *                        heads as a self-draft (no separate draft model).
   *                        Requires a GGUF that ships with MTP heads
   *                        (e.g. unsloth's Qwen3.5-2B-MTP-GGUF).
   *   - "draft-simple"   — classic two-model speculative decoding (needs
   *                        `draftModelPath` set).
   *   - "draft-eagle3"   — EAGLE3 self-draft.
   *   - "ngram-simple"   — n-gram-cache draft, no extra model needed.
   *   - undefined/"none" — no speculative decoding.
   */
  specType?: "none" | "draft-simple" | "draft-eagle3" | "draft-mtp" | "ngram-simple" | "ngram-map-k" | "ngram-map-k4v" | "ngram-mod" | "ngram-cache";
  draftModelPath?: string;
  /** `--spec-draft-n-max`. Max speculative tokens per step. llama.cpp default
   *  is 3; we explicitly pin it on the profile so it shows up in the args
   *  + is tunable per-profile. */
  specDraftNMax?: number;
  /** `--parallel`. Number of parallel slots llama-server reserves. Default
   *  "auto" picks 4. For a single-user app we only need 1 — the extra slots
   *  reserve KV cache + recurrent state we never use. */
  nParallel?: number;
  // Sampler defaults are passed via --sampling-config on llama-server, or
  // sent per-request via the chat API. We keep them on the profile for
  // future per-profile request defaults.
  temperature: number;
  topK: number;
  topP: number;
  minP: number;
  repeatPenalty: number;
  maxTokens: number;
}

export interface LaunchResult {
  status: LlamaStatus;
  url: string;
  pid: number | null;
  errorTail?: string;
  external?: boolean;
}

export type SpawnFn = typeof nodeSpawn;

/** Construct the CLI args for llama-server from a profile. Pure. */
export function buildArgs(profile: LlamaProfile): string[] {
  const args: string[] = [
    "--model", profile.modelPath,
    "--port", String(profile.port),
    "--host", "127.0.0.1",
    "-c", String(profile.ctxSize),
    "-ngl", String(profile.nGpuLayers),
    "-b", String(profile.batchSize),
    // Disable context shifting so the server never silently drops earlier
    // tokens to make room for new ones. With multi-turn chat history the
    // correct failure mode when the window is exhausted is a hard error the
    // UI can surface ("conversation is full — clear it"), not an invisible
    // forget that breaks coherence mid-conversation. Qwen3 has no SWA-style
    // window of its own; this is the right safety knob.
    "--no-context-shift",
  ];
  if (profile.nThreads !== undefined) args.push("-t", String(profile.nThreads));
  // Newer llama.cpp requires an explicit value for -fa (on/off/auto), not
  // a bare flag. Without the value it consumes the next CLI token as the
  // flash-attn value and dies with a usage error.
  if (profile.flashAttn) args.push("-fa", "on");
  // mmap / mlock only matter on the CPU path — they pin model weights into
  // host RAM. When we're fully offloading to GPU (nGpuLayers > 0), weights
  // live in VRAM, so mlock just wastes host RAM and `--no-mmap` adds an
  // extra host-side copy before transfer. Skip them on the GPU path.
  if (profile.nGpuLayers === 0) {
    if (!profile.useMmap) args.push("--no-mmap");
    if (profile.useMlock) args.push("--mlock");
  }
  if (profile.specType && profile.specType !== "none") {
    args.push("--spec-type", profile.specType);
    if (profile.draftModelPath) {
      args.push("--spec-draft-model", profile.draftModelPath);
    }
    if (profile.specDraftNMax !== undefined) {
      args.push("--spec-draft-n-max", String(profile.specDraftNMax));
    }
  }
  if (profile.nParallel !== undefined) {
    args.push("--parallel", String(profile.nParallel));
  }
  // Sampler defaults — server-level fallback. Per-request values from
  // /api/chat or the OpenAI-compatible body will still override these.
  args.push("--temp", String(profile.temperature));
  args.push("--top-p", String(profile.topP));
  args.push("--top-k", String(profile.topK));
  args.push("--min-p", String(profile.minP));
  args.push("--repeat-penalty", String(profile.repeatPenalty));
  args.push("-n", String(profile.maxTokens));
  return args;
}

export interface LauncherOptions {
  /** Path to the llama-server binary. If unset, looks for ./bin/llama-cpp/llama-server[.exe]. */
  binPath?: string;
  /** Override the LLAMA_SERVER_URL env-var check (for tests). */
  externalUrl?: string;
  spawnFn?: SpawnFn;
  /** Inject a client (tests stub it; prod creates one targeting the resolved URL). */
  client?: LlamaClient;
  /** Port-availability probe override (tests). Defaults to a real bind probe. */
  portProbe?: (port: number) => Promise<boolean>;
}

export class LlamaLauncher {
  private proc: ChildProcess | null = null;
  private status: LlamaStatus = "stopped";
  private currentUrl: string = "";
  private lastError: string | null = null;
  private profile: LlamaProfile | null = null;
  /** Which backend the current/last run used. Reset to "unknown" on start. */
  private backendMode: BackendMode = "unknown";
  /** If we fell back from Vulkan→CPU at startup, this holds the GPU init
   *  error so the UI can surface "running on CPU because <reason>". */
  private backendWarning: string | null = null;

  constructor(private readonly opts: LauncherOptions = {}) {}

  /** Resolve the URL the chat bridge should point at right now. */
  resolveUrl(): string {
    const external = this.opts.externalUrl ?? process.env.LLAMA_SERVER_URL;
    if (external) return external;
    if (this.profile) return `http://127.0.0.1:${this.profile.port}`;
    // Stopped state: fall back to the default-profile port so the UI shows
    // the URL the user will actually get when they click Start.
    return `http://127.0.0.1:${defaultProfile().port}`;
  }

  /** Return current status without side effects. */
  getStatus(): {
    status: LlamaStatus;
    url: string;
    pid: number | null;
    external: boolean;
    error: string | null;
    backendMode: BackendMode;
    backendWarning: string | null;
  } {
    const external = Boolean(this.opts.externalUrl ?? process.env.LLAMA_SERVER_URL);
    return {
      status: external ? "external" : this.status,
      url: this.resolveUrl(),
      pid: this.proc?.pid ?? null,
      external,
      error: this.lastError,
      backendMode: this.backendMode,
      backendWarning: this.backendWarning,
    };
  }

  /** Find the llama-server binary or report a clear missing-binary error.
   *
   *  Explicit `opts.binPath` overrides everything. If it's set but missing,
   *  we return null rather than falling through to the default candidates —
   *  silently swapping in some other binary would surprise the caller and
   *  break tests that intentionally point at a nonexistent path.
   *
   *  Default candidates are resolved against the project root, so they
   *  work regardless of the API's cwd. */
  private resolveBin(): string | null {
    if (this.opts.binPath) {
      return existsSync(this.opts.binPath) ? this.opts.binPath : null;
    }
    const env = process.env.LLAMA_SERVER_BIN;
    if (env && existsSync(env)) return env;
    return findInstalledLlamaServer();
  }

  /** Start the subprocess. No-op (returns "external") if LLAMA_SERVER_URL is set.
   *
   *  Vulkan-first policy: if the profile asks for GPU offload (nGpuLayers > 0)
   *  AND the first launch attempt fails with a recognizable backend-init error
   *  (no Vulkan device, driver missing, etc.), we automatically retry once
   *  with nGpuLayers=0 and surface a `backendMode: "cpu-fallback"` warning so
   *  the UI can tell the user. */
  async start(profile: LlamaProfile): Promise<LaunchResult> {
    if (this.opts.externalUrl ?? process.env.LLAMA_SERVER_URL) {
      this.profile = profile;
      this.backendMode = "unknown";
      this.backendWarning = null;
      return { status: "external", url: this.resolveUrl(), pid: null, external: true };
    }
    if (this.proc && !this.proc.killed) {
      return { status: this.status, url: this.resolveUrl(), pid: this.proc.pid ?? null };
    }

    const bin = this.resolveBin();
    if (!bin) {
      this.status = "error";
      this.lastError = "llama-server binary not found — use the Update button to fetch one";
      return {
        status: "error",
        url: "",
        pid: null,
        errorTail: this.lastError,
      };
    }

    // C4: probe for a free port BEFORE spawning. llama-server exits with an
    // opaque bind error when the port is taken; walking forward up to
    // PORT_WALK_RANGE ports keeps a squatter (8090 default) from hard-failing
    // the launch. The chosen port lands on this.profile via attemptStart, so
    // resolveUrl()/getStatus() and the chat bridge see the live URL.
    const probe = this.opts.portProbe ?? isPortFree;
    const freePort = await findFreePort(profile.port, PORT_WALK_RANGE, probe);
    if (freePort === null) {
      this.status = "error";
      this.lastError =
        `ports ${profile.port}-${profile.port + PORT_WALK_RANGE - 1} are all in use — ` +
        `close whatever is holding them (netstat -ano | findstr :${profile.port}) ` +
        `or launch with a different "port" in the profile`;
      this.profile = profile;
      return { status: "error", url: "", pid: null, errorTail: this.lastError };
    }
    if (freePort !== profile.port) {
      // eslint-disable-next-line no-console
      console.warn(`[llama-launcher] port ${profile.port} is busy; using ${freePort} instead`);
    }
    profile = { ...profile, port: freePort };

    let attempt = await this.attemptStart(bin, profile);

    // Narrow race: the probe said free but another process bound the port
    // before llama-server did. One more walk starting past the failed port.
    if (attempt.status !== "ready" && isPortBindFailure(attempt.errorTail ?? "")) {
      const retryPort = await findFreePort(profile.port + 1, PORT_WALK_RANGE - 1, probe);
      if (retryPort !== null) {
        // eslint-disable-next-line no-console
        console.warn(
          `[llama-launcher] bind failed on port ${profile.port} after probe; retrying on ${retryPort}`,
        );
        profile = { ...profile, port: retryPort };
        attempt = await this.attemptStart(bin, profile);
      }
    }

    if (attempt.status === "ready") {
      this.backendMode = profile.nGpuLayers > 0 ? "vulkan" : "cpu";
      this.backendWarning = null;
      return attempt;
    }

    // Attempt failed. If we asked for GPU offload AND the failure looks
    // like a backend-init problem (no Vulkan device, driver missing, etc.),
    // retry once with nGpuLayers=0 so the user gets a working CPU fallback
    // instead of a hard "error" status.
    //
    // Critical: when falling back to CPU, also reset the knobs that were
    // tuned for the GPU path:
    //   - nThreads: was lowered to 4 for GPU (host-side only). On CPU,
    //     every layer's matmul runs on threads, so use all available cores.
    //   - specType: MTP draft heads add work-per-step that's only a win
    //     when GPU compute is fast enough to keep up. On CPU, the draft
    //     compute usually costs more than it saves; disable it.
    const isBackendFailure = profile.nGpuLayers > 0 && isVulkanInitFailure(attempt.errorTail ?? "");
    if (isBackendFailure) {
      const reason = extractBackendFailureReason(attempt.errorTail ?? "");
      const cpuProfile: LlamaProfile = {
        ...profile,
        nGpuLayers: 0,
        nThreads: cpus().length,
        specType: "none",
      };
      const second = await this.attemptStart(bin, cpuProfile);
      if (second.status === "ready") {
        this.profile = cpuProfile;
        this.backendMode = "cpu-fallback";
        this.backendWarning = `Vulkan unavailable (${reason}). Running on CPU.`;
        return second;
      }
      return second;
    }
    return attempt;
  }

  /** Single launch attempt. Spawns the binary, polls /health until ready
   *  or timeout, and returns the resulting LaunchResult. Sets this.profile
   *  and this.status as a side effect. */
  private async attemptStart(bin: string, profile: LlamaProfile): Promise<LaunchResult> {
    this.profile = profile;
    this.status = "starting";
    this.lastError = null;
    const args = buildArgs(profile);
    const spawnFn = this.opts.spawnFn ?? nodeSpawn;
    const proc = spawnFn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc = proc;

    let stderrTail = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      stderrTail = (stderrTail + s).slice(-4096);
    });
    proc.on("exit", (code) => {
      if (this.status !== "ready") {
        this.status = "error";
        this.lastError = `llama-server exited with code ${code}; stderr tail: ${stderrTail.slice(-512)}`;
      } else {
        this.status = "stopped";
      }
      this.proc = null;
    });

    const client = this.opts.client ?? createLlamaClient(this.resolveUrl());
    // Loading a multi-GB GGUF and allocating a 128k-context KV cache can take
    // well over 15s on a cold start (the 4B model was still at "loading model"
    // when the old 15s deadline fired, so auto-start reported a false failure
    // even though the server came up moments later). Give it 3 minutes.
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (!this.proc) break;
      const h = await client.health();
      if (h.ok) {
        this.status = "ready";
        return { status: "ready", url: this.resolveUrl(), pid: proc.pid ?? null };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (this.status === "starting") {
      this.status = "error";
      this.lastError = `health check timed out; stderr tail: ${stderrTail.slice(-512)}`;
      // Capture `this.proc` locally — between the if-check and the kill,
      // another caller (or the 'exit' handler on line 365) may have set
      // `this.proc = null`, causing a TOCTOU NPE. We also stop touching
      // `this.proc` after the kill so we don't trample a fresh proc spawned
      // by a concurrent attemptStart() call.
      const procToKill = this.proc;
      try {
        if (procToKill && !procToKill.killed) procToKill.kill("SIGKILL");
      } catch {
        /* best-effort */
      }
      // Only clear if it's STILL the same proc we captured — guards against
      // wiping out a fresh subprocess that landed in this.proc between the
      // capture and now.
      if (this.proc === procToKill) this.proc = null;
    }
    return {
      status: this.status,
      url: this.resolveUrl(),
      pid: proc.pid ?? null,
      errorTail: this.lastError ?? stderrTail,
    };
  }

  /** SIGTERM the subprocess, then SIGKILL after a grace period. */
  async stop(): Promise<void> {
    if (!this.proc || this.proc.killed) {
      this.status = "stopped";
      return;
    }
    const proc = this.proc;
    proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 5_000));
    if (!proc.killed) proc.kill("SIGKILL");
    this.proc = null;
    this.status = "stopped";
  }

  /**
   * Synchronously hard-kill the tracked subprocess (C3 — API shutdown path).
   *
   * Why a separate method from stop():
   *   - process 'exit' handlers may only do SYNCHRONOUS work, and the
   *     SIGINT/SIGTERM/uncaughtException handlers in apps/api/src/index.ts
   *     must not delay shutdown by stop()'s 5s SIGTERM grace window.
   *   - llama-server is a stateless inference server (no durable state to
   *     flush), so an immediate SIGKILL loses nothing; leaving it orphaned
   *     would strand multiple GB of VRAM until the user hunts the PID down.
   *
   * Kills ONLY the exact child this launcher spawned (via its ChildProcess
   * handle) — never by name or pattern. No-op when nothing is running.
   */
  killNow(): void {
    const proc = this.proc;
    if (proc && !proc.killed) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone — nothing to do */
      }
    }
    if (this.proc === proc) this.proc = null;
    this.status = "stopped";
  }

  async restart(profile?: LlamaProfile): Promise<LaunchResult> {
    await this.stop();
    return this.start(profile ?? this.profile ?? defaultProfile());
  }
}

/**
 * Hardcoded default profile: GPU-offloaded inference of Qwen3.5-2B-MTP with the
 * model's packed MTP heads acting as a self-draft (--spec-type draft-mtp).
 *
 * - `nGpuLayers: 99` asks llama-server to offload every layer to the GPU.
 *   The 2B Q5_K_S model is ~1.33 GB and runs on any GPU with ≥1.4 GB VRAM.
 *   If Vulkan init fails (no compatible device, missing driver), the
 *   launcher auto-retries with nGpuLayers=0 and reports
 *   `backendMode: "cpu-fallback"`.
 * - `flashAttn: true` — flash-attention is a clear win on GPU and is the
 *   modern default. (llama-server logs "Flash Attention was auto, set to
 *   enabled" anyway during sched_reserve; we make it explicit.)
 * - `nParallel: 1` — single-user app. 4 slots reserves KV cache + recurrent
 *   state for parallel requests we never make. Single slot frees that
 *   memory and reduces graph complexity.
 * - `specDraftNMax: 1` — minimal MTP draft length. Qwen3.5 is a hybrid
 *   Transformer + Gated DeltaNet (SSM) architecture; the SSM layers don't
 *   speculate cleanly with longer draft chains, and Vulkan's SSM kernels
 *   are unoptimized vs CUDA. With n_max=1 the draft cost is minimal and
 *   any accepted token is pure profit.
 * - `useMmap: false` + `useMlock: true` pin the GGUF in resident RAM on the
 *   CPU fallback path (no effect when nGpuLayers > 0 — buildArgs elides them).
 *
 * Hardcoded modelPath assumes the project layout's `./data/models/` dir.
 * Override via the saved llama_profiles row if you swap the GGUF.
 *
 * `modelId` selects which registered model the profile points at; it defaults
 * to the 2B (the smaller/bundled default). Pass "qwen3.5-4b" for the smarter
 * model. An unknown id falls back to the 2B path so a stale persisted value
 * can never produce an unresolvable modelPath. The MTP self-draft (specType:
 * draft-mtp) is specific to the 2B-MTP GGUF, so non-MTP models disable it.
 */
export function defaultProfile(modelId?: string): LlamaProfile {
  const spec = (modelId && modelById(modelId)) || MODEL_REGISTRY[0]!;
  return {
    // Path is resolved against the project root (where pnpm-workspace.yaml
    // lives), NOT the API's cwd — which would be apps/api/ under
    // `pnpm --filter dev`. Keeps the project shippable: no
    // machine-specific absolute path checked in.
    modelPath: modelPathFor(spec),
    // 8080 is commonly hogged by other services on Windows (we saw
    // AgentService squat on it during initial setup). 8090 is rarely
    // contested — and if it IS taken, start() probes and walks forward up
    // to 8095 (PORT_WALK_RANGE), propagating the chosen port through
    // resolveUrl()/status and the chat bridge. Override via the saved
    // llama_profiles row if you need a fixed different port.
    port: 8090,
    // 128k context. The fixed prefill alone is heavy — base system
    // instructions + workspace summary + the FULL tool registry (~5–7k tokens
    // of name/description/input-schema serialized by Qwen's chat template every
    // turn) — and we want generous room for long multi-turn sessions. 128k f16
    // KV-cache is ~6.4 GB extra over the 8k baseline on our Vulkan path (double
    // 64k); on VRAM-tight machines this can fail to allocate and fall back to
    // CPU (slow) or refuse — watch the launch log for a KV-alloc / OOM failure
    // and dial back if so. Qwen3.5's native context comfortably exceeds 128k.
    // Must stay in sync with chat.ts CONTEXT_BUDGET_TOKENS.
    ctxSize: 131072,
    nGpuLayers: 99,
    // Pin to 4 host threads. When fully offloaded, llama-server only uses
    // host threads for sampling, tokenization, the small CPU prelude, and
    // (on CPU fallback) the actual compute. Default (auto-picks ~10 here)
    // is overkill on the GPU path and contends with other apps; 4 is
    // plenty for the host-side work without monopolizing cores.
    nThreads: 4,
    batchSize: 512,
    flashAttn: true,
    // KV cache type-k and type-v are left at llama-server's f16 default
    // (no --cache-type-k / --cache-type-v passed). Quantizing KV (q8_0,
    // q4_0) was tested and slowed things down on this Vulkan + small-model
    // path because the dequant cost beat the memory-bandwidth savings.
    useMmap: false,
    useMlock: true,
    // Per-model: the 2B-MTP build self-drafts via packed MTP heads; the 4B
    // GGUF has none, so it declares "none" and runs without speculation.
    specType: spec.specType,
    specDraftNMax: 1,
    nParallel: 1,
    // Qwen3.5 recommended sampler settings for "precise coding" / agentic
    // tool-calling workloads (per unsloth's published guidance).
    //   temperature=0.6, top_p=0.95, top_k=20, min_p=0.0, repeat_penalty=1.0
    // These suppress the off-task wandering you see with the generic
    // temp=0.7/top_p=0.9 defaults and keep tool-call argument JSON stable.
    temperature: 0.6,
    topK: 20,
    topP: 0.95,
    minP: 0.0,
    repeatPenalty: 1.0,
    // 16k reply cap (`-n`). With a 128k context window there's ample room, and
    // long reasoning + multi-step tool-call turns benefit from the headroom.
    // Mirrored by chat.ts REPLY_RESERVATION_TOKENS and the per-request max_tokens.
    maxTokens: 16384,
  };
}

/** Heuristic: does the stderr tail show a Vulkan/GPU init failure that
 *  warrants a CPU retry? Conservative — only flags cases that look
 *  unambiguously like backend init, NOT model load / OOM / bad-config. */
export function isVulkanInitFailure(stderr: string): boolean {
  if (!stderr) return false;
  const s = stderr.toLowerCase();
  const hits = [
    /no\s+vulkan\s+devices?\s+found/,
    /vk_error/,
    /vulkan.*not\s+available/,
    /vulkan.*init.*fail/,
    /failed\s+to\s+initialize\s+(vulkan|gpu)/,
    /no\s+compatible\s+(vulkan|gpu)\s+device/,
    /vk_(no_device|error_incompatible_driver|error_initialization_failed)/i,
    /no\s+ggml\s+backends/,
    /failed\s+to\s+load\s+vulkan/,
    /ggml_vulkan.*error/,
    /unable\s+to\s+find\s+vulkan\s+loader/,
  ];
  return hits.some((re) => re.test(s));
}

/** Pull out a short human-readable reason from the stderr tail for the
 *  fallback warning the UI surfaces. Falls back to a generic string. */
export function extractBackendFailureReason(stderr: string): string {
  if (!stderr) return "GPU init failed";
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // Prefer lines that look like the actual error, not the build banner.
  const candidates = lines.filter(
    (l) => /vulkan|gpu|ggml/i.test(l) && /fail|error|no |unable|cannot/i.test(l),
  );
  const pick = candidates[0] ?? lines[lines.length - 1] ?? "GPU init failed";
  return pick.slice(0, 160);
}
