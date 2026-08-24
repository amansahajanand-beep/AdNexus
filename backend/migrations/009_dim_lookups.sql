-- Phase 3: dimension lookup tables (shared + per-client)

CREATE TABLE IF NOT EXISTS dim_country (
  id   SMALLINT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS dim_device (
  id   SMALLINT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS dim_ad_unit (
  id        SERIAL PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES gam_clients(id),
  name      TEXT NOT NULL,
  UNIQUE (client_id, name)
);

CREATE TABLE IF NOT EXISTS dim_domain (
  id        SERIAL PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES gam_clients(id),
  name      TEXT NOT NULL,
  UNIQUE (client_id, name)
);

CREATE TABLE IF NOT EXISTS dim_site (
  id        SERIAL PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES gam_clients(id),
  name      TEXT NOT NULL,
  UNIQUE (client_id, name)
);

-- Sentinel row id=0 for optional dimensions
INSERT INTO dim_country (id, name) VALUES (0, '') ON CONFLICT (id) DO NOTHING;
INSERT INTO dim_device (id, name) VALUES (0, '') ON CONFLICT (id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_dim_ad_unit_client ON dim_ad_unit (client_id);
CREATE INDEX IF NOT EXISTS idx_dim_domain_client ON dim_domain (client_id);
CREATE INDEX IF NOT EXISTS idx_dim_site_client ON dim_site (client_id);
