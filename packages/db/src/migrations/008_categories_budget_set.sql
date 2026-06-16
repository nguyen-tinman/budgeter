-- Make the BUDGET category set the single canonical taxonomy (schema_version 8).
--
-- Background / the bug this fixes:
--   The web budget UI used one category taxonomy (`CATEGORIES` in
--   apps/web/src/lib/helpers.ts) while the DB/Trends/assistant used the
--   001_init.sql seed — a DIFFERENT taxonomy with COLLIDING ids. E.g. budget
--   id 4 = "Food" but DB id 4 = "Gas", so categorizing on the Budget page
--   mislabeled everything in Trends + the assistant. This migration converges
--   the DB onto the budget set so there is exactly one taxonomy.
--
-- Canonical budget set (id, name, color_hex) — mirrors helpers.CATEGORIES:
--   1 Housing #c97a4a · 2 Utilities #7a9ec9 · 3 Communications #a07cc9
--   4 Food #c9a14a · 5 Transport #7ec98a · 6 Subscriptions #c97a98
--   7 Insurance #5db8b8 · 8 Discretionary #9a9a9a · 9 Annual fees #b89a4a
-- (9 categories, NO "Other".)
--
-- Live-data semantics (verified before this migration was written):
--   * MANUAL expenses (expenses.source='manual') already hold BUDGET-semantic
--     category_ids (the budget UI wrote ids 1–9). They are LEFT UNCHANGED —
--     once `categories` becomes the budget set, those ids already mean the
--     right thing.
--   * IMPORTED expenses (source != 'manual') AND ALL rows in `transactions`
--     hold OLD-DB-semantic category_ids (assigned by the merchant resolver
--     against the old DB names). These are remapped below.
--
-- Old-DB → budget id remap (applied ONLY to old-DB-semantic rows):
--   1→1 (Rent→Housing), 2→2 (Utilities→Utilities), 3→4 (Food→Food),
--   4→5 (Gas→Transport), 5→7 (Auto Insurance→Insurance),
--   6→8 (Health→Discretionary), 7→6 (Subscriptions→Subscriptions),
--   8→5 (Tolls→Transport), 9→9 (Annual Fees→Annual fees),
--   10→8 (Other→Discretionary).
--
-- Order matters: remap the FK-referencing rows FIRST (while ids 1–10 still
-- point at the old table), THEN converge the `categories` table and delete
-- id 10. Each remap uses a SINGLE CASE expression evaluated against the
-- ORIGINAL value, so it cannot chain/double-apply (e.g. 3→4 and 4→5 don't
-- compose into 3→5 — every row is rewritten exactly once).
--
-- Idempotent: the migration runner only applies versions absent from
-- schema_migrations, so re-running is a no-op. Works on an existing populated
-- DB and on a fresh one where 001→007 already ran. The whole file runs inside
-- the single BEGIN/COMMIT supplied by migrate.ts.

------------------------------------------------------------
-- 1. Remap old-DB-semantic category_ids FIRST (keep FKs valid).
------------------------------------------------------------
-- transactions: every row is old-DB-semantic.
UPDATE transactions
   SET category_id = CASE category_id
     WHEN 3  THEN 4   -- Food            → Food
     WHEN 4  THEN 5   -- Gas             → Transport
     WHEN 5  THEN 7   -- Auto Insurance  → Insurance
     WHEN 6  THEN 8   -- Health          → Discretionary
     WHEN 7  THEN 6   -- Subscriptions   → Subscriptions
     WHEN 8  THEN 5   -- Tolls           → Transport
     WHEN 10 THEN 8   -- Other           → Discretionary
     ELSE category_id -- 1 (Rent→Housing), 2 (Utilities), 9 (Annual Fees) and NULL unchanged
   END;

-- expenses: only the imported (non-manual) rows are old-DB-semantic.
UPDATE expenses
   SET category_id = CASE category_id
     WHEN 3  THEN 4
     WHEN 4  THEN 5
     WHEN 5  THEN 7
     WHEN 6  THEN 8
     WHEN 7  THEN 6
     WHEN 8  THEN 5
     WHEN 10 THEN 8
     ELSE category_id
   END
 WHERE source != 'manual';

------------------------------------------------------------
-- 2. Converge the `categories` table onto the budget set.
------------------------------------------------------------
-- After step 1, nothing references id 10 any more, so deleting it is safe.
-- ids are stable (PK), so existing FK references stay valid through the
-- in-place UPDATEs below.
--
-- `categories.name` is UNIQUE. Some BUDGET names collide with OLD names on a
-- DIFFERENT row, so a naive id-ordered rename can transiently violate the
-- constraint (old id 3 = "Food" vs new id 4 = "Food"; old id 7 =
-- "Subscriptions" vs new id 6 = "Subscriptions"). To stay constraint-safe
-- regardless of ordering, first move every row to a unique temporary sentinel
-- ("__bk_tmp_<id>"), then assign the final budget names — at which point no
-- old name can collide with a new one.
-- Tolerant rename: only touch rows that currently exist. Running this on a
-- DB where the 001 seed was already overwritten (e.g. after a partial
-- prior run, or a future migration that trims the seed) will silently no-op
-- for missing ids rather than failing. The final INSERT ... ON CONFLICT
-- ensures any budget-set row that is entirely absent is created fresh.
--
-- Step 1: move existing rows to unique sentinels to avoid transient UNIQUE
-- constraint violations during the rename sequence (e.g. old id 3 = "Food"
-- collides with new id 4 = "Food" if renamed in id order).
UPDATE categories SET name = '__bk_tmp_' || id
 WHERE id BETWEEN 1 AND 9 AND EXISTS (SELECT 1 FROM categories WHERE id = categories.id);

-- Step 2: assign final budget names. Rows absent from the seed are upserted
-- so the budget set is complete regardless of what the seed contained.
INSERT INTO categories (id, name, color_hex, builtin) VALUES
  (1, 'Housing',        '#c97a4a', 1),
  (2, 'Utilities',      '#7a9ec9', 1),
  (3, 'Communications', '#a07cc9', 1),
  (4, 'Food',           '#c9a14a', 1),
  (5, 'Transport',      '#7ec98a', 1),
  (6, 'Subscriptions',  '#c97a98', 1),
  (7, 'Insurance',      '#5db8b8', 1),
  (8, 'Discretionary',  '#9a9a9a', 1),
  (9, 'Annual fees',    '#b89a4a', 1)
ON CONFLICT(id) DO UPDATE SET
  name      = excluded.name,
  color_hex = excluded.color_hex,
  builtin   = excluded.builtin;

DELETE FROM categories WHERE id = 10;
