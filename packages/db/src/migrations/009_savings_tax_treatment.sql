-- Adds an optional per-account tax-treatment OVERRIDE to savings_items.
--
-- NULL (the default) → derive the treatment from account_type via
-- core/account_tax.ts accountTaxTreatment(). A non-null value lets the user
-- reclassify ANY account — especially 'other' or future investment types —
-- independent of its account_type:
--   'payroll_pretax'  — traditional-401k / HSA style: reduces taxable income
--                       AND take-home cash.
--   'payroll_posttax' — Roth-401k style: reduces take-home cash, NOT taxable.
--   'from_cash'       — Roth-IRA / brokerage / HYSA style: a USE of take-home,
--                       not a reduction of it.
--
-- Honored by resolveTreatment / resolveWithholdings in core. Existing rows keep
-- NULL and behave exactly as before. Optional + nullable, so no backfill.

ALTER TABLE savings_items ADD COLUMN tax_treatment TEXT
  CHECK (tax_treatment IS NULL OR tax_treatment IN ('payroll_pretax', 'payroll_posttax', 'from_cash'));
