# Database Import / Export

## Why

The shipped app artifact contains only code, never personal data. The user's DB
lives in `./data/budgetkit.db` and survives app upgrades because the upgrader
doesn't replace `./data/`. For machine migration or first-run-on-new-install,
the user exports a versioned bundle from the old install and imports it on the
new one.

## Bundle format

A bundle is two files travelling together:

```
budgetkit-export-2026-05-26-194530-123-00.db              # the SQLite file
budgetkit-export-2026-05-26-194530-123-00.db.manifest.json # sidecar
```

The timestamp format is `YYYY-MM-DD-HHmmss-mmm-seq` where `mmm` is
milliseconds and `seq` is a per-process counter (00–99) that prevents
collisions when two exports happen within the same millisecond.

The `.db` is a flat copy of `budgetkit.db` after `PRAGMA wal_checkpoint(TRUNCATE)`
so the WAL is fully flushed into the main file.

The manifest is human-readable JSON:

```json
{
  "manifest_version": 1,
  "schema_version": 1,
  "app_version": "0.1.0",
  "exported_at": "2026-05-26T19:45:30.123Z",
  "source_db_path": "C:/.../data/budgetkit.db",
  "file_sha256": "a3f2...hex64...",
  "file_size_bytes": 102400,
  "table_row_counts": {
    "workspaces": 1,
    "expenses": 0,
    "incomes": 0,
    "categories": 8,
    "tax_tables": 6,
    "recurring_subscriptions": 0,
    ...
  }
}
```

The manifest lets the importer:
- Reject bundles whose `schema_version` is newer than the app understands (with
  a clear message: "Upgrade the app before importing").
- Run forward migrations on the bundle if `schema_version` is older.
- Show the user a before/after row-count diff after import.
- Be validated WITHOUT opening the SQLite file (cheap pre-flight).

## Export flow

1. `PRAGMA wal_checkpoint(TRUNCATE)` to flush WAL.
2. Close the DB to release the file handle (Windows is strict).
3. `copyFileSync()` to `./data/exports/budgetkit-export-{ts}.db`.
4. Compute and write the manifest sidecar.

## Import flow

1. Read manifest, validate `schema_version <= SCHEMA_VERSION`.
2. If a live DB exists, snapshot it to `./data/backups/auto-pre-import-{ts}.db`
   so the user can roll back from a bad import.
3. Atomic swap: copy bundle to `{live_path}.import-tmp`, remove live file +
   `-wal` + `-shm` sidecars, rename tmp to live path.
4. Reopen DB, run forward migrations if `bundle.schema_version < SCHEMA_VERSION`.
5. Return `{backupPath, importedManifest, migrationsApplied, rowCountsAfter}`.

## Why a separate sidecar instead of a meta table inside the DB

- Lets the importer validate cheaply without opening SQLite.
- Lets the user inspect the manifest in a text editor.
- Keeps the DB itself byte-identical to a normal backup (no app-private rows).

## Failure modes covered (tests in `apps/api/test/backup.test.ts`)

- Round-trip preserves seeded data and row counts ✓
- Auto-backup created when live DB exists at import time ✓
- Manifest with newer schema_version is rejected ✓
- Missing manifest sidecar is rejected ✓

## CLI scripts

```bash
# Export the live DB
pnpm --filter @budgetkit/api exec tsx src/db/scripts/db-export.ts
# → writes ./data/exports/budgetkit-export-{ts}.db + .manifest.json

# Import a bundle
pnpm --filter @budgetkit/api exec tsx src/db/scripts/db-import.ts ./data/exports/budgetkit-export-{ts}.db
# → snapshots current DB to ./data/backups/auto-pre-import-{ts}.db, swaps,
#   runs forward migrations, prints row count diff
```

## UI (shipped in M10)

`/setup` exposes a "Database Backup & Restore" panel:
- **Export** button → writes a bundle, toast shows the absolute path + "Open folder" link.
- **Import** button → file picker → validate → auto-backup → atomic swap → confirmation modal with before/after row counts.
- **Backups list** → scrollable list of `./data/backups/*.db` with per-row "Restore" / "Delete".
- **Schema version** displayed in the header.
