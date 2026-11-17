-- AdNexus read-only diagnostics. Run in psql:
--   psql -h HOST -U gam_dashboard_user -d gam_dashboard_db -f explain_diagnostics.sql
-- Everything here is SELECT / EXPLAIN only. EXPLAIN ANALYZE runs the SELECT for real
-- (reads data, writes nothing) - run it off-peak, with the date range kept small first.

\timing on
\pset pager off

-- ---- 0. Settings: pick a client and a date range --------------------------------
-- Run "SELECT id, name FROM gam_clients;" first if you do not know the client id.
-- Adsyntra LLC. Others: Yieldoora cc03da55-d238-4d34-b4d4-9d7daf5c5520,
-- WHITEARBI 46b1425c-c0fb-46b6-ada5-0e509f91f57f, KGS BY CG 0684ba42-3b77-44f4-ad97-6a1c043749cb,
-- Mediamonetix c7f026e5-ba1d-494d-b2d2-e43203de0213, BT GLOBAL 210e35a7-cf34-4d98-8e3d-4a84ef800ab4
\set cid  '''a6a80cdd-9028-4ba2-9c42-b2ac6c316e08'''
-- Row-level security hides every row unless the session sets the tenant (the app does this per request).
SELECT set_config('app.client_id', :cid, false);
\set d1   '''2026-11-09'''
\set d2   '''2026-11-15'''

-- ---- 1. Server / settings --------------------------------------------------------
SELECT version();
SELECT name, setting, unit FROM pg_settings
WHERE name IN ('shared_buffers','effective_cache_size','work_mem','maintenance_work_mem',
               'random_page_cost','max_connections','autovacuum_vacuum_scale_factor');

-- ---- 2. Biggest tables and how much of each is index ----------------------------
SELECT c.relname,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
       pg_size_pretty(pg_relation_size(c.oid))       AS table_only,
       pg_size_pretty(pg_indexes_size(c.oid))        AS indexes,
       c.reltuples::bigint                           AS est_rows
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 15;

-- ---- 3. Bloat: dead rows and last vacuum ----------------------------------------
SELECT relname, n_live_tup, n_dead_tup,
       round(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
       last_autovacuum, last_autoanalyze
FROM pg_stat_user_tables ORDER BY n_dead_tup DESC LIMIT 10;

-- ---- 4. Indexes on the grain partition you query most ---------------------------
SELECT indexname, indexdef FROM pg_indexes
WHERE tablename = 'report_grain_2026_11' ORDER BY indexname;

-- Which indexes are never used (candidates to drop) and which are used most
SELECT relname, indexrelname, idx_scan,
       pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
WHERE relname LIKE 'report_grain_%'
ORDER BY idx_scan ASC LIMIT 15;

-- ---- 5. Cache hit ratio (should be above 99% for a healthy setup) ---------------
SELECT sum(heap_blks_hit)  AS hit,
       sum(heap_blks_read) AS read_from_disk,
       round(100.0 * sum(heap_blks_hit) / NULLIF(sum(heap_blks_hit) + sum(heap_blks_read), 0), 2) AS hit_pct
FROM pg_statio_user_tables;

-- ---- 6. Currently running / waiting queries -------------------------------------
SELECT pid, state, wait_event_type, wait_event,
       now() - query_start AS running_for, left(query, 100) AS query
FROM pg_stat_activity
WHERE datname = current_database() AND state <> 'idle' AND pid <> pg_backend_pid()
ORDER BY query_start;

-- ---- 7. Pre-aggregated path: dashboard KPI from rollup (should be fast) ---------
EXPLAIN (ANALYZE, BUFFERS, TIMING)
SELECT report_date, SUM(impressions) AS impressions, SUM(revenue) AS revenue
FROM rollup_network_daily
WHERE client_id = :cid::uuid AND report_date BETWEEN :d1::date AND :d2::date
GROUP BY report_date ORDER BY report_date;

-- ---- 8. Same totals computed from the raw grain (compare timing with #7) --------
EXPLAIN (ANALYZE, BUFFERS, TIMING)
SELECT report_date, SUM(impressions) AS impressions, SUM(revenue) AS revenue
FROM report_grain
WHERE client_id = :cid::uuid AND report_date BETWEEN :d1::date AND :d2::date
GROUP BY report_date ORDER BY report_date;

-- ---- 9. Grain filtered by site (this is the shape that is slow today) -----------
-- Picks the site with the most rows in the range so the filter is realistic.
EXPLAIN (ANALYZE, BUFFERS, TIMING)
SELECT g.report_date, SUM(g.impressions) AS impressions, SUM(g.revenue) AS revenue
FROM report_grain g
WHERE g.client_id = :cid::uuid
  AND g.report_date BETWEEN :d1::date AND :d2::date
  AND g.site_id = (
        SELECT site_id FROM report_grain
        WHERE client_id = :cid::uuid AND report_date = :d2::date AND site_id <> 0
        GROUP BY site_id ORDER BY count(*) DESC LIMIT 1)
GROUP BY g.report_date ORDER BY g.report_date;

-- ---- 10. Grain filtered by country and ad unit ----------------------------------
EXPLAIN (ANALYZE, BUFFERS, TIMING)
SELECT country_id, ad_unit_id, SUM(impressions) AS impressions, SUM(revenue) AS revenue
FROM report_grain
WHERE client_id = :cid::uuid AND report_date BETWEEN :d1::date AND :d2::date
GROUP BY country_id, ad_unit_id
ORDER BY revenue DESC LIMIT 50;

-- ---- 11. Rollup by site and country (should be fast) ----------------------------
EXPLAIN (ANALYZE, BUFFERS, TIMING)
SELECT * FROM rollup_site_country_daily
WHERE client_id = :cid::uuid AND report_date BETWEEN :d1::date AND :d2::date
LIMIT 100;

