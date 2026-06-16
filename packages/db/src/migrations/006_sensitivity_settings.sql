-- sensitivity_settings: persisted axis ranges for the Planning page's
-- sensitivity grid, one row per workspace. Mirrors retirement_settings'
-- shape (PRIMARY KEY on workspace_id, FK CASCADE on workspace delete) so the
-- grid's last-used primary/spouse income ranges round-trip through the DB the
-- same way retirement projection inputs do.
--
-- All four range bounds are integer CENTS (the app's money convention; $50,000
-- → 5000000). primary_low < primary_high and spouse_low <= spouse_high mirror
-- the UI's range validation; the spouse axis may collapse to a single point
-- (low == high) which the grid renders as a degenerate column, so its lower
-- bound is <= rather than <.
--
-- Idempotent: the migration runner (migrate.ts) only applies versions without
-- a row in schema_migrations, so re-running this file is a no-op.

CREATE TABLE sensitivity_settings (
  workspace_id        INTEGER PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  primary_low_cents   INTEGER NOT NULL,
  primary_high_cents  INTEGER NOT NULL,
  spouse_low_cents    INTEGER NOT NULL,
  spouse_high_cents   INTEGER NOT NULL,
  CHECK (primary_low_cents >= 0 AND spouse_low_cents >= 0),
  CHECK (primary_low_cents < primary_high_cents),
  CHECK (spouse_low_cents <= spouse_high_cents)
);
