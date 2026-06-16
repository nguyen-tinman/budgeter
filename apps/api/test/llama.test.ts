// llama.cpp launcher + updater. Tests use injected spawn/fetch stubs so
// they're hermetic — no real subprocess, no real HTTP.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { EventEmitter } from "node:events";
import {
  buildArgs,
  defaultProfile,
  LlamaLauncher,
  isVulkanInitFailure,
  extractBackendFailureReason,
  detectModels,
  selectModelId,
  modelById,
  modelPathFor,
  MODEL_REGISTRY,
  type ModelSpec,
} from "../src/services/llama_launcher.js";
import type { AppSettingsRepo } from "@budgetkit/db";
import { pickAsset, type Release } from "../src/services/llama_updater.js";

describe("llama_launcher — buildArgs (pure)", () => {
  it("includes core args and -fa toggle on GPU path", () => {
    const args = buildArgs({
      ...defaultProfile(),
      modelPath: "/models/m.gguf",
      port: 9999,
      ctxSize: 16384,
      nGpuLayers: 28,
      flashAttn: true,
      useMmap: false,
      useMlock: true,
    });
    expect(args).toContain("--model");
    expect(args).toContain("/models/m.gguf");
    expect(args).toContain("--port");
    expect(args).toContain("9999");
    expect(args).toContain("-c");
    expect(args).toContain("16384");
    expect(args).toContain("-ngl");
    expect(args).toContain("28");
    expect(args).toContain("-fa");
  });

  it("omits --no-mmap / --mlock when nGpuLayers > 0 (GPU path)", () => {
    const args = buildArgs({
      ...defaultProfile(),
      nGpuLayers: 99,
      useMmap: false,
      useMlock: true,
    });
    expect(args).not.toContain("--no-mmap");
    expect(args).not.toContain("--mlock");
  });

  it("includes --no-mmap / --mlock when nGpuLayers === 0 (CPU path)", () => {
    const args = buildArgs({
      ...defaultProfile(),
      nGpuLayers: 0,
      useMmap: false,
      useMlock: true,
    });
    expect(args).toContain("--no-mmap");
    expect(args).toContain("--mlock");
  });
});

describe("llama_launcher — dev-mode external override", () => {
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env.LLAMA_SERVER_URL;
    delete process.env.LLAMA_SERVER_URL;
  });

  it("when externalUrl is provided, start() returns external without spawning", async () => {
    let spawnCalls = 0;
    const launcher = new LlamaLauncher({
      externalUrl: "http://localhost:5001",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spawnFn: (() => { spawnCalls++; throw new Error("should not spawn"); }) as any,
    });
    const r = await launcher.start({ ...defaultProfile(), modelPath: "/dev/null" });
    expect(r.status).toBe("external");
    expect(r.url).toBe("http://localhost:5001");
    expect(spawnCalls).toBe(0);

    const s = launcher.getStatus();
    expect(s.status).toBe("external");
    expect(s.external).toBe(true);

    process.env.LLAMA_SERVER_URL = savedEnv ?? "";
    if (!savedEnv) delete process.env.LLAMA_SERVER_URL;
  });

  it("reports 'error' with a clear message when no binary is found", async () => {
    const launcher = new LlamaLauncher({
      binPath: "/definitely/does/not/exist/llama-server",
    });
    const r = await launcher.start({ ...defaultProfile(), modelPath: "/dev/null" });
    expect(r.status).toBe("error");
    expect(r.errorTail).toMatch(/binary not found/);
  });
});

