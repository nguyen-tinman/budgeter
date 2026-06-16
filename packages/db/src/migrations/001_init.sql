-- BudgetKit initial schema (schema_version = 1)
-- All monetary amounts are integer CENTS to avoid float drift.
-- All timestamps are ISO-8601 strings (UTC). SQLite has no datetime type;
-- TEXT with datetime('now') gives sortable, portable values.

------------------------------------------------------------
-- workspaces: 'current' (real baseline) or 'scenario' (move/job alternatives)
------------------------------------------------------------
CREATE TABLE workspaces (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL CHECK (kind IN ('current','scenario')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  notes       TEXT
);

------------------------------------------------------------
-- categories: Food, Gas, Rent, Utilities, Insurance, Subscriptions, etc.
------------------------------------------------------------
CREATE TABLE categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  color_hex   TEXT NOT NULL DEFAULT '#888888',
  builtin     INTEGER NOT NULL DEFAULT 0
);

------------------------------------------------------------
-- expenses: workspace-scoped recurring or one-off costs
------------------------------------------------------------
CREATE TABLE expenses (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id          INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label                 TEXT NOT NULL,
  amount_cents          INTEGER NOT NULL,
  frequency             TEXT NOT NULL CHECK (frequency IN ('weekly','biweekly','monthly','quarterly','annually','one_time')),
  category_id           INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  source                TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','imported','recurring_detector','ground_truth')),
  linked_recurring_id   INTEGER REFERENCES recurring_subscriptions(id) ON DELETE SET NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_expenses_workspace ON expenses(workspace_id);

------------------------------------------------------------
-- incomes: gross annual amounts, per filing role
------------------------------------------------------------
CREATE TABLE incomes (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id             INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label                    TEXT NOT NULL,
  gross_annual_cents       INTEGER NOT NULL,
  tax_status               TEXT NOT NULL CHECK (tax_status IN ('pretax','posttax','taxed','untaxable')),
  is_federal_income_tax    INTEGER NOT NULL DEFAULT 1,
  filing_role              TEXT NOT NULL DEFAULT 'primary' CHECK (filing_role IN ('primary','spouse')),
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_incomes_workspace ON incomes(workspace_id);

------------------------------------------------------------
-- recurring_subscriptions: detected (and human-confirmed) recurring charges
-- These are NOT workspace-scoped — they describe real-world subscriptions,
-- and expenses.linked_recurring_id ties workspace-level cost lines back.
------------------------------------------------------------
CREATE TABLE recurring_subscriptions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_normalized   TEXT NOT NULL,
  amount_cents          INTEGER NOT NULL,
  cadence_days          INTEGER NOT NULL,
  last_seen             TEXT,
  source_account        TEXT,
  confidence            REAL NOT NULL DEFAULT 0,
  manually_added        INTEGER NOT NULL DEFAULT 0,
  notes                 TEXT
);
CREATE INDEX idx_recurring_merchant ON recurring_subscriptions(merchant_normalized);

------------------------------------------------------------
-- rolling_bills: 12-month rolling average per category, workspace-scoped
------------------------------------------------------------
CREATE TABLE rolling_bills (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id             INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  category                 TEXT NOT NULL,
  monthly_average_cents    INTEGER NOT NULL,
  computed_at              TEXT NOT NULL DEFAULT (datetime('now')),
  source                   TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','baseline_roller'))
);
CREATE INDEX idx_rolling_bills_workspace ON rolling_bills(workspace_id);

------------------------------------------------------------
-- savings_items: retirement + general savings tracking
------------------------------------------------------------
CREATE TABLE savings_items (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id                INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label                       TEXT NOT NULL,
  current_balance_cents       INTEGER NOT NULL DEFAULT 0,
  target_balance_cents        INTEGER,
  monthly_contribution_cents  INTEGER NOT NULL DEFAULT 0,
  account_type                TEXT NOT NULL CHECK (account_type IN ('hysa','brokerage','roth_ira','traditional_401k','roth_401k','hsa','other')),
  created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_savings_workspace ON savings_items(workspace_id);

------------------------------------------------------------
-- tax_tables: bracket sets per year/jurisdiction/filing
-- brackets_json shape: [{"upTo": <cents | null for top>, "rate": <0..1>}]
------------------------------------------------------------
CREATE TABLE tax_tables (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  year                        INTEGER NOT NULL,
  jurisdiction                TEXT NOT NULL CHECK (jurisdiction IN ('federal','ca')),
  filing                      TEXT NOT NULL CHECK (filing IN ('single','mfj')),
  standard_deduction_cents    INTEGER NOT NULL,
  brackets_json               TEXT NOT NULL,
  source_url                  TEXT,
  UNIQUE (year, jurisdiction, filing)
);

------------------------------------------------------------
-- tax_settings: per-workspace tax knobs (one row per workspace)
------------------------------------------------------------
CREATE TABLE tax_settings (
  workspace_id                       INTEGER PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  filing_status                      TEXT NOT NULL CHECK (filing_status IN ('single','mfj')),
  tax_year                           INTEGER NOT NULL,
  ca_sdi_rate                        REAL NOT NULL DEFAULT 0.011,
  ss_wage_base_cents                 INTEGER NOT NULL DEFAULT 17610000,    -- $176,100 (2025 base; editable)
  fica_ss_rate                       REAL NOT NULL DEFAULT 0.062,
  fica_medicare_rate                 REAL NOT NULL DEFAULT 0.0145,
  retirement_effective_tax_rate      REAL NOT NULL DEFAULT 0.12
);

------------------------------------------------------------
-- retirement_settings: projection inputs per workspace
------------------------------------------------------------
CREATE TABLE retirement_settings (
  workspace_id                INTEGER PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  current_age                 INTEGER NOT NULL,
  retirement_age              INTEGER NOT NULL,
  initial_balance_cents       INTEGER NOT NULL DEFAULT 0,
  growth_rate                 REAL NOT NULL DEFAULT 0.07,
  roth_split_pct              REAL NOT NULL DEFAULT 0.5,
  CHECK (retirement_age > current_age),
  CHECK (roth_split_pct >= 0 AND roth_split_pct <= 1)
);

------------------------------------------------------------
-- statement_imports: idempotency + audit for ingest runs
------------------------------------------------------------
CREATE TABLE statement_imports (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  source_account    TEXT NOT NULL,
  file_hash         TEXT NOT NULL UNIQUE,
  file_path         TEXT,
  imported_at       TEXT NOT NULL DEFAULT (datetime('now')),
  txn_count         INTEGER NOT NULL DEFAULT 0
);

------------------------------------------------------------
-- transactions: raw ingest, kept so detectors can re-run
------------------------------------------------------------
CREATE TABLE transactions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id             INTEGER NOT NULL REFERENCES statement_imports(id) ON DELETE CASCADE,
  posted_date           TEXT NOT NULL,                  -- YYYY-MM-DD
  merchant_raw          TEXT NOT NULL,
  merchant_normalized   TEXT NOT NULL,
  amount_cents          INTEGER NOT NULL,               -- negative = charge, positive = credit
  category_id           INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  account_type          TEXT NOT NULL                   -- e.g. 'chase', 'amex_gold', 'amex_plat'
);
CREATE INDEX idx_txn_merchant ON transactions(merchant_normalized);
CREATE INDEX idx_txn_date ON transactions(posted_date);

------------------------------------------------------------
-- review_queue: parser lines that couldn't be cleanly extracted
------------------------------------------------------------
CREATE TABLE review_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id     INTEGER NOT NULL REFERENCES statement_imports(id) ON DELETE CASCADE,
  raw_line      TEXT NOT NULL,
  reason        TEXT NOT NULL,
  resolved      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

------------------------------------------------------------
-- llama_profiles: saved sampler + binary settings
------------------------------------------------------------
CREATE TABLE llama_profiles (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL UNIQUE,
  model_path      TEXT,
  port            INTEGER NOT NULL DEFAULT 8080,
  ctx_size        INTEGER NOT NULL DEFAULT 8192,
  n_gpu_layers    INTEGER NOT NULL DEFAULT 0,
  n_threads       INTEGER,
  batch_size      INTEGER NOT NULL DEFAULT 512,
  flash_attn      INTEGER NOT NULL DEFAULT 0,
  use_mmap        INTEGER NOT NULL DEFAULT 1,
  use_mlock       INTEGER NOT NULL DEFAULT 0,
  temperature     REAL NOT NULL DEFAULT 0.7,
  top_k           INTEGER NOT NULL DEFAULT 40,
  top_p           REAL NOT NULL DEFAULT 0.9,
  min_p           REAL NOT NULL DEFAULT 0.05,
  repeat_penalty  REAL NOT NULL DEFAULT 1.1,
  repeat_last_n   INTEGER NOT NULL DEFAULT 64,
  mirostat        INTEGER NOT NULL DEFAULT 0,   -- 0=off, 1=v1, 2=v2
  mirostat_tau    REAL NOT NULL DEFAULT 5.0,
  mirostat_eta    REAL NOT NULL DEFAULT 0.1,
  tfs_z           REAL NOT NULL DEFAULT 1.0,
  typical_p       REAL NOT NULL DEFAULT 1.0,
  max_tokens      INTEGER NOT NULL DEFAULT 1024,
  stop_sequences  TEXT,                          -- JSON array
  is_active       INTEGER NOT NULL DEFAULT 0
);

------------------------------------------------------------
-- tools_call_log: audit trail of LLM + MCP mutations
------------------------------------------------------------
CREATE TABLE tools_call_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL DEFAULT (datetime('now')),
  tool_name     TEXT NOT NULL,
  args_json     TEXT NOT NULL,
  result_json   TEXT,
  source        TEXT NOT NULL CHECK (source IN ('in_app_llm','mcp_client','api_direct'))
);
CREATE INDEX idx_tools_call_ts ON tools_call_log(ts);

