// Cross-package schema version drift guard.
//
// packages/core exports a compat literal SCHEMA_VERSION that other consumers
// (apps/api, apps/mcp) import for display / debug. The authoritative value
// lives in packages/db/src/migrate.ts and is derived from the SQL migration
// file count — never hardcoded. This test asserts the two are equal so any
// migration added by another train that forgets to update core's literal is
// caught immediately.

import { describe, it, expect } from "vitest";
import { SCHEMA_VERSION as coreSV } from "@budgetkit/core";
import { SCHEMA_VERSION as dbSV } from "@budgetkit/db";

describe("SCHEMA_VERSION consistency (D5 guard)", () => {
  it("core compat literal matches the authoritative db migration count", () => {
    expect(coreSV).toBe(dbSV);
  });

  it("schema version is a positive integer >= 10", () => {
    // Sanity: we have at least 10 migrations committed; the value must never
    // regress below that. If this fires, a migration was accidentally deleted.
    expect(dbSV).toBeGreaterThanOrEqual(10);
    expect(Number.isInteger(dbSV)).toBe(true);
  });
});
