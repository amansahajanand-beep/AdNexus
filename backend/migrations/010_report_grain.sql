-- Phase 3: typed grain table (replaces report_present + report_daily)

CREATE TABLE IF NOT EXISTS report_grain (
  client_id     UUID NOT NULL REFERENCES gam_clients(id),
  report_date   DATE NOT NULL,
  country_id    SMALLINT NOT NULL DEFAULT 0 REFERENCES dim_country(id),
  device_id     SMALLINT NOT NULL DEFAULT 0 REFERENCES dim_device(id),
  ad_unit_id    INT NOT NULL DEFAULT 0,
  domain_id     INT NOT NULL DEFAULT 0,
  site_id       INT NOT NULL DEFAULT 0,
  channel_name  TEXT NOT NULL DEFAULT '',
  app_name      TEXT NOT NULL DEFAULT '',
  app_id        TEXT NOT NULL DEFAULT '',
  impressions   BIGINT NOT NULL DEFAULT 0,
  clicks        INT NOT NULL DEFAULT 0,
  revenue       DOUBLE PRECISION NOT NULL DEFAULT 0,
  viewable_pct  REAL,
  ecpm          REAL,
  unfilled      BIGINT,
  currency      CHAR(3) NOT NULL DEFAULT 'USD',
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (
    client_id, report_date, country_id, device_id,
    ad_unit_id, domain_id, site_id, channel_name, app_name, app_id
  )
) PARTITION BY RANGE (report_date);

-- Default partition catches rows until monthly partitions are created
CREATE TABLE IF NOT EXISTS report_grain_default PARTITION OF report_grain DEFAULT;

CREATE INDEX IF NOT EXISTS idx_report_grain_client_date ON report_grain (client_id, report_date DESC);
CREATE INDEX IF NOT EXISTS idx_report_grain_date ON report_grain (report_date DESC);
