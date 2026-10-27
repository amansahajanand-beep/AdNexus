-- PROPOSAL, NOT APPLIED. Review, then run yourself with psql if you agree:
--   psql -d gam_dashboard_db -f backend/scripts/sql/rollup-country-grains.sql
--
-- Why: Reporting with a Country dimension next to Site/Domain, App ID or Device has no rollup at that grain, so it
-- aggregates raw report_grain on every request. Measured on the local copy (one day, one client):
--     inventory_core raw rows ............ 116,797   (just counting them: 84 s on a loaded disk)
--     Site x Country aggregation ......... did not finish in 150 s
--     App ID x Country aggregation ....... 108 s   (8,270 result rows)
--   and the three reports below got no response at all in 170 s for 7 days:
--     Date x Site x Country, Date x App ID x Country, Date x Country x Device.
-- Each table below holds the already-aggregated result per day, so a report reads thousands of rows, not millions.
--
-- Only ADDS three new tables. No existing table, column, index or data is changed. Safe to re-run.
--
-- Expected size (per day): app x country ~8,300 rows (measured); site x country at most ~117,000 (upper bound: it
-- cannot exceed the raw rows it summarises; the real figure is smaller and was not measurable here);
-- country x device a few hundred rows.

BEGIN;

-- 1) Date x Site (x Domain) x Country, from the inventory_core slice (the slice Reporting reads for Site/Domain).
CREATE TABLE IF NOT EXISTS rollup_site_country_daily (
  client_id        UUID             NOT NULL REFERENCES gam_clients(id),
  report_date      DATE             NOT NULL,
  site_id          INT              NOT NULL DEFAULT 0,
  domain_id        INT              NOT NULL DEFAULT 0,
  country_id       SMALLINT         NOT NULL DEFAULT 0,
  impressions      DOUBLE PRECISION NOT NULL DEFAULT 0,
  revenue          DOUBLE PRECISION NOT NULL DEFAULT 0,
  clicks           DOUBLE PRECISION NOT NULL DEFAULT 0,
  viewable_weight  DOUBLE PRECISION NOT NULL DEFAULT 0,   -- sum(impressions * viewable_pct)
  currency         CHAR(3)          NOT NULL DEFAULT 'USD',
  PRIMARY KEY (client_id, report_date, site_id, domain_id, country_id)
);

-- 2) Date x App ID x Country, from the app_id slice. app_id is stored lower-cased (reports match it case-insensitively).
CREATE TABLE IF NOT EXISTS rollup_app_country_daily (
  client_id        UUID             NOT NULL REFERENCES gam_clients(id),
  report_date      DATE             NOT NULL,
  app_id           TEXT             NOT NULL DEFAULT '',   -- LOWER(report_grain.app_id)
  app_name         TEXT             NOT NULL DEFAULT '',
  country_id       SMALLINT         NOT NULL DEFAULT 0,
  impressions      DOUBLE PRECISION NOT NULL DEFAULT 0,
  revenue          DOUBLE PRECISION NOT NULL DEFAULT 0,
  clicks           DOUBLE PRECISION NOT NULL DEFAULT 0,
  viewable_weight  DOUBLE PRECISION NOT NULL DEFAULT 0,
  currency         CHAR(3)          NOT NULL DEFAULT 'USD',
  PRIMARY KEY (client_id, report_date, app_id, country_id)
);

-- 3) Date x Country x Device, from the inventory_core slice (also answers Date x Device).
CREATE TABLE IF NOT EXISTS rollup_country_device_daily (
  client_id        UUID             NOT NULL REFERENCES gam_clients(id),
  report_date      DATE             NOT NULL,
  country_id       SMALLINT         NOT NULL DEFAULT 0,
  device_id        SMALLINT         NOT NULL DEFAULT 0,
  impressions      DOUBLE PRECISION NOT NULL DEFAULT 0,
  revenue          DOUBLE PRECISION NOT NULL DEFAULT 0,
  clicks           DOUBLE PRECISION NOT NULL DEFAULT 0,
  viewable_weight  DOUBLE PRECISION NOT NULL DEFAULT 0,
  currency         CHAR(3)          NOT NULL DEFAULT 'USD',
  PRIMARY KEY (client_id, report_date, country_id, device_id)
);

-- Same tenant isolation as every other report table (see migrateMultiClientTenancy in src/db.js).
ALTER TABLE rollup_site_country_daily    ENABLE ROW LEVEL SECURITY;  ALTER TABLE rollup_site_country_daily    FORCE ROW LEVEL SECURITY;
ALTER TABLE rollup_app_country_daily     ENABLE ROW LEVEL SECURITY;  ALTER TABLE rollup_app_country_daily     FORCE ROW LEVEL SECURITY;
ALTER TABLE rollup_country_device_daily  ENABLE ROW LEVEL SECURITY;  ALTER TABLE rollup_country_device_daily  FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON rollup_site_country_daily;
DROP POLICY IF EXISTS tenant_isolation ON rollup_app_country_daily;
DROP POLICY IF EXISTS tenant_isolation ON rollup_country_device_daily;
CREATE POLICY tenant_isolation ON rollup_site_country_daily
  USING (client_id::text = current_setting('app.client_id', true)) WITH CHECK (client_id::text = current_setting('app.client_id', true));
CREATE POLICY tenant_isolation ON rollup_app_country_daily
  USING (client_id::text = current_setting('app.client_id', true)) WITH CHECK (client_id::text = current_setting('app.client_id', true));
CREATE POLICY tenant_isolation ON rollup_country_device_daily
  USING (client_id::text = current_setting('app.client_id', true)) WITH CHECK (client_id::text = current_setting('app.client_id', true));

