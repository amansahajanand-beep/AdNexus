-- Full reporting sync tables (cron). Separate from lean dashboard tables
-- report_present / report_daily and from on-demand report_adhoc.
--
-- Hourly cron → report_full_present (today)
-- Past presets (yesterday / 7d / 30d / this month / last month) → report_full_daily
--
-- Each row is one GAM slice (compatible dim set × metric batch). JSONB holds
-- whatever dimensions/metrics that slice returned.

CREATE TABLE IF NOT EXISTS report_full_present (
  id           BIGSERIAL PRIMARY KEY,
  report_date  DATE        NOT NULL,
  slice_key    TEXT        NOT NULL,
  dim_hash     TEXT        NOT NULL,
  dimensions   JSONB       NOT NULL DEFAULT '{}',
  metrics      JSONB       NOT NULL DEFAULT '{}',
  dim_keys     TEXT[]      NOT NULL DEFAULT '{}',
  metric_keys  TEXT[]      NOT NULL DEFAULT '{}',
  currency     CHAR(3)     NOT NULL DEFAULT 'USD',
  synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  inv_domain   TEXT,
  inv_site     TEXT,
  inv_ad_unit  TEXT,
  inv_app      TEXT,
  UNIQUE (report_date, slice_key, dim_hash)
);

CREATE TABLE IF NOT EXISTS report_full_daily (
  id           BIGSERIAL PRIMARY KEY,
  report_date  DATE        NOT NULL,
  slice_key    TEXT        NOT NULL,
  dim_hash     TEXT        NOT NULL,
  dimensions   JSONB       NOT NULL DEFAULT '{}',
  metrics      JSONB       NOT NULL DEFAULT '{}',
  dim_keys     TEXT[]      NOT NULL DEFAULT '{}',
  metric_keys  TEXT[]      NOT NULL DEFAULT '{}',
  currency     CHAR(3)     NOT NULL DEFAULT 'USD',
  synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  inv_domain   TEXT,
  inv_site     TEXT,
  inv_ad_unit  TEXT,
  inv_app      TEXT,
  UNIQUE (report_date, slice_key, dim_hash)
);

CREATE INDEX IF NOT EXISTS idx_report_full_present_date
  ON report_full_present (report_date DESC);
CREATE INDEX IF NOT EXISTS idx_report_full_daily_date
  ON report_full_daily (report_date DESC);
CREATE INDEX IF NOT EXISTS idx_report_full_present_slice
  ON report_full_present (slice_key, report_date DESC);
CREATE INDEX IF NOT EXISTS idx_report_full_daily_slice
  ON report_full_daily (slice_key, report_date DESC);
CREATE INDEX IF NOT EXISTS idx_report_full_present_inv_domain
  ON report_full_present (LOWER(inv_domain));
CREATE INDEX IF NOT EXISTS idx_report_full_daily_inv_domain
  ON report_full_daily (LOWER(inv_domain));
CREATE INDEX IF NOT EXISTS idx_report_full_present_inv_site
  ON report_full_present (LOWER(inv_site));
CREATE INDEX IF NOT EXISTS idx_report_full_daily_inv_site
  ON report_full_daily (LOWER(inv_site));
CREATE INDEX IF NOT EXISTS idx_report_full_present_inv_ad_unit
  ON report_full_present (LOWER(inv_ad_unit));
CREATE INDEX IF NOT EXISTS idx_report_full_daily_inv_ad_unit
  ON report_full_daily (LOWER(inv_ad_unit));
CREATE INDEX IF NOT EXISTS idx_report_full_present_inv_app
  ON report_full_present (LOWER(inv_app));
CREATE INDEX IF NOT EXISTS idx_report_full_daily_inv_app
  ON report_full_daily (LOWER(inv_app));
