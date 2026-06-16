// Round-trip + failure-mode tests for DB export/import. Uses a temp DB so
// the test is hermetic (never touches the real ./data/ DB).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "budgetkit-backup-test-"));
  process.env.BUDGETKIT_DB = join(tmpRoot, "test.db");
});

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("backup — export/import round-trip", () => {
  it("export → wipe → import preserves row counts, file hash matches", async () => {
    const { migrate } = await import("@budgetkit/db");
    const { openDb, closeDb, defaultDbConfig } = await import(
      "@budgetkit/db"
    );
    const { exportDatabase, importDatabase } = await import(
      "@budgetkit/db"
    );

    let db = openDb();
    migrate(db);
    const seedName = `roundtrip-${Date.now()}`;
    db.prepare("INSERT INTO workspaces (name, kind) VALUES (?, 'scenario')").run(
      seedName,
    );
    const beforeCount = (
      db.prepare("SELECT COUNT(*) AS n FROM workspaces").get() as { n: number }
    ).n;
    closeDb();

    const exp = await exportDatabase();
    expect(existsSync(exp.bundlePath)).toBe(true);
    expect(existsSync(exp.manifestPath)).toBe(true);
    expect(exp.manifest.manifest_version).toBe(1);
    expect(exp.manifest.file_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(exp.manifest.file_size_bytes).toBeGreaterThan(0);
    expect(exp.manifest.table_row_counts.workspaces).toBe(beforeCount);

    // Wipe live DB so importDatabase doesn't auto-backup (cleaner assertion).
    const cfg = defaultDbConfig();
    rmSync(cfg.path, { force: true });
    for (const side of ["-wal", "-shm"]) rmSync(`${cfg.path}${side}`, { force: true });

    const imp = await importDatabase(exp.bundlePath);
    expect(existsSync(cfg.path)).toBe(true);
    expect(imp.backupPath).toBe("");
    expect(imp.imported.schema_version).toBe(exp.manifest.schema_version);
    expect(imp.rowCountsAfter.workspaces).toBe(beforeCount);
    // No migrations ran (bundle is current schema) → counts should match exactly.
    expect(imp.rowCountMismatches).toEqual({});

    db = openDb();
    const row = db
      .prepare("SELECT name FROM workspaces WHERE name = ?")
      .get(seedName) as { name: string } | undefined;
    expect(row?.name).toBe(seedName);
    closeDb();
  });

  it("two exports inside the same wall-clock second produce distinct bundle paths", async () => {
    // Regression: the old timestamp() returned second-precision strings, so
    // back-to-back exportDatabase() calls produced identical filenames and the
    // second silently overwrote the first. Millisecond + per-call counter
    // guarantee distinctness even in a tight loop.
    const { migrate } = await import("@budgetkit/db");
    const { openDb, closeDb, defaultDbConfig } = await import("@budgetkit/db");
    const { exportDatabase } = await import("@budgetkit/db");

    const cfg = defaultDbConfig();
    rmSync(cfg.path, { force: true });
    for (const side of ["-wal", "-shm"]) rmSync(`${cfg.path}${side}`, { force: true });

    const db = openDb();
    migrate(db);
    closeDb();

    // Loop a handful of times — they almost certainly land inside the same
    // millisecond on a fast machine. All must be distinct.
    const paths = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const r = await exportDatabase();
      paths.add(r.bundlePath);
      // Bundle and its sidecar must exist on disk after every call.
      expect(existsSync(r.bundlePath)).toBe(true);
      expect(existsSync(r.manifestPath)).toBe(true);
    }
    expect(paths.size).toBe(5);
  });

  it("import with existing live DB creates an auto-backup", async () => {
    const { migrate } = await import("@budgetkit/db");
    const { openDb, closeDb, defaultDbConfig } = await import(
      "@budgetkit/db"
    );
    const { exportDatabase, importDatabase } = await import(
      "@budgetkit/db"
    );

    const cfg = defaultDbConfig();
    rmSync(cfg.path, { force: true });
    for (const side of ["-wal", "-shm"]) rmSync(`${cfg.path}${side}`, { force: true });

    let db = openDb();
    migrate(db);
    db.prepare("INSERT INTO workspaces (name, kind) VALUES (?, 'scenario')").run(
      "original",
    );
    closeDb();

    const exp = await exportDatabase();
    const imp = await importDatabase(exp.bundlePath);
    expect(imp.backupPath).not.toBe("");
    expect(existsSync(imp.backupPath)).toBe(true);
  });
});

