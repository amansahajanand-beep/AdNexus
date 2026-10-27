-- PROPOSAL, NOT APPLIED. Review, then run yourself with psql if you agree:
--   psql -d gam_dashboard_db -f backend/scripts/sql/rollup-unit-daily.sql
--
-- Why: Reporting "Date x Ad Unit" for 30 days read ~540,000 rows from rollup_unit_country_daily
-- (about 18,000 rows per day, because that table also splits by country) and timed out. This table is
-- the same data summed over country: about 840 rows per day, so 30 days is ~25,000 rows.
--
-- Only ADDS a new table. No existing table, column, index or data is changed.
-- Safe to re-run (IF NOT EXISTS / delete-then-insert per day).

BEGIN;

CREATE TABLE IF NOT EXISTS rollup_unit_daily (
  client_id        UUID             NOT NULL REFERENCES gam_clients(id),
  report_date      DATE             NOT NULL,
  ad_unit_id       INT              NOT NULL,
  -- site / domain of the ad unit's highest-impression (unit, country) row that day, as in
  -- rollup_unit_country_daily (an ad unit sits on one site in practice).
  site_id          INT              NOT NULL DEFAULT 0,
  domain_id        INT              NOT NULL DEFAULT 0,
  impressions      DOUBLE PRECISION NOT NULL DEFAULT 0,
  revenue          DOUBLE PRECISION NOT NULL DEFAULT 0,
  clicks           DOUBLE PRECISION NOT NULL DEFAULT 0,
  viewable_weight  DOUBLE PRECISION NOT NULL DEFAULT 0,   -- sum(impressions * viewable_pct)
  currency         CHAR(3)          NOT NULL DEFAULT 'USD',
  PRIMARY KEY (client_id, report_date, ad_unit_id)
);

-- Same tenant isolation as every other report table (see migrateMultiClientTenancy in src/db.js).
ALTER TABLE rollup_unit_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE rollup_unit_daily FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON rollup_unit_daily;
CREATE POLICY tenant_isolation ON rollup_unit_daily
  USING (client_id::text = current_setting('app.client_id', true))
  WITH CHECK (client_id::text = current_setting('app.client_id', true));

COMMIT;

-- One-time backfill from the existing country-level rollup (runs as the table owner, so RLS is bypassed;
-- if you run it as a role subject to RLS, run it per client with SET app.client_id = '<uuid>').
-- Run per month if the table is large; each statement is idempotent.
--
-- DELETE + INSERT keeps it re-runnable:
--   DELETE FROM rollup_unit_daily WHERE report_date BETWEEN '2026-09-01' AND '2026-10-31';
INSERT INTO rollup_unit_daily
  (client_id, report_date, ad_unit_id, site_id, domain_id, impressions, revenue, clicks, viewable_weight, currency)
SELECT u.client_id, u.report_date, u.ad_unit_id,
       (array_agg(u.site_id   ORDER BY u.impressions DESC))[1],
       (array_agg(u.domain_id ORDER BY u.impressions DESC))[1],
       SUM(u.impressions), SUM(u.revenue), SUM(u.clicks), SUM(u.viewable_weight),
       COALESCE(MAX(u.currency), 'USD')
FROM rollup_unit_country_daily u
WHERE u.report_date BETWEEN '2026-09-01' AND '2026-10-31'      -- adjust the window
GROUP BY u.client_id, u.report_date, u.ad_unit_id
ON CONFLICT (client_id, report_date, ad_unit_id) DO UPDATE
  SET site_id = EXCLUDED.site_id, domain_id = EXCLUDED.domain_id,
      impressions = EXCLUDED.impressions, revenue = EXCLUDED.revenue, clicks = EXCLUDED.clicks,
      viewable_weight = EXCLUDED.viewable_weight, currency = EXCLUDED.currency;

-- Check after the backfill: totals must equal the source table for the same days.
--   SELECT (SELECT sum(revenue) FROM rollup_unit_daily        WHERE report_date = '2026-10-20') AS new_total,
--          (SELECT sum(revenue) FROM rollup_unit_country_daily WHERE report_date = '2026-10-20') AS source_total;
--
-- Application side (NOT in the code yet; only added once you approve this table):
--   1. src/services/reportGrainStore.js (rebuild step near line 590): after the rollup_unit_country_daily
--      insert for a day, also DELETE + INSERT that day into rollup_unit_daily, in the same transaction.
--   2. src/services/gamSyncService.js fetchUnitDailyRollupBundle: read rollup_unit_daily when it covers the
--      range, otherwise keep using rollup_unit_country_daily (already implemented).
