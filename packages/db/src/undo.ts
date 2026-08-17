// Undo stack for assistant-driven changes, keyed to USER turns.
//
// The unit is deliberately the user turn, not the assistant turn: one request
// ("set up my 401k") can spawn many assistant turns and many tool calls, and a
// user thinks of that whole thing as ONE change. So a snapshot is taken at the
// start of each user turn and undo rewinds to the state before it.
//
// Snapshots are whole-database copies (VACUUM INTO), which is why undo can
// reverse any mix of tools without anyone writing an inverse operation per
// tool. The cost is that undo is a TIME machine, not a change filter: anything
// that happened after the snapshot is reverted, including edits made by hand in
// the UI. Callers must say so before restoring.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defaultDbConfig, openDb, type DatabaseSync } from "./database.js";

/** How many user turns you can walk back. */
export const UNDO_DEPTH = 10;
const MAX_LABEL_CHARS = 120;

export interface UndoSnapshot {
  id: string;
  /** ISO timestamp of when the snapshot was taken (start of the user turn). */
  takenAt: string;
  /** Short echo of the user message that opened the turn, for the UI. */
  label: string;
  sizeBytes: number;
}

interface ManifestEntry extends UndoSnapshot {
  file: string;
  sha256: string;
}

function undoDir(): string {
  return resolve(dirname(defaultDbConfig().path), "undo");
}

function manifestPath(): string {
  return join(undoDir(), "manifest.json");
}

function readManifest(): ManifestEntry[] {
  try {
    const raw = readFileSync(manifestPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ManifestEntry[]) : [];
  } catch {
    // Missing or corrupt manifest: an empty stack is the safe reading — undo
    // simply has nothing to offer rather than the app failing to start.
    return [];
  }
}

function writeManifest(entries: ManifestEntry[]): void {
  mkdirSync(undoDir(), { recursive: true });
  writeFileSync(manifestPath(), JSON.stringify(entries, null, 2), "utf8");
}

/** SQLite string literal: the only metacharacter is a single quote. Paths here
 *  come from our own config, never from user input, but doubling keeps a path
 *  containing an apostrophe from breaking the statement. */
function sqlLiteral(path: string): string {
  return `'${path.replace(/'/g, "''")}'`;
}

/**
 * Snapshot the database as the state BEFORE a user turn.
 *
 * Returns null when nothing changed since the previous snapshot — an unchanged
 * copy would otherwise consume one of the ten slots and shorten how far back
 * the user can actually reach.
 */
