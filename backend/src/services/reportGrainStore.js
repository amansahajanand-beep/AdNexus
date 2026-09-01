/**
 * Typed report_grain storage — upsert, read, rollup rebuild, partition management.
 */
const { query, schemaQuery } = require('../db');
const { requireClientId } = require('../utils/clientContext');
const {
  normalizeRowToGrain,
  jsonbRowToGrain,
  grainRowToLegacyDimensions,
  grainRowToLegacyMetrics,
} = require('./dimLookupService');
const logger = require('../utils/logger');

const RICH_GRAIN_SQL = `(g.country_id IS NOT NULL AND g.country_id <> 0 AND g.device_id IS NOT NULL AND g.device_id <> 0)`;

/**
 * Slice used for network-wide KPI totals (overview cards, rollup_kpi_daily).
 * Default `channel` matches GAM Home / programmatic-channel overview (Open auction totals).
 */
const CANONICAL_KPI_SLICE = process.env.CANONICAL_KPI_SLICE || 'channel';

/** SQL fragment: only canonical KPI slice rows (handles legacy empty slice_key). */
function kpiSliceFilterSql(prefix = 'g') {
  const p = prefix;
  const sk = CANONICAL_KPI_SLICE.replace(/'/g, "''");
  if (sk === 'channel') {
    return `(
      ${p}.slice_key = 'channel'
      OR (
        COALESCE(${p}.slice_key, '') = ''
        AND COALESCE(${p}.channel_name, '') <> ''
      )
    )`;
  }
  if (sk === 'inventory_core') {
    return `(
      ${p}.slice_key = 'inventory_core'
      OR (
        COALESCE(${p}.slice_key, '') = ''
        AND COALESCE(${p}.channel_name, '') = ''
        AND COALESCE(${p}.app_id, '') = ''
        AND (
          ${p}.site_id <> 0
          OR COALESCE(${p}.app_name, '') <> ''
          OR ${p}.domain_id <> 0
        )
      )
    )`;
  }
  return `${p}.slice_key = '${sk}'`;
}

const GRAIN_JOIN_SQL = `
  FROM report_grain g
  LEFT JOIN dim_country dc ON dc.id = g.country_id
  LEFT JOIN dim_device dd ON dd.id = g.device_id
  LEFT JOIN dim_ad_unit da ON da.id = g.ad_unit_id AND da.client_id = g.client_id
  LEFT JOIN dim_domain dm ON dm.id = g.domain_id AND dm.client_id = g.client_id
  LEFT JOIN dim_site ds ON ds.id = g.site_id AND ds.client_id = g.client_id
`;

function monthPartitionName(ymd) {
  const [y, m] = String(ymd).slice(0, 7).split('-');
  return `report_grain_${y}_${m}`;
}

function monthBounds(ymd) {
  const [y, m] = String(ymd).slice(0, 7).split('-').map(Number);
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const nextM = m === 12 ? 1 : m + 1;
  const nextY = m === 12 ? y + 1 : y;
  const end = `${nextY}-${String(nextM).padStart(2, '0')}-01`;
  return { start, end };
}

/** Avoid repeated DDL + pool exhaustion — one CREATE per month partition per process. */
const ensuredPartitions = new Set();
const inflightPartitionEnsures = new Map();

async function ensureGrainPartition(reportDate) {
  const part = monthPartitionName(reportDate);
  if (ensuredPartitions.has(part)) return;

  let pending = inflightPartitionEnsures.get(part);
  if (pending) {
    await pending;
    return;
  }

  const { start, end } = monthBounds(reportDate);
  pending = (async () => {
    try {
      await schemaQuery(`
        CREATE TABLE IF NOT EXISTS ${part} PARTITION OF report_grain
        FOR VALUES FROM ('${start}') TO ('${end}')
      `);
      ensuredPartitions.add(part);
    } catch (e) {
      if (/already exists/i.test(e.message)) {
        ensuredPartitions.add(part);
      } else {
        logger.warn(`ensureGrainPartition ${part}:`, e.message);
      }
    } finally {
      inflightPartitionEnsures.delete(part);
    }
  })();

  inflightPartitionEnsures.set(part, pending);
  await pending;
}

async function ensureGrainPartitionsForDates(dates) {
  const sampleByMonth = new Map();
  for (const d of dates || []) {
    const ymd = String(d).slice(0, 10);
    if (!ymd) continue;
    const ym = ymd.slice(0, 7);
    if (!sampleByMonth.has(ym)) sampleByMonth.set(ym, ymd);
  }
  for (const ymd of sampleByMonth.values()) {
    await ensureGrainPartition(ymd);
  }
}

async function upsertGrainBatch(grainRows) {
  if (!grainRows.length) return 0;

  const BATCH = Math.max(50, parseInt(process.env.PG_UPSERT_BATCH || '250', 10));
  let upserted = 0;

  for (let i = 0; i < grainRows.length; i += BATCH) {
    const chunk = grainRows.slice(i, i + BATCH);
    const values = [];
    const params = [];
    let p = 1;
    for (const g of chunk) {
      values.push(
        `($${p++}::uuid,$${p++}::date,$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},NOW())`
      );
      params.push(
        g.client_id, g.report_date, g.country_id, g.device_id,
        g.ad_unit_id, g.domain_id, g.site_id,
        g.channel_name, g.app_name, g.app_id,
        g.slice_key || CANONICAL_KPI_SLICE,
        g.impressions, g.clicks, g.revenue,
        g.viewable_pct, g.ecpm, g.unfilled, g.currency
      );
    }
    await query(
      `INSERT INTO report_grain (
         client_id, report_date, country_id, device_id, ad_unit_id, domain_id, site_id,
         channel_name, app_name, app_id, slice_key,
         impressions, clicks, revenue, viewable_pct, ecpm, unfilled, currency, synced_at
       ) VALUES ${values.join(',\n')}
       ON CONFLICT (client_id, report_date, country_id, device_id, ad_unit_id, domain_id, site_id, channel_name, app_name, app_id)
       DO UPDATE SET
         slice_key = COALESCE(NULLIF(EXCLUDED.slice_key, ''), report_grain.slice_key),
         impressions = COALESCE(NULLIF(EXCLUDED.impressions, 0), report_grain.impressions),
         clicks = COALESCE(NULLIF(EXCLUDED.clicks, 0), report_grain.clicks),
         revenue = COALESCE(NULLIF(EXCLUDED.revenue, 0), report_grain.revenue),
         viewable_pct = COALESCE(NULLIF(EXCLUDED.viewable_pct, 0), report_grain.viewable_pct),
         ecpm = COALESCE(NULLIF(EXCLUDED.ecpm, 0), report_grain.ecpm),
         unfilled = COALESCE(NULLIF(EXCLUDED.unfilled, 0), report_grain.unfilled),
         currency = EXCLUDED.currency,
         synced_at = EXCLUDED.synced_at`,
      params
    );
    upserted += chunk.length;
  }
  return upserted;
}

async function upsertGrainRows(normalizedRows, syncType = 'sync') {
  if (!normalizedRows?.length) return 0;

  const clientId = requireClientId();
  const PROCESS_CHUNK = Math.max(100, parseInt(process.env.GRAIN_NORMALIZE_CHUNK || '500', 10));
  let upserted = 0;

  for (let i = 0; i < normalizedRows.length; i += PROCESS_CHUNK) {
    const slice = normalizedRows.slice(i, i + PROCESS_CHUNK);
    const grainRows = [];
    const partitionDates = new Set();

    for (const row of slice) {
      try {
        const g = await normalizeRowToGrain(row, clientId);
        if (!g.report_date) continue;
        partitionDates.add(g.report_date);
        grainRows.push(g);
      } catch (e) {
        logger.warn(`[${syncType}] normalizeRowToGrain failed:`, e.message);
      }
    }

    if (!grainRows.length) continue;

    await ensureGrainPartitionsForDates(partitionDates);
    upserted += await upsertGrainBatch(grainRows);
  }

  return upserted;
}

async function upsertGrainFromJsonbRows(jsonbRows, syncType) {
  if (!jsonbRows?.length) return 0;
  const clientId = requireClientId();
  const normalized = [];
  for (const row of jsonbRows) {
    try {
      const g = await jsonbRowToGrain(row, clientId);
      normalized.push({
        report_date: g.report_date,
        dimensions: grainRowToLegacyDimensions(g, {}),
        metrics: grainRowToLegacyMetrics(g),
        currency: g.currency,
      });
    } catch (e) {
      logger.warn(`[${syncType}] jsonbRowToGrain:`, e.message);
    }
  }
  return upsertGrainRows(normalized, syncType);
}

/** SQL: canonical domain for inventory — prefer real SITE_NAME root, then ad-unit, then DOMAIN dim.
 * Matches GAM Historical Domain better than channel/ad-unit-only inference. */
function grainDomainExprSql() {
  const au = `COALESCE(da.name, '')`;
  const auRoot = `CASE
      WHEN ${au} <> '' AND ${au} LIKE '%.%_%'
      THEN NULLIF(LOWER(TRIM(split_part(
        regexp_replace(${au}, '\\s*\\(\\d+\\)\\s*$', ''),
        '_', 1
      ))), '')
      ELSE NULL
    END`;
  // Last two hostname labels: www.gamisco.com / game1.gamisco.com → gamisco.com
  const siteRoot = `NULLIF(LOWER(SUBSTRING(TRIM(COALESCE(ds.name, '')) FROM '[^.]+\\.[^.]+$')), '')`;
  return `COALESCE(
    ${siteRoot},
    ${auRoot},
    NULLIF(LOWER(TRIM(dm.name)), '')
  )`;
}

/** Same inference on rollup_kpi_daily flat columns (works before rollup rebuild). */
function rollupInvDomainExprSql() {
  const au = `COALESCE(inv_ad_unit, '')`;
  const auRoot = `CASE
      WHEN ${au} <> '' AND ${au} LIKE '%.%_%'
      THEN NULLIF(LOWER(TRIM(split_part(
        regexp_replace(${au}, '\\s*\\(\\d+\\)\\s*$', ''),
        '_', 1
      ))), '')
      ELSE NULL
    END`;
  const siteRoot = `NULLIF(LOWER(SUBSTRING(TRIM(COALESCE(inv_site, '')) FROM '[^.]+\\.[^.]+$')), '')`;
  return `COALESCE(
    ${siteRoot},
    ${auRoot},
    NULLIF(LOWER(TRIM(inv_domain)), '')
  )`;
}

/** Typed SQL fragments for rollup rebuild from report_grain. */
function typedGrainMetricSql(prefix = 'g') {
  const p = prefix;
  const domainExpr = grainDomainExprSql();
  return {
    impressionExpr: `COALESCE(${p}.impressions, 0)::float8`,
    revenueExpr: `COALESCE(${p}.revenue, 0)::float8`,
    viewablePctExpr: `COALESCE(${p}.viewable_pct, 0)::float8`,
    clickExpr: `COALESCE(${p}.clicks, 0)::float8`,
    domainExpr,
    siteExpr: `COALESCE(NULLIF(TRIM(ds.name), ''), '')`,
    adUnitExpr: `COALESCE(NULLIF(TRIM(da.name), ''), '')`,
    appExpr: `COALESCE(NULLIF(TRIM(${p}.app_id), ''), NULLIF(TRIM(${p}.app_name), ''), '')`,
    countryExpr: `COALESCE(NULLIF(TRIM(dc.name), ''), '')`,
    deviceExpr: `COALESCE(NULLIF(TRIM(dd.name), ''), '')`,
    currencyExpr: `COALESCE(${p}.currency, 'USD')`,
  };
}

async function rebuildRollupsFromGrain(dates, syncType = 'rollup') {
  const uniq = [...new Set((dates || []).map((d) => String(d).slice(0, 10)).filter(Boolean))];
  if (!uniq.length) return 0;

  const m = typedGrainMetricSql('g');
  let totalKpi = 0;
  const clientId = requireClientId();

  for (const day of uniq) {
    try {
      await query(
        `DELETE FROM rollup_kpi_daily WHERE client_id = $2::uuid AND report_date = $1::date`,
        [day, clientId]
      );
      await query(
        `DELETE FROM rollup_dim_daily WHERE client_id = $2::uuid AND report_date = $1::date`,
        [day, clientId]
      );

      const kpiRes = await query(
        `INSERT INTO rollup_kpi_daily (
           client_id, report_date, inv_domain, inv_site, inv_ad_unit, inv_app,
           impressions, revenue, viewable_weight, clicks, grain_count, currency
         )
         SELECT
           $2::uuid,
           g.report_date,
           COALESCE(NULLIF(TRIM(${m.domainExpr}), ''), ''),
           COALESCE(NULLIF(TRIM(${m.siteExpr}), ''), ''),
           COALESCE(NULLIF(TRIM(${m.adUnitExpr}), ''), ''),
           COALESCE(NULLIF(TRIM(${m.appExpr}), ''), ''),
           COALESCE(SUM(${m.impressionExpr}), 0),
           COALESCE(SUM(${m.revenueExpr}), 0),
           COALESCE(SUM((${m.impressionExpr}) * (${m.viewablePctExpr})), 0),
           COALESCE(SUM(${m.clickExpr}), 0),
           COUNT(*)::int,
           COALESCE(MAX(${m.currencyExpr}), 'USD')
         ${GRAIN_JOIN_SQL}
         WHERE g.client_id = $2::uuid AND g.report_date = $1::date
           AND ${kpiSliceFilterSql('g')}
         GROUP BY g.report_date,
           COALESCE(NULLIF(TRIM(${m.domainExpr}), ''), ''),
           COALESCE(NULLIF(TRIM(${m.siteExpr}), ''), ''),
           COALESCE(NULLIF(TRIM(${m.adUnitExpr}), ''), ''),
           COALESCE(NULLIF(TRIM(${m.appExpr}), ''), '')
         HAVING COALESCE(SUM(${m.impressionExpr}), 0) > 0
             OR COALESCE(SUM(${m.revenueExpr}), 0) > 0`,
        [day, clientId]
      );
      totalKpi += kpiRes.rowCount || 0;

      const dimInserts = [
        ['domain', m.domainExpr],
        ['ad_unit', m.adUnitExpr],
        ['country', m.countryExpr],
        ['device', m.deviceExpr],
      ];
      for (const [kind, expr] of dimInserts) {
        await query(
          `INSERT INTO rollup_dim_daily (client_id, report_date, dim_kind, dim_value, revenue, impressions)
           SELECT
             $3::uuid,
             g.report_date,
             $2::text,
             NULLIF(TRIM(${expr}), ''),
             COALESCE(SUM(${m.revenueExpr}), 0),
             COALESCE(SUM(${m.impressionExpr}), 0)
           ${GRAIN_JOIN_SQL}
           WHERE g.client_id = $3::uuid AND g.report_date = $1::date
             AND ${kpiSliceFilterSql('g')}
           GROUP BY g.report_date, NULLIF(TRIM(${expr}), '')
           HAVING NULLIF(TRIM(${expr}), '') IS NOT NULL
             AND (COALESCE(SUM(${m.impressionExpr}), 0) > 0 OR COALESCE(SUM(${m.revenueExpr}), 0) > 0)`,
          [day, kind, clientId]
        );
      }
    } catch (e) {
      logger.warn(`[${syncType}] rollup rebuild failed for ${day}:`, e.message);
    }
  }
  logger.info(`[${syncType}] Rebuilt rollups from grain for ${uniq.length} day(s); kpi rows≈${totalKpi}`);
  await rebuildInventoryRollupsFromGrain(uniq, syncType);
  return totalKpi;
}

/**
 * Rebuild Site/Domain rollups from inventory_core (real GAM SITE_NAME hosts).
 * Channel KPI rollups keep d1.* slot hosts for overview; inventory table uses this.
 */
async function rebuildInventoryRollupsFromGrain(dates, syncType = 'rollup') {
  const uniq = [...new Set((dates || []).map((d) => String(d).slice(0, 10)).filter(Boolean))];
  if (!uniq.length) return 0;

  const m = typedGrainMetricSql('g');
  let totalKpi = 0;
  const clientId = requireClientId();

  for (const day of uniq) {
    try {
      await query(
        `DELETE FROM rollup_inventory_kpi_daily WHERE client_id = $2::uuid AND report_date = $1::date`,
        [day, clientId]
      );
      // Collapse to date × domain × site (no ad-unit) — Inventory Breakdown default grain.
      const kpiRes = await query(
        `INSERT INTO rollup_inventory_kpi_daily (
           client_id, report_date, inv_domain, inv_site, inv_ad_unit, inv_app,
           impressions, revenue, viewable_weight, clicks, grain_count, currency
         )
         SELECT
           $2::uuid,
           g.report_date,
           COALESCE(NULLIF(TRIM(${m.domainExpr}), ''), ''),
           COALESCE(NULLIF(TRIM(${m.siteExpr}), ''), ''),
           '',
           '',
           COALESCE(SUM(${m.impressionExpr}), 0),
           COALESCE(SUM(${m.revenueExpr}), 0),
           COALESCE(SUM((${m.impressionExpr}) * (${m.viewablePctExpr})), 0),
           COALESCE(SUM(${m.clickExpr}), 0),
           COUNT(*)::int,
           COALESCE(MAX(${m.currencyExpr}), 'USD')
         ${GRAIN_JOIN_SQL}
         WHERE g.client_id = $2::uuid AND g.report_date = $1::date
           AND g.slice_key = 'inventory_core'
         GROUP BY g.report_date,
           COALESCE(NULLIF(TRIM(${m.domainExpr}), ''), ''),
           COALESCE(NULLIF(TRIM(${m.siteExpr}), ''), '')
         HAVING COALESCE(SUM(${m.impressionExpr}), 0) > 0
             OR COALESCE(SUM(${m.revenueExpr}), 0) > 0`,
        [day, clientId]
      );
      totalKpi += kpiRes.rowCount || 0;
    } catch (e) {
      logger.warn(`[${syncType}] inventory rollup rebuild failed for ${day}:`, e.message);
    }
  }
  if (totalKpi > 0) {
    logger.info(`[${syncType}] Rebuilt inventory rollups for ${uniq.length} day(s); rows≈${totalKpi}`);
  }
  return totalKpi;
}

async function fetchGrainLegacyFromDB(startDate, endDate) {
  const clientId = requireClientId();
  const { rows } = await query(
    `SELECT
       g.report_date,
       dc.name AS country_name,
       dd.name AS device_name,
       da.name AS ad_unit_name,
       dm.name AS domain_name,
       ds.name AS site_name,
       g.channel_name, g.app_name, g.app_id,
       g.impressions, g.clicks, g.revenue, g.viewable_pct, g.ecpm,
       g.currency, g.synced_at
     ${GRAIN_JOIN_SQL}
     WHERE g.client_id = $1::uuid
       AND g.report_date BETWEEN $2::date AND $3::date
     ORDER BY g.report_date DESC`,
    [clientId, startDate, endDate]
  );

  return rows.map((r) => {
    const dimensions = grainRowToLegacyDimensions(r, {
      country: r.country_name,
      device: r.device_name,
      adUnit: r.ad_unit_name,
      domain: r.domain_name,
      site: r.site_name,
    });
    const metrics = grainRowToLegacyMetrics({
      impressions: r.impressions,
      clicks: r.clicks,
      revenue: r.revenue,
      viewable_pct: r.viewable_pct,
      ecpm: r.ecpm,
    });
    return {
      report_date: r.report_date,
      dimensions,
      metrics,
      currency: r.currency,
      synced_at: r.synced_at,
      source: 'grain',
    };
  });
}

async function fetchGrainLeanRowsFromDB(startDate, endDate, opts = {}) {
  const clientId = requireClientId();
  const params = [clientId, startDate, endDate];
  let extra = '';

  const { sanitizeInventoryFilters, MAX_INVENTORY_FILTER_VALUES } = require('../utils/inventoryFilters');
  const safeOpts = sanitizeInventoryFilters({
    domain: opts.domains,
    site: opts.sites,
    domainName: opts.adUnitNames,
    domainId: opts.apps,
  });

  const adUnitNames = (safeOpts.domainName || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const domains = (safeOpts.domain || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const sites = (safeOpts.site || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const apps = (safeOpts.domainId || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const countryNames = (opts.countryNames || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);

  if (adUnitNames.length) {
    params.push(adUnitNames);
    extra += ` AND LOWER(COALESCE(da.name, '')) = ANY($${params.length}::text[])`;
  }
  if (domains.length) {
    params.push(domains);
    extra += ` AND ${grainDomainExprSql()} = ANY($${params.length}::text[])`;
  }
  if (sites.length) {
    params.push(sites);
    extra += ` AND LOWER(COALESCE(ds.name, '')) = ANY($${params.length}::text[])`;
  }
  if (apps.length) {
    params.push(apps);
    extra += ` AND (LOWER(COALESCE(g.app_id, '')) = ANY($${params.length}::text[])
      OR LOWER(COALESCE(g.app_name, '')) = ANY($${params.length}::text[]))`;
  }
  if (countryNames.length) {
    params.push(countryNames);
    extra += ` AND LOWER(COALESCE(dc.name, '')) = ANY($${params.length}::text[])`;
  }
  if (opts.kpiSliceOnly) {
    extra += ` AND ${kpiSliceFilterSql('g')}`;
  }

  const leanSelect = `
       to_char(g.report_date, 'YYYY-MM-DD') AS report_date,
       COALESCE(dc.name, '') AS country,
       COALESCE(dd.name, '') AS device,
       COALESCE(da.name, '') AS ad_unit,
       COALESCE(dm.name, '') AS domain_name,
       COALESCE(ds.name, '') AS site_url,
       COALESCE(NULLIF(g.app_id, ''), g.app_name, '') AS app_id,
       COALESCE(g.impressions, 0)::float8 AS impression,
       COALESCE(g.revenue, 0)::float8 AS revenue_raw,
       COALESCE(g.viewable_pct, 0)::float8 AS viewable_raw,
       COALESCE(g.clicks, 0)::float8 AS clicks,
       g.currency`;

  const tableLimit = Math.min(Math.max(parseInt(opts.tableLimit, 10) || 0, 0), 5000);
  if (opts.tableSample && tableLimit > 0) {
    const startMs = new Date(`${startDate}T12:00:00`).getTime();
    const endMs = new Date(`${endDate}T12:00:00`).getTime();
    const dayCount = Math.max(1, Math.round((endMs - startMs) / 86400000) + 1);
    const perDay = Math.max(20, Math.min(400, Math.ceil(tableLimit / dayCount)));
    params.push(perDay);
    const perDayIdx = params.length;
    params.push(tableLimit);
    const limitIdx = params.length;
    const { rows } = await query(
      `WITH ranked AS (
         SELECT
           ${leanSelect},
           ROW_NUMBER() OVER (
             PARTITION BY g.report_date
             ORDER BY COALESCE(g.revenue, 0) DESC, COALESCE(g.impressions, 0) DESC
           ) AS day_rank
         ${GRAIN_JOIN_SQL}
         WHERE g.client_id = $1::uuid
           AND g.report_date BETWEEN $2::date AND $3::date
           ${extra}
       )
       SELECT report_date, country, device, ad_unit, domain_name, site_url, app_id,
              impression, revenue_raw, viewable_raw, clicks, currency
       FROM ranked
       WHERE day_rank <= $${perDayIdx}
       ORDER BY day_rank ASC, report_date DESC, revenue_raw DESC
       LIMIT $${limitIdx}`,
      params
    );
    return rows;
  }

  const maxRows = Math.max(1000, parseInt(process.env.MAX_LEAN_GRAIN_ROWS || '25000', 10) || 25000);
  const { rows } = await query(
    `SELECT
       ${leanSelect}
     ${GRAIN_JOIN_SQL}
     WHERE g.client_id = $1::uuid
       AND g.report_date BETWEEN $2::date AND $3::date
       ${extra}
     ORDER BY g.report_date DESC
     LIMIT ${maxRows}`,
    params
  );
  return rows;
}

function appendGrainInventoryFilters(params, extra, opts = {}) {
  const { sanitizeInventoryFilters } = require('../utils/inventoryFilters');
  const safeOpts = sanitizeInventoryFilters({
    domain: opts.domains,
    site: opts.sites,
    domainName: opts.adUnitNames,
    domainId: opts.apps,
  });
  const adUnitNames = (safeOpts.domainName || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const domains = (safeOpts.domain || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const sites = (safeOpts.site || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const apps = (safeOpts.domainId || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const countryNames = (opts.countryNames || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const domainExpr = grainDomainExprSql();
  let clause = extra || '';

  if (adUnitNames.length) {
    params.push(adUnitNames);
    clause += ` AND LOWER(COALESCE(da.name, '')) = ANY($${params.length}::text[])`;
  }
  if (domains.length) {
    params.push(domains);
    // Match canonical domain, dim name, ad-unit root, or site-host root so
    // mis-tagged DOMAIN rows for gamisco (etc.) still resolve correctly.
    clause += ` AND (
      ${domainExpr} = ANY($${params.length}::text[])
      OR LOWER(COALESCE(dm.name, '')) = ANY($${params.length}::text[])
      OR LOWER(SPLIT_PART(REGEXP_REPLACE(COALESCE(da.name, ''), '\\s*\\(\\d+\\)\\s*$', ''), '_', 1))
           = ANY($${params.length}::text[])
      OR NULLIF(LOWER(SUBSTRING(TRIM(COALESCE(ds.name, '')) FROM '[^.]+\\.[^.]+$')), '')
           = ANY($${params.length}::text[])
    )`;
  }
  if (sites.length) {
    const expanded = [];
    const seen = new Set();
    for (const raw of sites) {
      const s = String(raw || '').trim().toLowerCase();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      expanded.push(s);
      if (s.startsWith('www.') && !seen.has(s.slice(4))) {
        seen.add(s.slice(4));
        expanded.push(s.slice(4));
      } else if ((s.match(/\./g) || []).length === 1) {
        const www = `www.${s}`;
        if (!seen.has(www)) {
          seen.add(www);
          expanded.push(www);
        }
      }
    }
    params.push(expanded);
    clause += ` AND LOWER(COALESCE(ds.name, '')) = ANY($${params.length}::text[])`;
  }
  if (apps.length) {
    params.push(apps);
    clause += ` AND (LOWER(COALESCE(g.app_id, '')) = ANY($${params.length}::text[])
      OR LOWER(COALESCE(g.app_name, '')) = ANY($${params.length}::text[]))`;
  }
  if (countryNames.length) {
    params.push(countryNames);
    clause += ` AND LOWER(COALESCE(dc.name, '')) = ANY($${params.length}::text[])`;
  }
  if (opts.kpiSliceOnly) {
    clause += ` AND ${kpiSliceFilterSql('g')}`;
  } else if (opts.sliceKey) {
    const sk = String(opts.sliceKey).replace(/'/g, "''");
    clause += ` AND g.slice_key = '${sk}'`;
  } else if (opts.inventorySlicesOnly) {
    clause += ` AND g.slice_key IN ('inventory_core', 'inventory_site_domain', 'inventory_domain', 'rich_core')`;
  }
  return clause;
}

function reportingTableLimit(startDate, endDate, requested) {
  const startMs = new Date(`${startDate}T12:00:00`).getTime();
  const endMs = new Date(`${endDate}T12:00:00`).getTime();
  const dayCount = Math.max(1, Math.round((endMs - startMs) / 86400000) + 1);
  const base = Math.min(Math.max(parseInt(requested, 10) || 2500, 50), 15000);
  // Keep enough capacity that every day can contribute rows across long presets.
  const fairMin = Math.min(15000, Math.max(200, dayCount * 40));
  return Math.min(15000, Math.max(base, fairMin));
}

/**
 * Fast Reporting table: one LATERAL top-N per day (partition pruning) instead of
 * aggregating the entire multi-month range into a giant hash before LIMIT.
 */
async function fetchGrainDomainTableRows(startDate, endDate, opts = {}) {
  const clientId = requireClientId();
  const params = [clientId, startDate, endDate];
  const wantsGeo = Boolean(
    opts.groupByCountry || opts.groupByDevice || (opts.countryNames && opts.countryNames.length)
  );
  let filterOpts;
  if (wantsGeo) {
    filterOpts = { ...opts, kpiSliceOnly: false, inventorySlicesOnly: true };
    delete filterOpts.sliceKey;
  } else {
    // Inventory Breakdown must use inventory_core (SITE_NAME), not channel KPI slice.
    filterOpts = { ...opts, kpiSliceOnly: false, sliceKey: opts.sliceKey || 'inventory_core' };
  }
  let extra = appendGrainInventoryFilters(params, '', filterOpts);

  const domainExpr = grainDomainExprSql();
  const siteExpr = `NULLIF(LOWER(TRIM(COALESCE(ds.name, ''))), '')`;
  const adUnitExpr = `NULLIF(TRIM(COALESCE(da.name, '')), '')`;
  const appExpr = `NULLIF(TRIM(COALESCE(NULLIF(g.app_id, ''), g.app_name, '')), '')`;
  const countryExpr = `COALESCE(NULLIF(TRIM(dc.name), ''), '')`;
  const deviceExpr = `COALESCE(NULLIF(TRIM(dd.name), ''), '')`;
  const byCountry = Boolean(opts.groupByCountry || (opts.countryNames && opts.countryNames.length));
  const byDevice = Boolean(opts.groupByDevice);

  let groupExprs;
  let selectDims;
  if (opts.adUnitNames?.length) {
    groupExprs = [`g.report_date`, domainExpr, siteExpr, adUnitExpr];
    selectDims = `
       ${domainExpr} AS domain_name,
       COALESCE(${siteExpr}, '') AS site_url,
       COALESCE(${adUnitExpr}, '') AS ad_unit,
       '' AS app_id`;
  } else if (opts.apps?.length && !opts.domains?.length && !opts.sites?.length) {
    groupExprs = [`g.report_date`, appExpr];
    selectDims = `
       '' AS domain_name,
       '' AS site_url,
       '' AS ad_unit,
       COALESCE(${appExpr}, '') AS app_id`;
  } else if (opts.sites?.length || opts.groupBySite) {
    groupExprs = [`g.report_date`, domainExpr, siteExpr];
    selectDims = `
       ${domainExpr} AS domain_name,
       COALESCE(${siteExpr}, '') AS site_url,
       '' AS ad_unit,
       '' AS app_id`;
  } else {
    // Default inventory table: date × domain × site (not domain-only).
    groupExprs = [`g.report_date`, domainExpr, siteExpr];
    selectDims = `
       ${domainExpr} AS domain_name,
       COALESCE(${siteExpr}, '') AS site_url,
       '' AS ad_unit,
       '' AS app_id`;
  }

  if (byCountry) {
    groupExprs.push(countryExpr);
    selectDims += `,\n       ${countryExpr} AS country`;
  } else {
    selectDims += `,\n       '' AS country`;
  }
  if (byDevice) {
    groupExprs.push(deviceExpr);
    selectDims += `,\n       ${deviceExpr} AS device`;
  } else {
    selectDims += `,\n       '' AS device`;
  }

  const tableLimit = reportingTableLimit(startDate, endDate, opts.tableLimit);
  const startMs = new Date(`${startDate}T12:00:00`).getTime();
  const endMs = new Date(`${endDate}T12:00:00`).getTime();
  const dayCount = Math.max(1, Math.round((endMs - startMs) / 86400000) + 1);
  const perDay = Math.max(8, Math.min(80, Math.ceil(tableLimit / dayCount)));
  params.push(perDay);
  const perDayIdx = params.length;
  params.push(tableLimit);
  const limitIdx = params.length;

  const groupBy = groupExprs.join(', ');
  const havingDomain = groupExprs.includes(domainExpr)
    ? ` AND ${domainExpr} IS NOT NULL AND ${domainExpr} <> ''`
    : '';

  const { rows } = await query(
    `SELECT
       to_char(day_rows.report_date, 'YYYY-MM-DD') AS report_date,
       day_rows.domain_name, day_rows.site_url, day_rows.ad_unit, day_rows.app_id,
       day_rows.country, day_rows.device,
       day_rows.impression, day_rows.revenue_raw, day_rows.viewable_raw, day_rows.clicks, day_rows.currency
     FROM generate_series($2::date, $3::date, '1 day'::interval) AS d(day)
     CROSS JOIN LATERAL (
       SELECT
         ranked.*,
         ROW_NUMBER() OVER (
           ORDER BY ranked.revenue_raw DESC, ranked.impression DESC
         ) AS day_rank
       FROM (
         SELECT
           g.report_date,
           ${selectDims},
           COALESCE(SUM(g.impressions), 0)::float8 AS impression,
           COALESCE(SUM(g.revenue), 0)::float8 AS revenue_raw,
           CASE WHEN COALESCE(SUM(g.impressions), 0) > 0
             THEN COALESCE(SUM(COALESCE(g.impressions, 0) * COALESCE(g.viewable_pct, 0)), 0)
                  / COALESCE(SUM(g.impressions), 0)
             ELSE 0
           END AS viewable_raw,
           COALESCE(SUM(g.clicks), 0)::float8 AS clicks,
           COALESCE(MAX(g.currency), 'USD') AS currency
         ${GRAIN_JOIN_SQL}
         WHERE g.client_id = $1::uuid
           AND g.report_date = d.day::date
           ${extra}${havingDomain}
         GROUP BY ${groupBy}
         HAVING COALESCE(SUM(g.impressions), 0) > 0 OR COALESCE(SUM(g.revenue), 0) > 0
         ORDER BY
           CASE WHEN NULLIF(TRIM(${byCountry ? countryExpr : `''`}), '') IS NOT NULL THEN 0 ELSE 1 END,
           COALESCE(SUM(g.revenue), 0) DESC,
           COALESCE(SUM(g.impressions), 0) DESC
         LIMIT $${perDayIdx}
       ) ranked
     ) AS day_rows
     -- Interleave days (rank then date) so page-1 is not only the latest day.
     ORDER BY day_rows.day_rank ASC, day_rows.report_date DESC, day_rows.revenue_raw DESC
     LIMIT $${limitIdx}`,
    params
  );
  return rows;
}

async function grainHasRichDimsForDate(reportDate) {
  const { rows } = await query(
    `SELECT 1 AS ok FROM report_grain g
     WHERE g.client_id = $1::uuid AND g.report_date = $2::date AND ${RICH_GRAIN_SQL}
     LIMIT 1`,
    [requireClientId(), reportDate]
  );
  return rows.length > 0;
}

async function listGrainDatesMissingRichDims(startDate, endDate) {
  const { rows } = await query(
    `WITH days AS (
       SELECT d::date AS d
       FROM generate_series($2::date, $3::date, '1 day'::interval) AS d
     )
     SELECT to_char(days.d, 'YYYY-MM-DD') AS report_date
     FROM days
     LEFT JOIN LATERAL (
       SELECT 1 AS ok FROM report_grain g
       WHERE g.client_id = $1::uuid AND g.report_date = days.d AND ${RICH_GRAIN_SQL}
       LIMIT 1
     ) rich ON true
     WHERE rich.ok IS NULL
     ORDER BY 1`,
    [requireClientId(), startDate, endDate]
  );
  return rows.map((r) => r.report_date);
}

async function deleteStaleGrain(dates, syncStartedAt) {
  if (!dates?.length) return;
  await query(
    `DELETE FROM report_grain
     WHERE client_id = $2::uuid
       AND report_date = ANY($1::date[])
       AND synced_at < $3`,
    [dates, requireClientId(), syncStartedAt]
  );
}

async function deleteThinGrainRows(dates) {
  if (!dates?.length) return;
  await query(
    `DELETE FROM report_grain
     WHERE client_id = $2::uuid
       AND report_date = ANY($1::date[])
       AND COALESCE(slice_key, '') <> 'network_kpi'
       AND NOT ${RICH_GRAIN_SQL.replace(/g\./g, 'report_grain.')}`,
    [dates, requireClientId()]
  );
}

async function deleteGrainForDate(reportDate) {
  await query(
    `DELETE FROM report_grain WHERE client_id = $1::uuid AND report_date = $2::date`,
    [requireClientId(), reportDate]
  );
}

async function fetchGrainRowsForArchive(clientId, reportDate) {
  const { rows } = await schemaQuery(
    `SELECT g.*, dc.name AS country_name, dd.name AS device_name,
            da.name AS ad_unit_name, dm.name AS domain_name, ds.name AS site_name
     ${GRAIN_JOIN_SQL}
     WHERE g.client_id = $1::uuid AND g.report_date = $2::date`,
    [clientId, reportDate]
  );
  return rows;
}

module.exports = {
  RICH_GRAIN_SQL,
  CANONICAL_KPI_SLICE,
  kpiSliceFilterSql,
  GRAIN_JOIN_SQL,
  grainDomainExprSql,
  rollupInvDomainExprSql,
  ensureGrainPartition,
  upsertGrainRows,
  upsertGrainFromJsonbRows,
  typedGrainMetricSql,
  rebuildRollupsFromGrain,
  rebuildInventoryRollupsFromGrain,
  fetchGrainLegacyFromDB,
  fetchGrainLeanRowsFromDB,
  fetchGrainDomainTableRows,
  reportingTableLimit,
  appendGrainInventoryFilters,
  grainHasRichDimsForDate,
  listGrainDatesMissingRichDims,
  deleteStaleGrain,
  deleteThinGrainRows,
  deleteGrainForDate,
  fetchGrainRowsForArchive,
};
