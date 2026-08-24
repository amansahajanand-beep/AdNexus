const { Pool } = require('pg');
const logger = require('./utils/logger');

const pool = new Pool({
  host:     process.env.PG_HOST     || '127.0.0.1',
  port:     parseInt(process.env.PG_PORT) || 5432,
  user:     process.env.PG_USER     || 'gam_dashbaord_user',
  password: process.env.PG_PASSWORD || 'GAM_Mediamonetix',
  database: process.env.PG_DATABASE || 'gam_dashboard_db',
  ssl:      process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false,
  // Sync jobs + API share this pool — keep enough headroom for dashboard reads
  // while hourly backfill is writing.
  max: parseInt(process.env.PG_POOL_MAX || '20', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: parseInt(process.env.PG_CONNECT_TIMEOUT_MS || '30000', 10),
});

function formatPgError(err) {
  if (!err) return 'unknown error';
  const parts = [
    err.message,
    err.code && `code=${err.code}`,
    err.routine && `routine=${err.routine}`,
  ].filter(Boolean);
  return parts.join(' ') || String(err);
}

pool.on('error', (err) => {
  logger.error('PostgreSQL pool error:', formatPgError(err));
});

pool.query('SELECT 1').then(() => {
  logger.info(`[DB] PostgreSQL connected → ${process.env.PG_DATABASE}@${process.env.PG_HOST}:${process.env.PG_PORT}`);
}).catch(err => {
  const detail = formatPgError(err);
  logger.error('[DB] PostgreSQL connection FAILED:', detail);
  if (err?.routine === 'auth_failed' || /password authentication failed/i.test(detail)) {
    logger.error(
      '[DB] Postgres rejected login (auth_failed). Check PG_USER / PG_PASSWORD / PG_HOST on this host — '
      + 'sync jobs cannot fill report tables until this is fixed.'
    );
  }
});

/**
 * Run a query. Returns { rows, rowCount }.
 * Sets app.client_id so FORCE RLS isolates each tenant's report rows.
 */
async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    let clientId = null;
    try {
      clientId = require('./utils/clientContext').getClientId();
    } catch (_) { /* module not ready */ }
    if (clientId) {
      await client.query(`SELECT set_config('app.client_id', $1, false)`, [String(clientId)]);
    } else {
      await client.query(`SELECT set_config('app.client_id', '', false)`);
    }
    return await client.query(sql, params);
  } finally {
    try {
      await client.query(`SELECT set_config('app.client_id', '', false)`);
    } catch (_) { /* ignore */ }
    client.release();
  }
}

/** DDL / backfill — bypasses tenant session so FORCE RLS cannot hide rows. */
async function schemaQuery(sql, params = []) {
  return pool.query(sql, params);
}

/**
 * Initialize schema — safe to call on every startup (CREATE IF NOT EXISTS).
 */