describe("backup — failure modes", () => {
  it("rejects a bundle with newer schema_version than the app (N+1 gate)", async () => {
    // D5: the version gate must actually fire now that SCHEMA_VERSION is
    // derived from the migration count. Tests both N+1 (rejected) and N (accepted).
    const { migrate, SCHEMA_VERSION } = await import("@budgetkit/db");
    const { openDb, closeDb, defaultDbConfig } = await import(
      "@budgetkit/db"
    );
    const { exportDatabase, importDatabase } = await import(
      "@budgetkit/db"
    );

    const cfg = defaultDbConfig();
    rmSync(cfg.path, { force: true });
    for (const side of ["-wal", "-shm"]) rmSync(`${cfg.path}${side}`, { force: true });

    const db = openDb();
    migrate(db);
    closeDb();

    const exp = await exportDatabase();

    // N: current schema version — must be accepted (no migration needed, no gate).
    const nManifest = { ...exp.manifest, schema_version: SCHEMA_VERSION };
    writeFileSync(exp.manifestPath, JSON.stringify(nManifest, null, 2), "utf8");
    await expect(importDatabase(exp.bundlePath)).resolves.toBeDefined();

    // N+1: future schema version — must be rejected.
    const n1Manifest = { ...exp.manifest, schema_version: SCHEMA_VERSION + 1 };
    writeFileSync(exp.manifestPath, JSON.stringify(n1Manifest, null, 2), "utf8");
    await expect(importDatabase(exp.bundlePath)).rejects.toThrow(/newer than app schema/i);
  });

  it("rejects a bundle with a far-future schema_version (999)", async () => {
    const { migrate } = await import("@budgetkit/db");
    const { openDb, closeDb, defaultDbConfig } = await import(
      "@budgetkit/db"
    );
    const { exportDatabase, importDatabase } = await import(
      "@budgetkit/db"
    );

    const cfg = defaultDbConfig();
    rmSync(cfg.path, { force: true });
    for (const side of ["-wal", "-shm"]) rmSync(`${cfg.path}${side}`, { force: true });

    const db = openDb();
    migrate(db);
    closeDb();

    const exp = await exportDatabase();
    const tampered = { ...exp.manifest, schema_version: 999 };
    writeFileSync(exp.manifestPath, JSON.stringify(tampered, null, 2), "utf8");

    await expect(importDatabase(exp.bundlePath)).rejects.toThrow(/newer than app schema/i);
  });

  it("rejects when the manifest sidecar is missing", async () => {
    const { migrate } = await import("@budgetkit/db");
    const { openDb, closeDb } = await import("@budgetkit/db");
    const { exportDatabase, importDatabase } = await import(
      "@budgetkit/db"
    );

    const db = openDb();
    migrate(db);
    closeDb();

    const exp = await exportDatabase();
    rmSync(exp.manifestPath, { force: true });
    await expect(importDatabase(exp.bundlePath)).rejects.toThrow(/manifest/i);
  });

  it("rejects malformed manifest JSON cleanly (not as an uncaught parse error)", async () => {
    const { migrate } = await import("@budgetkit/db");
    const { openDb, closeDb } = await import("@budgetkit/db");
    const { exportDatabase, importDatabase } = await import(
      "@budgetkit/db"
    );

    const db = openDb();
    migrate(db);
    closeDb();

    const exp = await exportDatabase();
    writeFileSync(exp.manifestPath, "{ not valid json", "utf8");
    await expect(importDatabase(exp.bundlePath)).rejects.toThrow(/not valid json/i);
  });

  it("rejects a truncated bundle via file_size mismatch", async () => {
    const { migrate } = await import("@budgetkit/db");
    const { openDb, closeDb } = await import("@budgetkit/db");
    const { exportDatabase, importDatabase } = await import(
      "@budgetkit/db"
    );

    const db = openDb();
    migrate(db);
    closeDb();

    const exp = await exportDatabase();
    // Truncate the bundle in place. Manifest still claims original size.
    const buf = readFileSync(exp.bundlePath);
    writeFileSync(exp.bundlePath, buf.subarray(0, Math.floor(buf.length / 2)));

    await expect(importDatabase(exp.bundlePath)).rejects.toThrow(/size mismatch/i);
  });

  it("rejects a bundle whose contents don't match the manifest hash", async () => {
    const { migrate } = await import("@budgetkit/db");
    const { openDb, closeDb } = await import("@budgetkit/db");
    const { exportDatabase, importDatabase } = await import(
      "@budgetkit/db"
    );

    const db = openDb();
    migrate(db);
    closeDb();

    const exp = await exportDatabase();
    // Append a byte — file size matches if we also patch manifest, but the
    // hash will drift. To isolate the hash check specifically, append a byte
    // AND patch the manifest's recorded size to match.
    appendFileSync(exp.bundlePath, "\0");
    const m = JSON.parse(readFileSync(exp.manifestPath, "utf8"));
    m.file_size_bytes += 1;
    writeFileSync(exp.manifestPath, JSON.stringify(m, null, 2), "utf8");

    await expect(importDatabase(exp.bundlePath)).rejects.toThrow(/hash mismatch/i);
  });

  it("normalizes the bundle path before lookup (rejects nonexistent normalized path)", async () => {
    const { importDatabase } = await import("@budgetkit/db");
    await expect(importDatabase("./does/not/exist.db")).rejects.toThrow(
      /Bundle not found/,
    );
  });

  // D6: pre-swap integrity validation — the bundle is opened read-only and
  // inspected BEFORE the live DB is touched. These tests exercise the cases
  // where the bundle passes the manifest/hash checks but fails the SQLite
  // integrity check or is missing required tables.

  it("pre-swap: rejects a non-SQLite file masquerading as a bundle", async () => {
    // Build a valid manifest for a file that is NOT a valid SQLite database.
    const { migrate } = await import("@budgetkit/db");
    const { openDb, closeDb, defaultDbConfig } = await import("@budgetkit/db");
    const { exportDatabase, importDatabase } = await import("@budgetkit/db");

    const cfg = defaultDbConfig();
    rmSync(cfg.path, { force: true });
    for (const side of ["-wal", "-shm"]) rmSync(`${cfg.path}${side}`, { force: true });

    const db = openDb();
    migrate(db);
    closeDb();

    const exp = await exportDatabase();

    // Overwrite the bundle with random bytes (not a valid SQLite file),
    // then patch the manifest so size+hash match the garbage content.
    const { createHash } = await import("node:crypto");
    const garbage = Buffer.alloc(exp.manifest.file_size_bytes, 0x41); // 'AAAA...'
    writeFileSync(exp.bundlePath, garbage);
    const hash = createHash("sha256").update(garbage).digest("hex");
    const patchedManifest = {
      ...exp.manifest,
      file_sha256: hash,
      file_size_bytes: garbage.length,
    };
    writeFileSync(exp.manifestPath, JSON.stringify(patchedManifest, null, 2), "utf8");

    // The pre-swap integrity check should catch this before the live DB is modified.
    // Node:sqlite will throw "file is not a database" when attempting to open
    // garbage as SQLite, OR our integrity_check will catch corruption.
    await expect(importDatabase(exp.bundlePath)).rejects.toThrow(
      /integrity_check|not.*a.*BudgetKit|required tables|not a database|invalid database|unable to open/i,
    );
  });
});
