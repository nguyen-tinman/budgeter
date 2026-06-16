// Streamed GGUF download with per-chunk progress callbacks. Used by the
// /api/llama/setup orchestrator and (separately) testable on its own.
//
// Portability: caller provides absolute destination + URL — no project-root
// assumptions live in here. The default URL for the bundled Qwen3.5-2B-MTP
// is hardcoded in the orchestrator, not this module.
//
// Integrity (C5): every download is SHA-256-hashed WHILE streaming and
// verified against the checked-in manifest (model_digests.ts, keyed by the
// destination basename) or an explicit `expectedSha256`. A mismatch deletes
// the file and fails loud. Unverified downloads FAIL CLOSED (Codex F-3):
// both `skipDigest: true` and "TODO" manifest entries refuse unless the dev
// escape hatch BUDGETKIT_ALLOW_UNVERIFIED_DOWNLOADS=1 is set, and even then
// they warn loudly. A pinned manifest digest is always enforced.

import { mkdirSync, createWriteStream, existsSync, renameSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { lookupDigest } from "./model_digests.js";

export interface DownloadProgress {
  bytesDone: number;
  bytesTotal: number; // -1 if Content-Length not provided
  percent: number;    // 0..100, or NaN/0 if total unknown
}

export interface DownloadOptions {
  /** Override fetch for tests. */
  fetcher?: typeof fetch;
  /** Bytes-received callback. Fires roughly once per chunk. */
  onProgress?: (p: DownloadProgress) => void;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
  /** Explicit expected SHA-256 (lowercase hex). Overrides the manifest. */
  expectedSha256?: string;
  /** Allow downloading an asset that has NO digest available — neither an
   *  `expectedSha256` nor a manifest entry. Honored only when the dev escape
   *  hatch BUDGETKIT_ALLOW_UNVERIFIED_DOWNLOADS=1 is also set (fail closed);
   *  logged with a warning. Has no effect on pinned assets: a manifest digest
   *  is always enforced. */
  skipDigest?: boolean;
}

/** Dev-only escape hatch for unverified downloads (Codex F-3): both the
 *  `skipDigest` option and "TODO" manifest entries refuse without it. */
function allowUnverifiedDownloads(): boolean {
  return process.env.BUDGETKIT_ALLOW_UNVERIFIED_DOWNLOADS === "1";
}

export interface DownloadResult {
  url: string;
  destPath: string;
  bytesDownloaded: number;
}

/**
 * Stream the given URL to `destPath`. Writes to a temp file then atomic-
 * renames in place so a half-baked download never poses as the real file.
 *
 * No allowlist enforcement here — the orchestrator picks the URL and is
 * trusted. (Compare with `web_fetcher.ts`, which IS called with LLM-derived
 * URLs and enforces a strict host allowlist.)
 */
export async function downloadFile(
  url: string,
  destPath: string,
  opts: DownloadOptions = {},
): Promise<DownloadResult> {
  const fetcher = opts.fetcher ?? fetch;
  const assetId = basename(destPath);

  // Resolve the integrity expectation BEFORE any bytes move (C5): explicit
  // expectedSha256 wins; otherwise the checked-in manifest keyed by the
  // destination basename. No digest at all → refuse unless the caller
  // explicitly opted out, so unverified downloads are always deliberate.
  let expectedSha256: string | null = null;
  if (opts.expectedSha256) {
    expectedSha256 = opts.expectedSha256.trim().toLowerCase();
  } else {
    const pin = lookupDigest(assetId);
    if (pin.state === "pinned") {
      expectedSha256 = pin.sha256;
    } else if (pin.state === "todo") {
      // Fail closed (Codex F-3): a TODO manifest entry only downloads when the
      // dev escape hatch is explicitly set — never silently in normal runs.
      if (!allowUnverifiedDownloads()) {
        throw new Error(
          `"${assetId}" is in model_digests.ts with a TODO digest. Pin its sha256, or set ` +
            `BUDGETKIT_ALLOW_UNVERIFIED_DOWNLOADS=1 to download unverified (dev only).`,
        );
      }
      // eslint-disable-next-line no-console
      console.warn(
        `[downloader] WARNING: "${assetId}" has a TODO digest and BUDGETKIT_ALLOW_UNVERIFIED_DOWNLOADS=1 ` +
          `is set — downloading WITHOUT integrity verification. Pin its sha256 as soon as it is known.`,
      );
    } else if (opts.skipDigest === true) {
      // Fail closed (Codex F-3): skipDigest is honored only with the dev escape hatch.
      if (!allowUnverifiedDownloads()) {
        throw new Error(
          `skipDigest was set for "${assetId}" but unverified downloads are disabled. Set ` +
            `BUDGETKIT_ALLOW_UNVERIFIED_DOWNLOADS=1 (dev only) or pin the digest in model_digests.ts.`,
        );
      }
      // eslint-disable-next-line no-console
      console.warn(
        `[downloader] WARNING: skipDigest set — downloading "${assetId}" WITHOUT integrity ` +
          `verification (no manifest entry). Add a pinned sha256 to model_digests.ts if this ` +
          `asset is shipped to users.`,
      );
    } else {
      throw new Error(
        `No pinned SHA-256 for "${assetId}" (apps/api/src/services/model_digests.ts) and no ` +
          `expectedSha256 was provided. Pass { skipDigest: true } to download unverified, or ` +
          `add the digest to the manifest.`,
      );
    }
  }

  const dir = dirname(destPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const res = await fetcher(url, { signal: opts.signal });
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText} for ${url}`);
  }
  const cl = res.headers.get("content-length");
  const bytesTotal = cl ? Number.parseInt(cl, 10) : -1;
  const tmpPath = `${destPath}.tmp-${process.pid}`;

  if (!res.body) {
    throw new Error("Response has no body to stream");
  }

  let bytesDone = 0;
  const reader = res.body.getReader();
  const writeStream = createWriteStream(tmpPath);
  // Stream-hash while downloading (C5) — no second pass over a 1.3-3 GB file.
  const hasher = createHash("sha256");

  // Convert the Web ReadableStream chunks into an async iterable that
  // emits Buffers for the Node stream pipeline, and tick onProgress
  // along the way.
  async function* asyncChunks(): AsyncGenerator<Buffer> {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      if (value) {
        const buf = Buffer.from(value);
        bytesDone += buf.length;
        hasher.update(buf);
        if (opts.onProgress) {
          const percent =
            bytesTotal > 0
              ? Math.min(100, Math.round((bytesDone * 100) / bytesTotal))
              : 0;
          opts.onProgress({ bytesDone, bytesTotal, percent });
        }
        yield buf;
      }
    }
  }

  try {
    await pipeline(Readable.from(asyncChunks()), writeStream);
  } catch (err) {
    // Clean up the half-written temp file.
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }

  // Content-Length sanity check: if the server told us how big the file
  // should be, our streamed total has to match. A truncated stream
  // (network dropped, NAT timed out) lands here with bytesDone < bytesTotal;
  // refuse to rename a partial download into place so the next /setup call
  // doesn't see a size-positive-but-broken file and skip Step 2.
  if (bytesTotal > 0 && bytesDone !== bytesTotal) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw new Error(
      `Download truncated: got ${bytesDone} bytes, expected ${bytesTotal} (Content-Length). Network issue or upstream close.`,
    );
  }

  // SHA-256 verification (C5). Fail LOUD and delete the temp file on a
  // mismatch — a wrong-hash model must never be renamed into place where the
  // setup orchestrator's skip-if-present check would trust it forever.
  if (expectedSha256) {
    const actual = hasher.digest("hex");
    if (actual !== expectedSha256) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // ignore
      }
      throw new Error(
        `SHA-256 mismatch for "${assetId}": expected ${expectedSha256}, got ${actual}. ` +
          `The download is corrupt or the upstream file changed; the file was deleted. ` +
          `Retry setup — if it persists, re-check the source and update model_digests.ts.`,
      );
    }
  }

  if (existsSync(destPath)) {
    // Drop the existing file directly; we never need to keep aside copies
    // of model files (1.4 GB each — they'd accumulate fast on re-downloads).
    try {
      unlinkSync(destPath);
    } catch {
      // ignore
    }
  }
  renameSync(tmpPath, destPath);

  if (opts.onProgress) {
    opts.onProgress({ bytesDone, bytesTotal, percent: 100 });
  }

  return { url, destPath, bytesDownloaded: bytesDone };
}
