import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { openDb, type DatabaseSync } from "./database.js";

// migrations/*.sql live at packages/db/src/migrations. When running via tsx
// import.meta.dirname == src; when running from dist (compiled) it == dist
// and we look one level back at src/migrations/ which is shipped alongside.
function resolveMigrationsDir(): string {
  const here = resolve(import.meta.dirname, "migrations");
  if (existsSync(here)) return here;
  const fromDist = resolve(import.meta.dirname, "..", "src", "migrations");
  if (existsSync(fromDist)) return fromDist;
  return here; // surface the original path in the error
}
const MIGRATIONS_DIR = resolveMigrationsDir();

function ensureMigrationTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function listMigrations(): { id: string; sql: string }[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files.map((f) => ({
    id: f.replace(/\.sql$/, ""),
    sql: readFileSync(resolve(MIGRATIONS_DIR, f), "utf8"),
  }));
}

/**
 * Authoritative schema version — derived from the number of SQL migration
 * files in packages/db/src/migrations/. Never hardcode this value; add a
 * new *.sql file instead. The backup gate (backup.ts) imports from here so
 * it always reflects the true migration count.
 */
export const SCHEMA_VERSION: number = listMigrations().length;

function appliedSet(db: DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT id FROM schema_migrations").all() as {
    id: string;
  }[];
  return new Set(rows.map((r) => r.id));
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Migrations that use the table-rebuild pattern (CREATE new → INSERT …
 * SELECT old → DROP old → ALTER RENAME). The pattern drops and recreates
 * tables, which is safe under foreign_keys=OFF but will fail or behave
 * incorrectly under foreign_keys=ON if any dependent table still holds
 * references to the old table name during the DROP step.
 *
 * These migrations explicitly disable FK enforcement for their duration and
 * restore it after. Keeping this set here ensures future table-rebuild
 * migrations also get wrapped.
 */
const TABLE_REBUILD_MIGRATIONS = new Set(["007_cents_to_dollars"]);

export function migrate(db: DatabaseSync = openDb()): MigrateResult {
  ensureMigrationTable(db);
  const applied = appliedSet(db);
  const all = listMigrations();

  const result: MigrateResult = { applied: [], alreadyApplied: [] };
  const insert = db.prepare("INSERT INTO schema_migrations (id) VALUES (?)");

  for (const m of all) {
    if (applied.has(m.id)) {
      result.alreadyApplied.push(m.id);
      continue;
    }

    // Table-rebuild migrations violate FK ordering during DROP (the old table
    // is referenced by live FK constraints until it is renamed away). Wrap
    // with PRAGMA foreign_keys=OFF so SQLite does not enforce FK consistency
    // mid-rebuild. Restored unconditionally (even on error) so FK enforcement
    // stays enabled for the rest of the session.
    const needsFkOff = TABLE_REBUILD_MIGRATIONS.has(m.id);
    if (needsFkOff) {
      db.exec("PRAGMA foreign_keys = OFF");
    }

    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      insert.run(m.id);
      db.exec("COMMIT");
      result.applied.push(m.id);
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${m.id} failed: ${(e as Error).message}`);
    } finally {
      if (needsFkOff) {
        db.exec("PRAGMA foreign_keys = ON");
      }
    }
  }
  return result;
}

