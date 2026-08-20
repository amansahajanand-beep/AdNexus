-- Drop retired full-report warehouse (replaced by lean + adhoc tables).
-- Safe to run multiple times.

DROP TABLE IF EXISTS report_full_present CASCADE;
DROP TABLE IF EXISTS report_full_daily CASCADE;
