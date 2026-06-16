-- Convert every monetary column from integer CENTS to floating-point DOLLARS.
--
-- The product owner chose float dollars over integer cents / a decimal library,
-- accepting the rounding tradeoff. Float drift is bounded by rounding to 2dp at
-- every storage + computation boundary in the application code (core/round2).
-- This migration restates the persisted schema in the same unit: each
-- `*_cents INTEGER` column becomes `*_dollars REAL`, dividing existing data by
-- 100.0 ($7,000 stored as 700000 cents becomes 7000.0 dollars).
--
-- SQLite can't rename + retype a column in place cleanly, so each money-bearing
-- table is rebuilt with the table-recreate pattern (CREATE new → INSERT…SELECT
-- old/100.0 → DROP old → ALTER RENAME), preserving PKs/FKs/CHECKs/indexes.
-- Tables WITHOUT money columns (workspaces, categories, recurring_subscriptions
-- has amount_cents — rebuilt; rolling_bills has monthly_average_cents — rebuilt;
-- statement_imports, review_queue, llama_profiles, tools_call_log, app_settings,
-- schema_migrations) are left untouched except where they carry a money column.
--
-- tax_tables.brackets_json stores [{"upTo": <cents|null>, "rate": <0..1>}]. Each
-- upTo is divided by 100.0 in place via json_each/json_group_array, preserving
-- null for the top bracket. standard_deduction_cents → standard_deduction_dollars.
--
-- Idempotent: the migration runner only applies versions absent from
-- schema_migrations, so re-running this file is a no-op. The whole file runs in
-- one BEGIN/COMMIT supplied by migrate.ts.