async function initSchema() {
  await schemaQuery(`
    CREATE TABLE IF NOT EXISTS gam_clients (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      network_code TEXT NOT NULL UNIQUE,
      google_client_id TEXT NOT NULL,
      google_client_secret_enc TEXT NOT NULL,
      google_refresh_token_enc TEXT,
      redirect_uri TEXT,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  await schemaQuery(`
    CREATE TABLE IF NOT EXISTS report_daily (
      id          BIGSERIAL PRIMARY KEY,
      client_id   UUID        NOT NULL REFERENCES gam_clients(id),
      report_date DATE        NOT NULL,
      dim_hash    TEXT        NOT NULL,
      dimensions  JSONB       NOT NULL DEFAULT '{}',
      metrics     JSONB       NOT NULL DEFAULT '{}',
      currency    CHAR(3)     NOT NULL DEFAULT 'USD',
      synced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (client_id, report_date, dim_hash)
    );

    CREATE TABLE IF NOT EXISTS report_present (
      id          BIGSERIAL PRIMARY KEY,
      client_id   UUID        NOT NULL REFERENCES gam_clients(id),
      report_date DATE        NOT NULL,
      dim_hash    TEXT        NOT NULL,
      dimensions  JSONB       NOT NULL DEFAULT '{}',
      metrics     JSONB       NOT NULL DEFAULT '{}',
      currency    CHAR(3)     NOT NULL DEFAULT 'USD',
      synced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (client_id, report_date, dim_hash)
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      id          BIGSERIAL PRIMARY KEY,
      client_id   UUID        REFERENCES gam_clients(id),
      sync_type   TEXT        NOT NULL,
      started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      status      TEXT        NOT NULL DEFAULT 'running',
      error_msg   TEXT,
      rows_upserted INT
    );

    CREATE TABLE IF NOT EXISTS app_kv_cache (
      cache_key  TEXT PRIMARY KEY,
      payload    JSONB       NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS report_adhoc (
      id           BIGSERIAL PRIMARY KEY,
      client_id    UUID        NOT NULL REFERENCES gam_clients(id),
      report_date  DATE        NOT NULL,
      query_hash   TEXT        NOT NULL,
      dim_hash     TEXT        NOT NULL,
      dimensions   JSONB       NOT NULL DEFAULT '{}',
      metrics      JSONB       NOT NULL DEFAULT '{}',
      dim_keys     TEXT[]      NOT NULL DEFAULT '{}',
      metric_keys  TEXT[]      NOT NULL DEFAULT '{}',
      currency     CHAR(3)     NOT NULL DEFAULT 'USD',
      synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      inv_domain   TEXT,
      inv_site     TEXT,
      inv_ad_unit  TEXT,
      inv_app      TEXT,
      UNIQUE (client_id, report_date, query_hash, dim_hash)
    );

    CREATE TABLE IF NOT EXISTS report_adhoc_coverage (
      client_id   UUID        NOT NULL REFERENCES gam_clients(id),
      query_hash  TEXT        NOT NULL,
      start_date  DATE        NOT NULL,
      end_date    DATE        NOT NULL,
      row_count   INT         NOT NULL DEFAULT 0,
      synced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (client_id, query_hash, start_date, end_date)
    );

    CREATE TABLE IF NOT EXISTS rollup_kpi_daily (
      client_id       UUID        NOT NULL REFERENCES gam_clients(id),
      report_date     DATE        NOT NULL,
      inv_domain      TEXT        NOT NULL DEFAULT '',
      inv_site        TEXT        NOT NULL DEFAULT '',
      inv_ad_unit     TEXT        NOT NULL DEFAULT '',
      inv_app         TEXT        NOT NULL DEFAULT '',
      impressions     DOUBLE PRECISION NOT NULL DEFAULT 0,
      revenue         DOUBLE PRECISION NOT NULL DEFAULT 0,
      viewable_weight DOUBLE PRECISION NOT NULL DEFAULT 0,
      grain_count     INT         NOT NULL DEFAULT 0,
      currency        CHAR(3)     NOT NULL DEFAULT 'USD',
      PRIMARY KEY (client_id, report_date, inv_domain, inv_site, inv_ad_unit, inv_app)
    );

    CREATE TABLE IF NOT EXISTS rollup_dim_daily (
      client_id    UUID        NOT NULL REFERENCES gam_clients(id),
      report_date  DATE        NOT NULL,
      dim_kind     TEXT        NOT NULL,
      dim_value    TEXT        NOT NULL,
      revenue      DOUBLE PRECISION NOT NULL DEFAULT 0,
      impressions  DOUBLE PRECISION NOT NULL DEFAULT 0,
      PRIMARY KEY (client_id, report_date, dim_kind, dim_value)
    );

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

    CREATE TABLE IF NOT EXISTS report_grain (
      client_id     UUID NOT NULL REFERENCES gam_clients(id),
      report_date   DATE NOT NULL,
      country_id    SMALLINT NOT NULL DEFAULT 0 REFERENCES dim_country(id),
      device_id     SMALLINT NOT NULL DEFAULT 0 REFERENCES dim_device(id),
      ad_unit_id    INT NOT NULL DEFAULT 0,
      domain_id     INT NOT NULL DEFAULT 0,
      site_id       INT NOT NULL DEFAULT 0,
      channel_name  TEXT NOT NULL DEFAULT '',
      app_name      TEXT NOT NULL DEFAULT '',
      app_id        TEXT NOT NULL DEFAULT '',
      slice_key     TEXT NOT NULL DEFAULT '',
      impressions   BIGINT NOT NULL DEFAULT 0,
      clicks        INT NOT NULL DEFAULT 0,
      revenue       DOUBLE PRECISION NOT NULL DEFAULT 0,
      viewable_pct  REAL,
      ecpm          REAL,
      unfilled      BIGINT,
      currency      CHAR(3) NOT NULL DEFAULT 'USD',
      synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (
        client_id, report_date, country_id, device_id,
        ad_unit_id, domain_id, site_id, channel_name, app_name, app_id
      )
    );

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
  `);

  try {
    await schemaQuery(`INSERT INTO dim_country (id, name) VALUES (0, '') ON CONFLICT (id) DO NOTHING`);
    await schemaQuery(`INSERT INTO dim_device (id, name) VALUES (0, '') ON CONFLICT (id) DO NOTHING`);
  } catch (e) {
    logger.warn('dim sentinel seed:', e.message);
  }

  try {
    await schemaQuery(`ALTER TABLE gam_clients ADD COLUMN IF NOT EXISTS grain_retention_days INT DEFAULT 365`);
    await schemaQuery(`ALTER TABLE gam_clients ADD COLUMN IF NOT EXISTS rollup_retention_days INT DEFAULT 365`);
    await schemaQuery(`ALTER TABLE report_grain ADD COLUMN IF NOT EXISTS slice_key TEXT NOT NULL DEFAULT ''`);
  } catch (e) {
    logger.warn('gam_clients retention columns:', e.message);
  }

  try {
    const { rows } = await schemaQuery(`
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = 'report_grain' AND c.relkind = 'p'
    `);
    if (!rows.length) {
      await schemaQuery(`
        ALTER TABLE report_grain RENAME TO report_grain_legacy_flat
      `).catch(() => {});
      await schemaQuery(`
        CREATE TABLE IF NOT EXISTS report_grain (
          client_id     UUID NOT NULL REFERENCES gam_clients(id),
          report_date   DATE NOT NULL,
          country_id    SMALLINT NOT NULL DEFAULT 0 REFERENCES dim_country(id),
          device_id     SMALLINT NOT NULL DEFAULT 0 REFERENCES dim_device(id),
          ad_unit_id    INT NOT NULL DEFAULT 0,
          domain_id     INT NOT NULL DEFAULT 0,
          site_id       INT NOT NULL DEFAULT 0,
          channel_name  TEXT NOT NULL DEFAULT '',
          app_name      TEXT NOT NULL DEFAULT '',
          app_id        TEXT NOT NULL DEFAULT '',
          slice_key     TEXT NOT NULL DEFAULT '',
          impressions   BIGINT NOT NULL DEFAULT 0,
          clicks        INT NOT NULL DEFAULT 0,
          revenue       DOUBLE PRECISION NOT NULL DEFAULT 0,
          viewable_pct  REAL,
          ecpm          REAL,
          unfilled      BIGINT,
          currency      CHAR(3) NOT NULL DEFAULT 'USD',
          synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (
            client_id, report_date, country_id, device_id,
            ad_unit_id, domain_id, site_id, channel_name, app_name, app_id
          )
        ) PARTITION BY RANGE (report_date)
      `).catch(() => {});
      await schemaQuery(`
        CREATE TABLE IF NOT EXISTS report_grain_default PARTITION OF report_grain DEFAULT
      `).catch(() => {});
    }
  } catch (e) {
    logger.warn('report_grain partition setup:', e.message);
  }

  // Partition conversion creates a fresh report_grain — ensure slice_key exists after that step.
  try {
    await schemaQuery(`ALTER TABLE report_grain ADD COLUMN IF NOT EXISTS slice_key TEXT NOT NULL DEFAULT ''`);
  } catch (e) {
    logger.warn('report_grain slice_key column:', e.message);
  }

  // Retired warehouse — drop if leftover from older deploys (frees a lot of disk).
  try {
    await schemaQuery(`DROP TABLE IF EXISTS report_full_present CASCADE`);
    await schemaQuery(`DROP TABLE IF EXISTS report_full_daily CASCADE`);
    logger.info('Dropped retired tables report_full_present / report_full_daily (if they existed)');
  } catch (e) {
    logger.warn('Drop retired report_full_* tables:', e.message);
  }

  // Separate statements so one index failure doesn't abort the whole schema init.
  const ddlStatements = [
    `ALTER TABLE report_daily ADD COLUMN IF NOT EXISTS inv_domain TEXT`,
    `ALTER TABLE report_daily ADD COLUMN IF NOT EXISTS inv_site TEXT`,
    `ALTER TABLE report_daily ADD COLUMN IF NOT EXISTS inv_ad_unit TEXT`,
    `ALTER TABLE report_daily ADD COLUMN IF NOT EXISTS inv_app TEXT`,
    `ALTER TABLE report_present ADD COLUMN IF NOT EXISTS inv_domain TEXT`,
    `ALTER TABLE report_present ADD COLUMN IF NOT EXISTS inv_site TEXT`,
    `ALTER TABLE report_present ADD COLUMN IF NOT EXISTS inv_ad_unit TEXT`,
    `ALTER TABLE report_present ADD COLUMN IF NOT EXISTS inv_app TEXT`,
    `ALTER TABLE rollup_kpi_daily ADD COLUMN IF NOT EXISTS clicks DOUBLE PRECISION NOT NULL DEFAULT 0`,
    `CREATE INDEX IF NOT EXISTS idx_report_daily_date ON report_daily (report_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_report_present_date ON report_present (report_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_report_adhoc_query_date ON report_adhoc (query_hash, report_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_report_adhoc_date ON report_adhoc (report_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_report_adhoc_inv_domain ON report_adhoc (LOWER(inv_domain))`,
    `CREATE INDEX IF NOT EXISTS idx_report_adhoc_inv_site ON report_adhoc (LOWER(inv_site))`,
    `CREATE INDEX IF NOT EXISTS idx_report_adhoc_inv_ad_unit ON report_adhoc (LOWER(inv_ad_unit))`,
    `CREATE INDEX IF NOT EXISTS idx_report_adhoc_inv_app ON report_adhoc (LOWER(inv_app))`,
    `CREATE INDEX IF NOT EXISTS idx_report_daily_ad_unit_lower
       ON report_daily (LOWER(COALESCE(dimensions->>'AD_UNIT_NAME', dimensions->>'ad_unit_name', dimensions->>'site', '')))`,
    `CREATE INDEX IF NOT EXISTS idx_report_present_ad_unit_lower
       ON report_present (LOWER(COALESCE(dimensions->>'AD_UNIT_NAME', dimensions->>'ad_unit_name', dimensions->>'site', '')))`,
    `CREATE INDEX IF NOT EXISTS idx_report_daily_domain_lower
       ON report_daily (LOWER(COALESCE(dimensions->>'domainName', dimensions->>'domain', '')))`,
    `CREATE INDEX IF NOT EXISTS idx_report_present_domain_lower
       ON report_present (LOWER(COALESCE(dimensions->>'domainName', dimensions->>'domain', '')))`,
    `CREATE INDEX IF NOT EXISTS idx_report_daily_site_lower
       ON report_daily (LOWER(COALESCE(dimensions->>'siteUrl', dimensions->>'gamSite', dimensions->>'siteName', '')))`,
    `CREATE INDEX IF NOT EXISTS idx_report_present_site_lower
       ON report_present (LOWER(COALESCE(dimensions->>'siteUrl', dimensions->>'gamSite', dimensions->>'siteName', '')))`,
    `CREATE INDEX IF NOT EXISTS idx_report_daily_inv_domain ON report_daily (LOWER(inv_domain))`,
    `CREATE INDEX IF NOT EXISTS idx_report_daily_inv_site ON report_daily (LOWER(inv_site))`,
    `CREATE INDEX IF NOT EXISTS idx_report_daily_inv_ad_unit ON report_daily (LOWER(inv_ad_unit))`,
    `CREATE INDEX IF NOT EXISTS idx_report_daily_inv_app ON report_daily (LOWER(inv_app))`,
    `CREATE INDEX IF NOT EXISTS idx_report_present_inv_domain ON report_present (LOWER(inv_domain))`,
    `CREATE INDEX IF NOT EXISTS idx_report_present_inv_site ON report_present (LOWER(inv_site))`,
    `CREATE INDEX IF NOT EXISTS idx_report_present_inv_ad_unit ON report_present (LOWER(inv_ad_unit))`,
    `CREATE INDEX IF NOT EXISTS idx_report_present_inv_app ON report_present (LOWER(inv_app))`,
    `CREATE INDEX IF NOT EXISTS idx_rollup_kpi_date ON rollup_kpi_daily (report_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_rollup_kpi_domain ON rollup_kpi_daily (report_date, LOWER(inv_domain))`,
    `CREATE INDEX IF NOT EXISTS idx_rollup_kpi_site ON rollup_kpi_daily (report_date, LOWER(inv_site))`,
    `CREATE INDEX IF NOT EXISTS idx_rollup_kpi_ad_unit ON rollup_kpi_daily (report_date, LOWER(inv_ad_unit))`,
    `CREATE INDEX IF NOT EXISTS idx_rollup_kpi_app ON rollup_kpi_daily (report_date, LOWER(inv_app))`,
    `CREATE INDEX IF NOT EXISTS idx_rollup_dim_kind_date ON rollup_dim_daily (dim_kind, report_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_report_daily_client_date ON report_daily (client_id, report_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_report_present_client_date ON report_present (client_id, report_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_report_adhoc_client_date ON report_adhoc (client_id, report_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_sync_log_client ON sync_log (client_id, started_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_report_grain_client_date ON report_grain (client_id, report_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_report_grain_date ON report_grain (report_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_archive_manifest_date ON report_archive_manifest (client_id, report_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_dim_ad_unit_client ON dim_ad_unit (client_id)`,
    `CREATE INDEX IF NOT EXISTS idx_dim_domain_client ON dim_domain (client_id)`,
    `CREATE INDEX IF NOT EXISTS idx_dim_site_client ON dim_site (client_id)`,
  ];
  await migrateMultiClientTenancy();

  logger.info('PostgreSQL schema ready');

  // Indexes + client_id backfill run after listen (see finishTenantBackfill).
  initSchema._deferredDdl = ddlStatements;
}

const TENANT_TABLES = [
  'report_daily',
  'report_present',
  'report_grain',
  'report_archive_manifest',
  'report_adhoc',
  'report_adhoc_coverage',
  'rollup_kpi_daily',
  'rollup_dim_daily',
  'sync_log',
];

function safeIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name || ''))) {
    throw new Error(`Unsafe SQL identifier: ${name}`);
  }
  return name;
}

async function listConstraints(table, types) {
  const { rows } = await schemaQuery(
    `SELECT c.conname, c.contype
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public' AND t.relname = $1 AND c.contype = ANY($2::char[])`,
    [table, types]
  );
  return rows;
}

async function constraintIncludesClientId(table, conname) {
  const { rows } = await schemaQuery(
    `SELECT 1
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN unnest(c.conkey) AS attnum ON true
     JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = attnum
     WHERE t.relname = $1 AND c.conname = $2 AND a.attname = 'client_id'
     LIMIT 1`,
    [table, conname]
  );
  return rows.length > 0;
}

async function migrateMultiClientTenancy() {
  await schemaQuery(`
    CREATE TABLE IF NOT EXISTS gam_clients (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      network_code TEXT NOT NULL UNIQUE,
      google_client_id TEXT NOT NULL,
      google_client_secret_enc TEXT NOT NULL,
      google_refresh_token_enc TEXT,
      redirect_uri TEXT,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  for (const table of TENANT_TABLES) {
    try {
      await schemaQuery(`SET lock_timeout = '2s'`);
      await schemaQuery(`ALTER TABLE ${safeIdent(table)} ADD COLUMN IF NOT EXISTS client_id UUID`);
    } catch (e) {
      logger.warn(`client_id column on ${table}:`, e.message);
    }
  }

  const { ensureBootstrapFromEnv } = require('./models/clientStore');
  await ensureBootstrapFromEnv();

  logger.info('Multi-client tenancy columns ready (row backfill runs after listen)');
}

/** Heavy: indexes, stamp client_id, unique/RLS. Does not block login. */
async function finishTenantBackfill() {
  const deferred = initSchema._deferredDdl || [];
  for (const sql of deferred) {
    try {
      await schemaQuery(sql);
    } catch (e) {
      logger.warn('Schema DDL skipped:', e.message);
    }
  }

  const { ensureBootstrapFromEnv } = require('./models/clientStore');
  const bootstrap = await ensureBootstrapFromEnv();
  const bootstrapId = bootstrap?.id || null;

  if (bootstrapId) {
    for (const table of TENANT_TABLES) {
      try {
        const res = await schemaQuery(
          `UPDATE ${safeIdent(table)} SET client_id = $1::uuid WHERE client_id IS NULL`,
          [bootstrapId]
        );
        if (res.rowCount) {
          logger.info(`Backfilled client_id on ${table}: ${res.rowCount} row(s)`);
        }
      } catch (e) {
        logger.warn(`Backfill client_id on ${table}:`, e.message);
      }
    }
  }

  const uniqueSwaps = [
    ['report_daily', 'report_daily_client_date_hash', '(client_id, report_date, dim_hash)'],
    ['report_present', 'report_present_client_date_hash', '(client_id, report_date, dim_hash)'],
    ['report_adhoc', 'report_adhoc_client_query_hash', '(client_id, report_date, query_hash, dim_hash)'],
  ];

  for (const [table, newName, cols] of uniqueSwaps) {
    try {
      const uniques = await listConstraints(table, ['u']);
      for (const u of uniques) {
        if (u.conname === newName) continue;
        const hasClient = await constraintIncludesClientId(table, u.conname);
        if (!hasClient) {
          await schemaQuery(`ALTER TABLE ${safeIdent(table)} DROP CONSTRAINT IF EXISTS ${safeIdent(u.conname)}`);
        }
      }
      await schemaQuery(`ALTER TABLE ${safeIdent(table)} DROP CONSTRAINT IF EXISTS ${safeIdent(newName)}`);
      await schemaQuery(`ALTER TABLE ${safeIdent(table)} ADD CONSTRAINT ${safeIdent(newName)} UNIQUE ${cols}`);
    } catch (e) {
      logger.warn(`Unique swap ${table}:`, e.message);
    }
  }

  const pkSwaps = [
    ['report_adhoc_coverage', 'report_adhoc_coverage_client_pkey', '(client_id, query_hash, start_date, end_date)'],
    ['rollup_kpi_daily', 'rollup_kpi_daily_pkey', '(client_id, report_date, inv_domain, inv_site, inv_ad_unit, inv_app)'],
    ['rollup_dim_daily', 'rollup_dim_daily_pkey', '(client_id, report_date, dim_kind, dim_value)'],
  ];
  for (const [table, newName, cols] of pkSwaps) {
    try {
      const pks = await listConstraints(table, ['p']);
      for (const pk of pks) {
        await schemaQuery(`ALTER TABLE ${safeIdent(table)} DROP CONSTRAINT IF EXISTS ${safeIdent(pk.conname)}`);
      }
      await schemaQuery(`ALTER TABLE ${safeIdent(table)} ADD CONSTRAINT ${safeIdent(newName)} PRIMARY KEY ${cols}`);
    } catch (e) {
      logger.warn(`PK swap ${table}:`, e.message);
    }
  }

  for (const table of TENANT_TABLES) {
    if (table === 'sync_log') continue;
    try {
      await schemaQuery(`ALTER TABLE ${safeIdent(table)} ALTER COLUMN client_id SET NOT NULL`);
    } catch (e) {
      logger.warn(`NOT NULL client_id on ${table}:`, e.message);
    }
    try {
      await schemaQuery(
        `ALTER TABLE ${safeIdent(table)} DROP CONSTRAINT IF EXISTS ${safeIdent(`${table}_client_id_fkey`)}`
      );
      await schemaQuery(
        `ALTER TABLE ${safeIdent(table)}
         ADD CONSTRAINT ${safeIdent(`${table}_client_id_fkey`)}
         FOREIGN KEY (client_id) REFERENCES gam_clients(id)`
      );
    } catch (e) {
      logger.warn(`FK client_id on ${table}:`, e.message);
    }
  }

  for (const table of TENANT_TABLES) {
    try {
      await schemaQuery(`ALTER TABLE ${safeIdent(table)} ENABLE ROW LEVEL SECURITY`);
      await schemaQuery(`ALTER TABLE ${safeIdent(table)} FORCE ROW LEVEL SECURITY`);
      await schemaQuery(`DROP POLICY IF EXISTS tenant_isolation ON ${table}`);
      await schemaQuery(`
        CREATE POLICY tenant_isolation ON ${safeIdent(table)}
        USING (client_id::text = current_setting('app.client_id', true))
        WITH CHECK (client_id::text = current_setting('app.client_id', true))
      `);
    } catch (e) {
      logger.warn(`RLS on ${table}:`, e.message);
    }
  }

  logger.info('Multi-client tenancy schema ready (client_id on all report tables)');
}

module.exports = { query, schemaQuery, initSchema, finishTenantBackfill, pool };
