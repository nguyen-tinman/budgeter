// CLI: import a bundle into the live DB. Auto-snapshots first, runs
// forward migrations, reports row counts. Counts and paths only.
//
// Usage:
//   pnpm --filter @budgetkit/api exec tsx src/db/scripts/db-import.ts <bundlePath>
import { importDatabase } from "@budgetkit/db";

const bundlePath = process.argv[2];
if (!bundlePath) {
  console.error("Usage: db-import <bundlePath>");
  process.exit(1);
}

const result = await importDatabase(bundlePath);
console.log(
  JSON.stringify(
    {
      backupPath: result.backupPath,
      importedSchemaVersion: result.imported.schema_version,
      importedAppVersion: result.imported.app_version,
      importedExportedAt: result.imported.exported_at,
      migrationsApplied: result.migrationsApplied,
      tableCount: Object.keys(result.rowCountsAfter).length,
      totalRowsAfter: Object.values(result.rowCountsAfter).reduce((s, n) => s + n, 0),
      preExportRowCounts: result.imported.table_row_counts,
      postImportRowCounts: result.rowCountsAfter,
      rowCountMismatches: result.rowCountMismatches,
    },
    null,
    2,
  ),
);
