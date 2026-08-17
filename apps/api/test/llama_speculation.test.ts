// MTP speculation is both a speed dial and a memory cost, so whether to enable
// it is a function of free VRAM. These pin the policy with synthetic GPU
// readings — no GPU required, which is the point of keeping it pure.

import { describe, it, expect } from "vitest";
import {
  speculationFor,
  defaultProfile,
  buildArgs,
  modelById,
  MODEL_REGISTRY,
  VRAM_HEADROOM_MIB,
  type GpuInfo,
} from "../src/services/llama_launcher.js";

const large = MODEL_REGISTRY.reduce((a, b) => (b.sizeRank > a.sizeRank ? b : a));
const small = MODEL_REGISTRY.reduce((a, b) => (b.sizeRank < a.sizeRank ? b : a));

const gpu = (freeMiB: number): GpuInfo => ({
  name: "Test GPU",
  totalMiB: freeMiB + 1024,
  freeMiB,
});

describe("speculationFor — MTP only when it fits", () => {
  it("enables MTP at the measured draft length when there is room", () => {
    const c = speculationFor(large, gpu(15194));
    expect(c.specType).toBe("draft-mtp");
    expect(c.specDraftNMax).toBe(large.specDraftNMax);
  });

  it("gives each model its own measured draft length", () => {
    // The optimum is not a property of the algorithm: the 4B's verify batch
    // stops paying at 3 while the 2B keeps winning out to 8. A single shared
    // value would cost one model or the other ~25%.
    expect(speculationFor(small, gpu(15194)).specDraftNMax).toBe(8);
    expect(speculationFor(large, gpu(15194)).specDraftNMax).toBe(3);
  });

  it("disables MTP rather than risking an allocation failure when VRAM is tight", () => {
    // 5 GB free: the 4B fits WITHOUT speculation (5,542 MiB) but not with it
    // (6,183 + headroom). Dropping speculation is far cheaper than the CPU
    // fallback that an OOM would trigger.
    const c = speculationFor(large, gpu(5 * 1024));
    expect(c.specType).toBe("none");
    expect(c.specDraftNMax).toBe(0);
    expect(c.reason).toMatch(/without speculation/);
  });

  it("fits the large model WITH speculation on an 8 GB card", () => {
    // This is what q8_0 KV bought: at f16 the 4B needed 8,351 MiB and an 8 GB
    // card could not run it with speculation at all. Guard the reach.
    expect(speculationFor(large, gpu(8 * 1024)).specType).toBe("draft-mtp");
  });

  it("keeps MTP on the small model at VRAM where the large model loses it", () => {
    // The threshold is per-model, from each one's measured peak. A 6 GB card
    // runs the 2B with speculation happily; a single global 8 GB bar would
    // have switched it off for no reason.
    const at6gb = 6 * 1024;
    expect(speculationFor(small, gpu(at6gb)).specType).toBe("draft-mtp");
    expect(speculationFor(large, gpu(at6gb)).specType).toBe("none");
  });

  it("uses each model's own measured peak plus headroom as the bar", () => {
    for (const spec of MODEL_REGISTRY) {
      const need = spec.vramMib.mtp + VRAM_HEADROOM_MIB;
      expect(speculationFor(spec, gpu(need)).specType).toBe("draft-mtp");
      expect(speculationFor(spec, gpu(need - 1)).specType).toBe("none");
      // The no-MTP figure must actually be the cheaper one, or the fallback
      // would be pointless.
      expect(spec.vramMib.noMtp).toBeLessThan(spec.vramMib.mtp);
    }
  });

  it("disables MTP when no GPU was detected", () => {
    const c = speculationFor(large, null);
    expect(c.specType).toBe("none");
    expect(c.reason).toMatch(/no gpu/i);
  });
});

describe("defaultProfile — speculation wiring", () => {
  it("keeps the model's declared default when no GPU reading is supplied", () => {
    // Legacy/no-argument callers must not silently lose speculation.
    const p = defaultProfile(large.id);
    expect(p.specType).toBe("draft-mtp");
    expect(p.specDraftNMax).toBe(large.specDraftNMax);
  });

  it("emits --spec-type draft-mtp with the swept draft length on a roomy GPU", () => {
    const args = buildArgs(defaultProfile(large.id, gpu(15194)));
    expect(args[args.indexOf("--spec-type") + 1]).toBe("draft-mtp");
    expect(args[args.indexOf("--spec-draft-n-max") + 1]).toBe(String(large.specDraftNMax));
  });

  it("emits no draft-mtp flag at all on a tight GPU", () => {
    const args = buildArgs(defaultProfile(large.id, gpu(5 * 1024)));
    expect(args).not.toContain("draft-mtp");
    const i = args.indexOf("--spec-type");
    if (i >= 0) expect(args[i + 1]).toBe("none");
  });

  it("passes q8_0 to both the main and the draft KV cache", () => {
    // Leaving the draft context at f16 would leave part of the saving unclaimed.
    const args = buildArgs(defaultProfile(large.id, gpu(15194)));
    for (const flag of ["-ctk", "-ctv", "-ctkd", "-ctvd"]) {
      expect(args[args.indexOf(flag) + 1]).toBe("q8_0");
    }
  });

  it("omits the draft cache flags when speculation is off", () => {
    const args = buildArgs(defaultProfile(large.id, gpu(5 * 1024)));
    expect(args).toContain("-ctk");
    expect(args).not.toContain("-ctkd");
  });

  it("uses q8_0 KV on EVERY path — roomy, tight, no GPU, and CPU fallback", () => {
    // q8_0 is unconditional: it is a pure memory win with no measured speed
    // cost, so there is no configuration in which f16 is preferable. Pinning
    // every path because the cache type lives on the profile, and a future
    // path that rebuilds a profile by hand (as the Vulkan->CPU fallback does)
    // could drop it without any other test noticing.
    const cases: Array<[string, GpuInfo | null]> = [
      ["roomy", gpu(15194)],
      ["tight", gpu(5 * 1024)],
      ["no gpu", null],
    ];
    for (const spec of MODEL_REGISTRY) {
      for (const [label, g] of cases) {
        const args = buildArgs(defaultProfile(spec.id, g));
        expect(args[args.indexOf("-ctk") + 1], `${spec.id} ${label}`).toBe("q8_0");
        expect(args[args.indexOf("-ctv") + 1], `${spec.id} ${label}`).toBe("q8_0");
      }
      // The fallback spreads the original profile; assert the spread keeps it.
      const cpu = { ...defaultProfile(spec.id, gpu(15194)), nGpuLayers: 0, specType: "none" as const };
      const args = buildArgs(cpu);
      expect(args[args.indexOf("-ctk") + 1], `${spec.id} cpu`).toBe("q8_0");
      expect(args).not.toContain("-ctkd");
    }
  });

  it("still resolves an unknown model id to the small default", () => {
    expect(defaultProfile("nope", gpu(15194)).modelPath).toContain(
      modelById(small.id)!.fileName,
    );
  });
});
