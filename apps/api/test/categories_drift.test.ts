// Drift guard: a freshly-migrated DB's `categories` table MUST exactly equal
// the canonical BUDGET category set. This ties the persisted taxonomy to the
// web's hardcoded `CATEGORIES` (apps/web/src/lib/helpers.ts) so the two can
// never silently diverge again — the colliding-ids data-integrity bug that
// migration 008_categories_budget_set fixed.
//
// The expected rows below are the single source of truth that BOTH the DB
// migrations AND apps/web/src/lib/helpers.ts CATEGORIES must match (id, name,
// color_hex). If you change the budget set, update all three together — this
// test will fail loudly otherwise.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Canonical budget set — MUST match apps/web/src/lib/helpers.ts CATEGORIES.
const CANONICAL_BUDGET_SET: ReadonlyArray<{ id: number; name: string; color_hex: string }> = [
  { id: 1, name: "Housing",        color_hex: "#c97a4a" },
  { id: 2, name: "Utilities",      color_hex: "#7a9ec9" },
  { id: 3, name: "Communications", color_hex: "#a07cc9" },
  { id: 4, name: "Food",           color_hex: "#c9a14a" },
  { id: 5, name: "Transport",      color_hex: "#7ec98a" },
  { id: 6, name: "Subscriptions",  color_hex: "#c97a98" },
  { id: 7, name: "Insurance",      color_hex: "#5db8b8" },
  { id: 8, name: "Discretionary",  color_hex: "#9a9a9a" },
  { id: 9, name: "Annual fees",    color_hex: "#b89a4a" },
];

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "budgetkit-cats-drift-"));
  // Point the DB layer at a throwaway file so we exercise the full 001→008
  // migration chain on a fresh DB without touching ./data/budgetkit.db.
  process.env.BUDGETKIT_DB = join(tmpRoot, "test.db");
});

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("categories drift guard (migrations 001→008)", () => {
  it("a freshly-migrated DB's categories table EXACTLY equals the canonical budget set", async () => {
    const { openDb, closeDb, migrate } = await import("@budgetkit/db");
    closeDb();
    const db = openDb();
    migrate(db);

    const rows = db
      .prepare("SELECT id, name, color_hex FROM categories ORDER BY id")
      .all() as Array<{ id: number; name: string; color_hex: string }>;

    expect(rows).toEqual(CANONICAL_BUDGET_SET);

    // Belt-and-suspenders: every builtin row stays flagged builtin=1 and there
    // is no leftover "Other" row (id 10 was deleted by migration 008).
    const builtinCount = (
      db.prepare("SELECT COUNT(*) AS n FROM categories WHERE builtin = 1").get() as { n: number }
    ).n;
    expect(builtinCount).toBe(CANONICAL_BUDGET_SET.length);
    const other = db.prepare("SELECT id FROM categories WHERE name = 'Other'").get();
    expect(other).toBeUndefined();

    closeDb();
  });
});