------------------------------------------------------------
-- Seed data: default categories + the 'Current' workspace
------------------------------------------------------------
INSERT INTO workspaces (name, kind, notes) VALUES
  ('Current', 'current', 'Your real baseline — current income, expenses, savings.');

INSERT INTO categories (name, color_hex, builtin) VALUES
  ('Rent',          '#ef4444', 1),
  ('Utilities',     '#f59e0b', 1),
  ('Food',          '#10b981', 1),
  ('Gas',           '#3b82f6', 1),
  ('Auto Insurance','#8b5cf6', 1),
  ('Health',        '#ec4899', 1),
  ('Subscriptions', '#a855f7', 1),
  ('Tolls',         '#06b6d4', 1),
  ('Annual Fees',   '#f43f5e', 1),
  ('Other',         '#888888', 1);

-- Tax tables: seeded with 2025 brackets (federal + CA, single + MFJ).
-- Cents-based bracket cutoffs. NULL upTo = top bracket.
INSERT INTO tax_tables (year, jurisdiction, filing, standard_deduction_cents, brackets_json, source_url) VALUES
  -- 2025 federal single: std ded $15,750 (post-OBBBA July 2025).
  (2025, 'federal', 'single', 1575000, '[
    {"upTo":1192500,"rate":0.10},
    {"upTo":4847500,"rate":0.12},
    {"upTo":10335000,"rate":0.22},
    {"upTo":19730000,"rate":0.24},
    {"upTo":25052500,"rate":0.32},
    {"upTo":62635000,"rate":0.35},
    {"upTo":null,"rate":0.37}
  ]', 'https://www.irs.gov/'),
  -- 2025 federal MFJ: std ded $31,500 (post-OBBBA).
  (2025, 'federal', 'mfj', 3150000, '[
    {"upTo":2385000,"rate":0.10},
    {"upTo":9695000,"rate":0.12},
    {"upTo":20670000,"rate":0.22},
    {"upTo":39460000,"rate":0.24},
    {"upTo":50105000,"rate":0.32},
    {"upTo":75160000,"rate":0.35},
    {"upTo":null,"rate":0.37}
  ]', 'https://www.irs.gov/'),
  (2025, 'ca', 'single', 568500, '[
    {"upTo":1075600,"rate":0.01},
    {"upTo":2549900,"rate":0.02},
    {"upTo":4024500,"rate":0.04},
    {"upTo":5586600,"rate":0.06},
    {"upTo":7060600,"rate":0.08},
    {"upTo":36065900,"rate":0.093},
    {"upTo":43279000,"rate":0.103},
    {"upTo":72131500,"rate":0.113},
    {"upTo":100000000,"rate":0.123},
    {"upTo":null,"rate":0.133}
  ]', 'https://www.ftb.ca.gov/'),
  -- CA MFJ: 1% Mental Health Services Tax applies on taxable income > $1M,
  -- not doubled for MFJ. Bracket cutoffs must be monotonically ascending
  -- because bracketTax() walks the list in order.
  --
  -- The MFJ FTB 11.3% bracket runs $865,580–$1,442,628 — i.e. it STRADDLES
  -- the $1M MHST split. To embed MHST as bracket arithmetic we must split
  -- it: below $1M it's just 11.3%; from $1M to $1,442,628 it's 11.3% + 1%
  -- MHST = 12.3% effective; above $1,442,628 it's the FTB 12.3% + 1% MHST
  -- = 13.3% effective. This puts the cutoffs in the order the walker needs.
  (2025, 'ca', 'mfj', 1137000, '[
    {"upTo":2151200,"rate":0.01},
    {"upTo":5099800,"rate":0.02},
    {"upTo":8049000,"rate":0.04},
    {"upTo":11173200,"rate":0.06},
    {"upTo":14121200,"rate":0.08},
    {"upTo":72131800,"rate":0.093},
    {"upTo":86558000,"rate":0.103},
    {"upTo":100000000,"rate":0.113},
    {"upTo":144263000,"rate":0.123},
    {"upTo":null,"rate":0.133}
  ]', 'https://www.ftb.ca.gov/');

-- Default tax_settings for the Current workspace (filing single by default)
INSERT INTO tax_settings (workspace_id, filing_status, tax_year) VALUES
  ((SELECT id FROM workspaces WHERE name = 'Current'), 'single', 2025);

-- A default llama profile for sane initial sampler settings
INSERT INTO llama_profiles (name, is_active) VALUES ('Default', 1);
