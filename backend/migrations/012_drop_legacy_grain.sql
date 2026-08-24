-- Phase 3: drop legacy JSONB grain tables after migration to report_grain
-- Run manually after migrate-jsonb-to-grain.js completes successfully.

DROP TABLE IF EXISTS report_present CASCADE;
DROP TABLE IF EXISTS report_daily CASCADE;
