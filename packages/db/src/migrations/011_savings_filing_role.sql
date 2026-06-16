-- Adds an owner (filing_role) to savings_items so a dual-earner MFJ household's
-- payroll withholdings (traditional/Roth 401k, HSA) can be attributed to the
-- correct filer.
--
-- Before this migration, compute_take_home resolved ALL savings withholdings
-- against the PRIMARY filer's salary and fed them into the PRIMARY leg of the
-- take-home calculation, while the spouse leg's pretax/post-tax payroll were
-- hardcoded to 0. A spouse's 401k/Roth contributions were silently dropped,
-- so dual-earner households got the wrong take-home.
--
-- filing_role mirrors incomes.filing_role:
--   'primary' (default) — owned by the primary filer; %-of-salary resolves
--                         against the primary's taxed gross.
--   'spouse'            — owned by the spouse filer; %-of-salary resolves
--                         against the spouse's taxed gross and feeds the spouse
--                         leg of takeHome().
--
-- NOT NULL DEFAULT 'primary' is behavior-preserving: every existing row becomes
-- 'primary', which is exactly how withholdings were resolved before, so
-- single-earner workspaces are unaffected and no backfill is required.

ALTER TABLE savings_items ADD COLUMN filing_role TEXT NOT NULL DEFAULT 'primary'
  CHECK (filing_role IN ('primary', 'spouse'));
