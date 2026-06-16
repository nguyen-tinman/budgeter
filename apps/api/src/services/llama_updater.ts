// llama.cpp binary updater. Queries GitHub releases, picks the right asset
// for the host OS/arch, downloads, atomically swaps the binary, returns
// version metadata. Testable: HTTP fetcher and FS writer are injectable.
//
// GitHub release asset names follow patterns like:
//   llama-b6789-bin-win-cuda-x64.zip
//   llama-b6789-bin-ubuntu-x64.zip
//   llama-b6789-bin-macos-arm64.zip
// We pick the first asset matching the host's OS+arch (+ GPU when detected).

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join, basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
  /** Per-asset digest the GitHub releases API publishes ("sha256:<hex>").
   *  Used to verify the downloaded archive (C5). A checked-in manifest pin is
   *  impossible here — we always install the LATEST release, whose hash
   *  changes every upstream publish — so the API-provided digest is the
   *  strongest available check: same-source (weaker than out-of-band), but it
   *  still catches truncation, corruption, and CDN tampering. */
  digest?: string;
}

export interface Release {
  tag_name: string;
  name: string;
  published_at: string;
  assets: ReleaseAsset[];
}

export interface UpdateOptions {
  /** Where to put the unpacked llama-server binary. Defaults to ./bin/llama-cpp/. */
  destDir?: string;
  /** Override the GH API URL (for tests). */
  releasesUrl?: string;
  /** Fetcher (tests stub this). */
  fetcher?: typeof fetch;
  /** Host platform detection override (for tests). */
  platform?: NodeJS.Platform;
  /** Host arch override. */
  arch?: NodeJS.Architecture;
  /** Whether CUDA is available — affects asset selection. */
  hasCuda?: boolean;
  /** Skip the actual download + extract; just resolve the URL and asset name. */
  dryRun?: boolean;
  /** Prefer the Vulkan-backed asset over CPU-only. Default true — Vulkan
   *  works on AMD/Intel/NVIDIA and integrated GPUs, and the launcher
   *  falls back to CPU at runtime if no compatible device is found. */
  preferVulkan?: boolean;
  /** Per-chunk byte progress while downloading the zip. */
  onDownloadProgress?: (p: { bytesDone: number; bytesTotal: number; percent: number }) => void;
  /** Called once when the zip extraction begins (no per-byte progress). */
  onExtractStart?: () => void;
  /** Called once when the zip extraction completes. */
  onExtractDone?: () => void;
  /** Skip the extraction step (tests that only want to verify the download). */
  skipExtract?: boolean;
}

export interface UpdateResult {
  tag: string;
  assetName: string;
  assetUrl: string;
  destPath: string;
  bytesDownloaded: number;
  swapped: boolean;
  extracted: boolean;
  dryRun: boolean;
}

/**
 * Pick the best asset for the host. Preference order:
 *   1. Exact OS+arch match with CUDA (if hasCuda) — fastest path on NVIDIA.
 *   2. Exact OS+arch match with Vulkan (if preferVulkan) — works on AMD,
 *      Intel, NVIDIA, integrated GPUs alike.
 *   3. Exact OS+arch match without any GPU backend (CPU-only).
 *   4. The first asset that mentions the OS (loose fallback).
 * Returns null if nothing reasonable found.
 */
export function pickAsset(
  assets: ReleaseAsset[],
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  hasCuda: boolean,
  preferVulkan: boolean = true,
): ReleaseAsset | null {
  const osTag =
    platform === "win32" ? "win" :
    platform === "darwin" ? "macos" :
    platform === "linux" ? "ubuntu" :
    "linux";
  const archTag = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : arch;

  const matchesOsArch = (name: string): boolean =>
    new RegExp(`\\b${osTag}\\b.*\\b${archTag}\\b|\\b${archTag}\\b.*\\b${osTag}\\b`, "i").test(name);

  const isZipOrTar = (name: string): boolean => /\.(zip|tar\.gz|tar\.xz)$/i.test(name);

  if (hasCuda) {
    const cudaPick = assets.find(
      (a) => isZipOrTar(a.name) && matchesOsArch(a.name) && /cuda|cu1\d/i.test(a.name),
    );
    if (cudaPick) return cudaPick;
  }

  if (preferVulkan) {
    const vulkanPick = assets.find(
      (a) => isZipOrTar(a.name) && matchesOsArch(a.name) && /vulkan/i.test(a.name),
    );
    if (vulkanPick) return vulkanPick;
  }

  const cpuPick = assets.find(
    (a) => isZipOrTar(a.name) && matchesOsArch(a.name) && !/cuda|hip|sycl|vulkan/i.test(a.name),
  );
  if (cpuPick) return cpuPick;

  return assets.find((a) => isZipOrTar(a.name) && new RegExp(osTag, "i").test(a.name)) ?? null;
}

