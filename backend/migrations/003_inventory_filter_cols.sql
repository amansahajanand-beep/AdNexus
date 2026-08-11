-- Inventory filter fields stored as first-class columns for fast exact matching.
-- Maps to API filters: domain → inv_domain, site → inv_site,
-- domainName (ad unit) → inv_ad_unit, domainId (app) → inv_app.

ALTER TABLE report_daily
  ADD COLUMN IF NOT EXISTS inv_domain  TEXT,
  ADD COLUMN IF NOT EXISTS inv_site    TEXT,
  ADD COLUMN IF NOT EXISTS inv_ad_unit TEXT,
  ADD COLUMN IF NOT EXISTS inv_app     TEXT;

ALTER TABLE report_present
  ADD COLUMN IF NOT EXISTS inv_domain  TEXT,
  ADD COLUMN IF NOT EXISTS inv_site    TEXT,
  ADD COLUMN IF NOT EXISTS inv_ad_unit TEXT,
  ADD COLUMN IF NOT EXISTS inv_app     TEXT;

CREATE INDEX IF NOT EXISTS idx_report_daily_inv_domain ON report_daily (LOWER(inv_domain));
CREATE INDEX IF NOT EXISTS idx_report_daily_inv_site ON report_daily (LOWER(inv_site));
CREATE INDEX IF NOT EXISTS idx_report_daily_inv_ad_unit ON report_daily (LOWER(inv_ad_unit));
CREATE INDEX IF NOT EXISTS idx_report_daily_inv_app ON report_daily (LOWER(inv_app));

CREATE INDEX IF NOT EXISTS idx_report_present_inv_domain ON report_present (LOWER(inv_domain));
CREATE INDEX IF NOT EXISTS idx_report_present_inv_site ON report_present (LOWER(inv_site));
CREATE INDEX IF NOT EXISTS idx_report_present_inv_ad_unit ON report_present (LOWER(inv_ad_unit));
CREATE INDEX IF NOT EXISTS idx_report_present_inv_app ON report_present (LOWER(inv_app));
