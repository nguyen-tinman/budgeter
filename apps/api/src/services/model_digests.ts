// Pinned SHA-256 digests for downloadable assets (C5 — download integrity).
//
// Keyed by ASSET ID = the on-disk basename the downloader writes (for model
// GGUFs this is ModelSpec.fileName from llama_launcher's MODEL_REGISTRY).
// model_downloader.ts consults this manifest automatically: a pinned asset
// whose streamed hash mismatches is deleted and the download fails loud.
//
// Provenance: GGUF digests were read from the HuggingFace git-LFS pointer
// files (https://huggingface.co/<repo>/raw/main/<file> → `oid sha256:<hex>`),
// which is the same digest HF's storage layer verifies on upload. Fetched
// 2026-06-10. If a model is re-uploaded upstream (same filename, new bytes),
// downloads will fail closed until this manifest is updated — that is the
// intended behavior; re-read the pointer file and update the pin.
//
// The llama-server BINARY is intentionally NOT pinned here: the updater
// installs whatever the LATEST llama.cpp release is, so a checked-in pin
// would go stale on every upstream release. It is verified instead against
// the per-asset `digest` field the GitHub releases API returns (see
// llama_updater.ts) — weaker than an out-of-band pin (same source serves
// metadata and bytes) but still catches truncation, corruption, and CDN
// tampering.
//
// Adding a new model: ship the entry with `sha256: "TODO"` if the digest is
// not yet known — the downloader then WARNS and proceeds unverified for that
// asset instead of failing closed, so a missing pin never bricks setup.

export interface PinnedDigest {
  /** Lowercase hex SHA-256 of the complete asset, or "TODO" when not yet
   *  pinned (warn-and-proceed). */
  sha256: string;
  /** Expected size in bytes — advisory documentation; the byte count is
   *  enforced separately via Content-Length during streaming. */
  sizeBytes?: number;
  /** Where the digest came from, for reviewers. */
  source?: string;
}

export const MODEL_DIGESTS: Record<string, PinnedDigest> = {
  // qwen3.5-2b (MODEL_REGISTRY id) — default bundled model.
  "Qwen3.5-2B-Q5_K_S.gguf": {
    sha256: "4cf8768832f5d52827916c4cc1e3d5371083558c0f4f99fef371cd7060c3ad4e",
    sizeBytes: 1_433_013_664,
    source: "huggingface.co/unsloth/Qwen3.5-2B-MTP-GGUF LFS pointer (raw/main), 2026-06-10",
  },
  // qwen3.5-4b (MODEL_REGISTRY id) — larger optional model.
  "Qwen3.5-4B-UD-Q5_K_XL.gguf": {
    sha256: "b4c36a8e14a80c21bcab5a067ce342b2e70e28f60b4aa95ad12203fa17b87426",
    sizeBytes: 3_250_869_408,
    source: "huggingface.co/unsloth/Qwen3.5-4B-GGUF LFS pointer (raw/main), 2026-06-10",
  },
};

/** Manifest lookup result for one asset id. */
export type DigestLookup =
  | { state: "pinned"; sha256: string }
  | { state: "todo" }
  | { state: "absent" };

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Resolve an asset id against the manifest. Entries whose sha256 is not a
 *  valid 64-char hex string (e.g. "TODO") report state "todo" — present but
 *  intentionally unpinned. */
export function lookupDigest(assetId: string): DigestLookup {
  const entry = MODEL_DIGESTS[assetId];
  if (!entry) return { state: "absent" };
  const normalized = entry.sha256.trim().toLowerCase();
  if (SHA256_HEX.test(normalized)) return { state: "pinned", sha256: normalized };
  return { state: "todo" };
}
