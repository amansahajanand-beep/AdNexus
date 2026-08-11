-- Reporting page cache (custom dims/metrics). Separate from dashboard lean tables
-- report_present / report_daily. Ladder: memory → Redis → report_adhoc → GAM → persist.

CREATE TABLE IF NOT EXISTS report_adhoc (
  id           BIGSERIAL PRIMARY KEY,
  report_date  DATE        NOT NULL,
  query_hash   TEXT        NOT NULL,
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
  UNIQUE (report_date, query_hash, dim_hash)
);

CREATE INDEX IF NOT EXISTS idx_report_adhoc_query_date
  ON report_adhoc (query_hash, report_date DESC);

CREATE INDEX IF NOT EXISTS idx_report_adhoc_date
  ON report_adhoc (report_date DESC);

CREATE INDEX IF NOT EXISTS idx_report_adhoc_inv_domain ON report_adhoc (LOWER(inv_domain));
CREATE INDEX IF NOT EXISTS idx_report_adhoc_inv_site ON report_adhoc (LOWER(inv_site));
CREATE INDEX IF NOT EXISTS idx_report_adhoc_inv_ad_unit ON report_adhoc (LOWER(inv_ad_unit));
CREATE INDEX IF NOT EXISTS idx_report_adhoc_inv_app ON report_adhoc (LOWER(inv_app));

-- Exact query coverage marker so sparse GAM days still count as a cache hit.
CREATE TABLE IF NOT EXISTS report_adhoc_coverage (
  query_hash  TEXT        NOT NULL,
  start_date  DATE        NOT NULL,
  end_date    DATE        NOT NULL,
  row_count   INT         NOT NULL DEFAULT 0,
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (query_hash, start_date, end_date)
);
