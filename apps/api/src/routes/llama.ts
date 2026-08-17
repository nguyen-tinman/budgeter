// /api/llama — lifecycle + updater endpoints for llama-server.
//
//   GET  /api/llama/status   — current status, url, pid, external?
//   GET  /api/llama/models   — registry + on-disk presence + selected model id
//   POST /api/llama/start    — start with the provided profile (optional `model`)
//   POST /api/llama/stop     — stop the subprocess
//   POST /api/llama/restart  — stop + start with last (or provided) profile
//   POST /api/llama/select   — persist a model choice + restart onto it
//   POST /api/llama/update   — download latest llama.cpp release; optional dryRun

import { Hono } from "hono";
import {
  LlamaLauncher,
  defaultProfile,
  detectModels,
  selectModelId,
  detectGpu,
  chooseSetupModel,
  launchProfile,
  modelById,
  MODEL_REGISTRY,
  resetGpuCache,
  type LlamaProfile,
} from "../services/llama_launcher.js";
import { defaultLlamaUrl } from "../services/llama_client.js";
import { updateLlama, type UpdateOptions } from "../services/llama_updater.js";
import { startSetup, getSetupStatus } from "../services/setup_orchestrator.js";
import { isRunning as setupIsRunning, reset as resetSetupProgress } from "../services/setup_progress.js";
import { openDb, appSettingsRepo, type AppSettingsRepo } from "@budgetkit/db";

/** app_settings key under which we persist the last-used model id. */
export const LAST_MODEL_KEY = "llama.lastModelId";

export interface LlamaRouterOptions {
  launcher?: LlamaLauncher;
  /** Override the updater (for tests). */
  update?: typeof updateLlama;
  /** Override the last-used-model persistence (tests pass an in-memory stub;
   *  prod uses the app_settings table). */
  settings?: AppSettingsRepo;
}

let sharedLauncher: LlamaLauncher | null = null;

function getLauncher(opts: LlamaRouterOptions): LlamaLauncher {
  if (opts.launcher) return opts.launcher;
  if (!sharedLauncher) sharedLauncher = new LlamaLauncher();
  return sharedLauncher;
}

/**
 * The base URL the chat bridge should target RIGHT NOW (C4). Reflects the
 * shared launcher's live state — including a port chosen by start()'s
 * walk when 8090 was busy, and the LLAMA_SERVER_URL external override.
 * Falls back to the client's default resolution when nothing was ever
 * launched (fresh boot before auto-start, or test routers that inject
 * their own launcher/client).
 */
export function currentLlamaUrl(): string {
  return sharedLauncher ? sharedLauncher.resolveUrl() : defaultLlamaUrl();
}

/**
 * Synchronously hard-kill the SHARED launcher's llama-server child, if any
 * (C3 — wired into the API's shutdown/exit handlers in index.ts so a
 * Ctrl+C'd or crashed API never orphans the multi-GB-VRAM inference
 * subprocess). Safe to call repeatedly and from process 'exit' handlers
 * (fully synchronous); a no-op when nothing was ever launched. Only the
 * exact tracked child PID is killed — see LlamaLauncher.killNow().
 */
export function killSharedLlamaSync(): void {
  sharedLauncher?.killNow();
}

function getSettings(opts: LlamaRouterOptions): AppSettingsRepo {
  return opts.settings ?? appSettingsRepo(openDb());
}