export function snapshotForUndo(label: string): UndoSnapshot | null {
  const db = openDb();
  mkdirSync(undoDir(), { recursive: true });

  const id = `u_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const file = join(undoDir(), `${id}.db`);

  // VACUUM INTO writes a consistent copy without blocking readers and without
  // touching the WAL of the live database.
  db.exec(`VACUUM INTO ${sqlLiteral(file)}`);

  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
  const entries = readManifest();
  const newest = entries[entries.length - 1];
  if (newest && newest.sha256 === sha256) {
    rmSync(file, { force: true });
    return null;
  }

  const entry: ManifestEntry = {
    id,
    file,
    sha256,
    takenAt: new Date().toISOString(),
    label: label.trim().slice(0, MAX_LABEL_CHARS),
    sizeBytes: statSync(file).size,
  };
  entries.push(entry);

  // Prune oldest beyond the depth limit, deleting their files too.
  while (entries.length > UNDO_DEPTH) {
    const dropped = entries.shift();
    if (dropped) rmSync(dropped.file, { force: true });
  }
  writeManifest(entries);

  return { id: entry.id, takenAt: entry.takenAt, label: entry.label, sizeBytes: entry.sizeBytes };
}

/**
 * Drop a snapshot without restoring it. Chat uses this when a turn took an
 * undo point up front and then recorded no successful mutation — keeping
 * those would fill the ten-step stack with questions that changed no budget
 * data, and walking them would rewind unrelated manual edits.
 */
export function discardUndoSnapshot(id: string): boolean {
  const entries = readManifest();
  const idx = entries.findIndex((e) => e.id === id);
  if (idx < 0) return false;
  const [removed] = entries.splice(idx, 1);
  writeManifest(entries);
  if (removed) rmSync(removed.file, { force: true });
  return true;
}

/** Newest first — the order the UI walks when undoing repeatedly. */
export function listUndoSnapshots(): UndoSnapshot[] {
  return readManifest()
    .slice()
    .reverse()
    .map(({ id, takenAt, label, sizeBytes }) => ({ id, takenAt, label, sizeBytes }));
}

export interface UndoRestoreResult {
  restored: boolean;
  /** The snapshot that was applied, if any. */
  snapshot?: UndoSnapshot;
  /** How many undo steps remain afterwards. */
  remaining: number;
  reason?: string;
}

/**
 * Restore the most recent snapshot and pop it, so repeated calls walk further
 * back. Content is copied table-by-table inside one transaction rather than by
 * replacing the database file: another process (the MCP server) may hold the
 * file open — fatal for a file swap on Windows — and a transaction means a
 * failure part-way leaves the database untouched rather than half-rewound.
 */
export function undoLastUserTurn(): UndoRestoreResult {
  const entries = readManifest();
  const entry = entries[entries.length - 1];
  if (!entry) return { restored: false, remaining: 0, reason: "nothing to undo" };
  if (!existsSync(entry.file)) {
    entries.pop();
    writeManifest(entries);
    return { restored: false, remaining: entries.length, reason: "snapshot file is missing" };
  }

  const db = openDb();
  applySnapshot(db, entry.file);

  entries.pop();
  writeManifest(entries);
  rmSync(entry.file, { force: true });

  return {
    restored: true,
    snapshot: { id: entry.id, takenAt: entry.takenAt, label: entry.label, sizeBytes: entry.sizeBytes },
    remaining: entries.length,
  };
}

function tableNames(db: DatabaseSync, schema: string): string[] {
  return db
    .prepare(
      `SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )
    .all()
    .map((r: { name: string }) => r.name);
}

/** Tables that record which migrations have been applied. Restoring these
 *  from an older snapshot would make `migrate()` treat newer, already-applied
 *  migrations as pending and re-run non-idempotent DDL. */
const MIGRATION_META_TABLES = new Set(["schema_migrations"]);

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function tableColumns(db: DatabaseSync, schema: string, table: string): string[] {
  return db
    .prepare(`PRAGMA ${schema}.table_info(${quoteIdent(table)})`)
    .all()
    .map((r: { name: string }) => r.name);
}

function applySnapshot(db: DatabaseSync, file: string): void {
  db.exec(`ATTACH DATABASE ${sqlLiteral(file)} AS undo_src`);
  try {
    // Foreign keys off for the duration: rows are replaced wholesale, so
    // intermediate states legitimately violate constraints that hold before
    // and after. Restored inside the finally below.
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
    try {
      const source = new Set(tableNames(db, "undo_src"));
      // Tables the snapshot doesn't know about (added by a migration since)
      // are emptied rather than left with rows from the future. Migration
      // metadata is left alone so the live schema version stays authoritative.
      for (const table of tableNames(db, "main")) {
        if (MIGRATION_META_TABLES.has(table)) continue;
        db.exec(`DELETE FROM main.${quoteIdent(table)}`);
        if (!source.has(table)) continue;
        // Copy only columns that exist on both sides. A wholesale SELECT *
        // breaks when a later migration added or removed a column; shared
        // names still restore the snapshot's budget data, and new columns
        // keep their DEFAULT / NULL.
        const destCols = new Set(tableColumns(db, "main", table));
        const shared = tableColumns(db, "undo_src", table).filter((c) => destCols.has(c));
        if (shared.length === 0) continue;
        const cols = shared.map(quoteIdent).join(", ");
        db.exec(
          `INSERT INTO main.${quoteIdent(table)} (${cols}) SELECT ${cols} FROM undo_src.${quoteIdent(table)}`,
        );
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("DETACH DATABASE undo_src");
  }
}
