// llama-server subprocess lifecycle. Dev-mode override: if
// LLAMA_SERVER_URL is set (e.g. http://localhost:5001 for the user's
// running kobold.cpp), the launcher reports status "external" and skips
// spawn — the chat bridge always talks to whatever URL is resolved.
//
// Testability: `spawnFn` is injectable so tests don't shell out to a real
// binary. Production passes child_process.spawn.

import { spawn as nodeSpawn, spawnSync, type ChildProcess } from "node:child_process";
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
  /** Speculative-decoding mode this GGUF supports. Both registry entries are
   *  MTP builds with packed self-draft heads, so both declare "draft-mtp"; the
   *  plain (non-MTP) upstream GGUFs would have to declare "none". */
  specType: NonNullable<LlamaProfile["specType"]>;
  /** Peak dedicated VRAM in MiB, MEASURED at ctxSize 131072 on Vulkan with
   *  full offload, sampled across load and generation. `mtp` is with
   *  speculation at the default draft length, `noMtp` with --spec-type none.
   *  The gap is almost entirely the extra nextn attention layer's KV cache,
   *  which is why disabling speculation is a real memory lever and not just a
   *  speed knob. Used by speculationFor() to decide if MTP fits. */
  vramMib: { mtp: number; noMtp: number };
  /** `--spec-draft-n-max` for THIS model. Per-model because the optimum is not
   *  a property of the algorithm — it is where each model's verify-batch cost
   *  crosses its own accept rate, and the two models land nowhere near each
   *  other (2B: 8, 4B: 3). Measured; see the table at defaultProfile. */
  specDraftNMax: number;
  /** Is this model usable with no GPU at all? Gates the bottom rung of the
   *  degradation ladder — the CPU fallback runs the largest present model for
   *  which this is true, NOT necessarily the model that was loaded.
   *
   *  The 2B measures 23.8 tok/s on CPU (16 threads, q8_0 KV, draft length 2):
   *  slow but usable for chat. The 4B is 2.1x the weights and ~1.9x the KV
   *  cache, which puts it in the low single digits — technically it loads, but
   *  a reply would take minutes, so we do not offer it. That is an inference
   *  from the 2B measurement and the size ratio, not a measurement of the 4B
   *  itself; if you ever measure it, put the number here. */
  cpuCapable: boolean;
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
    vramMib: { mtp: 2750, noMtp: 2377 },
    specDraftNMax: 8,
    cpuCapable: true,
  },
  {
    id: "qwen3.5-4b",
    label: "Qwen 3.5 4B",
    // Local name carries "MTP" deliberately. The MTP repo publishes the same
    // UD-Q5_K_XL filename as the plain 4B repo, so reusing that name would let
    // an already-downloaded NON-MTP file be detected as present and then
    // launched with --spec-type draft-mtp against a GGUF that has no heads.
    fileName: "Qwen3.5-4B-MTP-UD-Q5_K_XL.gguf",
    url: "https://huggingface.co/unsloth/Qwen3.5-4B-MTP-GGUF/resolve/main/Qwen3.5-4B-UD-Q5_K_XL.gguf?download=true",
    sizeRank: 2,
    // VRAM note, peak measured at -c 131072 on Vulkan with the default
    // speculation and q8_0 KV: 6,183 MiB, versus 2,750 MiB for the 2B. We keep
    // nGpuLayers:99 (full offload) and lean on the existing Vulkan→CPU
    // fallback if the GPU can't allocate.
    blurb: "Smarter. ~3.3 GB. Default when the GPU has room; ships MTP self-draft heads.",
    // MTP build, same as the 2B — packed draft heads, so self-draft
    // speculation is available on both models.
    specType: "draft-mtp",
    vramMib: { mtp: 6183, noMtp: 5542 },
    specDraftNMax: 3,
    cpuCapable: false,
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
// GPU detection + first-run model choice.
//
// Everywhere else GPU handling is REACTIVE: ask for full offload, and fall back
// to CPU if Vulkan init fails (see start()). That is the right behaviour for a
// model already on disk, but it cannot help the one decision made before any
// download exists — which model to fetch in the first place. A 1.3 GB download
// onto a 16 GB GPU wastes the hardware; a 3.3 GB one onto a 4 GB GPU spends
// twenty minutes downloading a model that will crawl on the CPU.
// ---------------------------------------------------------------------------

export interface GpuInfo {
  name: string;
  totalMiB: number;
  freeMiB: number;
}

/** `Vulkan0: NVIDIA GeForce RTX 5060 Ti (15962 MiB, 15194 MiB free)` */
const DEVICE_LINE_RE = /^\s*\S+:\s*(.+?)\s*\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)\s*$/;

