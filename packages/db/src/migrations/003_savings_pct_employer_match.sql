-- Adds 401k-as-%-of-salary and employer-match support to savings_items.
--
-- All three columns are OPTIONAL (nullable / 'none' default). Existing rows
-- are untouched and continue to use monthly_contribution_cents as the source
-- of truth. The new fields are interpreted by core/retirement_projector.ts'
-- effectiveMonthlyContributionCents() helper:
--
--   * contribution_pct_of_salary (REAL, 0..1)
--       When set AND non-null AND non-zero, the row's effective monthly
--       employee contribution is computed as
--           (primary_taxed_gross_annual_cents * pct) / 12
--       instead of using monthly_contribution_cents directly. This is the
--       "401k as % of salary" knob.
--
--   * employer_match_kind (TEXT, one of 'none' | 'pct_of_salary' | 'flat_annual_cents')
--       Always present (default 'none'). Determines how employer_match_value
--       is interpreted.
--
--   * employer_match_value (REAL, nullable)
--       Meaning depends on kind:
--         - 'pct_of_salary'    : 0..1 fraction (e.g. 0.05 = 5% match)
--         - 'flat_annual_cents': integer cents per year (stored as REAL to
--                                share one column; cast on read)
--         - 'none'             : ignored
--
-- Idempotent: each ALTER is wrapped only by the migration runner's
-- one-shot apply (schema_migrations row prevents re-application).

ALTER TABLE savings_items ADD COLUMN contribution_pct_of_salary REAL;

ALTER TABLE savings_items ADD COLUMN employer_match_kind TEXT NOT NULL
  DEFAULT 'none'
  CHECK (employer_match_kind IN ('none', 'pct_of_salary', 'flat_annual_cents'));

ALTER TABLE savings_items ADD COLUMN employer_match_value REAL;
