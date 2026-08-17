// Degradation ladder: what happens when a launch fails for want of memory.
//
// Two halves. The first exercises the policy as pure functions (no GPU, no
// GGUFs, no subprocess). The second drives the real launcher with a spawn stub
// that fails on command, because the ordering only matters if start() actually
// walks it.

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { cpus } from "node:os";
import {
  LlamaLauncher,
  MODEL_REGISTRY,
  CPU_SPEC_DRAFT_N_MAX,
  cpuFallbackModel,
  cpuProfileFor,
  degradationLadder,
  describeProfile,
  installCpuModelAction,
  isOutOfMemoryFailure,
  isVulkanInitFailure,
  defaultProfile,
  modelPathFor,
  type ModelSpec,
  type LlamaProfile,
} from "../src/services/llama_launcher.js";

const sorted = [...MODEL_REGISTRY].sort((a, b) => a.sizeRank - b.sizeRank);
const small = sorted[0]!;
const large = sorted[sorted.length - 1]!;

const presentAll = () => true;
const presentNone = () => false;
const only = (...specs: ModelSpec[]) => (s: ModelSpec) => specs.some((x) => x.id === s.id);

/** A GPU profile for `spec` with speculation on, as launchProfile would build. */
function gpuProfile(spec: ModelSpec): LlamaProfile {
  return {
    ...defaultProfile(spec.id),
    modelPath: modelPathFor(spec),
    nGpuLayers: 99,
    specType: spec.specType,
    specDraftNMax: spec.specDraftNMax,
  };
}

/**
 * Verbatim stderr from a real allocation failure: Qwen3.5-4B on Vulkan, asked
 * for a 1.5M-token context on a 16 GB card (2026-08-14). Captured rather than
 * invented, because the heuristics below are only worth anything if they match
 * what llama.cpp actually prints.
 */
const REAL_OOM_STDERR = [
  "0.02.678.576 W llama_context: n_ctx_seq (1500160) > n_ctx_train (262144) -- possible training context overflow",
  "ggml_vulkan: Device memory allocation of size 1632174080 failed.",
  "ggml_vulkan: vk::Device::allocateMemory: ErrorOutOfDeviceMemory",
  "0.05.982.175 E alloc_tensor_range: failed to allocate Vulkan0 buffer of size 1632174080",
  "0.06.650.537 E llama_init_from_model: failed to initialize the context: failed to allocate buffer for kv cache",
  "0.06.650.549 E srv    load_model: failed to create_context with model './data/models/Qwen3.5-4B-MTP-UD-Q5_K_XL.gguf'",
  "0.06.660.464 E srv  llama_server: exiting due to model loading error",
].join("\n");

describe("isOutOfMemoryFailure", () => {
  it("matches real llama.cpp output", () => {
    expect(isOutOfMemoryFailure(REAL_OOM_STDERR)).toBe(true);
  });

  it("outranks the backend-init heuristic, which the same text also trips", () => {
    // "ErrorOutOfDeviceMemory" contains "error", so ggml_vulkan.*error matches.
    // If backend-init won this tie, every genuine OOM would skip the GPU rungs
    // and drop the user straight to the CPU.
    expect(isVulkanInitFailure(REAL_OOM_STDERR)).toBe(true);
    expect(isOutOfMemoryFailure(REAL_OOM_STDERR)).toBe(true);
  });

  it("recognizes the allocator, the KV cache, and the driver", () => {
    for (const line of [
      "ggml_vulkan: Device memory allocation of size 2147483648 failed.",
      "vk::Device::allocateMemory: ErrorOutOfDeviceMemory",
      "llama_kv_cache_init: failed to allocate buffer for kv cache",
      "ggml_backend_alloc_ctx_tensors_from_buft: failed to allocate buffer",
      "cudaMalloc failed: out of memory",
      "terminate called after throwing an instance of 'std::bad_alloc'",
    ]) {
      expect(isOutOfMemoryFailure(line), line).toBe(true);
    }
  });

  it("does not fire on unrelated failures", () => {
    expect(isOutOfMemoryFailure("error: failed to open model file 'foo.gguf'")).toBe(false);
    expect(isOutOfMemoryFailure("unknown value for --flash-attn: '--jinja'")).toBe(false);
    expect(isOutOfMemoryFailure("")).toBe(false);
  });

  it("is a DIFFERENT signal from a backend-init failure", () => {
    // The distinction drives the response: no GPU at all -> jump to CPU;
    // GPU present but full -> step down one rung and stay on the GPU.
    const noDevice = "ggml_vulkan: No Vulkan devices found.";
    expect(isVulkanInitFailure(noDevice)).toBe(true);
    expect(isOutOfMemoryFailure(noDevice)).toBe(false);

    const oom = "ggml_vulkan: Device memory allocation of size 4294967296 failed.";
    expect(isOutOfMemoryFailure(oom)).toBe(true);
    expect(isVulkanInitFailure(oom)).toBe(false);
  });
});

