-- Multi-client tenancy: every report table stores rows with client_id.
-- Backend initSchema() also applies this on startup (idempotent).
-- Existing rows are backfilled to the bootstrap GAM client.

ALTER TABLE report_daily ADD COLUMN IF NOT EXISTS client_id UUID;
ALTER TABLE report_present ADD COLUMN IF NOT EXISTS client_id UUID;
ALTER TABLE report_full_present ADD COLUMN IF NOT EXISTS client_id UUID;
ALTER TABLE report_full_daily ADD COLUMN IF NOT EXISTS client_id UUID;
ALTER TABLE report_adhoc ADD COLUMN IF NOT EXISTS client_id UUID;
ALTER TABLE report_adhoc_coverage ADD COLUMN IF NOT EXISTS client_id UUID;
ALTER TABLE rollup_kpi_daily ADD COLUMN IF NOT EXISTS client_id UUID;
ALTER TABLE rollup_dim_daily ADD COLUMN IF NOT EXISTS client_id UUID;
ALTER TABLE sync_log ADD COLUMN IF NOT EXISTS client_id UUID;

-- Unique / PK keys include client_id so two publishers can share a date+dim_hash.
-- (initSchema drops the old keys and creates these.)

-- report_daily UNIQUE (client_id, report_date, dim_hash)
-- report_present UNIQUE (client_id, report_date, dim_hash)
-- report_full_* UNIQUE (client_id, report_date, slice_key, dim_hash)
-- report_adhoc UNIQUE (client_id, report_date, query_hash, dim_hash)
-- report_adhoc_coverage PK (client_id, query_hash, start_date, end_date)
-- rollup_kpi_daily PK (client_id, report_date, inv_domain, inv_site, inv_ad_unit, inv_app)
-- rollup_dim_daily PK (client_id, report_date, dim_kind, dim_value)

CREATE INDEX IF NOT EXISTS idx_report_daily_client_date
  ON report_daily (client_id, report_date DESC);
CREATE INDEX IF NOT EXISTS idx_report_present_client_date
  ON report_present (client_id, report_date DESC);
CREATE INDEX IF NOT EXISTS idx_report_full_daily_client_date
  ON report_full_daily (client_id, report_date DESC);
CREATE INDEX IF NOT EXISTS idx_report_full_present_client_date
  ON report_full_present (client_id, report_date DESC);
CREATE INDEX IF NOT EXISTS idx_report_adhoc_client_date
  ON report_adhoc (client_id, report_date DESC);
CREATE INDEX IF NOT EXISTS idx_sync_log_client
  ON sync_log (client_id, started_at DESC);