------------------------------------------------------------
-- expenses: amount_cents → amount_dollars
------------------------------------------------------------
CREATE TABLE expenses_new (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id          INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label                 TEXT NOT NULL,
  amount_dollars        REAL NOT NULL,
  frequency             TEXT NOT NULL CHECK (frequency IN ('weekly','biweekly','monthly','quarterly','annually','one_time')),
  category_id           INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  source                TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','imported','recurring_detector','ground_truth')),
  linked_recurring_id   INTEGER REFERENCES recurring_subscriptions(id) ON DELETE SET NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO expenses_new
  (id, workspace_id, label, amount_dollars, frequency, category_id, source, linked_recurring_id, created_at, updated_at)
  SELECT id, workspace_id, label, amount_cents / 100.0, frequency, category_id, source, linked_recurring_id, created_at, updated_at
    FROM expenses;
DROP TABLE expenses;
ALTER TABLE expenses_new RENAME TO expenses;
CREATE INDEX idx_expenses_workspace ON expenses(workspace_id);

------------------------------------------------------------
-- incomes: gross_annual_cents → gross_annual_dollars
------------------------------------------------------------
CREATE TABLE incomes_new (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id             INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label                    TEXT NOT NULL,
  gross_annual_dollars     REAL NOT NULL,
  tax_status               TEXT NOT NULL CHECK (tax_status IN ('pretax','posttax','taxed','untaxable')),
  is_federal_income_tax    INTEGER NOT NULL DEFAULT 1,
  filing_role              TEXT NOT NULL DEFAULT 'primary' CHECK (filing_role IN ('primary','spouse')),
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO incomes_new
  (id, workspace_id, label, gross_annual_dollars, tax_status, is_federal_income_tax, filing_role, created_at, updated_at)
  SELECT id, workspace_id, label, gross_annual_cents / 100.0, tax_status, is_federal_income_tax, filing_role, created_at, updated_at
    FROM incomes;
DROP TABLE incomes;
ALTER TABLE incomes_new RENAME TO incomes;
CREATE INDEX idx_incomes_workspace ON incomes(workspace_id);

------------------------------------------------------------
-- recurring_subscriptions: amount_cents → amount_dollars
------------------------------------------------------------
CREATE TABLE recurring_subscriptions_new (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_normalized   TEXT NOT NULL,
  amount_dollars        REAL NOT NULL,
  cadence_days          INTEGER NOT NULL,
  last_seen             TEXT,
  source_account        TEXT,
  confidence            REAL NOT NULL DEFAULT 0,
  manually_added        INTEGER NOT NULL DEFAULT 0,
  notes                 TEXT
);
INSERT INTO recurring_subscriptions_new
  (id, merchant_normalized, amount_dollars, cadence_days, last_seen, source_account, confidence, manually_added, notes)
  SELECT id, merchant_normalized, amount_cents / 100.0, cadence_days, last_seen, source_account, confidence, manually_added, notes
    FROM recurring_subscriptions;
DROP TABLE recurring_subscriptions;
ALTER TABLE recurring_subscriptions_new RENAME TO recurring_subscriptions;
CREATE INDEX idx_recurring_merchant ON recurring_subscriptions(merchant_normalized);

------------------------------------------------------------
-- rolling_bills: monthly_average_cents → monthly_average_dollars
------------------------------------------------------------
CREATE TABLE rolling_bills_new (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id             INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  category                 TEXT NOT NULL,
  monthly_average_dollars  REAL NOT NULL,
  computed_at              TEXT NOT NULL DEFAULT (datetime('now')),
  source                   TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','baseline_roller'))
);
INSERT INTO rolling_bills_new
  (id, workspace_id, category, monthly_average_dollars, computed_at, source)
  SELECT id, workspace_id, category, monthly_average_cents / 100.0, computed_at, source
    FROM rolling_bills;
DROP TABLE rolling_bills;
ALTER TABLE rolling_bills_new RENAME TO rolling_bills;
CREATE INDEX idx_rolling_bills_workspace ON rolling_bills(workspace_id);

------------------------------------------------------------
-- savings_items: current/target/monthly + employer_match_value (flat_annual)
-- current_balance_cents → current_balance_dollars
-- target_balance_cents  → target_balance_dollars
-- monthly_contribution_cents → monthly_contribution_dollars
-- employer_match_value: when kind = 'flat_annual_cents' it stored cents → now
--   stored as dollars and the kind label becomes 'flat_annual_dollars'.
--   pct_of_salary values (0..1 fractions) are NOT divided.
------------------------------------------------------------
CREATE TABLE savings_items_new (
  id                            INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id                  INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label                         TEXT NOT NULL,
  current_balance_dollars       REAL NOT NULL DEFAULT 0,
  target_balance_dollars        REAL,
  monthly_contribution_dollars  REAL NOT NULL DEFAULT 0,
  account_type                  TEXT NOT NULL CHECK (account_type IN ('hysa','brokerage','roth_ira','traditional_401k','roth_401k','hsa','other')),
  contribution_pct_of_salary    REAL,
  employer_match_kind           TEXT NOT NULL DEFAULT 'none' CHECK (employer_match_kind IN ('none', 'pct_of_salary', 'flat_annual_dollars')),
  employer_match_value          REAL,
  created_at                    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                    TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO savings_items_new
  (id, workspace_id, label, current_balance_dollars, target_balance_dollars,
   monthly_contribution_dollars, account_type, contribution_pct_of_salary,
   employer_match_kind, employer_match_value, created_at, updated_at)
  SELECT id, workspace_id, label,
         current_balance_cents / 100.0,
         CASE WHEN target_balance_cents IS NULL THEN NULL ELSE target_balance_cents / 100.0 END,
         monthly_contribution_cents / 100.0,
         account_type,
         contribution_pct_of_salary,
         CASE WHEN employer_match_kind = 'flat_annual_cents' THEN 'flat_annual_dollars' ELSE employer_match_kind END,
         CASE WHEN employer_match_kind = 'flat_annual_cents' AND employer_match_value IS NOT NULL
              THEN employer_match_value / 100.0
              ELSE employer_match_value END,
         created_at, updated_at
    FROM savings_items;
DROP TABLE savings_items;
ALTER TABLE savings_items_new RENAME TO savings_items;
CREATE INDEX idx_savings_workspace ON savings_items(workspace_id);

------------------------------------------------------------
-- tax_tables: standard_deduction_cents → standard_deduction_dollars +
-- brackets_json upTo cents → dollars (preserving null for top bracket)
------------------------------------------------------------
CREATE TABLE tax_tables_new (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  year                        INTEGER NOT NULL,
  jurisdiction                TEXT NOT NULL CHECK (jurisdiction IN ('federal','ca')),
  filing                      TEXT NOT NULL CHECK (filing IN ('single','mfj')),
  standard_deduction_dollars  REAL NOT NULL,
  brackets_json               TEXT NOT NULL,
  source_url                  TEXT,
  UNIQUE (year, jurisdiction, filing)
);
INSERT INTO tax_tables_new
  (id, year, jurisdiction, filing, standard_deduction_dollars, brackets_json, source_url)
  SELECT id, year, jurisdiction, filing,
         standard_deduction_cents / 100.0,
         (SELECT json_group_array(
                   CASE WHEN json_extract(value, '$.upTo') IS NULL
                        THEN json_object('upTo', json('null'), 'rate', json_extract(value, '$.rate'))
                        ELSE json_object('upTo', json_extract(value, '$.upTo') / 100.0, 'rate', json_extract(value, '$.rate'))
                   END)
            FROM json_each(tax_tables.brackets_json)),
         source_url
    FROM tax_tables;
DROP TABLE tax_tables;
ALTER TABLE tax_tables_new RENAME TO tax_tables;

------------------------------------------------------------
-- tax_settings: ss_wage_base_cents → ss_wage_base_dollars
------------------------------------------------------------
CREATE TABLE tax_settings_new (
  workspace_id                       INTEGER PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  filing_status                      TEXT NOT NULL CHECK (filing_status IN ('single','mfj')),
  tax_year                           INTEGER NOT NULL,
  ca_sdi_rate                        REAL NOT NULL DEFAULT 0.011,
  ss_wage_base_dollars               REAL NOT NULL DEFAULT 176100,
  fica_ss_rate                       REAL NOT NULL DEFAULT 0.062,
  fica_medicare_rate                 REAL NOT NULL DEFAULT 0.0145,
  retirement_effective_tax_rate      REAL NOT NULL DEFAULT 0.12
);
INSERT INTO tax_settings_new
  (workspace_id, filing_status, tax_year, ca_sdi_rate, ss_wage_base_dollars,
   fica_ss_rate, fica_medicare_rate, retirement_effective_tax_rate)
  SELECT workspace_id, filing_status, tax_year, ca_sdi_rate,
         ss_wage_base_cents / 100.0,
         fica_ss_rate, fica_medicare_rate, retirement_effective_tax_rate
    FROM tax_settings;
DROP TABLE tax_settings;
ALTER TABLE tax_settings_new RENAME TO tax_settings;

------------------------------------------------------------
-- retirement_settings: initial_balance_cents → initial_balance_dollars
------------------------------------------------------------
CREATE TABLE retirement_settings_new (
  workspace_id                INTEGER PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  current_age                 INTEGER NOT NULL,
  retirement_age              INTEGER NOT NULL,
  initial_balance_dollars     REAL NOT NULL DEFAULT 0,
  growth_rate                 REAL NOT NULL DEFAULT 0.07,
  roth_split_pct              REAL NOT NULL DEFAULT 0.5,
  CHECK (retirement_age > current_age),
  CHECK (roth_split_pct >= 0 AND roth_split_pct <= 1)
);
INSERT INTO retirement_settings_new
  (workspace_id, current_age, retirement_age, initial_balance_dollars, growth_rate, roth_split_pct)
  SELECT workspace_id, current_age, retirement_age, initial_balance_cents / 100.0, growth_rate, roth_split_pct
    FROM retirement_settings;
DROP TABLE retirement_settings;
ALTER TABLE retirement_settings_new RENAME TO retirement_settings;

------------------------------------------------------------
-- transactions: amount_cents → amount_dollars
------------------------------------------------------------
CREATE TABLE transactions_new (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id             INTEGER NOT NULL REFERENCES statement_imports(id) ON DELETE CASCADE,
  posted_date           TEXT NOT NULL,
  merchant_raw          TEXT NOT NULL,
  merchant_normalized   TEXT NOT NULL,
  amount_dollars        REAL NOT NULL,
  category_id           INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  account_type          TEXT NOT NULL
);
INSERT INTO transactions_new
  (id, import_id, posted_date, merchant_raw, merchant_normalized, amount_dollars, category_id, account_type)
  SELECT id, import_id, posted_date, merchant_raw, merchant_normalized, amount_cents / 100.0, category_id, account_type
    FROM transactions;
DROP TABLE transactions;
ALTER TABLE transactions_new RENAME TO transactions;
CREATE INDEX idx_txn_merchant ON transactions(merchant_normalized);
CREATE INDEX idx_txn_date ON transactions(posted_date);

------------------------------------------------------------
-- sensitivity_settings: *_cents → *_dollars (migration 006)
------------------------------------------------------------
CREATE TABLE sensitivity_settings_new (
  workspace_id          INTEGER PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  primary_low_dollars   REAL NOT NULL,
  primary_high_dollars  REAL NOT NULL,
  spouse_low_dollars    REAL NOT NULL,
  spouse_high_dollars   REAL NOT NULL,
  CHECK (primary_low_dollars >= 0 AND spouse_low_dollars >= 0),
  CHECK (primary_low_dollars < primary_high_dollars),
  CHECK (spouse_low_dollars <= spouse_high_dollars)
);
INSERT INTO sensitivity_settings_new
  (workspace_id, primary_low_dollars, primary_high_dollars, spouse_low_dollars, spouse_high_dollars)
  SELECT workspace_id, primary_low_cents / 100.0, primary_high_cents / 100.0,
         spouse_low_cents / 100.0, spouse_high_cents / 100.0
    FROM sensitivity_settings;
DROP TABLE sensitivity_settings;
ALTER TABLE sensitivity_settings_new RENAME TO sensitivity_settings;
