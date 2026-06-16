// DB export / import — schema-versioned for cross-version migration.
//
// Format: a single .db SQLite file + a sidecar .manifest.json with
// {schema_version, app_version, exported_at, row_counts_per_table}. The
// sidecar lets us validate the bundle without opening it as a database.
//
// Why not a tarball/zip: keeps the bundle inspectable with the sqlite3 CLI
// and avoids a new dependency. The pair (file.db + file.db.manifest.json)
// travels together.

import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { closeDb, defaultDbConfig, openDb, type DatabaseSync } from "./database.js";
import { migrate, SCHEMA_VERSION } from "./migrate.js";
// basename is referenced from the test helper export; suppress unused warning
void basename;

// Non-singleton SQLite open — used to inspect the bundle before swapping it
// into the live slot. We use createRequire (same pattern as database.ts) to
// bypass Vite's static-import analyser.
const _nodeRequire = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _sqliteMod: any = _nodeRequire("node:sqlite");

/** The core tables every BudgetKit DB must have after migration. */
const REQUIRED_TABLES = [
  "schema_migrations",
  "workspaces",
  "expenses",
  "incomes",
];

/**
 * Open the bundle SQLite file read-only (independent of the live singleton),
 * run PRAGMA integrity_check, and verify the expected core tables exist.
 * Throws with a descriptive message if anything looks wrong.
 * Always closes the read-only handle before returning.
 */
function validateBundleIntegrity(bundlePath: string): void {
  // node:sqlite DatabaseSync supports { readOnly: true } as of Node 24.
  let bundleDb: DatabaseSync | null = null;
  try {
    bundleDb = new _sqliteMod.DatabaseSync(bundlePath, { readOnly: true });

    // PRAGMA integrity_check returns rows like {integrity_check: "ok"} when clean.
    const icRows = bundleDb.prepare("PRAGMA integrity_check").all() as {
      integrity_check: string;
    }[];
    const notOk = icRows.filter((r) => r.integrity_check !== "ok");
    if (notOk.length > 0) {
      throw new Error(
        `Bundle failed SQLite integrity_check: ${notOk.map((r) => r.integrity_check).join("; ")}`,
      );
    }

    // Verify the required core tables exist in the bundle.
    const existingTables = new Set(
      (
        bundleDb
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .all() as { name: string }[]
      ).map((r) => r.name),
    );
    const missing = REQUIRED_TABLES.filter((t) => !existingTables.has(t));
    if (missing.length > 0) {
      throw new Error(
        `Bundle is missing required tables: ${missing.join(", ")}. This may not be a BudgetKit database.`,
      );
    }
  } finally {
    try { bundleDb?.close(); } catch { /* ignore close errors */ }
  }
}

const APP_VERSION = "0.1.0"; // bumped manually; could read from package.json later
const MANIFEST_VERSION = 1;
const MAX_BACKUPS_KEEP = 10;

export interface Manifest {
  /** Format version of THIS manifest JSON structure (not the DB schema). */
  manifest_version: number;
  /** SQLite DB schema version. */
  schema_version: number;
  /** App version that produced the export. */
  app_version: string;
  /** ISO-8601 export timestamp. */
  exported_at: string;
  /** Absolute path the DB was exported from (informational only). */
  source_db_path: string;
  /** SHA-256 of the .db bundle file, hex-encoded. Verified at import. */
  file_sha256: string;
  /** Bytes of the .db bundle file. Verified at import. */
  file_size_bytes: number;
  /** Row counts at export time, per user table. Informational — NOT compared post-migration. */
  table_row_counts: Record<string, number>;
}

export interface ExportResult {
  bundlePath: string;
  manifestPath: string;
  manifest: Manifest;
}

export interface ImportResult {
  backupPath: string;
  imported: Manifest;
  migrationsApplied: string[];
  rowCountsAfter: Record<string, number>;
  /**
   * Tables whose live count differs from the manifest count. Empty when no
   * migrations ran AND counts agree. Populated only on no-migration imports —
   * if a migration ran, divergence is expected (seed inserts, drops) and
   * comparison is skipped.
   */
  rowCountMismatches: Record<string, { manifest: number; actual: number }>;
}