describe("cpuFallbackModel", () => {
  it("picks the largest CPU-capable model that is downloaded", () => {
    expect(cpuFallbackModel(presentAll)?.id).toBe(small.id);
  });

  it("returns null when only GPU-only models are downloaded", () => {
    // The 4B is marked cpuCapable:false — it loads but replies would take
    // minutes, so it is not offered as a CPU fallback.
    expect(large.cpuCapable).toBe(false);
    expect(cpuFallbackModel(only(large))).toBeNull();
  });

  it("returns null when nothing is downloaded", () => {
    expect(cpuFallbackModel(presentNone)).toBeNull();
  });
});

describe("cpuProfileFor", () => {
  it("moves every knob that must move with nGpuLayers", () => {
    const p = cpuProfileFor(gpuProfile(large), small);
    expect(p.nGpuLayers).toBe(0);
    expect(p.modelPath).toBe(modelPathFor(small));
    expect(p.nThreads).toBe(cpus().length);
    // The GPU optimum for the 2B is 8, which is SLOWER than no speculation on
    // a CPU. Carrying it over would be worse than not speculating at all.
    expect(p.specDraftNMax).toBe(CPU_SPEC_DRAFT_N_MAX);
    expect(p.specType).toBe(small.specType);
  });
});

describe("degradationLadder", () => {
  it("gives up speed before it gives up model quality", () => {
    const steps = degradationLadder(gpuProfile(large), presentAll);
    // Rung 1 keeps the model and drops speculation: same answers, ~30% slower.
    expect(steps[0]!.profile.modelPath).toBe(modelPathFor(large));
    expect(steps[0]!.profile.specType).toBe("none");
    expect(steps[0]!.profile.nGpuLayers).toBe(99);
    // Only then does it change which model answers.
    expect(steps[1]!.profile.modelPath).toBe(modelPathFor(small));
    expect(steps[1]!.profile.specType).toBe(small.specType);
    expect(steps[2]!.profile.specType).toBe("none");
    // And the CPU is last.
    const last = steps[steps.length - 1]!;
    expect(last.profile.nGpuLayers).toBe(0);
    expect(last.profile.modelPath).toBe(modelPathFor(small));
  });

  it("skips models that are not downloaded", () => {
    const steps = degradationLadder(gpuProfile(large), only(large));
    // No smaller model on disk and the 4B cannot run on CPU: the only thing
    // left to try is the 4B without speculation.
    expect(steps).toHaveLength(1);
    expect(steps[0]!.profile.specType).toBe("none");
  });

  it("still offers the CPU when the small model is already the one loaded", () => {
    const steps = degradationLadder(gpuProfile(small), only(small));
    expect(steps.map((s) => s.profile.nGpuLayers)).toEqual([99, 0]);
  });

  it("does not offer the CPU rung to a profile already on the CPU", () => {
    const cpu = cpuProfileFor(gpuProfile(small), small);
    expect(degradationLadder(cpu, presentAll)).toHaveLength(0);
  });

  it("labels each rung in terms the UI can show a user", () => {
    const steps = degradationLadder(gpuProfile(large), presentAll);
    expect(steps[0]!.label).toContain(large.label);
    expect(steps[0]!.label).toMatch(/without speculation/);
    expect(steps[steps.length - 1]!.label).toMatch(/on the CPU/);
  });
});

describe("describeProfile", () => {
  it("names the tier", () => {
    expect(describeProfile(gpuProfile(large))).toBe(`${large.label} with speculation`);
    expect(describeProfile({ ...gpuProfile(large), specType: "none" })).toBe(large.label);
    expect(describeProfile(cpuProfileFor(gpuProfile(small), small))).toBe(
      `${small.label} on the CPU`,
    );
  });
});