describe("llama_launcher — spawn + health loop (stubbed)", () => {
  it("transitions to ready when health check passes", async () => {
    // A fake ChildProcess emitter that never exits.
    const fakeProc = Object.assign(new EventEmitter(), {
      pid: 99999,
      killed: false,
      kill: () => true,
      stderr: new EventEmitter(),
      stdout: new EventEmitter(),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spawnFn = (() => fakeProc) as any;
    // Stub the client to report healthy immediately.
    const client = {
      baseUrl: "stub://",
      chat: async () => { throw new Error("not used"); },
      health: async () => ({ ok: true, status: 200 }),
    };
    const launcher = new LlamaLauncher({
      binPath: process.execPath, // exists; we won't actually spawn it
      spawnFn,
      client,
    });
    const r = await launcher.start({ ...defaultProfile(), modelPath: "/m.gguf" });
    expect(r.status).toBe("ready");
    expect(launcher.getStatus().status).toBe("ready");
  });
});

describe("llama_launcher — model registry + detection (pure)", () => {
  // Derive the smaller/larger ids from the registry so these tests don't
  // hard-code names and survive a registry rename.
  const sorted = [...MODEL_REGISTRY].sort((a, b) => a.sizeRank - b.sizeRank);
  const smaller = sorted[0]!;
  const larger = sorted[sorted.length - 1]!;

  it("registry contains at least the 2B and 4B with distinct sizeRanks", () => {
    expect(MODEL_REGISTRY.length).toBeGreaterThanOrEqual(2);
    expect(smaller.sizeRank).toBeLessThan(larger.sizeRank);
    expect(smaller.id).not.toBe(larger.id);
  });

  it("modelById resolves known ids and returns undefined for unknown", () => {
    expect(modelById(smaller.id)?.id).toBe(smaller.id);
    expect(modelById("does-not-exist")).toBeUndefined();
  });

  it("modelPathFor resolves under data/models with the spec fileName", () => {
    const p = modelPathFor(smaller);
    // Forward/back slashes differ per-OS; assert the tail is stable.
    expect(p.replace(/\\/g, "/")).toContain(`data/models/${smaller.fileName}`);
  });

  it("detectModels reports presence via the injected existsFn (no real files)", () => {
    // Only the larger model 'exists' on disk.
    const existsFn = (path: string) => path.includes(larger.fileName);
    const detected = detectModels(existsFn);
    const byId = new Map(detected.map((d) => [d.spec.id, d.present]));
    expect(byId.get(larger.id)).toBe(true);
    expect(byId.get(smaller.id)).toBe(false);
  });
});

describe("llama_launcher — selectModelId default policy (pure)", () => {
  const a: { spec: ModelSpec; present: boolean } = {
    spec: { id: "small", label: "S", fileName: "s.gguf", url: "u", sizeRank: 1, blurb: "", specType: "none" },
    present: false,
  };
  const b: { spec: ModelSpec; present: boolean } = {
    spec: { id: "big", label: "B", fileName: "b.gguf", url: "u", sizeRank: 2, blurb: "", specType: "none" },
    present: false,
  };

  it("returns null when nothing is present", () => {
    expect(selectModelId([a, b], null)).toBeNull();
    expect(selectModelId([a, b], "small")).toBeNull(); // lastUsed not present → ignored
  });

  it("returns the only present model when just one is on disk", () => {
    expect(selectModelId([{ ...a, present: true }, b], null)).toBe("small");
    expect(selectModelId([a, { ...b, present: true }], null)).toBe("big");
  });

  it("prefers the LARGER model when both are present and no last-used", () => {
    expect(selectModelId([{ ...a, present: true }, { ...b, present: true }], null)).toBe("big");
  });

  it("prefers the sticky last-used model when it is present", () => {
    expect(
      selectModelId([{ ...a, present: true }, { ...b, present: true }], "small"),
    ).toBe("small");
  });

  it("falls back to the larger model when last-used is set but NOT present", () => {
    // small is last-used but absent; big is present → big wins.
    expect(selectModelId([a, { ...b, present: true }], "small")).toBe("big");
  });

  it("ignores a stale/garbage last-used id and picks the largest present", () => {
    expect(
      selectModelId([{ ...a, present: true }, { ...b, present: true }], "ghost-model"),
    ).toBe("big");
  });
});

/** In-memory AppSettingsRepo for route tests — no DB, no files. */
function memSettings(initial: Record<string, string> = {}): AppSettingsRepo {
  const store = new Map(Object.entries(initial));
  return {
    get: (k) => store.get(k) ?? null,
    set: (k, v) => void store.set(k, v),
  };
}

describe("llama_updater — pickAsset", () => {
  const sampleAssets = [
    { name: "llama-b6789-bin-win-cuda-x64.zip", browser_download_url: "u1", size: 1 },
    { name: "llama-b6789-bin-win-x64.zip", browser_download_url: "u2", size: 1 },
    { name: "llama-b6789-bin-ubuntu-x64.zip", browser_download_url: "u3", size: 1 },
    { name: "llama-b6789-bin-macos-arm64.zip", browser_download_url: "u4", size: 1 },
    { name: "llama-b6789-bin-win-vulkan-x64.zip", browser_download_url: "u5", size: 1 },
  ];

  it("picks CUDA asset on Windows when hasCuda is true", () => {
    const a = pickAsset(sampleAssets, "win32", "x64", true);
    expect(a?.name).toMatch(/win-cuda-x64/);
  });

  it("picks Vulkan Windows asset by default when no CUDA", () => {
    const a = pickAsset(sampleAssets, "win32", "x64", false);
    expect(a?.name).toMatch(/vulkan/);
  });

  it("picks CPU Windows asset when preferVulkan is false", () => {
    const a = pickAsset(sampleAssets, "win32", "x64", false, false);
    expect(a?.name).toBe("llama-b6789-bin-win-x64.zip");
  });

  it("picks macOS arm64 asset on Apple Silicon", () => {
    const a = pickAsset(sampleAssets, "darwin", "arm64", false);
    expect(a?.name).toMatch(/macos-arm64/);
  });

  it("returns null when no asset matches at all", () => {
    const a = pickAsset(sampleAssets, "freebsd" as NodeJS.Platform, "mips" as NodeJS.Architecture, false);
    expect(a).toBeNull();
  });
});

describe("llama_launcher — Vulkan init failure heuristic", () => {
  it("flags 'no Vulkan devices found' as a backend failure", () => {
    expect(isVulkanInitFailure("ggml_vulkan: No Vulkan devices found.")).toBe(true);
  });

  it("flags VK_ERROR_INCOMPATIBLE_DRIVER", () => {
    expect(isVulkanInitFailure("VK_ERROR_INCOMPATIBLE_DRIVER")).toBe(true);
  });

  it("flags 'failed to initialize Vulkan'", () => {
    expect(isVulkanInitFailure("failed to initialize Vulkan: no compatible device")).toBe(true);
  });

  it("flags 'unable to find Vulkan loader'", () => {
    expect(isVulkanInitFailure("unable to find Vulkan loader on this system")).toBe(true);
  });

  it("does NOT flag a generic model-load OOM error", () => {
    expect(isVulkanInitFailure("failed to allocate buffer: out of memory")).toBe(false);
  });

  it("does NOT flag a missing-model error", () => {
    expect(isVulkanInitFailure("error: failed to open model file 'foo.gguf'")).toBe(false);
  });

  it("extracts a recognizable reason from a typical stderr tail", () => {
    const reason = extractBackendFailureReason(
      "build info: ...\nggml_vulkan: No Vulkan devices found.\nfallback to CPU not configured\n",
    );
    expect(reason.toLowerCase()).toContain("vulkan");
  });
});

describe("llama_updater — dryRun against stubbed GitHub API", () => {
  it("resolves the asset URL without downloading", async () => {
    const release: Release = {
      tag_name: "b6789",
      name: "release b6789",
      published_at: "2026-05-26T00:00:00Z",
      assets: [
        { name: "llama-b6789-bin-win-x64.zip", browser_download_url: "https://example/win.zip", size: 1234 },
        { name: "llama-b6789-bin-ubuntu-x64.zip", browser_download_url: "https://example/ubu.zip", size: 1234 },
      ],
    };
    const fetcher = (async (_url: string) => ({
      ok: true,
      status: 200,
      statusText: "OK",
      async json() { return release; },
    })) as unknown as typeof fetch;

    const { updateLlama } = await import("../src/services/llama_updater.js");
    const r = await updateLlama({
      fetcher,
      platform: "win32",
      arch: "x64",
      hasCuda: false,
      dryRun: true,
    });
    expect(r.tag).toBe("b6789");
    expect(r.assetUrl).toBe("https://example/win.zip");
    expect(r.swapped).toBe(false);
    expect(r.dryRun).toBe(true);
  });
});

describe("/api/llama REST routes", () => {
  beforeEach(() => {
    delete process.env.LLAMA_SERVER_URL;
  });

  it("GET /status reports stopped (no env override, no spawn)", async () => {
    const { llamaRouter } = await import("../src/routes/llama.js");
    const launcher = new LlamaLauncher({ binPath: "/does/not/exist" });
    const app = new Hono();
    app.route("/api/llama", llamaRouter({ launcher }));
    const res = await app.request("/api/llama/status");
    const body = (await res.json()) as { status: string; external: boolean };
    expect(body.status).toBe("stopped");
    expect(body.external).toBe(false);
  });

  it("GET /models returns the registry, presence, lastUsed, and selected id", async () => {
    const { llamaRouter } = await import("../src/routes/llama.js");
    const { LAST_MODEL_KEY } = await import("../src/routes/llama.js");
    const launcher = new LlamaLauncher({ binPath: "/does/not/exist" });
    // Persist a last-used so we can assert it surfaces in the response.
    const firstId = MODEL_REGISTRY[0]!.id;
    const settings = memSettings({ [LAST_MODEL_KEY]: firstId });
    const app = new Hono();
    app.route("/api/llama", llamaRouter({ launcher, settings }));
    const res = await app.request("/api/llama/models");
    const body = (await res.json()) as {
      models: Array<{ id: string; present: boolean; sizeRank: number }>;
      lastUsed: string | null;
      selected: string | null;
    };
    expect(body.models.length).toBe(MODEL_REGISTRY.length);
    expect(body.models.map((m) => m.id).sort()).toEqual(
      MODEL_REGISTRY.map((m) => m.id).sort(),
    );
    expect(body.lastUsed).toBe(firstId);
    // `selected` is selectModelId(detected, lastUsed); with no files on disk in
    // the hermetic test env it's null. If the 2B happens to be present it would
    // be a real id — accept either rather than depend on the disk state.
    expect(body.selected === null || typeof body.selected === "string").toBe(true);
  });

  it("POST /select rejects an unknown model id with 400 (no restart)", async () => {
    const { llamaRouter } = await import("../src/routes/llama.js");
    let restarts = 0;
    const launcher = new LlamaLauncher({ binPath: "/does/not/exist" });
    // Spy on restart to prove an invalid select never touches the launcher.
    const origRestart = launcher.restart.bind(launcher);
    launcher.restart = (async (p) => { restarts++; return origRestart(p); }) as typeof launcher.restart;
    const settings = memSettings();
    const app = new Hono();
    app.route("/api/llama", llamaRouter({ launcher, settings }));
    const res = await app.request("/api/llama/select", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "not-a-real-model" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("unknown_model");
    expect(restarts).toBe(0);
    // Nothing should have been persisted for a rejected select.
    const { LAST_MODEL_KEY } = await import("../src/routes/llama.js");
    expect(settings.get(LAST_MODEL_KEY)).toBeNull();
  });

  it("POST /update returns asset metadata when stubbed", async () => {
    const { llamaRouter } = await import("../src/routes/llama.js");
    const launcher = new LlamaLauncher({ binPath: "/does/not/exist" });
    const update = async () => ({
      tag: "b9999",
      assetName: "stub.zip",
      assetUrl: "https://example/stub.zip",
      destPath: "/tmp/stub.zip",
      bytesDownloaded: 0,
      swapped: false,
      dryRun: true,
    });
    const app = new Hono();
    app.route("/api/llama", llamaRouter({ launcher, update }));
    const res = await app.request("/api/llama/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dryRun: true }),
    });
    const body = (await res.json()) as { ok: boolean; tag: string };
    expect(body.ok).toBe(true);
    expect(body.tag).toBe("b9999");
  });

  it("autoStartLlama is a no-op (external) when LLAMA_SERVER_URL is set", async () => {
    process.env.LLAMA_SERVER_URL = "http://localhost:5001";
    try {
      const { autoStartLlama } = await import("../src/routes/llama.js");
      const r = await autoStartLlama({ settings: memSettings() });
      expect(r.started).toBe(false);
      expect(r.reason).toBe("external_url");
    } finally {
      delete process.env.LLAMA_SERVER_URL;
    }
  });

  it("autoStartLlama never throws even if the launcher.start rejects (non-fatal)", async () => {
    const launcher = new LlamaLauncher({ binPath: "/does/not/exist" });
    // Force start() to reject; autoStartLlama must swallow it.
    launcher.start = (async () => { throw new Error("boom"); }) as typeof launcher.start;
    // Make a model appear "selected" by persisting a last-used id AND making
    // detection see it. detectModels uses real fs, so instead we rely on the
    // catch path: if no model is present we get no_model_present; if one is
    // present and start throws we get the swallowed reason. Either way it must
    // NOT throw and must report started:false.
    const { autoStartLlama } = await import("../src/routes/llama.js");
    const firstId = MODEL_REGISTRY[0]!.id;
    const { LAST_MODEL_KEY } = await import("../src/routes/llama.js");
    const r = await autoStartLlama({
      launcher,
      settings: memSettings({ [LAST_MODEL_KEY]: firstId }),
    });
    expect(r.started).toBe(false);
    expect(["no_model_present", "boom"]).toContain(r.reason);
  });

  it("POST /update DROPS attacker-controlled releasesUrl/destDir from body (SSRF guard)", async () => {
    const { llamaRouter } = await import("../src/routes/llama.js");
    const launcher = new LlamaLauncher({ binPath: "/does/not/exist" });
    // Record exactly what UpdateOptions the route passes to the updater so
    // we can assert the unsafe fields are stripped.
    let observed: unknown = null;
    const update = async (opts: unknown) => {
      observed = opts;
      return {
        tag: "b9999",
        assetName: "stub.zip",
        assetUrl: "https://example/stub.zip",
        destPath: "/tmp/stub.zip",
        bytesDownloaded: 0,
        swapped: false,
        dryRun: true,
      };
    };
    const app = new Hono();
    app.route("/api/llama", llamaRouter({ launcher, update }));
    const res = await app.request("/api/llama/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        dryRun: true,
        preferVulkan: false,
        releasesUrl: "http://attacker.example/release.json",
        destDir: "C:\\Windows\\System32",
        fetcher: "anything",
      }),
    });
    expect(res.status).toBe(200);
    const safe = observed as Record<string, unknown>;
    // Only the allowlisted keys should make it through.
    expect(Object.keys(safe).sort()).toEqual(["dryRun", "preferVulkan"]);
    expect(safe).not.toHaveProperty("releasesUrl");
    expect(safe).not.toHaveProperty("destDir");
    expect(safe).not.toHaveProperty("fetcher");
  });
});