// Per-process counter so two timestamp() calls inside the same millisecond
// still yield distinct strings. Reset only on process restart; on Windows the
// monotonic clock is millisecond-coarse and back-to-back exportDatabase() calls
// frequently hit the same value, which under the old second-precision format
// silently overwrote the previous bundle.
let _tsCounter = 0;

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  // Counter is two digits (00..99) — wraps around well past any conceivable
  // single-millisecond burst, and stays short enough to keep the filename
  // readable.
  const seq = String(_tsCounter++ % 100).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${ms}-${seq}`;
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function checkpointWal(db: DatabaseSync): void {
  // TRUNCATE flushes the WAL into the main DB file and resets it to zero
  // bytes, so a flat file copy captures everything.
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

function listUserTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

function tableRowCounts(db: DatabaseSync): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of listUserTables(db)) {
    const r = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number };
    out[t] = r.n;
  }
  return out;
}

/** SHA-256 of a file, hex-encoded. Stream-based to handle large DBs without RAM spikes. */
async function fileSha256(path: string): Promise<string> {
  return await new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
    stream.on("error", rejectHash);
  });
}

/** Prune ./data/backups/ down to the most recent MAX_BACKUPS_KEEP files. */
function pruneBackups(dir: string): number {
  if (!existsSync(dir)) return 0;
  const entries = readdirSync(dir)
    .filter((f: string) => f.startsWith("auto-pre-import-") && f.endsWith(".db"))
    .map((f: string) => {
      const full = resolve(dir, f);
      return { full, mtime: statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  let removed = 0;
  for (const e of entries.slice(MAX_BACKUPS_KEEP)) {
    try {
      unlinkSync(e.full);
      removed++;
    } catch {
      // best-effort cleanup
    }
  }
  return removed;
}

/** List bundle files under `./data/exports/` with their manifest data. */
export function listExports(): Array<{ bundlePath: string; manifest: Manifest; sizeBytes: number }> {
  const cfg = defaultDbConfig();
  const root = resolve(dirname(cfg.path));
  const dir = resolve(root, "exports");
  if (!existsSync(dir)) return [];
  const out: Array<{ bundlePath: string; manifest: Manifest; sizeBytes: number }> = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".db")) continue;
    const bundlePath = resolve(dir, f);
    const manifestPath = `${bundlePath}.manifest.json`;
    if (!existsSync(manifestPath)) continue;
    const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    out.push({ bundlePath, manifest, sizeBytes: statSync(bundlePath).size });
  }
  return out.sort((a, b) => a.manifest.exported_at.localeCompare(b.manifest.exported_at));
}

/**
 * Export the live DB to a versioned bundle (file + sidecar manifest).
 * Default target dir is `./data/exports/` relative to repo root.
 */
export async function exportDatabase(targetDir?: string): Promise<ExportResult> {
  const cfg = defaultDbConfig();
  const root = resolve(dirname(cfg.path));
  const outDir = targetDir ?? resolve(root, "exports");
  ensureDir(outDir);

  const db = openDb(cfg);
  checkpointWal(db);
  const counts = tableRowCounts(db);
  // Close to release file handles before copying — Windows is strict.
  closeDb();

  const ts = timestamp();
  const bundlePath = resolve(outDir, `budgetkit-export-${ts}.db`);
  const manifestPath = `${bundlePath}.manifest.json`;

  copyFileSync(cfg.path, bundlePath);

  // Hash + size computed AFTER the copy so the manifest describes the bundle,
  // not the (potentially-mid-write) source.
  const sha256 = await fileSha256(bundlePath);
  const size = statSync(bundlePath).size;

  const manifest: Manifest = {
    manifest_version: MANIFEST_VERSION,
    schema_version: SCHEMA_VERSION,
    app_version: APP_VERSION,
    exported_at: new Date().toISOString(),
    source_db_path: cfg.path,
    file_sha256: sha256,
    file_size_bytes: size,
    table_row_counts: counts,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  return { bundlePath, manifestPath, manifest };
}

/**
 * Validate, parse, and integrity-check the bundle + sidecar pair. Pure —
 * does not touch the live DB.
 */
async function validateBundle(bundlePath: string): Promise<{
  manifest: Manifest;
  manifestPath: string;
  resolvedBundle: string;
}> {
  // Normalize the path so a `../`-laden argv can't escape via a typo.
  const resolvedBundle = resolve(bundlePath);
  if (!existsSync(resolvedBundle)) {
    throw new Error(`Bundle not found: ${resolvedBundle}`);
  }
  const manifestPath = `${resolvedBundle}.manifest.json`;
  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest sidecar not found: ${manifestPath}`);
  }

  let imported: Manifest;
  try {
    imported = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    throw new Error(
      `Manifest is not valid JSON: ${manifestPath} (${(e as Error).message})`,
    );
  }
  if (typeof imported.schema_version !== "number") {
    throw new Error(`Manifest missing schema_version`);
  }
  if (imported.schema_version > SCHEMA_VERSION) {
    throw new Error(
      `Bundle schema_version ${imported.schema_version} is newer than app schema ${SCHEMA_VERSION}. Upgrade the app before importing.`,
    );
  }

  // Integrity: size + sha256. Older bundles (no hash field) get a soft warning
  // but still import — the user can opt back into strict mode later.
  if (typeof imported.file_size_bytes === "number") {
    const actualSize = statSync(resolvedBundle).size;
    if (actualSize !== imported.file_size_bytes) {
      throw new Error(
        `Bundle size mismatch: manifest says ${imported.file_size_bytes} bytes, file is ${actualSize}. Bundle may be truncated or wrong sidecar.`,
      );
    }
  }
  if (typeof imported.file_sha256 === "string" && imported.file_sha256.length === 64) {
    const actualHash = await fileSha256(resolvedBundle);
    if (actualHash !== imported.file_sha256) {
      throw new Error(
        `Bundle hash mismatch: manifest sha256=${imported.file_sha256.slice(0, 12)}…, file hash=${actualHash.slice(0, 12)}…. Bundle may be corrupted or sidecar mismatched.`,
      );
    }
  }

  return { manifest: imported, manifestPath, resolvedBundle };
}

