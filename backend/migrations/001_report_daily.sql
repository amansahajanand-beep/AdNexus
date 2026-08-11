-- Run this once on your DigitalOcean PostgreSQL before starting the backend.
-- The backend also runs these via initSchema() on startup (idempotent).

CREATE TABLE IF NOT EXISTS report_daily (
  id          BIGSERIAL PRIMARY KEY,
  report_date DATE        NOT NULL,
  dim_hash    TEXT        NOT NULL,
  dimensions  JSONB       NOT NULL DEFAULT '{}',
  metrics     JSONB       NOT NULL DEFAULT '{}',
  currency    CHAR(3)     NOT NULL DEFAULT 'USD',
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (report_date, dim_hash)
);

CREATE INDEX IF NOT EXISTS idx_report_daily_date
  ON report_daily (report_date DESC);

CREATE TABLE IF NOT EXISTS sync_log (
  id           BIGSERIAL PRIMARY KEY,
  sync_type    TEXT        NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  status       TEXT        NOT NULL DEFAULT 'running',
  error_msg    TEXT,
  rows_upserted INT
);

-- Usage:
-- psql -U gam_user -d gam_dashboard -f migrations/001_report_daily.sql