/** Parse `llama-server --list-devices` output. Exported for tests, which must
 *  be able to exercise the policy without a GPU present. */
export function parseDeviceList(stdout: string): GpuInfo[] {
  const out: GpuInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = DEVICE_LINE_RE.exec(line);
    if (m) out.push({ name: m[1]!, totalMiB: Number(m[2]), freeMiB: Number(m[3]) });
  }
  return out;
}

let gpuCache: GpuInfo | null | undefined;

/**
 * Ask llama.cpp itself what it can see. The runtime that has to allocate the
 * memory is the authority — no vendor SDKs, no WMI, and no divergence between
 * what we probe and what actually loads.
 *
 * Returns the largest device by free VRAM, or null when there is no GPU, the
 * binary is missing, or the probe fails for any reason. Cached for the process
 * lifetime: it costs a subprocess and the answer does not change usefully.
 */
export function detectGpu(binPath = findInstalledLlamaServer()): GpuInfo | null {
  if (gpuCache !== undefined) return gpuCache;
  if (!binPath) return (gpuCache = null);
  try {
    const res = spawnSync(binPath, ["--list-devices"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    const devices = parseDeviceList(`${res.stdout ?? ""}\n${res.stderr ?? ""}`);
    gpuCache = devices.length === 0
      ? null
      : devices.reduce((a, b) => (b.freeMiB > a.freeMiB ? b : a));
  } catch {
    gpuCache = null;
  }
  return gpuCache;
}

/** Test seam: drop the memoized probe result. */
export function resetGpuCache(): void {
  gpuCache = undefined;
}

/** Free VRAM at or above which the 4B is the better default.
 *
 *  MEASURED, not estimated (RTX 5060 Ti, Vulkan, -c 131072, -ngl 99, -fa on,
 *  q8_0 KV), as a peak sampled across load and generation: the 4B holds
 *  6,183 MiB of dedicated VRAM and the 2B holds 2,750 MiB.
 *
 *  This bar was 10 GB when the KV cache was f16 and the 4B needed 8,351 MiB.
 *  Switching the cache to q8_0 took 2.2 GB off that number at no speed cost
 *  (it is in fact slightly faster), which moves the 4B from "needs a 12 GB
 *  card" to "fits an 8 GB card" — the single biggest reach improvement in this
 *  file. 7 GB leaves ~0.8 GB over the measured peak for the desktop
 *  compositor, the browser running this very app, and allocator slack. */
export const GPU_VRAM_MIB_FOR_LARGE_MODEL = 7 * 1024;

/** Draft length for the CPU path. Measured on the 2B with no GPU: speculation
 *  off 17.6 tok/s, n=2 23.8 tok/s (1.35x), n=8 15.9 tok/s (SLOWER than off).
 *  The GPU optimum for the same model is 8, so this is not a smaller version of
 *  the same curve — without a GPU the verify batch is pure CPU work and depth
 *  stops paying almost immediately. */
export const CPU_SPEC_DRAFT_N_MAX = 2;

/** Free VRAM we insist on keeping above a model's measured peak before turning
 *  MTP on. Allocation is not the only claimant — the desktop compositor and the
 *  browser running this very app grow and shrink underneath us — and an
 *  allocation failure costs a fall back to CPU, which is far more expensive
 *  than the speculation was worth. */
export const VRAM_HEADROOM_MIB = 512;

export interface SpeculationChoice {
  specType: NonNullable<LlamaProfile["specType"]>;
  specDraftNMax: number;
  /** Why, for the launch log and the setup UI. */
  reason: string;
}

/**
 * Decide whether MTP speculation fits, given a GPU reading.
 *
 * Speculation is not free memory-wise: it allocates a KV cache for the model's
 * extra nextn attention layer, measured under the shipping q8_0 cache at
 * +373 MiB on the 2B and +641 MiB on the 4B (it was +490/+878 at f16).
 * On a GPU with room that buys 1.42x/1.45x generation speed. On a GPU
 * without room it buys an OOM and a fall back to CPU. So the same knob is a
 * throughput dial above the line and a memory lever below it.
 *
 * Pure — the caller supplies the reading — so the policy is unit-testable on
 * any machine.
 */
export function speculationFor(
  spec: ModelSpec,
  gpu: GpuInfo | null,
): SpeculationChoice {
  if (spec.specType === "none") {
    return { specType: "none", specDraftNMax: 0, reason: "this build has no draft heads" };
  }
  if (!gpu) {
    // No GPU means the CPU path, where start() forces specType none anyway.
    // Saying so here keeps the profile honest rather than relying on that.
    return { specType: "none", specDraftNMax: 0, reason: "no GPU detected" };
  }
  const needed = spec.vramMib.mtp + VRAM_HEADROOM_MIB;
  if (gpu.freeMiB < needed) {
    return {
      specType: "none",
      specDraftNMax: 0,
      reason:
        `${(gpu.freeMiB / 1024).toFixed(1)} GB free is under the ` +
        `${(needed / 1024).toFixed(1)} GB ${spec.label} needs for MTP — running without ` +
        `speculation, which fits in ${(spec.vramMib.noMtp / 1024).toFixed(1)} GB`,
    };
  }
  return {
    specType: spec.specType,
    specDraftNMax: spec.specDraftNMax,
    reason: `${(gpu.freeMiB / 1024).toFixed(1)} GB free — MTP speculation on at draft length ${spec.specDraftNMax}`,
  };
}

// ---------------------------------------------------------------------------
// Degradation ladder.
//
// speculationFor() picks a tier from a VRAM reading BEFORE launching, which
// handles the predictable cases. It cannot handle the unpredictable one: the
// reading is a snapshot, and between the probe and the allocation a game, a
// second browser, or another model can take the memory. Then llama-server dies
// with an allocation error and — until now — the user got a dead assistant and
// a stderr tail.
//
// So allocation failure is treated as a signal rather than an outcome: step
// down one rung and try again, telling the user what changed and why. The rungs
// are ordered by what they cost the user, cheapest concession first:
//
//   1. same model, speculation off   -373/-641 MiB, ~30% slower, SAME answers
//   2. smaller model, speculation on  -3.4 GB, faster, but a weaker model
//   3. smaller model, speculation off
//   4. CPU                            no VRAM at all, ~10x slower again
//
// Rung 1 before rung 2 is the deliberate part: speculation is a pure speed
// knob, so giving it up changes nothing about what the assistant says, while
// dropping to a smaller model changes every answer it gives. Trade speed before
// quality.
// ---------------------------------------------------------------------------

/** One rung: a profile to try and a short phrase naming what it costs. */
export interface LadderStep {
  profile: LlamaProfile;
  /** Human-readable tier name, e.g. "Qwen 3.5 2B without speculation". */
  label: string;
}

/** Default presence test — is this model's GGUF on disk? Injectable so the
 *  ladder can be unit-tested without multi-GB files. */
export type PresenceFn = (spec: ModelSpec) => boolean;

const defaultPresence: PresenceFn = (spec) => existsSync(modelPathFor(spec));

/** The model the CPU rung should run: the largest present model that is usable
 *  without a GPU. Null when the user has none of them downloaded — the caller
 *  must then ask them to install one rather than launching something that will
 *  take minutes per reply. */
export function cpuFallbackModel(isPresent: PresenceFn = defaultPresence): ModelSpec | null {
  const usable = MODEL_REGISTRY.filter((m) => m.cpuCapable && isPresent(m));
  if (usable.length === 0) return null;
  return usable.reduce((a, b) => (b.sizeRank > a.sizeRank ? b : a));
}

/** Turn a profile into its CPU-path equivalent on `spec`.
 *
 *  Two knobs must move with nGpuLayers, or the CPU path is quietly misconfigured:
 *  nThreads (4 is right for a host-side prelude, wrong when every matmul runs on
 *  the CPU) and the draft length (the GPU optimum of 8 is SLOWER than no
 *  speculation at all here — see CPU_SPEC_DRAFT_N_MAX). */
export function cpuProfileFor(profile: LlamaProfile, spec: ModelSpec): LlamaProfile {
  return {
    ...profile,
    modelPath: modelPathFor(spec),
    nGpuLayers: 0,
    nThreads: cpus().length,
    specType: spec.specType,
    specDraftNMax: CPU_SPEC_DRAFT_N_MAX,
  };
}

/**
 * The rungs below `profile`, in the order they should be tried. Pure: presence
 * is injected, so the whole policy is testable on a machine with no GGUFs and
 * no GPU.
 *
 * Returns [] when there is nothing left to try — the caller reports the
 * original failure, plus (via cpuFallbackModel returning null) an offer to
 * install a CPU-capable model.
 */
export function degradationLadder(
  profile: LlamaProfile,
  isPresent: PresenceFn = defaultPresence,
): LadderStep[] {
  const steps: LadderStep[] = [];
  const current = MODEL_REGISTRY.find((m) => profile.modelPath.endsWith(m.fileName));
  const onGpu = profile.nGpuLayers > 0;
  const speculating = Boolean(profile.specType && profile.specType !== "none");

  if (onGpu && speculating) {
    steps.push({
      profile: { ...profile, specType: "none", specDraftNMax: 0 },
      label: `${current?.label ?? "the model"} without speculation`,
    });
  }

  if (onGpu && current) {
    const smaller = MODEL_REGISTRY.filter(
      (m) => m.sizeRank < current.sizeRank && isPresent(m),
    ).sort((a, b) => b.sizeRank - a.sizeRank);
    for (const spec of smaller) {
      const base: LlamaProfile = { ...profile, modelPath: modelPathFor(spec) };
      if (spec.specType !== "none") {
        steps.push({
          profile: { ...base, specType: spec.specType, specDraftNMax: spec.specDraftNMax },
          label: spec.label,
        });
      }
      steps.push({
        profile: { ...base, specType: "none", specDraftNMax: 0 },
        label: `${spec.label} without speculation`,
      });
    }
  }

  const cpuSpec = cpuFallbackModel(isPresent);
  if (cpuSpec && !(profile.nGpuLayers === 0 && profile.modelPath.endsWith(cpuSpec.fileName))) {
    steps.push({
      profile: cpuProfileFor(profile, cpuSpec),
      label: `${cpuSpec.label} on the CPU`,
    });
  }
  return steps;
}

/** Name the tier a profile represents, for warning text: "Qwen 3.5 4B with
 *  speculation", "Qwen 3.5 2B on the CPU". */
export function describeProfile(profile: LlamaProfile): string {
  const spec = MODEL_REGISTRY.find((m) => profile.modelPath.endsWith(m.fileName));
  const name = spec?.label ?? "the model";
  if (profile.nGpuLayers === 0) return `${name} on the CPU`;
  return profile.specType && profile.specType !== "none"
    ? `${name} with speculation`
    : `${name}`;
}

/**
 * Something the user can do about the current state, surfaced on /status so the
 * UI can render a button instead of a paragraph of stderr.
 *
 * Only one kind so far: the assistant needs a model that runs without a GPU and
 * none is downloaded. We deliberately do NOT start that download ourselves —
 * it happens at the exact moment the user's GPU just failed, and spending a
 * gigabyte of their bandwidth without asking is the wrong default.
 */
export interface LauncherAction {
  kind: "install-model";
  modelId: string;
  label: string;
  message: string;
}

/** Build the install-a-CPU-model prompt. Exported so the message is asserted in
 *  tests rather than duplicated as a string literal. */
export function installCpuModelAction(reason: string): LauncherAction | null {
  const spec = MODEL_REGISTRY.filter((m) => m.cpuCapable).sort(
    (a, b) => a.sizeRank - b.sizeRank,
  )[0];
  if (!spec) return null;
  return {
    kind: "install-model",
    modelId: spec.id,
    label: spec.label,
    message:
      `${reason} The models on this machine all need a GPU. ` +
      `Install ${spec.label} to run the assistant on the CPU instead — slower ` +
      `(around 24 tokens/sec), but it works with no GPU at all.`,
  };
}

export interface SetupModelChoice {
  modelId: string;
  /** Human-readable justification, shown on /setup. */
  reason: string;
}

/**
 * Which model first-time setup should download. Pure: the caller supplies the
 * GPU reading, so the policy is testable on any machine.
 */
export function chooseSetupModel(gpu: GpuInfo | null): SetupModelChoice {
  const large = MODEL_REGISTRY.reduce((a, b) => (b.sizeRank > a.sizeRank ? b : a));
  const small = MODEL_REGISTRY.reduce((a, b) => (b.sizeRank < a.sizeRank ? b : a));
  if (!gpu) {
    return { modelId: small.id, reason: "No GPU detected — using the lighter model for CPU." };
  }
  if (gpu.freeMiB >= GPU_VRAM_MIB_FOR_LARGE_MODEL) {
    return {
      modelId: large.id,
      reason: `Detected ${gpu.name}, ${(gpu.freeMiB / 1024).toFixed(1)} GB free — enough for ${large.label}.`,
    };
  }
  return {
    modelId: small.id,
    reason: `Detected ${gpu.name}, ${(gpu.freeMiB / 1024).toFixed(1)} GB free — not enough headroom for ${large.label} at full context, so using ${small.label}.`,
  };
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
  /** `--cache-type-k` / `--cache-type-v`: precision of the KV cache. f16 is
   *  llama-server's default; q8_0 halves it. At 128k the cache is the single
   *  largest allocation (bigger than the weights), so this is the biggest VRAM
   *  lever we have that does not cut context. Applied to the draft context too
   *  (`-ctkd`/`-ctvd`) — leaving the MTP layer at f16 would keep a chunk of the
   *  saving on the table. */
  cacheType?: "f16" | "q8_0" | "q4_0";
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
    // Tool calling REQUIRES the Jinja chat-template path: without --jinja
    // llama-server uses its legacy formatter, which emits no tool_calls and
    // silently degrades every /api/chat turn to plain prose. Current builds
    // default to Jinja, but the binary intentionally floats on "latest"
    // releases (llama_updater), so a default flip upstream would break tool
    // calls with no signal. Pin it.
    "--jinja",
    // "auto" is today's llama-server default, pinned explicitly for the same
    // reason. think_filter.ts tolerates both reasoning shapes (inline
    // <think> blocks and a separate reasoning_content field), so this is a
    // stability pin rather than a behavior change.
    "--reasoning-format", "auto",
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
    // --mlock is NOT passed on Windows. llama-server aborts on startup with
    //   llama-mmap.cpp:744: GGML_ASSERT(addr) failed
    // whenever it is set, regardless of context size or free RAM (reproduced at
    // 8k and 128k with 27 GB free). Locking pages needs a privilege the process
    // does not hold, and llama.cpp asserts rather than degrading. Since this
    // block only runs on the CPU-fallback path, passing it meant the fallback —
    // our safety net for a GPU that will not initialise — crashed 100% of the
    // time on the platform this app primarily targets.
    if (profile.useMlock && process.platform !== "win32") args.push("--mlock");
  }
  if (profile.cacheType && profile.cacheType !== "f16") {
    args.push("-ctk", profile.cacheType, "-ctv", profile.cacheType);
    // The draft context keeps its own cache; it defaults to f16 independently.
    if (profile.specType && profile.specType !== "none") {
      args.push("-ctkd", profile.cacheType, "-ctvd", profile.cacheType);
    }
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
  /** Which model GGUFs count as downloaded, for the degradation ladder.
   *  Defaults to a real on-disk check; tests inject presence so the fallback
   *  policy can be exercised without multi-GB files. */
  modelPresent?: PresenceFn;
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
  /** A user-actionable next step when the launcher cannot recover on its own
   *  (currently: no CPU-capable model downloaded). Cleared on any ready launch. */
  private action: LauncherAction | null = null;

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
    action: LauncherAction | null;
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
      action: this.action,
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
      this.action = null;
      return attempt;
    }

    // The attempt failed. Two failures are recoverable, and they need
    // different responses:
    //
    //   - Backend init failed: there is no usable GPU at all, so no GPU rung
    //     can help. Go straight to the CPU rung.
    //   - Allocation failed: the GPU works but is full right now. Walk the
    //     whole ladder, which usually lands one rung down and STILL on the GPU.
    //
    // Anything else (bad flag, corrupt GGUF, missing file) is not a memory
    // problem and retrying a smaller model would only obscure it, so it is
    // reported as-is.
    //
    // Order matters, and not for a subtle reason. A real allocation failure
    // prints this, verbatim, on Vulkan:
    //
    //   ggml_vulkan: Device memory allocation of size 1632174080 failed.
    //   ggml_vulkan: vk::Device::allocateMemory: ErrorOutOfDeviceMemory
    //
    // The second line ALSO satisfies isVulkanInitFailure's "ggml_vulkan.*error"
    // pattern, because "ErrorOutOfDeviceMemory" contains "error". Testing the
    // backend first would therefore classify every genuine OOM as "no GPU" and
    // skip straight to the CPU — throwing away the GPU rungs that would have
    // worked. Out-of-memory wins the tie.
    const errorTail = attempt.errorTail ?? "";
    const onGpu = profile.nGpuLayers > 0;
    const outOfMemory = isOutOfMemoryFailure(errorTail);
    const backendFailed = !outOfMemory && onGpu && isVulkanInitFailure(errorTail);
    if (!backendFailed && !outOfMemory) return attempt;

    const cause = backendFailed
      ? `Vulkan unavailable (${extractBackendFailureReason(errorTail)}).`
      : `Not enough memory to load ${describeProfile(profile)}.`;

    // On a backend failure the GPU rungs are pointless — filter the ladder down
    // to the CPU rung. On an allocation failure keep all of it.
    const ladder = degradationLadder(profile, this.opts.modelPresent).filter(
      (step) => !backendFailed || step.profile.nGpuLayers === 0,
    );

    for (const step of ladder) {
      // eslint-disable-next-line no-console
      console.warn(`[llama-launcher] ${cause} Falling back to ${step.label}.`);
      const next = await this.attemptStart(bin, step.profile);
      if (next.status !== "ready") continue;
      this.profile = step.profile;
      this.backendMode = step.profile.nGpuLayers > 0 ? "vulkan" : "cpu-fallback";
      this.backendWarning = `${cause} Running ${step.label} instead.`;
      this.action = null;
      return next;
    }

    // Ladder exhausted (or empty). If the reason we have no CPU rung is that no
    // CPU-capable model is downloaded, say so and offer the install — that is
    // the difference between "your assistant is broken" and one button.
    this.status = "error";
    if (cpuFallbackModel(this.opts.modelPresent) === null) {
      this.action = installCpuModelAction(cause);
      if (this.action) this.lastError = this.action.message;
    } else {
      this.lastError = `${cause} ${attempt.errorTail ?? ""}`.trim();
    }
    this.backendWarning = null;
    return { ...attempt, status: "error", errorTail: this.lastError ?? undefined };
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
      // another caller (or the process 'exit' handler above) may have set
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
    return this.start(profile ?? this.profile ?? launchProfile());
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
 * - `specDraftNMax: 2` — measured optimum, not a guess (see the table at the
 *   value itself). The prior reasoning for 1 — that Qwen3.5's hybrid
 *   Transformer + SSM layers would not speculate cleanly on Vulkan — was
 *   directionally right but one step too cautious: 2 beats 1 on both models
 *   (4B 1.44x vs 1.28x over speculation off), and only from 3 upward does the
 *   falling accept rate stop paying for the extra draft compute.
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
export function defaultProfile(
  modelId?: string,
  /** GPU reading used to decide whether MTP speculation fits. Explicit rather
   *  than probed here so the function stays pure and testable; production goes
   *  through launchProfile(), which probes. Omitting it keeps speculation at
   *  the model's declared default. */
  gpu?: GpuInfo | null,
): LlamaProfile {
  const spec = (modelId && modelById(modelId)) || MODEL_REGISTRY[0]!;
  const speculation =
    gpu === undefined
      ? { specType: spec.specType, specDraftNMax: spec.specDraftNMax }
      : speculationFor(spec, gpu);
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
    // instructions + workspace summary + the FULL tool registry (~5-7k tokens
    // of name/description/input-schema serialized by Qwen's chat template every
    // turn) — and we want generous room for long multi-turn sessions.
    //
    // 128k is affordable here only because qwen35 is a HYBRID: full attention
    // runs every 4th layer (full_attention_interval=4) and the rest are SSM
    // layers whose state is constant in context length. Only the attention
    // layers hold a KV cache, so at 128k f16 that is 1.75 GiB on the 2B (7 such
    // layers, incl. the MTP layer) and 4.5 GiB on the 4B (9). A dense model of
    // the same depth would want ~16 GiB and simply would not fit. On VRAM-tight
    // machines allocation can still fail and fall back to CPU (slow) — watch
    // the launch log for a KV-alloc / OOM failure and dial back if so.
    // Qwen3.5's native context (262144) comfortably exceeds 128k.
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
    // q8_0 KV cache. At 128k the cache outweighs the weights, so halving its
    // precision is the largest VRAM saving available that does not cut context:
    //   4B   8,351 -> 6,183 MiB  (-2,168)
    //   2B   3,590 -> 2,750 MiB    (-840)
    //
    // And it is FREE. Measured 4 prompts x 3 reps per cell (n=12), f16 vs q8_0,
    // speculation on and off, as q8/f16 throughput ratios:
    //   2B  spec-off 1.04x   spec-on 1.04x
    //   4B  spec-off 0.98x   spec-on 0.99x
    // No consistent direction and nothing outside run-to-run noise. Draft
    // acceptance is unchanged too (2B 69.3% -> 67.7%, 4B 75.1% -> 74.4%), which
    // says the quantized cache is not measurably perturbing the model's own
    // predictions — the dequant cost and the bandwidth saving cancel.
    //
    // (An earlier n=4 run suggested the 2B lost 16% here. That did not survive
    // more samples; do not re-derive the setting from small runs.)
    cacheType: "q8_0",
    useMmap: false,
    useMlock: true,
    // Per-model: both registry builds are MTP GGUFs and self-draft via packed
    // MTP heads (the extra nextn layer is the last block in each file). Whether
    // speculation is actually ON also depends on free VRAM — see speculationFor.
    specType: speculation.specType,
    // Per-model (spec.specDraftNMax). MEASURED under this exact config — q8_0
    // KV, 128k — as interleaved A/B blocks rather than one ascending sweep,
    // because an ascending sweep confounds the setting with anything that
    // drifts over a session. Medians of 12 samples per block, tok/s:
    //
    //   4B   off 94.9 | n2 133.7 | n3 137.7 | n6 101.3        -> peak 3 (1.45x)
    //   2B   off  187 | n2 210.5 | n6 262.8 | n8 265.8
    //                 | n12 261.0 | n16 189.4                 -> peak 8 (1.42x)
    //
    // The two models want wildly different depths, which is why this moved onto
    // the registry entry. The 4B's verify batch is expensive enough that depth
    // stops paying at 3; the 2B is cheap enough per pass to keep winning out to
    // a plateau around 6-12. Both collapse once the accept rate craters (2B at
    // n16: 33.7%).
    //
    // Two traps recorded so the next person does not re-learn them: an earlier
    // f16 sweep put both models at 2, so this MUST be re-measured if the KV
    // type changes; and 0 is not a legal value — llama-server exits at startup,
    // so "off" is specType "none".
    specDraftNMax: speculation.specDraftNMax,
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

/**
 * The profile production actually launches with: defaultProfile plus a real GPU
 * reading, so a VRAM-tight machine runs without speculation instead of failing
 * to allocate and falling all the way back to CPU.
 */
export function launchProfile(modelId?: string): LlamaProfile {
  return defaultProfile(modelId, detectGpu());
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

/**
 * Heuristic: did the launch fail because something could not be ALLOCATED?
 *
 * Distinct from isVulkanInitFailure on purpose. That one means "there is no
 * usable GPU", and the only sane response is the CPU. This one means "the GPU
 * is fine, it just does not have room right now", and the response is to step
 * down one rung of the ladder — which usually still lands on the GPU.
 *
 * Covers the three places llama.cpp reports it: the backend allocator, the KV
 * cache init, and the raw Vulkan/CUDA driver error underneath both.
 */
export function isOutOfMemoryFailure(stderr: string): boolean {
  if (!stderr) return false;
  const s = stderr.toLowerCase();
  const hits = [
    /out\s+of\s+(device\s+|host\s+)?memory/,
    /erroroutofdevicememory/,
    /erroroutofhostmemory/,
    /vk_error_out_of_\w+_memory/,
    /failed\s+to\s+allocate/,
    /allocation\s+of\s+size\s+\d+\s+failed/,
    /unable\s+to\s+allocate/,
    /cannot\s+allocate/,
    /failed\s+to\s+reserve\s+(a\s+)?buffer/,
    /ggml_backend_\w*alloc\w*.*fail/,
    /kv[\s_-]?cache.*(failed|could\s+not).*(alloc|creat)/,
    /(failed|could\s+not).*alloc.*kv[\s_-]?cache/,
    /insufficient\s+(device\s+)?memory/,
    /cudamalloc\s+failed/,
    /std::bad_alloc/,
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
