import { openDb, closeDb, migrate } from "@budgetkit/db";

const db = openDb();
try {
  const r = migrate(db);
  console.log(JSON.stringify(r, null, 2));
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  console.log(`\nTables (${tables.length}):`);
  for (const t of tables) console.log(`  ${t.name}`);
} finally {
  closeDb();
}
