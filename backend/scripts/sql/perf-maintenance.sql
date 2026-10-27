-- AdNexus performance maintenance. Run with psql against the production database, off-peak:
--   psql -d gam_dashboard_db -f backend/scripts/sql/perf-maintenance.sql
-- Review each step first. Nothing here changes data; steps 2-3 drop/alter indexes and storage settings.

-- 1. Planner statistics. Partitions Dec-Aug showed n_live_tup = 0 and no last_analyze,
--    so the planner was guessing for any query touching those months.
ANALYZE report_grain_2025_12;
ANALYZE report_grain_2026_01;
ANALYZE report_grain_2026_02;
ANALYZE report_grain_2026_03;
ANALYZE report_grain_2026_04;
ANALYZE report_grain_2026_05;
ANALYZE report_grain_2026_06;
ANALYZE report_grain_2026_07;
ANALYZE report_grain_2026_08;

-- 2. Redundant indexes (0 scans on Sep/Oct; duplicate the primary-key prefix).
--    db.js no longer re-creates them. Dropping the PARENT index drops it on every partition.
--    Check first:  SELECT stats_reset FROM pg_stat_database WHERE datname = current_database();
DROP INDEX IF EXISTS idx_report_grain_client_date;
DROP INDEX IF EXISTS idx_report_grain_client_date_domain;
-- NOTE: leave idx_report_grain_inv_core_date (3.8 GB) in place: it is the covering index the
-- inventory_core queries are written for. Investigate with EXPLAIN why it is rarely chosen
-- (stale visibility map -> index-only scans lose to the slice_key index).

-- 3. Autovacuum for the churn-heavy tables: vacuum/analyze after 2% change instead of 20%,
--    so the visibility map stays fresh (enables index-only scans) and dead rows do not pile up.
ALTER TABLE report_grain_2026_09 SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE report_grain_2026_10 SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE rollup_unit_country_fill  SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE rollup_unit_country_daily SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE rollup_fill_daily         SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE rollup_request_daily      SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);

-- 4. Refresh the visibility map on the current months now (does not lock readers).
VACUUM (ANALYZE) report_grain_2026_09;
VACUUM (ANALYZE) report_grain_2026_10;

-- 5. Optional: see slow statements (postgresql.conf or ALTER SYSTEM; then SELECT pg_reload_conf()):
--   ALTER SYSTEM SET log_min_duration_statement = 1000;