const DEFAULT_RELEASES_URL = "https://api.github.com/repos/ggerganov/llama.cpp/releases/latest";

/**
 * Extract a .zip into `destDir`. Cross-platform: shells out to `tar -xf`,
 * which handles .zip on modern macOS/Linux/Windows-10+. Returns the path
 * of the llama-server binary inside `destDir` (or null if not found).
 *
 * The llama.cpp release archives sometimes ship a flat structure
 * (llama-server.exe at the root) and sometimes nest under one subdir;
 * we flatten any single top-level subdir so resolveBin() finds the
 * binary at a predictable location.
 */
export function extractZip(zipPath: string, destDir: string): string | null {
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
  // Two cross-platform tar gotchas, both relevant on Windows:
  //   1. On Windows there are TWO `tar` binaries that might be on PATH:
  //      - Windows-bundled bsdtar at `%SystemRoot%\System32\tar.exe`
  //        (supports .zip via libarchive)
  //      - Git-bash MSYS2 GNU tar at `C:\Program Files\Git\usr\bin\tar.exe`
  //        (CANNOT read .zip — barfs with "This does not look like a tar archive")
  //      We pin to System32 so we always get the zip-capable one.
  //   2. bsdtar parses any drive-letter colon (`C:\...` or `C:/...`) as a
  //      host:path separator. Workaround: chdir into destDir and pass just
  //      the basename so tar never sees a drive-letter prefix.
  const tarBin =
    process.platform === "win32"
      ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\tar.exe`
      : "tar";
  const result = spawnSync(tarBin, ["-xf", basename(zipPath)], {
    cwd: destDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw new Error(
      `extractZip: 'tar' command failed: ${result.error.message}. tar is required on PATH (ships with Windows 10+, macOS, Linux).`,
    );
  }
  if (typeof result.status === "number" && result.status !== 0) {
    const stderr = result.stderr?.toString("utf8") ?? "";
    throw new Error(`extractZip: tar exited ${result.status}: ${stderr.slice(0, 500)}`);
  }
  // Clean up the zip itself FIRST so the flatten check below doesn't count
  // it as a sibling entry. (Bug found by review: with the zip still in
  // destDir, `readdirSync(destDir)` returned both the extracted subdir
  // AND the zip, so `entries.length === 1` was always false and flatten
  // never fired when it should.)
  try {
    rmSync(zipPath, { force: true });
  } catch {
    /* best-effort; we'll still try to find the binary below */
  }
  // Flatten: if the archive nested everything under a single subdir,
  // move its contents up. Detect by: destDir contains exactly one entry
  // that is itself a directory. (Now actually works because the zip is
  // already gone.)
  const entries = readdirSync(destDir);
  if (entries.length === 1) {
    const inner = join(destDir, entries[0]!);
    try {
      if (statSync(inner).isDirectory()) {
        for (const e of readdirSync(inner)) {
          renameSync(join(inner, e), join(destDir, e));
        }
        rmSync(inner, { recursive: true, force: true });
      }
    } catch {
      // best-effort flatten; if it fails the binary is still findable
    }
  }
  // The original rmSync(zipPath) lived here. Moved above so the flatten
  // check sees a clean directory listing.
  try {
    // Defensive: if for some reason the zip is still around (race on
    // Windows, AV scanner held a handle), try again.
    rmSync(zipPath, { force: true });
  } catch {
    // ignore
  }
  const binCandidates = [
    join(destDir, "llama-server.exe"),
    join(destDir, "llama-server"),
  ];
  for (const c of binCandidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Update llama-server. Downloads the latest release archive for the host
 * platform, streams to disk with progress callbacks, then extracts the
 * archive in place so the binary lands at `<destDir>/llama-server.exe`.
 */
export async function updateLlama(opts: UpdateOptions = {}): Promise<UpdateResult> {
  const fetcher = opts.fetcher ?? fetch;
  const releasesUrl = opts.releasesUrl ?? DEFAULT_RELEASES_URL;
  const destDir = opts.destDir ?? resolve(process.cwd(), "bin", "llama-cpp");
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const hasCuda = opts.hasCuda ?? false;
  const dryRun = opts.dryRun ?? false;
  const preferVulkan = opts.preferVulkan ?? true;

  const res = await fetcher(releasesUrl, {
    headers: { accept: "application/vnd.github+json", "user-agent": "budgetkit-updater" },
  });
  if (!res.ok) {
    throw new Error(`GitHub releases fetch failed: ${res.status} ${res.statusText}`);
  }
  const release = (await res.json()) as Release;
  const asset = pickAsset(release.assets, platform, arch, hasCuda, preferVulkan);
  if (!asset) {
    throw new Error(
      `No suitable llama.cpp asset for platform=${platform} arch=${arch} hasCuda=${hasCuda}. Available: ${release.assets.map((a) => a.name).join(", ")}`,
    );
  }

  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
  const zipName = basename(asset.name);
  const zipPath = resolve(destDir, zipName);

  if (dryRun) {
    return {
      tag: release.tag_name,
      assetName: asset.name,
      assetUrl: asset.browser_download_url,
      destPath: zipPath,
      bytesDownloaded: 0,
      swapped: false,
      extracted: false,
      dryRun: true,
    };
  }

  // Stream the asset to disk with per-chunk progress.
  const dl = await fetcher(asset.browser_download_url);
  if (!dl.ok) {
    throw new Error(`Asset download failed: ${dl.status} ${dl.statusText}`);
  }
  const cl = dl.headers.get("content-length");
  const bytesTotal = cl ? Number.parseInt(cl, 10) : -1;

  const tmpPath = `${zipPath}.tmp-${process.pid}`;
  if (!dl.body) throw new Error("Asset download has no body");
  const reader = dl.body.getReader();
  let bytesDone = 0;
  // Stream-hash while downloading (C5); verified against the release API's
  // per-asset digest below.
  const hasher = createHash("sha256");

  // Stream chunks straight to disk rather than buffering the whole archive
  // in memory. Avoids a per-update Node heap spike (and a memory-exhaustion
  // attack vector if /update were ever pointed at a huge response).
  async function* asyncChunks(): AsyncGenerator<Buffer> {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      if (value) {
        const buf = Buffer.from(value);
        bytesDone += buf.length;
        hasher.update(buf);
        if (opts.onDownloadProgress) {
          const percent =
            bytesTotal > 0
              ? Math.min(100, Math.round((bytesDone * 100) / bytesTotal))
              : 0;
          opts.onDownloadProgress({ bytesDone, bytesTotal, percent });
        }
        yield buf;
      }
    }
  }
  const writeStream = createWriteStream(tmpPath);
  try {
    await pipeline(Readable.from(asyncChunks()), writeStream);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }

  // Content-Length sanity check: refuse to install a truncated archive.
  if (bytesTotal > 0 && bytesDone !== bytesTotal) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw new Error(
      `Asset download truncated: got ${bytesDone} bytes, expected ${bytesTotal} (Content-Length).`,
    );
  }

  // SHA-256 verification against the release API's per-asset digest (C5).
  // Fail loud + delete on mismatch — never extract a corrupt archive over
  // the working binary. Older mocks / API responses without a digest field
  // proceed with a warning (there is nothing to verify against).
  const digestMatch = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? "");
  if (digestMatch) {
    const expected = digestMatch[1]!.toLowerCase();
    const actual = hasher.digest("hex");
    if (actual !== expected) {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
      throw new Error(
        `SHA-256 mismatch for llama.cpp asset "${asset.name}": expected ${expected}, got ${actual}. ` +
          `The archive is corrupt or tampered; it was deleted and the installed binary is untouched.`,
      );
    }
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      `[llama-updater] WARNING: release asset "${asset.name}" carries no sha256 digest in the ` +
        `GitHub API response — installing WITHOUT integrity verification (Content-Length check only).`,
    );
  }

  if (existsSync(zipPath)) {
    // Drop the old zip directly. There's no reason to keep an aside copy —
    // we never read it back, and a long-running app would accumulate one
    // file per update (binary releases are ~30-200 MB each).
    try { rmSync(zipPath, { force: true }); } catch { /* best-effort */ }
  }
  renameSync(tmpPath, zipPath);
  // Sweep any stale .replaced-* / .tmp-* siblings from prior runs so they
  // don't pile up forever on machines that update repeatedly.
  try {
    for (const sibling of readdirSync(destDir)) {
      if (/(\.replaced-\d+|\.tmp-\d+)$/.test(sibling)) {
        rmSync(resolve(destDir, sibling), { force: true });
      }
    }
  } catch { /* best-effort cleanup */ }

  let extracted = false;
  if (!opts.skipExtract) {
    opts.onExtractStart?.();
    try {
      const found = extractZip(zipPath, destDir);
      extracted = Boolean(found);
    } finally {
      opts.onExtractDone?.();
    }
  }

  return {
    tag: release.tag_name,
    assetName: asset.name,
    assetUrl: asset.browser_download_url,
    destPath: zipPath,
    bytesDownloaded: bytesDone,
    swapped: true,
    extracted,
    dryRun: false,
  };
}