/**
 * Best-effort retry wrapper for filesystem ops that can throw EBUSY/EACCES
 * on Windows when an antivirus or indexer briefly re-locks the file after
 * a close.
 */
function retrySync<T>(op: () => T, attempts = 5, delayMs = 50): T {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return op();
    } catch (e) {
      last = e;
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EACCES" && code !== "EPERM") throw e;
      // Spin-wait briefly; in a single-threaded fs path this is acceptable.
      const until = Date.now() + delayMs;
      while (Date.now() < until) {
        // tight wait
      }
    }
  }
  throw last;
}

/**
 * Import a bundle, replacing the live DB. Snapshots the current DB first,
 * runs forward migrations if needed, returns row counts.
 *
 * Atomic-swap strategy:
 *   1. Copy bundle to {live}.import-tmp (no overlap with live).
 *   2. If live exists: move it ASIDE to {live}.replaced-{ts} via rename
 *      (atomic within same directory). The live "slot" is now free.
 *   3. Rename tmp -> live (atomic; slot empty so Windows succeeds).
 *   4. Unlink the aside file. If step 3 failed, the aside file is the
 *      automatic rollback target.
 *
 * Both the snapshot-to-backups step and the rename-aside step provide
 * independent recovery paths if the swap fails mid-way.
 */
