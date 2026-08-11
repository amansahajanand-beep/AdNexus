-- Present-day (current) cron data — separate from historical report_daily.
-- Each hourly sync-today clears this table and writes a fresh snapshot.
-- Past ranges (yesterday, 7d, 30d, backfill) stay in report_daily.

CREATE TABLE IF NOT EXISTS report_present (
  id          BIGSERIAL PRIMARY KEY,
  report_date DATE        NOT NULL,
  dim_hash    TEXT        NOT NULL,
  dimensions  JSONB       NOT NULL DEFAULT '{}',
  metrics     JSONB       NOT NULL DEFAULT '{}',
  currency    CHAR(3)     NOT NULL DEFAULT 'USD',
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (report_date, dim_hash)
);

CREATE INDEX IF NOT EXISTS idx_report_present_date
  ON report_present (report_date DESC);

-- Usage:
-- psql -U gam_user -d gam_dashboard -f migrations/002_report_present.sql