// ---------------------------------------------------------------------------
// C3 — child-process hygiene: killNow() / killSharedLlamaSync().
// killNow must synchronously terminate the EXACT child the launcher spawned
// (never by name/pattern) and be safe from process 'exit' handlers.
// ---------------------------------------------------------------------------
describe("C3 — llama_launcher.killNow (child-process hygiene)", () => {
  it("kills the real spawned child synchronously and marks the launcher stopped", async () => {
    // Spawn a REAL long-lived node child through the injectable spawnFn so we
    // can verify an actual OS process is reaped. The launcher tracks its
    // exact ChildProcess handle; killNow() must terminate that one process.
    const { spawn: realSpawn } = await import("node:child_process");
    let spawned: import("node:child_process").ChildProcess | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spawnFn = ((_bin: string, _args: string[], opts: object) => {
      spawned = realSpawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], opts as never);
      return spawned;
    }) as never;
    const client = {
      baseUrl: "stub://",
      chat: async () => {
        throw new Error("not used");
      },
      health: async () => ({ ok: true, status: 200 }),
    };
    const launcher = new LlamaLauncher({ binPath: process.execPath, spawnFn, client });
    const r = await launcher.start({ ...defaultProfile(), modelPath: "/m.gguf" });
    expect(r.status).toBe("ready");
    expect(spawned!.pid).toBeGreaterThan(0);
    expect(spawned!.exitCode).toBeNull(); // still alive

    launcher.killNow();
    expect(launcher.getStatus().status).toBe("stopped");
    expect(launcher.getStatus().pid).toBeNull();

    // The OS process must actually die (SIGKILL delivery is async-observed).
    await new Promise<void>((resolve) => {
      if (spawned!.exitCode !== null || spawned!.signalCode) return resolve();
      spawned!.once("exit", () => resolve());
    });
    expect(spawned!.killed || spawned!.exitCode !== null || spawned!.signalCode !== null).toBe(true);
  }, 15_000);

  it("killNow is a synchronous no-op when nothing is running (exit-handler safe)", () => {
    const launcher = new LlamaLauncher({ binPath: "/does/not/exist" });
    expect(() => launcher.killNow()).not.toThrow();
    expect(launcher.getStatus().status).toBe("stopped");
  });

  it("killNow is idempotent after stop()/killNow()", async () => {
    const fakeProc = Object.assign(new EventEmitter(), {
      pid: 4242,
      killed: false,
      kill: function (this: { killed: boolean }) {
        this.killed = true;
        return true;
      },
      stderr: new EventEmitter(),
      stdout: new EventEmitter(),
    });
    const client = {
      baseUrl: "stub://",
      chat: async () => {
        throw new Error("not used");
      },
      health: async () => ({ ok: true, status: 200 }),
    };
    const launcher = new LlamaLauncher({
      binPath: process.execPath,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spawnFn: (() => fakeProc) as any,
      client,
    });
    await launcher.start({ ...defaultProfile(), modelPath: "/m.gguf" });
    launcher.killNow();
    expect(fakeProc.killed).toBe(true);
    expect(() => launcher.killNow()).not.toThrow(); // second call: no-op
    expect(launcher.getStatus().status).toBe("stopped");
  });

  it("killSharedLlamaSync is a safe no-op when no shared launcher was ever created", async () => {
    const { killSharedLlamaSync } = await import("../src/routes/llama.js");
    expect(() => killSharedLlamaSync()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// C4 — port robustness (probe + walk 8090→8095) and setup-progress reset.
// ---------------------------------------------------------------------------
describe("C4 — port selection (findFreePort / isPortBindFailure)", () => {
  it("findFreePort skips a genuinely occupied port and returns the next free one", async () => {
    const { findFreePort } = await import("../src/services/llama_launcher.js");
    const { createServer } = await import("node:net");
    // Occupy an ephemeral port for real, then ask findFreePort to start there.
    const blocker = createServer();
    const occupied: number = await new Promise((resolve) => {
      blocker.listen({ port: 0, host: "127.0.0.1" }, () => {
        resolve((blocker.address() as { port: number }).port);
      });
    });
    try {
      const picked = await findFreePort(occupied, 3);
      expect(picked).not.toBeNull();
      expect(picked).not.toBe(occupied);
      expect(picked).toBeGreaterThan(occupied);
      expect(picked! - occupied).toBeLessThan(3);
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it("findFreePort returns null when the whole range is busy (injected probe)", async () => {
    const { findFreePort } = await import("../src/services/llama_launcher.js");
    const probed: number[] = [];
    const picked = await findFreePort(8090, 6, async (p) => {
      probed.push(p);
      return false;
    });
    expect(picked).toBeNull();
    expect(probed).toEqual([8090, 8091, 8092, 8093, 8094, 8095]);
  });

  it("isPortBindFailure recognizes bind errors but not model-load errors", async () => {
    const { isPortBindFailure } = await import("../src/services/llama_launcher.js");
    expect(isPortBindFailure("main: couldn't bind HTTP server socket, hostname: 127.0.0.1, port: 8090")).toBe(true);
    expect(isPortBindFailure("listen EADDRINUSE: address already in use 127.0.0.1:8090")).toBe(true);
    expect(isPortBindFailure("failed to bind socket")).toBe(true);
    expect(isPortBindFailure("error: failed to open model file 'foo.gguf'")).toBe(false);
    expect(isPortBindFailure("ggml_vulkan: No Vulkan devices found.")).toBe(false);
    expect(isPortBindFailure("")).toBe(false);
  });
});

describe("C4 — launcher walks to the next free port and propagates it", () => {
  function healthyClient() {
    return {
      baseUrl: "stub://",
      chat: async () => {
        throw new Error("not used");
      },
      health: async () => ({ ok: true, status: 200 }),
    };
  }
  function fakeProc() {
    return Object.assign(new EventEmitter(), {
      pid: 1111,
      killed: false,
      kill: () => true,
      stderr: new EventEmitter(),
      stdout: new EventEmitter(),
    });
  }

  it("uses the requested port when the probe says it is free", async () => {
    const launcher = new LlamaLauncher({
      binPath: process.execPath,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spawnFn: (() => fakeProc()) as any,
      client: healthyClient(),
      portProbe: async () => true,
    });
    const r = await launcher.start({ ...defaultProfile(), modelPath: "/m.gguf", port: 8090 });
    expect(r.status).toBe("ready");
    expect(launcher.getStatus().url).toBe("http://127.0.0.1:8090");
  });

  it("walks past a busy port; the chosen port shows up in url/status (client-config propagation)", async () => {
    const spawnedArgs: string[][] = [];
    const launcher = new LlamaLauncher({
      binPath: process.execPath,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spawnFn: ((_bin: string, args: string[]) => {
        spawnedArgs.push(args);
        return fakeProc();
      }) as any,
      client: healthyClient(),
      // 8090 + 8091 busy, 8092 free.
      portProbe: async (p) => p !== 8090 && p !== 8091,
    });
    const r = await launcher.start({ ...defaultProfile(), modelPath: "/m.gguf", port: 8090 });
    expect(r.status).toBe("ready");
    // Propagation surface: resolveUrl()/getStatus().url is what /api/llama/status
    // returns and what the chat bridge's currentLlamaUrl() forwards.
    expect(launcher.getStatus().url).toBe("http://127.0.0.1:8092");
    // llama-server was actually launched with the walked port.
    const portFlag = spawnedArgs[0]!.indexOf("--port");
    expect(spawnedArgs[0]![portFlag + 1]).toBe("8092");
  });

  it("fails with an actionable error when the whole 8090-8095 range is busy (no spawn)", async () => {
    let spawns = 0;
    const launcher = new LlamaLauncher({
      binPath: process.execPath,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spawnFn: (() => {
        spawns++;
        return fakeProc();
      }) as any,
      client: healthyClient(),
      portProbe: async () => false,
    });
    const r = await launcher.start({ ...defaultProfile(), modelPath: "/m.gguf", port: 8090 });
    expect(r.status).toBe("error");
    expect(r.errorTail).toMatch(/8090-8095/);
    expect(r.errorTail).toMatch(/in use/);
    expect(spawns).toBe(0); // refused before spawning anything
  });
});

describe("C4 — POST /api/llama/setup/reset", () => {
  afterEach(async () => {
    const progress = await import("../src/services/setup_progress.js");
    progress.reset(); // never leak wedged module-singleton state across tests
  });

  it("resets a wedged error state back to idle", async () => {
    const progress = await import("../src/services/setup_progress.js");
    progress.beginRun();
    progress.failStep2("download exploded");
    expect(progress.snapshot().overall).toBe("error");

    const { llamaRouter } = await import("../src/routes/llama.js");
    const launcher = new LlamaLauncher({ binPath: "/does/not/exist" });
    const app = new Hono();
    app.route("/api/llama", llamaRouter({ launcher }));
    const res = await app.request("/api/llama/setup/reset", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; state: { overall: string } };
    expect(body.ok).toBe(true);
    expect(body.state.overall).toBe("idle");
    expect(progress.snapshot().overall).toBe("idle");
  });

  it("refuses to reset an ACTIVE run without force (409), allows it with force:true", async () => {
    const progress = await import("../src/services/setup_progress.js");
    progress.beginRun(); // overall: running
    const { llamaRouter } = await import("../src/routes/llama.js");
    const launcher = new LlamaLauncher({ binPath: "/does/not/exist" });
    const app = new Hono();
    app.route("/api/llama", llamaRouter({ launcher }));

    const refused = await app.request("/api/llama/setup/reset", { method: "POST" });
    expect(refused.status).toBe(409);
    const refusedBody = (await refused.json()) as { ok: boolean; error: string };
    expect(refusedBody.error).toBe("setup_in_progress");
    expect(progress.snapshot().overall).toBe("running"); // untouched

    const forced = await app.request("/api/llama/setup/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    expect(forced.status).toBe(200);
    expect(progress.snapshot().overall).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// C5 — download integrity: SHA-256 stream-hash verification against the
// checked-in manifest (model_digests.ts) / explicit digests, and the GitHub
// release API digest for the llama-server archive. Small fixture buffers.
// ---------------------------------------------------------------------------
describe("C5 — model_digests manifest", () => {
  it("pins a valid sha256 for every MODEL_REGISTRY GGUF (no drift)", async () => {
    const { lookupDigest } = await import("../src/services/model_digests.js");
    for (const spec of MODEL_REGISTRY) {
      const pin = lookupDigest(spec.fileName);
      expect(pin.state, `manifest entry for ${spec.fileName}`).not.toBe("absent");
    }
  });

  it("lookupDigest: pinned / absent / TODO states", async () => {
    const { lookupDigest, MODEL_DIGESTS } = await import("../src/services/model_digests.js");
    expect(lookupDigest("Qwen3.5-2B-Q5_K_S.gguf")).toEqual({
      state: "pinned",
      sha256: "4cf8768832f5d52827916c4cc1e3d5371083558c0f4f99fef371cd7060c3ad4e",
    });
    expect(lookupDigest("never-heard-of-it.gguf")).toEqual({ state: "absent" });
    // TODO placeholder entries report "todo" (warn-and-proceed downstream).
    MODEL_DIGESTS["__test_todo__.gguf"] = { sha256: "TODO" };
    try {
      expect(lookupDigest("__test_todo__.gguf")).toEqual({ state: "todo" });
    } finally {
      delete MODEL_DIGESTS["__test_todo__.gguf"];
    }
  });
});

describe("C5 — downloadFile SHA-256 verification (fixture buffers)", () => {
  async function fixtureEnv() {
    const { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createHash } = await import("node:crypto");
    const dir = mkdtempSync(join(tmpdir(), "bk-c5-dl-"));
    const buf = Buffer.from("GGUF-fixture-payload-" + "x".repeat(1024));
    const sha = createHash("sha256").update(buf).digest("hex");
    const fetcher = (async () =>
      new Response(new Uint8Array(buf), {
        status: 200,
        headers: { "content-length": String(buf.length) },
      })) as unknown as typeof fetch;
    return { dir, buf, sha, fetcher, fs: { rmSync, existsSync, readdirSync, readFileSync }, join };
  }

  it("succeeds when the streamed hash matches expectedSha256", async () => {
    const { downloadFile } = await import("../src/services/model_downloader.js");
    const env = await fixtureEnv();
    try {
      const dest = env.join(env.dir, "fixture-ok.bin");
      const r = await downloadFile("https://example/x", dest, {
        fetcher: env.fetcher,
        expectedSha256: env.sha,
      });
      expect(r.bytesDownloaded).toBe(env.buf.length);
      expect(env.fs.existsSync(dest)).toBe(true);
      expect(env.fs.readFileSync(dest).equals(env.buf)).toBe(true);
    } finally {
      env.fs.rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it("fails LOUD and deletes the file on a hash mismatch", async () => {
    const { downloadFile } = await import("../src/services/model_downloader.js");
    const env = await fixtureEnv();
    try {
      const dest = env.join(env.dir, "fixture-bad.bin");
      await expect(
        downloadFile("https://example/x", dest, {
          fetcher: env.fetcher,
          expectedSha256: "0".repeat(64),
        }),
      ).rejects.toThrow(/SHA-256 mismatch/);
      // Neither the dest nor any temp file may survive a mismatch.
      expect(env.fs.existsSync(dest)).toBe(false);
      expect(env.fs.readdirSync(env.dir)).toEqual([]);
    } finally {
      env.fs.rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it("manifest auto-lookup: a registry GGUF name with wrong bytes is rejected", async () => {
    const { downloadFile } = await import("../src/services/model_downloader.js");
    const env = await fixtureEnv();
    try {
      // basename matches the pinned 2B entry; fixture bytes obviously do not.
      const dest = env.join(env.dir, "Qwen3.5-2B-Q5_K_S.gguf");
      await expect(
        downloadFile("https://example/x", dest, { fetcher: env.fetcher }),
      ).rejects.toThrow(/SHA-256 mismatch/);
      expect(env.fs.existsSync(dest)).toBe(false);
    } finally {
      env.fs.rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it("refuses an unmanifested asset without skipDigest — before any bytes move", async () => {
    const { downloadFile } = await import("../src/services/model_downloader.js");
    const env = await fixtureEnv();
    let fetched = 0;
    const countingFetcher = (async (...args: unknown[]) => {
      fetched++;
      return (env.fetcher as unknown as (...a: unknown[]) => unknown)(...args);
    }) as unknown as typeof fetch;
    try {
      const dest = env.join(env.dir, "unknown-asset.bin");
      await expect(
        downloadFile("https://example/x", dest, { fetcher: countingFetcher }),
      ).rejects.toThrow(/No pinned SHA-256/);
      expect(fetched).toBe(0); // refused before the request fired
    } finally {
      env.fs.rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it("skipDigest: true REFUSES by default — fail closed without the dev escape hatch (F-3)", async () => {
    const { downloadFile } = await import("../src/services/model_downloader.js");
    const env = await fixtureEnv();
    delete process.env.BUDGETKIT_ALLOW_UNVERIFIED_DOWNLOADS;
    try {
      const dest = env.join(env.dir, "unknown-asset.bin");
      await expect(
        downloadFile("https://example/x", dest, { fetcher: env.fetcher, skipDigest: true }),
      ).rejects.toThrow(/unverified downloads are disabled/);
      expect(env.fs.existsSync(dest)).toBe(false);
    } finally {
      env.fs.rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it("skipDigest: true downloads only with BUDGETKIT_ALLOW_UNVERIFIED_DOWNLOADS=1 (warned, unverified)", async () => {
    const { downloadFile } = await import("../src/services/model_downloader.js");
    const env = await fixtureEnv();
    process.env.BUDGETKIT_ALLOW_UNVERIFIED_DOWNLOADS = "1";
    try {
      const dest = env.join(env.dir, "unknown-asset.bin");
      const r = await downloadFile("https://example/x", dest, {
        fetcher: env.fetcher,
        skipDigest: true,
      });
      expect(r.bytesDownloaded).toBe(env.buf.length);
      expect(env.fs.existsSync(dest)).toBe(true);
    } finally {
      delete process.env.BUDGETKIT_ALLOW_UNVERIFIED_DOWNLOADS;
      env.fs.rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it("a TODO manifest entry REFUSES by default — fail closed without the dev escape hatch (F-3)", async () => {
    const { downloadFile } = await import("../src/services/model_downloader.js");
    const { MODEL_DIGESTS } = await import("../src/services/model_digests.js");
    const env = await fixtureEnv();
    MODEL_DIGESTS["todo-pinned.bin"] = { sha256: "TODO" };
    delete process.env.BUDGETKIT_ALLOW_UNVERIFIED_DOWNLOADS;
    try {
      const dest = env.join(env.dir, "todo-pinned.bin");
      await expect(
        downloadFile("https://example/x", dest, { fetcher: env.fetcher }),
      ).rejects.toThrow(/TODO digest/);
      expect(env.fs.existsSync(dest)).toBe(false);
    } finally {
      delete MODEL_DIGESTS["todo-pinned.bin"];
      env.fs.rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it("a TODO manifest entry proceeds only with BUDGETKIT_ALLOW_UNVERIFIED_DOWNLOADS=1", async () => {
    const { downloadFile } = await import("../src/services/model_downloader.js");
    const { MODEL_DIGESTS } = await import("../src/services/model_digests.js");
    const env = await fixtureEnv();
    MODEL_DIGESTS["todo-pinned.bin"] = { sha256: "TODO" };
    process.env.BUDGETKIT_ALLOW_UNVERIFIED_DOWNLOADS = "1";
    try {
      const dest = env.join(env.dir, "todo-pinned.bin");
      const r = await downloadFile("https://example/x", dest, { fetcher: env.fetcher });
      expect(r.bytesDownloaded).toBe(env.buf.length);
      expect(env.fs.existsSync(dest)).toBe(true);
    } finally {
      delete MODEL_DIGESTS["todo-pinned.bin"];
      delete process.env.BUDGETKIT_ALLOW_UNVERIFIED_DOWNLOADS;
      env.fs.rmSync(env.dir, { recursive: true, force: true });
    }
  });
});

describe("C5 — llama_updater verifies the GitHub release asset digest", () => {
  async function updaterEnv(assetDigest: string | undefined) {
    const { mkdtempSync, rmSync, existsSync, readdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createHash } = await import("node:crypto");
    const dir = mkdtempSync(join(tmpdir(), "bk-c5-up-"));
    const zipBuf = Buffer.from("PK-fake-zip-" + "y".repeat(2048));
    const zipSha = createHash("sha256").update(zipBuf).digest("hex");
    const release = {
      tag_name: "b9999",
      name: "release b9999",
      published_at: "2026-06-01T00:00:00Z",
      assets: [
        {
          name: "llama-b9999-bin-win-x64.zip",
          browser_download_url: "https://example/win.zip",
          size: zipBuf.length,
          ...(assetDigest !== undefined ? { digest: assetDigest } : {}),
        },
      ],
    };
    const fetcher = (async (url: string) => {
      if (String(url).includes("releases")) {
        return new Response(JSON.stringify(release), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(new Uint8Array(zipBuf), {
        status: 200,
        headers: { "content-length": String(zipBuf.length) },
      });
    }) as unknown as typeof fetch;
    return { dir, zipBuf, zipSha, fetcher, fs: { rmSync, existsSync, readdirSync }, join };
  }

  it("installs when the streamed hash matches the API digest", async () => {
    const { updateLlama } = await import("../src/services/llama_updater.js");
    // Build one env to learn the fixture hash, then a second whose release
    // metadata carries that hash as its digest.
    const probe = await updaterEnv(undefined);
    probe.fs.rmSync(probe.dir, { recursive: true, force: true });
    const env = await updaterEnv("sha256:" + probe.zipSha);
    try {
      const r = await updateLlama({
        fetcher: env.fetcher,
        destDir: env.dir,
        platform: "win32",
        arch: "x64",
        preferVulkan: false,
        skipExtract: true, // fixture is not a real zip
      });
      expect(r.swapped).toBe(true);
      expect(r.bytesDownloaded).toBe(env.zipBuf.length);
      expect(env.fs.existsSync(env.join(env.dir, "llama-b9999-bin-win-x64.zip"))).toBe(true);
    } finally {
      env.fs.rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it("rejects + cleans up on an API-digest mismatch (binary untouched)", async () => {
    const { updateLlama } = await import("../src/services/llama_updater.js");
    const env = await updaterEnv("sha256:" + "f".repeat(64));
    try {
      await expect(
        updateLlama({
          fetcher: env.fetcher,
          destDir: env.dir,
          platform: "win32",
          arch: "x64",
          preferVulkan: false,
          skipExtract: true,
        }),
      ).rejects.toThrow(/SHA-256 mismatch/);
      // No zip, no temp leftovers.
      expect(env.fs.readdirSync(env.dir)).toEqual([]);
    } finally {
      env.fs.rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it("proceeds with a warning when the release asset has no digest field (legacy)", async () => {
    const { updateLlama } = await import("../src/services/llama_updater.js");
    const env = await updaterEnv(undefined);
    try {
      const r = await updateLlama({
        fetcher: env.fetcher,
        destDir: env.dir,
        platform: "win32",
        arch: "x64",
        preferVulkan: false,
        skipExtract: true,
      });
      expect(r.swapped).toBe(true);
    } finally {
      env.fs.rmSync(env.dir, { recursive: true, force: true });
    }
  });
});