export function llamaRouter(opts: LlamaRouterOptions = {}): Hono {
  const router = new Hono();
  const updater = opts.update ?? updateLlama;

  router.get("/status", (c) => c.json(getLauncher(opts).getStatus()));

  // Registry + which GGUFs are on disk + the model id that would be launched
  // by default (sticky last-used, else largest present). Drives the Setup
  // model picker and per-model download buttons.
  router.get("/models", (c) => {
    const detected = detectModels();
    const lastUsed = getSettings(opts).get(LAST_MODEL_KEY);
    const selected = selectModelId(detected, lastUsed);
    // First-time setup has no "largest present" to prefer, so recommend by
    // hardware instead of always shipping the smallest model.
    const gpu = detectGpu();
    const recommended = chooseSetupModel(gpu);
    return c.json({
      models: detected.map(({ spec, present }) => ({
        id: spec.id,
        label: spec.label,
        fileName: spec.fileName,
        blurb: spec.blurb,
        sizeRank: spec.sizeRank,
        present,
      })),
      lastUsed,
      selected,
      recommended: recommended.modelId,
      recommendedReason: recommended.reason,
      gpu,
    });
  });

  router.post("/start", async (c) => {
    // Block start while setup is actively downloading/extracting — the
    // binary and the GGUF can be mid-rename, which would crash llama-server
    // or pin the wrong file. Once setup finishes, /start picks up normally.
    if (setupIsRunning()) {
      return c.json(
        { ok: false, error: "setup_in_progress", state: getSetupStatus() },
        409,
      );
    }
    let body: Partial<LlamaProfile> & { model?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      /* default profile */
    }
    // `model` (a registry id) selects which GGUF to base the profile on; raw
    // profile fields in the body still override individual knobs on top of it.
    // An unknown/absent id resolves to the default (2B) inside launchProfile,
    // which also decides whether MTP speculation fits this GPU.
    const { model, ...profileOverrides } = body;
    const profile: LlamaProfile = { ...launchProfile(model), ...profileOverrides };
    const result = await getLauncher(opts).start(profile);
    // Persist the model we actually launched as last-used so the next startup
    // auto-launch + the Setup picker default reflect it. Only persist a known
    // registry id (don't write garbage from a bad body).
    if (result.status !== "error" && model && modelById(model)) {
      getSettings(opts).set(LAST_MODEL_KEY, model);
    }
    return c.json(result);
  });

  router.post("/stop", async (c) => {
    await getLauncher(opts).stop();
    return c.json(getLauncher(opts).getStatus());
  });

  // Pick which model inference runs on. Persists the choice as last-used and
  // restarts llama-server onto the selected GGUF. Rejects unknown ids and
  // models that aren't downloaded yet (so we never restart onto a missing
  // file). Body: { model: "<registry id>" }.
  router.post("/select", async (c) => {
    if (setupIsRunning()) {
      return c.json(
        { ok: false, error: "setup_in_progress", state: getSetupStatus() },
        409,
      );
    }
    let body: { model?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      /* fall through to validation */
    }
    const modelId = body.model;
    const spec = modelId ? modelById(modelId) : undefined;
    if (!spec) {
      return c.json({ ok: false, error: "unknown_model" }, 400);
    }
    // Refuse to select a model whose GGUF isn't on disk — restarting onto a
    // missing file would just error the launcher. The UI should download it
    // first via /setup.
    const present = detectModels().some((d) => d.spec.id === spec.id && d.present);
    if (!present) {
      return c.json({ ok: false, error: "model_not_present", model: spec.id }, 409);
    }
    // Persist BEFORE restart so a crash mid-restart still leaves the choice
    // recorded for the next auto-start.
    getSettings(opts).set(LAST_MODEL_KEY, spec.id);
    const result = await getLauncher(opts).restart(launchProfile(spec.id));
    return c.json({ ok: result.status !== "error", model: spec.id, ...result });
  });

  router.post("/restart", async (c) => {
    if (setupIsRunning()) {
      return c.json(
        { ok: false, error: "setup_in_progress", state: getSetupStatus() },
        409,
      );
    }
    let body: Partial<LlamaProfile> | undefined;
    try {
      body = await c.req.json();
    } catch {
      /* keep last */
    }
    const profile = body ? { ...launchProfile(), ...body } : undefined;
    const result = await getLauncher(opts).restart(profile);
    return c.json(result);
  });

  // Update llama-server binary. The request body is INTENTIONALLY narrow —
  // it only accepts safe-to-tune knobs (dryRun, preferVulkan). The internal
  // `UpdateOptions` exposes overrides for `releasesUrl` and `destDir` that
  // are used by tests/internals, but exposing them on the public HTTP
  // surface would let any local caller turn this into a download-and-extract
  // primitive pointed at an attacker-controlled host. Block them here.
  router.post("/update", async (c) => {
    let raw: unknown = {};
    try {
      raw = await c.req.json();
    } catch {
      /* defaults */
    }
    const r0 = raw as { dryRun?: unknown; preferVulkan?: unknown };
    const safe: UpdateOptions = {};
    if (typeof r0.dryRun === "boolean") safe.dryRun = r0.dryRun;
    if (typeof r0.preferVulkan === "boolean") safe.preferVulkan = r0.preferVulkan;
    try {
      const r = await updater(safe);
      // A successful install/replace can change what --list-devices reports
      // (missing binary → Vulkan build, or CPU-only → Vulkan). Drop the
      // memoized probe so /models and launchProfile() see the new binary.
      if (!r.dryRun) resetGpuCache();
      return c.json({ ok: true, ...r });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 502);
    }
  });

  // Two-step "set up local LLM" pipeline. Triggers a fire-and-forget
  // async run; progress is polled via /api/llama/setup/status.
  //
  // The body accepts ONLY a `model` registry id — never a raw URL. The
  // orchestrator resolves that id to a trusted URL + fixed on-disk path via
  // MODEL_REGISTRY. Allowing arbitrary `modelUrl` from the caller would let
  // any local process replace a GGUF with attacker bytes (the orchestrator
  // atomic-replaces the file at the fixed path). An unknown/absent id falls
  // back to the VRAM-appropriate recommendation.
  router.post("/setup", async (c) => {
    let body: { model?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      /* default model */
    }
    // Only forward a known registry id; anything else falls back to the
    // hardware-appropriate default rather than unconditionally to the 2B.
    const recommended = chooseSetupModel(detectGpu());
    const modelId =
      body.model && modelById(body.model) ? body.model : recommended.modelId;
    const r = startSetup({ modelId });
    if (r.alreadyRunning) {
      return c.json(
        { ok: false, error: "already_running", state: getSetupStatus() },
        409,
      );
    }
    return c.json({ ok: true, state: getSetupStatus() });
  });

  router.get("/setup/status", (c) => c.json(getSetupStatus()));

  // C4: the setup-progress singleton has no expiry — after a failed or
  // finished run the UI can be left staring at overall:'error'/'done' with no
  // way back to a clean idle state except restarting the API. POST
  // /setup/reset returns it to the initial state. While a run is ACTIVE the
  // reset is refused (409) — resetting mid-run would drop the
  // setup_in_progress guard that protects /start //select //restart from
  // racing a mid-rename binary/GGUF — unless the caller passes
  // { force: true }, the documented escape hatch for a run that is itself
  // wedged (e.g. a stalled download holding overall:'running' forever).
  router.post("/setup/reset", async (c) => {
    let body: { force?: boolean } = {};
    try {
      body = await c.req.json();
    } catch {
      /* no body → no force */
    }
    if (setupIsRunning() && body.force !== true) {
      return c.json(
        {
          ok: false,
          error: "setup_in_progress",
          message:
            "Setup is still running; reset would unguard a mid-flight download/extract. " +
            "Pass { \"force\": true } only if the run is wedged.",
          state: getSetupStatus(),
        },
        409,
      );
    }
    resetSetupProgress();
    return c.json({ ok: true, state: getSetupStatus() });
  });

  return router;
}