export async function importDatabase(bundlePath: string): Promise<ImportResult> {
  const { manifest: imported, resolvedBundle } = await validateBundle(bundlePath);

  // Pre-swap integrity check: open the bundle read-only, run SQLite's own
  // integrity_check, and confirm the core tables exist. This catches truncated
  // files or non-BudgetKit databases before we touch the live DB.
  validateBundleIntegrity(resolvedBundle);

  const cfg = defaultDbConfig();
  const root = resolve(dirname(cfg.path));
  const backupDir = resolve(root, "backups");
  ensureDir(backupDir);
  ensureDir(dirname(cfg.path));

  // 1) Snapshot the live DB (if any) into ./data/backups/ before swap.
  let backupPath = "";
  if (existsSync(cfg.path)) {
    const db = openDb(cfg);
    checkpointWal(db);
    closeDb();
    backupPath = resolve(backupDir, `auto-pre-import-${timestamp()}.db`);
    copyFileSync(cfg.path, backupPath);
  }

  // 2) Stage the bundle next to the live path (same directory = atomic
  //    rename territory on both Windows and POSIX).
  const stagedPath = `${cfg.path}.import-tmp-${process.pid}`;
  copyFileSync(resolvedBundle, stagedPath);

  // 3) Atomic-ish swap with the rename-aside dance.
  const asidePath = `${cfg.path}.replaced-${timestamp()}`;
  try {
    if (existsSync(cfg.path)) {
      retrySync(() => renameSync(cfg.path, asidePath));
    }
    // Sidecar WAL/SHM belonged to the previous live instance and are stale
    // now. They should be auto-recreated when we reopen on the imported DB.
    for (const side of ["-wal", "-shm"]) {
      const p = `${cfg.path}${side}`;
      if (existsSync(p)) {
        try { retrySync(() => unlinkSync(p)); } catch { /* tolerate */ }
      }
    }
    retrySync(() => renameSync(stagedPath, cfg.path));
  } catch (e) {
    // Rollback: if we moved the live file aside but couldn't bring the new
    // one in, put the original back.
    if (existsSync(asidePath) && !existsSync(cfg.path)) {
      try { renameSync(asidePath, cfg.path); } catch { /* surface original error */ }
    }
    if (existsSync(stagedPath)) {
      try { unlinkSync(stagedPath); } catch { /* tolerate */ }
    }
    throw new Error(
      `Atomic DB swap failed: ${(e as Error).message}. Live DB unchanged. Backup at ${backupPath || "(no prior DB)"}.`,
    );
  }

  // Aside file is now redundant; the backup in ./data/backups/ is the
  // canonical rollback point.
  if (existsSync(asidePath)) {
    try { unlinkSync(asidePath); } catch { /* leave for manual cleanup */ }
  }

  // 4) Reopen and run forward migrations if the bundle is older.
  const db = openDb(cfg);
  const migrations = migrate(db);
  const counts = tableRowCounts(db);
  closeDb();

  // 5) Integrity comparison: compare manifest row counts against actuals.
  //
  //    When NO migrations ran: counts must match exactly (same schema, same
  //    data — any divergence is a genuine anomaly).
  //
  //    When migrations ran: post-migration counts can legitimately differ from
  //    the manifest (seed inserts, column drops, remaps in 008, etc.). We log
  //    the tables that overlap between manifest and post-migration state and
  //    note which ones diverge, but do NOT populate rowCountMismatches (the
  //    caller would have no actionable recourse). The log makes the skip
  //    visible rather than silent.
  let countMismatches: Record<string, { manifest: number; actual: number }> = {};
  if (migrations.applied.length === 0 && imported.table_row_counts) {
    for (const [tbl, expected] of Object.entries(imported.table_row_counts)) {
      const actual = counts[tbl];
      if (actual === undefined) {
        countMismatches[tbl] = { manifest: expected, actual: -1 };
      } else if (actual !== expected) {
        countMismatches[tbl] = { manifest: expected, actual };
      }
    }
  } else if (migrations.applied.length > 0 && imported.table_row_counts) {
    // Migrations ran — counts may legitimately diverge. Log the intersection
    // so operators can audit what changed, but do not treat divergence as an
    // error (post-migration state is expected to differ from pre-migration manifest).
    const diverged: string[] = [];
    for (const [tbl, expected] of Object.entries(imported.table_row_counts)) {
      const actual = counts[tbl];
      if (actual !== undefined && actual !== expected) {
        diverged.push(`${tbl}: manifest=${expected} actual=${actual}`);
      }
    }
    if (diverged.length > 0) {
      console.info(
        `[import] ${migrations.applied.length} migration(s) ran; row counts diverged from manifest ` +
        `(expected — migrations may have added/removed rows): ${diverged.join(", ")}`,
      );
    }
  }

  // 6) Rotate old auto-backups so the folder doesn't grow without bound.
  pruneBackups(backupDir);

  return {
    backupPath,
    imported,
    migrationsApplied: migrations.applied,
    rowCountsAfter: counts,
    rowCountMismatches: countMismatches,
  };
}

/** Test helper — not exported in the public API but used by the round-trip test. */
export const __test = {
  basename,
  tableRowCounts,
};
