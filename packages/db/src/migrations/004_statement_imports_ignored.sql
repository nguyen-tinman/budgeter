-- Adds the per-statement "ignored" flag so users can hide statements they
-- don't want to import from the Library browse view (e.g. corrupted PDFs,
-- duplicates from a screenshot, statements from a closed account).
--
-- Defaults to 0 (visible). The Library page's status filter respects this
-- flag — ignored statements are hidden from the default list but reachable
-- via status=ignored.
--
-- Idempotent: the migration runner only applies migrations whose version
-- doesn't already have a row in schema_migrations.

ALTER TABLE statement_imports ADD COLUMN ignored INTEGER NOT NULL DEFAULT 0;