/**
 * Auto-start the inference server on API boot. Called from index.ts.
 *
 * Picks the model the same way the Setup picker does — sticky last-used, else
 * the largest GGUF present (selectModelId). If NO model is on disk yet, this is
 * a no-op (the user hasn't run setup), so a fresh install still boots cleanly.
 *
 * NON-FATAL by contract: every failure path is swallowed and logged as a
 * warning. The API must come up whether or not inference launches — a missing
 * GGUF, a missing binary, or a spawn error must never crash the process. The
 * caller does NOT await this (fire-and-forget) so a slow model load doesn't
 * delay the HTTP listener.
 *
 * Shares the route module's `sharedLauncher` singleton so the running process
 * is the same one /status, /stop, /restart, and /select operate on.
 */
export async function autoStartLlama(
  opts: LlamaRouterOptions = {},
): Promise<{ started: boolean; model: string | null; reason?: string }> {
  try {
    // External-URL dev mode: nothing to spawn, the bridge talks to that URL.
    if (process.env.LLAMA_SERVER_URL) {
      return { started: false, model: null, reason: "external_url" };
    }
    const detected = detectModels();
    const lastUsed = getSettings(opts).get(LAST_MODEL_KEY);
    const modelId = selectModelId(detected, lastUsed);
    if (!modelId) {
      // No GGUF downloaded yet — expected on a fresh install. Stay quiet-ish.
      return { started: false, model: null, reason: "no_model_present" };
    }
    const result = await getLauncher(opts).start(launchProfile(modelId));
    if (result.status === "error") {
      return { started: false, model: modelId, reason: result.errorTail ?? "launch_error" };
    }
    return { started: true, model: modelId };
  } catch (err) {
    // Defensive: any unexpected throw must not propagate out to boot.
    return {
      started: false,
      model: null,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
