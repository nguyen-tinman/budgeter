-- Adds an optional spend date to expenses, used only by one_time rows so the
-- Trends chart can place a one-off purchase in the month it happened. Recurring
-- rows leave this NULL. Legacy one_time rows (no date) fall back to created_at
-- in the chart. Optional + nullable → no backfill.

ALTER TABLE expenses ADD COLUMN spend_date TEXT;  -- 'YYYY-MM-DD'
