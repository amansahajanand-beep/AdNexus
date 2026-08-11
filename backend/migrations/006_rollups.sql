-- Pre-aggregated dashboard rollups (typed metrics — avoid JSONB scans on request).
-- Rebuilt after sync into report_present / report_daily.

CREATE TABLE IF NOT EXISTS rollup_kpi_daily (
  report_date     DATE        NOT NULL,
  inv_domain      TEXT        NOT NULL DEFAULT '',
  inv_site        TEXT        NOT NULL DEFAULT '',
  inv_ad_unit     TEXT        NOT NULL DEFAULT '',
  inv_app         TEXT        NOT NULL DEFAULT '',
  impressions     DOUBLE PRECISION NOT NULL DEFAULT 0,
  revenue         DOUBLE PRECISION NOT NULL DEFAULT 0,
  viewable_weight DOUBLE PRECISION NOT NULL DEFAULT 0,
  grain_count     INT         NOT NULL DEFAULT 0,
  currency        CHAR(3)     NOT NULL DEFAULT 'USD',
  PRIMARY KEY (report_date, inv_domain, inv_site, inv_ad_unit, inv_app)
);

CREATE INDEX IF NOT EXISTS idx_rollup_kpi_date ON rollup_kpi_daily (report_date DESC);
CREATE INDEX IF NOT EXISTS idx_rollup_kpi_domain ON rollup_kpi_daily (report_date, LOWER(inv_domain));
CREATE INDEX IF NOT EXISTS idx_rollup_kpi_site ON rollup_kpi_daily (report_date, LOWER(inv_site));
CREATE INDEX IF NOT EXISTS idx_rollup_kpi_ad_unit ON rollup_kpi_daily (report_date, LOWER(inv_ad_unit));
CREATE INDEX IF NOT EXISTS idx_rollup_kpi_app ON rollup_kpi_daily (report_date, LOWER(inv_app));

-- Chart dimensions: domain | device | country | ad_unit (network-wide per day)
CREATE TABLE IF NOT EXISTS rollup_dim_daily (
  report_date  DATE        NOT NULL,
  dim_kind     TEXT        NOT NULL,
  dim_value    TEXT        NOT NULL,
  revenue      DOUBLE PRECISION NOT NULL DEFAULT 0,
  impressions  DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (report_date, dim_kind, dim_value)
);

CREATE INDEX IF NOT EXISTS idx_rollup_dim_kind_date
  ON rollup_dim_daily (dim_kind, report_date DESC);
