-- Tag each GAM lean-sync slice so KPI rollups don't sum overlapping slices (~4x inflation).

ALTER TABLE report_grain
  ADD COLUMN IF NOT EXISTS slice_key TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_report_grain_slice_kpi
  ON report_grain (client_id, report_date, slice_key)
  WHERE slice_key <> '';

-- Best-effort backfill for rows synced before slice_key existed.
UPDATE report_grain SET slice_key = 'channel'
  WHERE slice_key = '' AND COALESCE(channel_name, '') <> '';

UPDATE report_grain SET slice_key = 'app_id'
  WHERE slice_key = '' AND COALESCE(app_id, '') <> '';

UPDATE report_grain SET slice_key = 'rich_core'
  WHERE slice_key = ''
    AND COALESCE(channel_name, '') = ''
    AND COALESCE(app_id, '') = ''
    AND COALESCE(app_name, '') = ''
    AND site_id = 0
    AND domain_id = 0;

UPDATE report_grain SET slice_key = 'inventory_core'
  WHERE slice_key = '';
