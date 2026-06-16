-- app_settings: tiny key/value store for cross-session app preferences that
-- don't belong to a workspace and don't warrant their own table.
--
-- First consumer: `llama.lastModelId` — the model id (e.g. "qwen3.5-2b" /
-- "qwen3.5-4b") the user last ran inference with. The API reads this on
-- startup to pick which GGUF to auto-launch, and writes it whenever the user
-- starts/selects a model. We deliberately store the *model id* (a stable
-- logical key from the launcher's MODEL_REGISTRY) rather than an absolute
-- path, so the value stays portable across machines.
--
-- Chosen over reusing llama_profiles because that table models full sampler/
-- binary settings and is keyed by a human name; a single last-used pointer is
-- a much smaller concern and a key/value row keeps it decoupled.
--
-- Idempotent: the migration runner only applies versions without a row in
-- schema_migrations.

CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
