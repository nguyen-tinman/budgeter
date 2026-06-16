import { dirname, resolve } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

// `node:sqlite` is a Node 23+ builtin. Vite's transform pipeline (used by
// vitest 2.x) tries to resolve it on disk and fails because it strips the
// `node:` prefix. createRequire bypasses Vite's static analysis entirely —
// the import happens at runtime through Node's native resolver.
const nodeRequire = createRequire(import.meta.url);

// `any` is intentional — typing this requires a `typeof import("node:sqlite")`
// expression that Vite's static analyser treats as a real import and tries to
// resolve. The runtime shape is fully exercised by tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sqliteMod: any = nodeRequire("node:sqlite");
const { DatabaseSync } = sqliteMod;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DatabaseSync = any;

export interface DbConfig {
  /** Absolute path to the SQLite file. */
  path: string;
}

// import.meta.dirname is packages/db/src when running tsx, packages/db/dist
// after build. Three levels up from EITHER is the repo root.
const REPO_ROOT_FROM_DB_DIR = "../../..";

export function defaultDbConfig(): DbConfig {
  const repoRoot = resolve(import.meta.dirname, REPO_ROOT_FROM_DB_DIR);
  return {
    path: process.env.BUDGETKIT_DB ?? resolve(repoRoot, "data", "budgetkit.db"),
  };
}

let dbInstance: DatabaseSync | null = null;

export function openDb(config: DbConfig = defaultDbConfig()): DatabaseSync {
  if (dbInstance) return dbInstance;

  if (!existsSync(dirname(config.path))) {
    mkdirSync(dirname(config.path), { recursive: true });
  }

  const db = new DatabaseSync(config.path);

  // WAL allows readers (MCP server) concurrent with the writer (API).
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");

  dbInstance = db;
  return db;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