describe("installCpuModelAction", () => {
  it("offers the smallest CPU-capable model, with the cause", () => {
    const a = installCpuModelAction("Vulkan unavailable (no device).")!;
    expect(a.kind).toBe("install-model");
    expect(a.modelId).toBe(small.id);
    expect(a.message).toContain("Vulkan unavailable");
    expect(a.message).toContain(small.label);
  });
});

// ---------------------------------------------------------------------------
// The launcher actually walking the ladder.
// ---------------------------------------------------------------------------

interface Harness {
  launcher: LlamaLauncher;
  /** Args of every spawn attempt, in order. */
  attempts: string[][];
}

/**
 * Build a launcher whose spawns fail with `stderr` until `succeedOn` says the
 * attempt should work. Failing children emit stderr and exit, which is exactly
 * how llama-server reports an allocation failure.
 */
function harness(opts: {
  stderr: string;
  succeedOn: (args: string[]) => boolean;
  present?: (spec: ModelSpec) => boolean;
}): Harness {
  const attempts: string[][] = [];
  let healthy = false;

  const spawnFn = ((_bin: string, args: string[]) => {
    attempts.push(args);
    const proc = Object.assign(new EventEmitter(), {
      pid: 4242 + attempts.length,
      killed: false,
      kill: () => true,
      stderr: new EventEmitter(),
      stdout: new EventEmitter(),
    });
    if (opts.succeedOn(args)) {
      healthy = true;
    } else {
      healthy = false;
      setTimeout(() => {
        proc.stderr.emit("data", Buffer.from(opts.stderr));
        proc.emit("exit", 1);
      }, 0);
    }
    return proc;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  const launcher = new LlamaLauncher({
    binPath: process.execPath,
    spawnFn,
    client: {
      baseUrl: "stub://",
      chat: async () => {
        throw new Error("not used");
      },
      health: async () => ({ ok: healthy, status: healthy ? 200 : 503 }),
    },
    portProbe: async () => true,
    modelPresent: opts.present ?? presentAll,
  });
  return { launcher, attempts };
}

/** Did this spawn ask for speculative decoding? */
const speculates = (args: string[]) =>
  args.includes("--spec-type") && args[args.indexOf("--spec-type") + 1] !== "none";

describe("launcher — recovery from an allocation failure", () => {
  const OOM = "ggml_vulkan: Device memory allocation of size 2147483648 failed.\n";

  it("drops speculation and keeps the model and the GPU", async () => {
    const { launcher, attempts } = harness({
      stderr: OOM,
      // Anything without speculation fits.
      succeedOn: (args) => !speculates(args),
    });
    const r = await launcher.start(gpuProfile(large));
    expect(r.status).toBe("ready");
    expect(attempts).toHaveLength(2);

    const st = launcher.getStatus();
    // Still on the GPU, still the 4B — only the speed knob was given up.
    expect(st.backendMode).toBe("vulkan");
    expect(st.backendWarning).toMatch(/Not enough memory/);
    expect(st.backendWarning).toContain(large.label);
    expect(st.action).toBeNull();
    // buildArgs omits the flag entirely rather than passing "none".
    expect(speculates(attempts[0]!)).toBe(true);
    expect(attempts[1]!).not.toContain("--spec-type");
    // Same model file, still fully offloaded.
    expect(attempts[1]!.some((a) => a.endsWith(large.fileName))).toBe(true);
    expect(attempts[1]![attempts[1]!.indexOf("-ngl") + 1]).toBe("99");
  });

  it("falls through to the smaller model when no 4B config fits", async () => {
    const { launcher, attempts } = harness({
      stderr: OOM,
      succeedOn: (args) => args.some((a) => a.endsWith(small.fileName)),
    });
    const r = await launcher.start(gpuProfile(large));
    expect(r.status).toBe("ready");

    const st = launcher.getStatus();
    expect(st.backendMode).toBe("vulkan");
    expect(st.backendWarning).toContain(small.label);
    // The winning attempt is the small model WITH speculation — the ladder does
    // not throw away speed it does not have to.
    const winner = attempts[attempts.length - 1]!;
    expect(speculates(winner)).toBe(true);
    expect(winner.some((a) => a.endsWith(small.fileName))).toBe(true);
  });

  it("lands on the CPU with the small model when nothing fits on the GPU", async () => {
    const { launcher, attempts } = harness({
      stderr: OOM,
      succeedOn: (args) => args[args.indexOf("-ngl") + 1] === "0",
    });
    const r = await launcher.start(gpuProfile(large));
    expect(r.status).toBe("ready");

    const st = launcher.getStatus();
    expect(st.backendMode).toBe("cpu-fallback");
    expect(st.backendWarning).toMatch(/on the CPU/);
    const winner = attempts[attempts.length - 1]!;
    expect(winner.some((a) => a.endsWith(small.fileName))).toBe(true);
    // The CPU-specific draft length, not the GPU one.
    expect(winner[winner.indexOf("--spec-draft-n-max") + 1]).toBe(String(CPU_SPEC_DRAFT_N_MAX));
  });

  it("offers a download instead of a stderr tail when no CPU-capable model is present", async () => {
    const { launcher } = harness({
      stderr: OOM,
      succeedOn: () => false,
      present: only(large),
    });
    const r = await launcher.start(gpuProfile(large));
    expect(r.status).toBe("error");

    const st = launcher.getStatus();
    expect(st.action).not.toBeNull();
    expect(st.action!.kind).toBe("install-model");
    expect(st.action!.modelId).toBe(small.id);
    expect(st.error).toContain(small.label);
  });

  it("walks the GPU rungs on the REAL out-of-memory stderr", async () => {
    // Regression guard for the tie above: with the real text, the launcher must
    // try "4B without speculation" before it considers the CPU.
    const { launcher, attempts } = harness({
      stderr: `${REAL_OOM_STDERR}\n`,
      succeedOn: (args) => !speculates(args),
    });
    const r = await launcher.start(gpuProfile(large));
    expect(r.status).toBe("ready");
    expect(attempts).toHaveLength(2);
    expect(launcher.getStatus().backendMode).toBe("vulkan");
    expect(attempts[1]![attempts[1]!.indexOf("-ngl") + 1]).toBe("99");
  });

  it("does not walk the ladder for a failure that is not about memory", async () => {
    const { launcher, attempts } = harness({
      stderr: "error: failed to open model file 'foo.gguf'\n",
      succeedOn: () => false,
    });
    const r = await launcher.start(gpuProfile(large));
    expect(r.status).toBe("error");
    // Exactly one attempt: retrying a smaller model would only hide the real
    // problem behind a slower assistant.
    expect(attempts).toHaveLength(1);
    expect(launcher.getStatus().action).toBeNull();
  });
});

describe("launcher — recovery from a backend-init failure", () => {
  const NO_GPU = "ggml_vulkan: No Vulkan devices found.\n";

  it("skips the GPU rungs entirely and goes to the CPU", async () => {
    const { launcher, attempts } = harness({
      stderr: NO_GPU,
      succeedOn: (args) => args[args.indexOf("-ngl") + 1] === "0",
    });
    const r = await launcher.start(gpuProfile(large));
    expect(r.status).toBe("ready");
    // No point trying "4B without speculation" when there is no GPU at all:
    // the original attempt, then straight to the CPU.
    expect(attempts).toHaveLength(2);
    expect(attempts[1]![attempts[1]!.indexOf("-ngl") + 1]).toBe("0");

    const st = launcher.getStatus();
    expect(st.backendMode).toBe("cpu-fallback");
    expect(st.backendWarning).toMatch(/Vulkan unavailable/);
  });

  it("swaps the GPU-only model for the CPU-capable one", async () => {
    const { launcher, attempts } = harness({
      stderr: NO_GPU,
      succeedOn: (args) => args[args.indexOf("-ngl") + 1] === "0",
    });
    await launcher.start(gpuProfile(large));
    // The 4B was loaded; the CPU rung must NOT keep it (minutes per reply).
    const winner = attempts[attempts.length - 1]!;
    expect(winner.some((a) => a.endsWith(small.fileName))).toBe(true);
    expect(winner.some((a) => a.endsWith(large.fileName))).toBe(false);
  });

  it("asks the user to install the CPU model when there is no GPU and no 2B", async () => {
    const { launcher } = harness({
      stderr: NO_GPU,
      succeedOn: () => false,
      present: only(large),
    });
    const r = await launcher.start(gpuProfile(large));
    expect(r.status).toBe("error");
    const action = launcher.getStatus().action!;
    expect(action.modelId).toBe(small.id);
    expect(action.message).toMatch(/Vulkan unavailable/);
    expect(action.message).toMatch(/CPU/);
  });
});