COMMIT;

-- ---------------------------------------------------------------------------------------------------------------
-- BACKFILL (heavy: each day reads the raw rows once per table; on the local disk that was minutes per day).
-- Run off-peak, as the table owner (bypasses RLS). One statement per day, each its own transaction, so it can be
-- stopped and resumed; re-running a day replaces it. Change the window, start with the most recent month.
-- Uses psql's \gexec: it runs every generated statement in turn.
-- ---------------------------------------------------------------------------------------------------------------

-- 1) site x country
SELECT format($sql$
  DELETE FROM rollup_site_country_daily WHERE report_date = %1$L;
  INSERT INTO rollup_site_country_daily (client_id, report_date, site_id, domain_id, country_id, impressions, revenue, clicks, viewable_weight, currency)
  SELECT g.client_id, g.report_date, g.site_id, g.domain_id, g.country_id,
         COALESCE(SUM(g.impressions), 0)::float8, COALESCE(SUM(g.revenue), 0)::float8, COALESCE(SUM(g.clicks), 0)::float8,
         COALESCE(SUM(COALESCE(g.impressions, 0) * COALESCE(g.viewable_pct, 0)), 0)::float8, COALESCE(MAX(g.currency), 'USD')
  FROM report_grain g
  WHERE g.report_date = %1$L AND g.slice_key = 'inventory_core'
  GROUP BY g.client_id, g.report_date, g.site_id, g.domain_id, g.country_id
  HAVING COALESCE(SUM(g.impressions), 0) > 0 OR COALESCE(SUM(g.revenue), 0) > 0;
$sql$, d::date)
FROM generate_series('2026-10-01'::date, '2026-10-31'::date, '1 day') d \gexec

-- 2) app x country
SELECT format($sql$
  DELETE FROM rollup_app_country_daily WHERE report_date = %1$L;
  INSERT INTO rollup_app_country_daily (client_id, report_date, app_id, app_name, country_id, impressions, revenue, clicks, viewable_weight, currency)
  SELECT g.client_id, g.report_date, LOWER(g.app_id), COALESCE(MAX(NULLIF(g.app_name, '')), ''), g.country_id,
         COALESCE(SUM(g.impressions), 0)::float8, COALESCE(SUM(g.revenue), 0)::float8, COALESCE(SUM(g.clicks), 0)::float8,
         COALESCE(SUM(COALESCE(g.impressions, 0) * COALESCE(g.viewable_pct, 0)), 0)::float8, COALESCE(MAX(g.currency), 'USD')
  FROM report_grain g
  WHERE g.report_date = %1$L AND g.slice_key = 'app_id' AND NULLIF(TRIM(g.app_id), '') IS NOT NULL
  GROUP BY g.client_id, g.report_date, LOWER(g.app_id), g.country_id
  HAVING COALESCE(SUM(g.impressions), 0) > 0 OR COALESCE(SUM(g.revenue), 0) > 0;
$sql$, d::date)
FROM generate_series('2026-10-01'::date, '2026-10-31'::date, '1 day') d \gexec

-- 3) country x device
SELECT format($sql$
  DELETE FROM rollup_country_device_daily WHERE report_date = %1$L;
  INSERT INTO rollup_country_device_daily (client_id, report_date, country_id, device_id, impressions, revenue, clicks, viewable_weight, currency)
  SELECT g.client_id, g.report_date, g.country_id, g.device_id,
         COALESCE(SUM(g.impressions), 0)::float8, COALESCE(SUM(g.revenue), 0)::float8, COALESCE(SUM(g.clicks), 0)::float8,
         COALESCE(SUM(COALESCE(g.impressions, 0) * COALESCE(g.viewable_pct, 0)), 0)::float8, COALESCE(MAX(g.currency), 'USD')
  FROM report_grain g
  WHERE g.report_date = %1$L AND g.slice_key = 'inventory_core'
  GROUP BY g.client_id, g.report_date, g.country_id, g.device_id
  HAVING COALESCE(SUM(g.impressions), 0) > 0 OR COALESCE(SUM(g.revenue), 0) > 0;
$sql$, d::date)
FROM generate_series('2026-10-01'::date, '2026-10-31'::date, '1 day') d \gexec

-- CHECK after the backfill: each rollup total must equal the matching existing rollup for the same day.
--   SELECT (SELECT sum(revenue) FROM rollup_site_country_daily   WHERE report_date = '2026-10-19') AS site_country,
--          (SELECT sum(revenue) FROM rollup_country_device_daily WHERE report_date = '2026-10-19') AS country_device,
--          (SELECT sum(revenue) FROM rollup_inventory_kpi_daily  WHERE report_date = '2026-10-19') AS reference;
-- (site_country and country_device must match the reference. app_country is the app_id slice, a different slice:
--  compare it with sum(revenue) over that day's app_id slice instead.)

-- ---------------------------------------------------------------------------------------------------------------
-- APPLICATION SIDE (NOT in the code yet; added only after you approve these tables):
--   1. src/services/reportGrainStore.js, the per-day rebuild next to rollup_unit_country_daily (line ~590): also
--      DELETE + INSERT that day into these three tables, in the same transaction, so they stay current after each sync.
--   2. src/services/gamSyncService.js: a read function per table (like fetchUnitDailyRollupBundle) used by
--      fetchReportingBundleFromDB for Site x Country, App ID x Country and Country x Device. Each checks that every day
--      with data is present and otherwise falls back to the existing raw-grain path.
--   3. Optional: a nightly job that re-checks the last 3 days (GAM revises recent days).
-- ---------------------------------------------------------------------------------------------------------------
