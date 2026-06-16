// CLI: export the live DB to ./data/exports/budgetkit-export-YYYY-MM-DD-HHmmss.db
// plus a sidecar .manifest.json. Counts and paths only — no PII.
//
// Usage: pnpm --filter @budgetkit/api exec tsx src/db/scripts/db-export.ts
import { exportDatabase } from "@budgetkit/db";

const result = await exportDatabase();
console.log(
  JSON.stringify(
    {
      bundlePath: result.bundlePath,
      manifestPath: result.manifestPath,
      schema_version: result.manifest.schema_version,
      app_version: result.manifest.app_version,
      exported_at: result.manifest.exported_at,
      tableCount: Object.keys(result.manifest.table_row_counts).length,
      totalRows: Object.values(result.manifest.table_row_counts).reduce((s, n) => s + n, 0),
    },
    null,
    2,
  ),
);
