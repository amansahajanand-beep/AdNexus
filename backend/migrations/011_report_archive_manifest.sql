-- Phase 3: S3 archive manifest for cold storage (365+ days)

CREATE TABLE IF NOT EXISTS report_archive_manifest (
  client_id    UUID NOT NULL REFERENCES gam_clients(id),
  report_date  DATE NOT NULL,
  archive_kind TEXT NOT NULL,
  object_key   TEXT NOT NULL,
  row_count    INT NOT NULL DEFAULT 0,
  byte_size    BIGINT NOT NULL DEFAULT 0,
  checksum     TEXT,
  format       TEXT NOT NULL DEFAULT 'json.gz',
  archived_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (client_id, report_date, archive_kind)
);

CREATE INDEX IF NOT EXISTS idx_archive_manifest_date
  ON report_archive_manifest (client_id, report_date DESC);

ALTER TABLE gam_clients ADD COLUMN IF NOT EXISTS grain_retention_days INT DEFAULT 365;
ALTER TABLE gam_clients ADD COLUMN IF NOT EXISTS rollup_retention_days INT DEFAULT 365;
