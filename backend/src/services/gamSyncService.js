const {
  FULL_SYNC_DIM_SLICES,
  FULL_SYNC_METRIC_BATCHES,
  SAFE_METRICS,
  pickBestFullSlice,
} = require('../utils/fullReportSyncCatalog');
const {
  UNIFIED_GRAIN_METRICS,
  LEAN_SYNC_DIM_SLICES,
  LEAN_SYNC_METRIC_ATTEMPTS,
} = require('../utils/warehouseGrain');
const { parseGamMetricValue, gamMoneyToDollars, coerceWarehouseRevenue, pickRowRevenueDollars } = require('../utils/gamReportMetrics');

/**
 * gamSyncService — fetches data from GAM and writes into PostgreSQL.
 * Called by BullMQ workers. Does NOT touch HTTP request/response.
 *
 * Tables:
 *   report_grain — typed unified grain (dashboard + Reporting SQL)
 *   report_adhoc — on-demand exotic Reporting queries (query cache)
 *   rollup_* — Dashboard KPI speed layer
 *   report_archive_manifest — S3 cold storage index (365+ days)
 */
const crypto  = require('crypto');
const { query } = require('../db');
const { requireClientId, tenantKey, getClientId } = require('../utils/clientContext');
const {
  redisDel, redisDelByPattern, bumpCacheGeneration, TTL, redisGet, redisSet, MAX_REDIS_ARRAY_ITEMS,
} = require('../redisClient');
const { todayInTZ, listDateWindowsNewestFirst, listDateWindowsOldestFirst } = require('../utils/datetime');
const { normalizeReportRows, rowsHaveMetrics } = require('../utils/rowNormalize');
const {
  resolveInventoryFields,
  normalizeHost,
  domainFromAdUnit,
  subdomainFromAdUnit,
  isGamReportSiteHost,
} = require('../utils/adUnit');
const {
  resolveAppFields,
  expandAppFilterAliases,
  loadCachedAppPackageMaps,
  isLikelyAppPackage,
} = require('../utils/appIdentity');
const logger  = require('../utils/logger');
const {
  upsertGrainRows,
  rebuildRollupsFromGrain,
  rebuildInventoryRollupsFromGrain,
  fetchGrainLegacyFromDB,
  fetchGrainLeanRowsFromDB,
  fetchGrainDomainTableRows,
  reportingTableLimit,
  rollupInvDomainExprSql,
  grainHasRichDimsForDate,
  listGrainDatesMissingRichDims,
  deleteStaleGrain,
  deleteThinGrainRows,
  deleteGrainForDate,
} = require('./reportGrainStore');
const archiveService = require('./reportArchiveService');

/** In-flight inventory rollup backfills — avoid stacking duplicate day rebuilds. */
const inventoryRollupBackfillInflight = new Set();

/**
 * Background rebuild of rollup_inventory_kpi_daily for dates missing inventory Site labels.
 * Safe to call from request path — does not block the response.
 */
async function enqueueInventoryRollupBackfill(startDate, endDate) {
  const start = String(startDate || '').slice(0, 10);
  const end = String(endDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return;
  const key = `${start}:${end}`;
  if (inventoryRollupBackfillInflight.has(key)) return;
  inventoryRollupBackfillInflight.add(key);
  setImmediate(async () => {
    try {
      const { rows } = await query(
        `SELECT to_char(d::date, 'YYYY-MM-DD') AS day
         FROM generate_series($1::date, $2::date, '1 day'::interval) d
         WHERE NOT EXISTS (
           SELECT 1 FROM rollup_inventory_kpi_daily r
           WHERE r.report_date = d::date
             AND r.client_id = $3::uuid
           LIMIT 1
         )
         ORDER BY d
         LIMIT 120`,
        [start, end, requireClientId()]
      );
      const dates = (rows || []).map((r) => r.day).filter(Boolean);
      if (!dates.length) return;
      logger.info(`Inventory rollup backfill: rebuilding ${dates.length} day(s) ${dates[0]}..${dates[dates.length - 1]}`);
      await rebuildInventoryRollupsFromGrain(dates, 'inventory-rollup-backfill');
    } catch (e) {
      logger.warn('Inventory rollup backfill failed:', e.message);
    } finally {
      inventoryRollupBackfillInflight.delete(key);
    }
  });
}

function cleanInv(v) {
  const s = String(v ?? '').trim();
  if (!s || s === '—' || /^\(not\s+applicable\)$/i.test(s)) return '';
  return s;
}

/** Match assigned App IDs against inv_app (often a display name) and app-style ad units. */
function sqlAppMatchClause(params, apps, appExpr, adUnitExpr) {
  if (!apps?.length) return '';
  const expanded = expandAppFilterAliases(apps, loadCachedAppPackageMaps());
  if (!expanded.length) return '';
  params.push(expanded);
  const appIdx = params.length;
  const packages = expanded.filter((a) => isLikelyAppPackage(a) && String(a).includes('.'));
  if (!packages.length) {
    return ` AND ${appExpr} = ANY($${appIdx}::text[])`;
  }
  params.push(packages);
  return ` AND (
    ${appExpr} = ANY($${appIdx}::text[])
    OR ${adUnitExpr} LIKE ANY(ARRAY(SELECT p || '%' FROM unnest($${params.length}::text[]) AS p))
  )`;
}

/**
 * Inventory filter field map (API query → stored columns / row fields):
 *   filters.domain     → inv_domain / domainName   (root domain)
 *   filters.site       → inv_site / siteUrl        (site URL host)
 *   filters.domainName → inv_ad_unit / site        (ad unit name)  [legacy param name]
 *   filters.domainId   → inv_app / appPackage      (app id/package) [legacy param name]
 */

/**
 * Hash a dimension-set so each unique combination gets one row per date.
 * Sorted keys → stable hash regardless of object property order.
 */
function dimHash(dimensions) {
  const stable = JSON.stringify(Object.keys(dimensions).sort().reduce((o, k) => {
    o[k] = dimensions[k]; return o;
  }, {}));
  return crypto.createHash('md5').update(stable).digest('hex').slice(0, 16);
}

function inventoryFieldsFromDimensions(dimensions = {}) {
  const adUnit = cleanInv(
    dimensions.AD_UNIT_NAME || dimensions.ad_unit_name || dimensions.site || ''
  );
  const gamSite = cleanInv(
    dimensions.URL_NAME || dimensions.url_name
    || dimensions.SITE_NAME || dimensions.site_name
    || dimensions.siteUrl || dimensions.gamSite || ''
  );
  const gamDomain = cleanInv(dimensions.DOMAIN || dimensions.domain || dimensions.domainName || '');
  const siteHost = normalizeHost(gamSite) || (isGamReportSiteHost(gamSite) ? gamSite : '');
  const inv = resolveInventoryFields(adUnit, siteHost || gamSite, gamDomain, siteHost || gamSite);

  let domainName = cleanInv(inv.domainName);
  if (!domainName || domainName === '—') {
    domainName = cleanInv(domainFromAdUnit(adUnit)) || cleanInv(gamDomain);
  }

  let siteUrl = siteHost || normalizeHost(inv.siteName) || '';
  if (!siteUrl) {
    siteUrl = cleanInv(subdomainFromAdUnit(adUnit)) || '';
  }

  const appFields = resolveAppFields({
    ...dimensions,
    MOBILE_APP_NAME: dimensions.MOBILE_APP_NAME || dimensions.mobile_app_name,
    MOBILE_APP_RESOLVED_ID: dimensions.MOBILE_APP_RESOLVED_ID || dimensions.mobile_app_resolved_id,
    appPackage: dimensions.appPackage,
    appId: dimensions.appId,
    appName: dimensions.appName,
  });
  const appId = cleanInv(
    (appFields.appPackage && appFields.appPackage !== '—' ? appFields.appPackage : '')
    || (appFields.gamResolvedId && appFields.gamResolvedId !== '—' ? appFields.gamResolvedId : '')
    || dimensions.MOBILE_APP_NAME
    || dimensions.mobile_app_name
  );

  return {
    domainName: domainName && domainName !== '—' ? domainName : '',
    siteUrl: siteUrl || '',
    adUnit,
    appId: appId || '',
    appName: appFields.appName && appFields.appName !== '—' ? appFields.appName : '',
    appPackage: appFields.appPackage && appFields.appPackage !== '—' ? appFields.appPackage : '',
  };
}

function attachInventoryDimensions(dimensions = {}) {
  const inv = inventoryFieldsFromDimensions(dimensions);
  const out = { ...dimensions };
  if (inv.adUnit) {
    out.AD_UNIT_NAME = out.AD_UNIT_NAME || inv.adUnit;
    out.ad_unit_name = inv.adUnit;
    out.site = inv.adUnit;
  }
  if (inv.domainName) {
    out.domainName = inv.domainName;
    out.domain = inv.domainName;
    if (!out.DOMAIN) out.DOMAIN = inv.domainName;
  }
  if (inv.siteUrl) {
    out.siteUrl = inv.siteUrl;
    out.gamSite = out.gamSite || inv.siteUrl;
    out.siteName = out.siteName || inv.siteUrl;
    out.site_name = out.site_name || inv.siteUrl;
  }
  if (inv.appId) {
    out.appId = inv.appId;
    out.appPackage = inv.appPackage || inv.appId;
  }
  if (inv.appName) out.appName = inv.appName;
  if (out.MOBILE_APP_NAME) out.mobile_app_name = out.MOBILE_APP_NAME;
  if (out.MOBILE_APP_RESOLVED_ID) out.mobile_app_resolved_id = out.MOBILE_APP_RESOLVED_ID;
  return { dimensions: out, inv };
}

function mergeMetricObjects(a = {}, b = {}) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    if (v == null || v === '') continue;
    const n = Number(v);
    const m = Number(out[k]);
    if (Number.isFinite(n) && Number.isFinite(m) && !/rate|ctr|ecpm|cpm|fill/i.test(k)) {
      out[k] = m + n;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Collapse rows that share (report_date, dim_hash) so a single INSERT…ON CONFLICT
 * batch never tries to update the same target row twice (Postgres error).
 */
function dedupeRowsByDimHash(rows = []) {
  const order = [];
  const byKey = new Map();
  for (const row of rows) {
    const { dimensions, inv } = attachInventoryDimensions(row.dimensions || {});
    const hash = dimHash(dimensions);
    const reportDate = row.report_date;
    const key = `${reportDate}\0${hash}`;
    const existing = byKey.get(key);
    if (!existing) {
      const next = {
        report_date: reportDate,
        dimensions,
        metrics: { ...(row.metrics || {}) },
        currency: row.currency || 'USD',
        inv,
        slice_key: row.slice_key,
        dim_keys: row.dim_keys,
        metric_keys: row.metric_keys,
      };
      byKey.set(key, next);
      order.push(key);
      continue;
    }
    existing.metrics = mergeMetricObjects(existing.metrics, row.metrics);
    if (row.currency) existing.currency = row.currency;
  }
  return order.map((k) => byKey.get(k));
}

async function insertRowsInto(_table, rows, syncType) {
  if (!rows.length) return 0;
  const deduped = dedupeRowsByDimHash(rows);
  if (deduped.length < rows.length) {
    logger.info(`[${syncType}] Deduped ${rows.length} → ${deduped.length} rows before grain upsert`);
  }
  return upsertGrainRows(deduped, syncType);
}

/**
 * Historical past data → report_daily (yesterday / 7d / 30d / backfill).
 */
async function upsertRows(rows, syncType) {
  const upserted = await insertRowsInto('report_grain', rows, syncType);
  logger.info(`[${syncType}] Upserted ${upserted} rows into report_grain`);
  return upserted;
}

/**
 * Replace historical rows for the dates present in `rows`.
 * Upserts rich rows first; only deletes thin (non-country/device) rows so the
 * dashboard never sees an empty day mid-sync.
 */
async function replaceHistoricalRows(rows, syncType = 'sync-day') {
  const dates = [...new Set(
    (rows || []).map((r) => toYmd(r.report_date)).filter(Boolean)
  )];
  if (!rows?.length) {
    if (dates.length) {
      for (const d of dates) {
        await deleteGrainForDate(d);
      }
      try {
        await query(
          `DELETE FROM rollup_kpi_daily WHERE client_id = $2::uuid AND report_date = ANY($1::date[])`,
          [dates, requireClientId()]
        );
        await query(
          `DELETE FROM rollup_dim_daily WHERE client_id = $2::uuid AND report_date = ANY($1::date[])`,
          [dates, requireClientId()]
        );
      } catch (_) { /* rollup tables may not exist yet */ }
    }
    return 0;
  }

  const syncStartedAt = new Date();
  const upserted = await upsertRows(rows, syncType);

  if (dates.length) {
    try {
      await deleteStaleGrain(dates, syncStartedAt);
    } catch (e) {
      logger.warn(`[${syncType}] stale grain cleanup skipped:`, e.message);
    }
    try {
      await deleteThinGrainRows(dates);
    } catch (e) {
      logger.warn(`[${syncType}] thin-row cleanup skipped:`, e.message);
    }
    try {
      await rebuildRollupsForDates(dates, syncType);
    } catch (e) {
      logger.warn(`[${syncType}] rollup rebuild skipped:`, e.message);
    }
  }
  return upserted;
}

/**
 * Present-day cron snapshot → report_present.
 * Upsert first, then drop stale rows — never leave the table empty mid-sync
 * (that forced dashboard onto live GAM ~70s).
 */
async function replacePresentRows(rows, syncType = 'sync-today') {
  const today = todayInTZ();
  const todayRows = (rows || []).filter((r) => toYmd(r.report_date) === today);

  if (!todayRows.length) {
    await deleteGrainForDate(today);
    try {
      await query(
        `DELETE FROM rollup_kpi_daily WHERE client_id = $2::uuid AND report_date = $1::date`,
        [today, requireClientId()]
      );
      await query(
        `DELETE FROM rollup_dim_daily WHERE client_id = $2::uuid AND report_date = $1::date`,
        [today, requireClientId()]
      );
    } catch (_) { /* ignore */ }
    logger.info(`[${syncType}] No today rows — cleared today's report_grain`);
    return 0;
  }

  const syncStartedAt = new Date();
  const upserted = await insertRowsInto('report_grain', todayRows, syncType);
  logger.info(`[${syncType}] Upserted ${upserted} rows into report_grain (today=${today})`);

  try {
    await deleteStaleGrain([today], syncStartedAt);
  } catch (e) {
    logger.warn(`[${syncType}] stale grain cleanup skipped:`, e.message);
  }

  try {
    await rebuildRollupsForDates([today], syncType);
  } catch (e) {
    logger.warn(`[${syncType}] rollup rebuild skipped:`, e.message);
  }
  return upserted;
}

/** True when the requested range includes the current business day. */
function rangeIncludesToday(startDate, endDate) {
  const today = todayInTZ();
  return startDate <= today && today <= endDate;
}

function toYmd(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/**
 * Legacy no-op — report_grain holds today and history in one table.
 */
async function migrateStalePresentToDaily(_syncType = 'migrate-present') {
  return 0;
}

/**
 * Legacy no-op — promote/migrate retired with unified report_grain.
 */
async function promotePresentToDaily(_syncType = 'promote-present') {
  return 0;
}

/**
 * Persist rows into the correct table(s):
 *   - today's rows → report_present (clear previous snapshot first)
 *   - past rows    → report_daily (keep history for yesterday / 7d / 30d)
 */
async function persistSyncedRows(rows, syncType = 'sync') {
  const today = todayInTZ();
  const presentRows = (rows || []).filter((r) => String(r.report_date || '').slice(0, 10) === today);
  const pastRows = (rows || []).filter((r) => {
    const d = String(r.report_date || '').slice(0, 10);
    return d && d !== today;
  });

  let total = 0;
  if (syncType === 'sync-today' || presentRows.length) {
    total += await replacePresentRows(presentRows, syncType);
  }
  if (pastRows.length) {
    total += await replaceHistoricalRows(pastRows, syncType);
  }
  return total;
}

/**
 * Fetch rows for a date range from the correct tables:
 *   today overlap → report_present
 *   past overlap  → report_daily
 */
async function fetchFromDB(startDate, endDate) {
  const { hotStart, hotEnd, coldStart, coldEnd } = archiveService.splitDateRange(startDate, endDate);
  let rows = [];

  if (hotStart && hotEnd && hotStart <= hotEnd) {
    rows = rows.concat(await fetchGrainLegacyFromDB(hotStart, hotEnd));
  }

  if (coldStart && coldEnd && coldStart <= coldEnd && archiveService.isArchiveEnabled()) {
    const clientId = requireClientId();
    const archived = await archiveService.fetchArchivedGrain(clientId, coldStart, coldEnd);
    rows = rows.concat(archived.map(archiveService.archivedGrainToLegacy));
  }

  return rows.sort((a, b) => String(b.report_date).localeCompare(String(a.report_date)));
}

function toDollarsLean(n) {
  return gamMoneyToDollars(n);
}

/** GAM money in metrics JSONB — prefer Total revenue (ALL), skip zero CPM stub. */
function leanRevenueSqlFragments() {
  const allRevRaw = `NULLIF(NULLIF(metrics->>'TOTAL_LINE_ITEM_LEVEL_ALL_REVENUE','')::double precision, 0)`;
  const cpcRevRaw = `NULLIF(NULLIF(metrics->>'TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE','')::double precision, 0)`;
  const legacyRevRaw = `NULLIF(metrics->>'revenue','')::double precision`;
  const revenueRawExpr = `COALESCE(${allRevRaw}, ${cpcRevRaw}, ${legacyRevRaw}, 0)`;
  // Sync stores dollars. Only treat classic GAM micros bands as micros:
  // 1000..999999 (sub-$1) and >=1e9 (clearly ≥$1000 in micros). Never ÷1e6
  // mid-range dollar totals (that turned $4.5M range totals into $4.50).
  const revenueExpr = `CASE
    WHEN ABS(${revenueRawExpr}) >= 1e9 THEN ${revenueRawExpr} / 1000000.0
    WHEN ABS(${revenueRawExpr}) >= 1000 AND ABS(${revenueRawExpr}) < 1e6
      AND ${revenueRawExpr} = FLOOR(${revenueRawExpr}) THEN ${revenueRawExpr} / 1000000.0
    WHEN ABS(${revenueRawExpr}) > 0 AND ABS(${revenueRawExpr}) < 1 THEN ${revenueRawExpr}
    ELSE ${revenueRawExpr}
  END`;
  return { revenueRawExpr, revenueExpr };
}

/** Map flat SQL dashboard rows into the canonical report shape (no heavy JSONB normalize). */
function mapLeanDbRow(r) {
  const impression = Math.round(Number(r.impression) || 0);
  const revenue = coerceWarehouseRevenue(r.revenue_raw, impression);
  const clicks = Math.round(Number(r.clicks) || 0);
  let viewableRate = Number(r.viewable_raw) || 0;
  if (viewableRate > 0 && viewableRate <= 1) viewableRate = +(viewableRate * 100).toFixed(2);
  else viewableRate = +Number(viewableRate || 0).toFixed(2);
  const ecpm = impression > 0 && revenue > 0 ? +((revenue / impression) * 1000).toFixed(2) : 0;
  const ctr = impression > 0 && clicks > 0 ? +((clicks / impression) * 100).toFixed(4) : 0;
  const adUnit = r.ad_unit || r.inv_ad_unit || '';
  const domainName = r.domain_name || r.inv_domain || '';
  const siteUrl = r.site_url || r.inv_site || '';
  const appId = r.app_id || r.inv_app || '';
  return {
    date: r.report_date,
    report_date: r.report_date,
    country: r.country || '',
    device: r.device || '',
    site: adUnit || '—',
    AD_UNIT_NAME: adUnit,
    ad_unit_name: adUnit,
    domainName: domainName || '',
    domain: domainName || '',
    siteUrl: siteUrl || '',
    gamSite: siteUrl || '',
    siteName: siteUrl || '',
    appId: appId || '',
    appPackage: appId || '',
    impression,
    revenue,
    clicks,
    ctr,
    viewableRate,
    ecpm,
    currency: r.currency || 'USD',
  };
}

function rowsHaveLeanMetrics(rows = []) {
  for (const r of rows) {
    if ((Number(r.revenue) || 0) > 0 || (Number(r.impression) || 0) > 0) return true;
  }
  return false;
}

/**
 * Fast dashboard read: flat columns + optional SQL inventory/country filters.
 * Prefer inv_* columns (filled by hourly cron / sync), then JSONB fallbacks.
 *
 * Filter opts map to inventory UI:
 *   domains → filters.domain, sites → filters.site,
 *   adUnitNames → filters.domainName, apps → filters.domainId
 */
async function fetchLeanRowsFromDB(startDate, endDate, opts = {}) {
  const { hotStart, hotEnd, coldStart, coldEnd } = archiveService.splitDateRange(startDate, endDate);
  let rows = [];

  if (hotStart && hotEnd && hotStart <= hotEnd) {
    rows = rows.concat(await fetchGrainLeanRowsFromDB(hotStart, hotEnd, opts));
  }

  if (coldStart && coldEnd && coldStart <= coldEnd && archiveService.isArchiveEnabled()) {
    const clientId = requireClientId();
    const archived = await archiveService.fetchArchivedGrain(clientId, coldStart, coldEnd);
    const legacy = archived.map((r) => {
      const leg = archiveService.archivedGrainToLegacy(r);
      return {
        report_date: String(leg.report_date).slice(0, 10),
        country: leg.dimensions.COUNTRY_NAME || '',
        device: leg.dimensions.DEVICE_CATEGORY_NAME || '',
        ad_unit: leg.dimensions.AD_UNIT_NAME || '',
        domain_name: leg.dimensions.DOMAIN || leg.dimensions.domainName || '',
        site_url: leg.dimensions.siteUrl || leg.dimensions.SITE_NAME || '',
        app_id: leg.dimensions.MOBILE_APP_RESOLVED_ID || leg.dimensions.MOBILE_APP_NAME || '',
        impression: Number(leg.metrics.TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS) || 0,
        revenue_raw: Number(leg.metrics.revenue) || 0,
        viewable_raw: Number(leg.metrics.TOTAL_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE) || 0,
        clicks: Number(leg.metrics.TOTAL_LINE_ITEM_LEVEL_CLICKS) || 0,
        currency: leg.currency || 'USD',
      };
    });
    rows = rows.concat(legacy);
  }

  return rows.map(mapLeanDbRow);
}

async function resolveGrainClientId() {
  const id = getClientId();
  if (id) return id;
  const { rows } = await query(
    `SELECT client_id FROM report_grain WHERE client_id IS NOT NULL LIMIT 1`
  );
  if (rows[0]?.client_id) return rows[0].client_id;
  return requireClientId();
}

/**
 * App ID filter must use app_id grain slice — channel KPI rollups have empty inv_app.
 * Returns overview totals or null.
 */
async function fetchAppSliceOverviewFromGrain(startDate, endDate, opts = {}) {
  const apps = (opts.apps || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
  if (!apps.length) return null;
  const clientId = await resolveGrainClientId();
  const params = [clientId, startDate, endDate];
  let appClause = sqlAppMatchClause(
    params,
    apps,
    `LOWER(COALESCE(NULLIF(g.app_id, ''), g.app_name, ''))`,
    `LOWER(COALESCE(da.name, ''))`
  );
  if (!appClause) return null;

  const { rows } = await query(
    `SELECT
       COALESCE(SUM(g.impressions), 0)::float8 AS impressions,
       COALESCE(SUM(g.revenue), 0)::float8 AS revenue,
       COALESCE(SUM(COALESCE(g.impressions, 0) * COALESCE(g.viewable_pct, 0)), 0)::float8 AS viewable_weight,
       COUNT(*)::int AS row_count
     ${require('./reportGrainStore').GRAIN_JOIN_SQL}
     WHERE g.client_id = $1::uuid
       AND g.report_date BETWEEN $2::date AND $3::date
       AND g.slice_key = 'app_id'
       ${appClause}`,
    params
  );
  const t = rows[0] || {};
  const impressions = Number(t.impressions) || 0;
  const revenue = coerceWarehouseRevenue(t.revenue, impressions);
  const viewableWeight = Number(t.viewable_weight) || 0;
  const rowCount = Number(t.row_count) || 0;
  if (!rowCount || (impressions <= 0 && revenue <= 0)) return null;
  return {
    impressions: Math.round(impressions),
    revenue,
    viewability: impressions > 0 ? +(viewableWeight / impressions).toFixed(1) : 0,
    rowCount,
    source: 'grain-app',
  };
}

/**
 * App ID table/trend bundle from app_id grain slice (GAM mobile-app report grain).
 */
async function fetchAppSliceDashboardBundle(startDate, endDate, opts = {}) {
  const apps = (opts.apps || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
  if (!apps.length) return null;
  const clientId = await resolveGrainClientId();
  const tableLimit = Math.min(Math.max(parseInt(opts.tableLimit, 10) || 2500, 50), 5000);
  const { GRAIN_JOIN_SQL } = require('./reportGrainStore');

  const baseParams = [clientId, startDate, endDate];
  const appClause = sqlAppMatchClause(
    baseParams,
    apps,
    `LOWER(COALESCE(NULLIF(g.app_id, ''), g.app_name, ''))`,
    `LOWER(COALESCE(da.name, ''))`
  );
  if (!appClause) return null;

  const { rows: totalsRows } = await query(
    `SELECT
       COALESCE(SUM(g.impressions), 0)::float8 AS impressions,
       COALESCE(SUM(g.revenue), 0)::float8 AS revenue,
       COALESCE(SUM(COALESCE(g.impressions, 0) * COALESCE(g.viewable_pct, 0)), 0)::float8 AS viewable_weight,
       COALESCE(SUM(g.clicks), 0)::float8 AS clicks,
       COUNT(*)::int AS row_count
     ${GRAIN_JOIN_SQL}
     WHERE g.client_id = $1::uuid
       AND g.report_date BETWEEN $2::date AND $3::date
       AND g.slice_key = 'app_id'
       ${appClause}`,
    baseParams
  );
  const t = totalsRows[0] || {};
  const impressions = Number(t.impressions) || 0;
  const revenue = coerceWarehouseRevenue(t.revenue, impressions);
  const viewableWeight = Number(t.viewable_weight) || 0;
  const clicks = Number(t.clicks) || 0;
  const grainCount = Number(t.row_count) || 0;
  if (!grainCount || (impressions <= 0 && revenue <= 0)) return null;

  const { rows: trendRaw } = await query(
    `SELECT
       to_char(g.report_date, 'YYYY-MM-DD') AS date,
       COALESCE(SUM(g.revenue), 0)::float8 AS earning,
       COALESCE(SUM(g.impressions), 0)::float8 AS impressions
     ${GRAIN_JOIN_SQL}
     WHERE g.client_id = $1::uuid
       AND g.report_date BETWEEN $2::date AND $3::date
       AND g.slice_key = 'app_id'
       ${appClause}
     GROUP BY g.report_date
     ORDER BY g.report_date`,
    baseParams
  );
  const trend = trendRaw.map((r) => {
    const impressions = Math.round(Number(r.impressions) || 0);
    return {
      date: r.date,
      earning: coerceWarehouseRevenue(r.earning, impressions),
      impressions,
    };
  });

  const startMs = new Date(`${startDate}T12:00:00`).getTime();
  const endMs = new Date(`${endDate}T12:00:00`).getTime();
  const dayCount = Math.max(1, Math.round((endMs - startMs) / 86400000) + 1);
  const perDay = Math.max(15, Math.min(400, Math.ceil(tableLimit / dayCount)));
  const tableParams = [...baseParams, perDay, tableLimit];
  const { rows: tableRaw } = await query(
    `WITH agg AS (
       SELECT
         g.report_date,
         '' AS domain_name,
         '' AS site_url,
         '' AS ad_unit,
         COALESCE(NULLIF(TRIM(g.app_id), ''), NULLIF(TRIM(g.app_name), ''), '') AS app_id,
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
         AND g.report_date BETWEEN $2::date AND $3::date
         AND g.slice_key = 'app_id'
         ${appClause}
       GROUP BY g.report_date, COALESCE(NULLIF(TRIM(g.app_id), ''), NULLIF(TRIM(g.app_name), ''), '')
       HAVING COALESCE(SUM(g.impressions), 0) > 0 OR COALESCE(SUM(g.revenue), 0) > 0
     ),
     ranked AS (
       SELECT *,
         ROW_NUMBER() OVER (
           PARTITION BY report_date
           ORDER BY revenue_raw DESC, impression DESC
         ) AS day_rank
       FROM agg
     )
     SELECT
       to_char(report_date, 'YYYY-MM-DD') AS report_date,
       domain_name, site_url, ad_unit, app_id,
       impression, revenue_raw, viewable_raw, clicks, currency
     FROM ranked
     WHERE day_rank <= $${tableParams.length - 1}
     ORDER BY day_rank ASC, report_date DESC, revenue_raw DESC
     LIMIT $${tableParams.length}`,
    tableParams
  );
  const tableRows = (tableRaw || []).map(mapDomainTableRow);

  const viewability = impressions > 0 ? +(viewableWeight / impressions).toFixed(1) : 0;
  return {
    summary: {
      totalEarning: +Number(revenue).toFixed(2),
      totalEarningChange: 0,
      selectRange: +Number(revenue).toFixed(2),
      selectRangeChange: 0,
      last7Days: +trend.slice(-7).reduce((a, x) => a + (x.earning || 0), 0).toFixed(2),
      last7DaysChange: 0,
      pageViews: Math.round(impressions),
      pageViewsChange: 0,
      impressions: Math.round(impressions),
      impressionsChange: 0,
      clicks: Math.round(clicks),
      clicksChange: 0,
      ctr: impressions > 0 ? +((clicks / impressions) * 100).toFixed(4) : 0,
      revenue: +Number(revenue).toFixed(2),
      revenueChange: 0,
      ecpm: impressions > 0 ? +((revenue / impressions) * 1000).toFixed(2) : 0,
      ecpmChange: 0,
      viewability,
      viewabilityChange: 0,
      currency: opts.currency || 'USD',
    },
    trend,
    charts: { revenue: [], device: [], country: [], performance: [] },
    rows: tableRows,
    pagination: {
      totalRows: tableRows.length,
      returnedRows: tableRows.length,
      truncated: grainCount > tableRows.length,
      allRows: false,
      compact: true,
    },
    grainCount,
    source: 'grain-app',
  };
}

/** GAM Site hosts: request (gameN/quizN) vs ad-slot (d1.domain). */
function classifySiteHostSelection(selectedSites = []) {
  const sites = (selectedSites || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
  if (!sites.length) return 'none';
  if (sites.every((s) => /^d\d+\./i.test(s))) return 'slot';
  if (sites.every((s) => !/^d\d+\./i.test(s))) return 'request';
  return 'mixed';
}

/**
 * Site filter must cover two host namespaces:
 *   - inventory_core SITE_NAME (request hosts: gameN / quizN)
 *   - rollup inv_site (ad-unit slot hosts: d1.domain)
 * Request-only filters must use grain-site only — channel rollups inflate totals vs table rows.
 */
function mergeSiteFilterBundles(rollupBundle, coreBundle, selectedSites = []) {
  const kind = classifySiteHostSelection(selectedSites);
  if (kind === 'request') return coreBundle || null;
  if (kind === 'slot') return rollupBundle || null;
  if (!rollupBundle) return coreBundle || null;
  if (!coreBundle) return rollupBundle || null;

  const selected = new Set(
    (selectedSites || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean)
  );
  const keyOf = (r) => String(r.siteUrl || r.gamSite || r.siteName || '').trim().toLowerCase();
  const inSelected = (r) => {
    if (!selected.size) return true;
    const k = keyOf(r);
    return k && selected.has(k);
  };

  const rollupRows = (rollupBundle.rows || []).filter(inSelected);
  const coreRows = (coreBundle.rows || []).filter(inSelected);
  const rollupKeys = new Set(rollupRows.map(keyOf).filter(Boolean));
  const coreKeys = new Set(coreRows.map(keyOf).filter(Boolean));

  // Prefer inventory_core when the same host exists in both; keep rollup-only slot hosts.
  const merged = [];
  for (const r of coreRows) merged.push(r);
  for (const r of rollupRows) {
    const k = keyOf(r);
    if (k && coreKeys.has(k)) continue;
    merged.push(r);
  }
  if (!merged.length) {
    if (kind === 'request') return coreBundle || null;
    if (kind === 'slot') return rollupBundle || null;
    return (Number(coreBundle.summary?.revenue) || 0) >= (Number(rollupBundle.summary?.revenue) || 0)
      ? coreBundle
      : rollupBundle;
  }

  let impressions = 0;
  let revenue = 0;
  let clicks = 0;
  let viewableWeight = 0;
  for (const r of merged) {
    const imp = Number(r.impression) || 0;
    const rev = Number(r.revenue) || 0;
    impressions += imp;
    revenue += rev;
    clicks += Number(r.clicks) || 0;
    viewableWeight += ((Number(r.viewableRate) || 0) / 100) * imp;
  }
  revenue = +revenue.toFixed(2);
  const viewability = impressions > 0 ? +(viewableWeight / impressions * 100).toFixed(1) : 0;

  const trendMap = new Map();
  for (const t of [...(rollupBundle.trend || []), ...(coreBundle.trend || [])]) {
    // Recompute trend from merged rows only (avoid double-count).
  }
  for (const r of merged) {
    const date = r.date || r.report_date;
    if (!date) continue;
    const prev = trendMap.get(date) || { date, earning: 0, impressions: 0 };
    prev.earning += Number(r.revenue) || 0;
    prev.impressions += Number(r.impression) || 0;
    trendMap.set(date, prev);
  }
  const trend = [...trendMap.values()]
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map((t) => ({
      date: t.date,
      earning: +Number(t.earning).toFixed(2),
      impressions: Math.round(t.impressions),
    }));

  return {
    summary: {
      totalEarning: revenue,
      totalEarningChange: 0,
      selectRange: revenue,
      selectRangeChange: 0,
      last7Days: +trend.slice(-7).reduce((a, x) => a + (x.earning || 0), 0).toFixed(2),
      last7DaysChange: 0,
      pageViews: Math.round(impressions),
      pageViewsChange: 0,
      impressions: Math.round(impressions),
      impressionsChange: 0,
      clicks: Math.round(clicks),
      clicksChange: 0,
      ctr: impressions > 0 ? +((clicks / impressions) * 100).toFixed(4) : 0,
      revenue,
      revenueChange: 0,
      ecpm: impressions > 0 ? +((revenue / impressions) * 1000).toFixed(2) : 0,
      ecpmChange: 0,
      viewability,
      viewabilityChange: 0,
      currency: coreBundle.summary?.currency || rollupBundle.summary?.currency || 'USD',
    },
    trend,
    charts: { revenue: [], device: [], country: [], performance: [] },
    rows: merged,
    pagination: {
      totalRows: merged.length,
      returnedRows: merged.length,
      truncated: false,
      allRows: false,
      compact: true,
    },
    grainCount: (rollupBundle.grainCount || 0) + (coreBundle.grainCount || 0),
    source: 'site-merge',
    _debug: {
      rollupHosts: rollupKeys.size,
      coreHosts: coreKeys.size,
      merged: merged.length,
    },
  };
}

async function fetchRollupSiteOverview(startDate, endDate, opts = {}) {
  const sites = (opts.sites || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
  if (!sites.length) return null;
  const filterParams = [startDate, endDate];
  let filterExtra = ` AND report_date BETWEEN $1::date AND $2::date`;
  filterExtra = appendRollupInventoryFilters(filterParams, filterExtra, {
    ...opts,
    sites,
    apps: [],
    skipAdUnitLike: true,
  });
  const { rows } = await query(
    `SELECT
       COALESCE(SUM(impressions), 0)::float8 AS impressions,
       COALESCE(SUM(revenue), 0)::float8 AS revenue,
       COALESCE(SUM(viewable_weight), 0)::float8 AS viewable_weight,
       COALESCE(SUM(grain_count), 0)::int AS row_count
     FROM rollup_kpi_daily
     WHERE TRUE${filterExtra}`,
    filterParams
  );
  const t = rows[0] || {};
  const impressions = Number(t.impressions) || 0;
  const revenue = coerceWarehouseRevenue(t.revenue, impressions);
  const viewableWeight = Number(t.viewable_weight) || 0;
  const rowCount = Number(t.row_count) || 0;
  if (!rowCount || (impressions <= 0 && revenue <= 0)) return null;
  return {
    impressions: Math.round(impressions),
    revenue,
    viewability: impressions > 0 ? +(viewableWeight / impressions).toFixed(1) : 0,
    rowCount,
    source: 'rollup-site',
  };
}

function mergeSiteOverviewTotals(rollupTotals, coreTotals, selectedSites = []) {
  if (!rollupTotals) return coreTotals || null;
  if (!coreTotals) return rollupTotals || null;
  const sites = (selectedSites || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
  const allSlot = sites.length > 0 && sites.every((s) => /^d\d+\./i.test(s));
  const allRequest = sites.length > 0 && sites.every((s) => !/^d\d+\./i.test(s));
  // Same traffic can be labeled as slot host (rollup) OR request SITE_NAME (core).
  if (allSlot) return { ...rollupTotals, source: 'rollup-site' };
  if (allRequest) return { ...coreTotals, source: 'grain-site' };
  const impressions = (rollupTotals.impressions || 0) + (coreTotals.impressions || 0);
  const revenue = +((rollupTotals.revenue || 0) + (coreTotals.revenue || 0)).toFixed(2);
  const viewableWeight = ((rollupTotals.viewability || 0) / 100) * (rollupTotals.impressions || 0)
    + ((coreTotals.viewability || 0) / 100) * (coreTotals.impressions || 0);
  return {
    impressions: Math.round(impressions),
    revenue,
    viewability: impressions > 0 ? +(viewableWeight / impressions * 100).toFixed(1) : 0,
    rowCount: (rollupTotals.rowCount || 0) + (coreTotals.rowCount || 0),
    source: 'site-merge',
  };
}

/**
 * Site filter must use inventory_core grain — channel/rollups store slot hosts (d1.domain)
 * while GAM Site / catalog hosts are gameN.domain / quizN.domain in inventory_core.
 */
async function fetchInventorySiteOverviewFromGrain(startDate, endDate, opts = {}) {
  const sites = (opts.sites || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
  if (!sites.length) return null;
  const domains = (opts.domains || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
  const countries = (opts.countryNames || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
  const adUnits = (opts.adUnitNames || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
  const clientId = await resolveGrainClientId();
  const { GRAIN_JOIN_SQL, grainDomainExprSql } = require('./reportGrainStore');
  const params = [clientId, startDate, endDate];
  params.push(sites);
  let clause = ` AND LOWER(TRIM(COALESCE(ds.name, ''))) = ANY($${params.length}::text[])`;
  if (domains.length) {
    params.push(domains);
    clause += ` AND ${grainDomainExprSql()} = ANY($${params.length}::text[])`;
  }
  if (countries.length) {
    params.push(countries);
    clause += ` AND LOWER(TRIM(COALESCE(dc.name, ''))) = ANY($${params.length}::text[])`;
  }
  if (adUnits.length) {
    params.push(adUnits);
    clause += ` AND LOWER(TRIM(COALESCE(da.name, ''))) = ANY($${params.length}::text[])`;
  }

  const { rows } = await query(
    `SELECT
       COALESCE(SUM(g.impressions), 0)::float8 AS impressions,
       COALESCE(SUM(g.revenue), 0)::float8 AS revenue,
       COALESCE(SUM(COALESCE(g.impressions, 0) * COALESCE(g.viewable_pct, 0)), 0)::float8 AS viewable_weight,
       COUNT(*)::int AS row_count
     ${GRAIN_JOIN_SQL}
     WHERE g.client_id = $1::uuid
       AND g.report_date BETWEEN $2::date AND $3::date
       AND g.slice_key = 'inventory_core'
       ${clause}`,
    params
  );
  const t = rows[0] || {};
  const impressions = Number(t.impressions) || 0;
  const revenue = coerceWarehouseRevenue(t.revenue, impressions);
  const viewableWeight = Number(t.viewable_weight) || 0;
  const rowCount = Number(t.row_count) || 0;
  if (!rowCount || (impressions <= 0 && revenue <= 0)) return null;
  return {
    impressions: Math.round(impressions),
    revenue,
    viewability: impressions > 0 ? +(viewableWeight / impressions).toFixed(1) : 0,
    rowCount,
    source: 'grain-site',
  };
}

/**
 * Expand site hosts so "gamisco.com" also matches "www.gamisco.com" and vice versa
 * (GAM Site filter often uses the www host).
 */
function expandSiteHostAliases(sites = []) {
  const out = new Set();
  for (const raw of sites || []) {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) continue;
    out.add(s);
    if (s.startsWith('www.')) {
      out.add(s.slice(4));
    } else if ((s.match(/\./g) || []).length === 1) {
      // Bare registrable domain only: gamisco.com ↔ www.gamisco.com
      out.add(`www.${s}`);
    }
  }
  return [...out];
}

/** Day count inclusive for a YYYY-MM-DD range. */
function inclusiveDayCount(startDate, endDate) {
  const startMs = new Date(`${startDate}T12:00:00`).getTime();
  const endMs = new Date(`${endDate}T12:00:00`).getTime();
  return Math.max(1, Math.round((endMs - startMs) / 86400000) + 1);
}

/** Ranges longer than this use rollup_kpi_daily only (fast). inventory_core for ≤ this many days. */
const DASHBOARD_ROLLUP_FIRST_DAYS = Math.max(
  7,
  parseInt(process.env.DASHBOARD_ROLLUP_FIRST_DAYS || '14', 10) || 14
);

/** Build inventory_core WHERE clause + params (join-free, ID filters). */
function buildInventoryCoreWhere(clientId, startDate, endDate, opts = {}, ids = {}) {
  const domains = (opts.domains || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
  const hasAppsOnly = (opts.apps || []).length > 0
    && !domains.length
    && !(opts.sites || []).length
    && !(opts.adUnitNames || []).length;
  const byApp = hasAppsOnly;

  const params = [clientId, startDate, endDate];
  let whereCore = `g.client_id = $1::uuid AND g.slice_key = '${byApp ? 'app_id' : 'inventory_core'}'`;

  if (domains.length) {
    params.push(domains);
    const domIdx = params.length;
    const idClause = ids.domainIds?.length
      ? (() => {
        params.push(ids.domainIds);
        return `g.domain_id = ANY($${params.length}::int[]) OR `;
      })()
      : '';
    whereCore += ` AND (
      ${idClause}
      EXISTS (
        SELECT 1 FROM dim_ad_unit da
        WHERE da.id = g.ad_unit_id AND da.client_id = g.client_id
          AND LOWER(SPLIT_PART(REGEXP_REPLACE(COALESCE(da.name, ''), '\\s*\\(\\d+\\)\\s*$', ''), '_', 1))
              = ANY($${domIdx}::text[])
      )
      OR EXISTS (
        SELECT 1 FROM dim_site ds
        WHERE ds.id = g.site_id AND ds.client_id = g.client_id
          AND NULLIF(LOWER(SUBSTRING(TRIM(COALESCE(ds.name, '')) FROM '[^.]+\\.[^.]+$')), '')
              = ANY($${domIdx}::text[])
      )
    )`;
  }
  if (ids.siteIds?.length) {
    params.push(ids.siteIds);
    whereCore += ` AND g.site_id = ANY($${params.length}::int[])`;
  }
  if (ids.adUnitIds?.length) {
    params.push(ids.adUnitIds);
    whereCore += ` AND g.ad_unit_id = ANY($${params.length}::int[])`;
  }
  if (ids.countryIds?.length) {
    params.push(ids.countryIds);
    whereCore += ` AND g.country_id = ANY($${params.length}::int[])`;
  }
  if ((opts.apps || []).length) {
    const apps = (opts.apps || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
    params.push(apps);
    whereCore += ` AND (LOWER(COALESCE(g.app_id, '')) = ANY($${params.length}::text[])
      OR LOWER(COALESCE(g.app_name, '')) = ANY($${params.length}::text[]))`;
  }

  const whereRange = `${whereCore} AND g.report_date BETWEEN $2::date AND $3::date`;
  return { params, whereRange, byApp, byAdUnit: Boolean(ids.adUnitIds?.length || (opts.adUnitNames || []).length) };
}

/**
 * Fast inventory_core table — one grain scan + window rank (no per-day LATERAL).
 * Long ranges: period-aggregate by domain×site (no report_date) for speed + real SITE_NAME.
 * Keeps GAM-accurate Site/Domain labels via hydrateGrainIdRows.
 */
async function fetchInventoryCoreTableFast(startDate, endDate, opts = {}) {
  const sites = expandSiteHostAliases(
    (opts.sites || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean)
  );
  const domains = (opts.domains || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
  const clientId = await resolveGrainClientId();
  const ids = await resolveInventoryFilterIds(clientId, { ...opts, sites, domains });
  if (sites.length && !ids.siteIds.length) return [];
  if ((opts.adUnitNames || []).length && !ids.adUnitIds.length) return [];
  if ((opts.countryNames || []).length && !ids.countryIds.length) return [];

  const tableLimit = reportingTableLimit(startDate, endDate, opts.tableLimit);
  const dayCount = inclusiveDayCount(startDate, endDate);
  const periodAggregate = dayCount > DASHBOARD_ROLLUP_FIRST_DAYS
    && !(opts.adUnitNames || []).length;
  const { params, whereRange, byApp, byAdUnit } = buildInventoryCoreWhere(
    clientId, startDate, endDate, { ...opts, sites, domains }, ids
  );

  // Wide ranges: collapse days → one row per domain×site (charts use server trend).
  if (periodAggregate && !byApp) {
    const groupCols = ['g.domain_id', 'g.site_id'];
    const selectIds = ['g.domain_id', 'g.site_id', `0 AS ad_unit_id`, `'' AS app_id`, `0 AS country_id`, `0 AS device_id`];
    if (byAdUnit) {
      groupCols.push('g.ad_unit_id');
      selectIds[2] = 'g.ad_unit_id';
    }
    const tableParams = [...params, tableLimit];
    const limitIdx = tableParams.length;
    const { rows } = await query(
      `SELECT
         ${selectIds.join(',\n         ')},
         COALESCE(SUM(g.impressions), 0)::float8 AS impression,
         COALESCE(SUM(g.revenue), 0)::float8 AS revenue_raw,
         CASE WHEN COALESCE(SUM(g.impressions), 0) > 0
           THEN COALESCE(SUM(COALESCE(g.impressions, 0) * COALESCE(g.viewable_pct, 0)), 0)
                / COALESCE(SUM(g.impressions), 0)
           ELSE 0
         END AS viewable_raw,
         COALESCE(SUM(g.clicks), 0)::float8 AS clicks,
         COALESCE(MAX(g.currency), 'USD') AS currency
       FROM report_grain g
       WHERE ${whereRange}
       GROUP BY ${groupCols.join(', ')}
       HAVING COALESCE(SUM(g.impressions), 0) > 0 OR COALESCE(SUM(g.revenue), 0) > 0
       ORDER BY revenue_raw DESC, impression DESC
       LIMIT $${limitIdx}`,
      tableParams
    );
    const stamped = (rows || []).map((r) => ({
      ...r,
      report_date: endDate,
    }));
    return hydrateGrainIdRows(stamped);
  }

  const perDay = Math.max(4, Math.min(20, Math.ceil(tableLimit / dayCount)));
  let groupCols;
  let selectIds;
  if (byApp) {
    groupCols = [`g.report_date`, `COALESCE(NULLIF(TRIM(g.app_id), ''), NULLIF(TRIM(g.app_name), ''), '')`];
    selectIds = [
      `g.report_date`,
      `COALESCE(NULLIF(TRIM(g.app_id), ''), NULLIF(TRIM(g.app_name), ''), '') AS app_id`,
      `0 AS domain_id`, `0 AS site_id`, `0 AS ad_unit_id`,
      `0 AS country_id`, `0 AS device_id`,
    ];
  } else {
    groupCols = [`g.report_date`, `g.domain_id`, `g.site_id`];
    selectIds = [`g.report_date`, `g.domain_id`, `g.site_id`];
    if (byAdUnit) {
      groupCols.push(`g.ad_unit_id`);
      selectIds.push(`g.ad_unit_id`);
    } else {
      selectIds.push(`0 AS ad_unit_id`);
    }
    selectIds.push(`'' AS app_id`, `0 AS country_id`, `0 AS device_id`);
  }

  const tableParams = [...params, perDay, tableLimit];
  const perDayIdx = tableParams.length - 1;
  const limitIdx = tableParams.length;

  const { rows } = await query(
    `WITH agg AS (
       SELECT
         ${selectIds.join(',\n         ')},
         COALESCE(SUM(g.impressions), 0)::float8 AS impression,
         COALESCE(SUM(g.revenue), 0)::float8 AS revenue_raw,
         CASE WHEN COALESCE(SUM(g.impressions), 0) > 0
           THEN COALESCE(SUM(COALESCE(g.impressions, 0) * COALESCE(g.viewable_pct, 0)), 0)
                / COALESCE(SUM(g.impressions), 0)
           ELSE 0
         END AS viewable_raw,
         COALESCE(SUM(g.clicks), 0)::float8 AS clicks,
         COALESCE(MAX(g.currency), 'USD') AS currency
       FROM report_grain g
       WHERE ${whereRange}
       GROUP BY ${groupCols.join(', ')}
       HAVING COALESCE(SUM(g.impressions), 0) > 0 OR COALESCE(SUM(g.revenue), 0) > 0
     ),
     ranked AS (
       SELECT
         agg.*,
         ROW_NUMBER() OVER (
           PARTITION BY agg.report_date
           ORDER BY agg.revenue_raw DESC, agg.impression DESC
         ) AS day_rank
       FROM agg
     )
     SELECT
       to_char(ranked.report_date, 'YYYY-MM-DD') AS report_date,
       ranked.domain_id, ranked.site_id, ranked.ad_unit_id,
       ranked.country_id, ranked.device_id, ranked.app_id,
       ranked.impression, ranked.revenue_raw, ranked.viewable_raw,
       ranked.clicks, ranked.currency
     FROM ranked
     WHERE ranked.day_rank <= $${perDayIdx}
     ORDER BY ranked.day_rank ASC, ranked.report_date DESC, ranked.revenue_raw DESC
     LIMIT $${limitIdx}`,
    tableParams
  );
  return hydrateGrainIdRows(rows || []);
}

/**
 * Inventory Breakdown from inventory_core (GAM Site grain) — join-free ID path.
 * Optional domain / site / ad-unit / country filters.
 */
async function fetchInventoryCoreDashboardBundle(startDate, endDate, opts = {}) {
  const t0 = Date.now();
  const sites = expandSiteHostAliases(
    (opts.sites || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean)
  );
  const domains = (opts.domains || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
  const clientId = await resolveGrainClientId();
  const ids = await resolveInventoryFilterIds(clientId, { ...opts, sites, domains });

  if (sites.length && !ids.siteIds.length) return null;
  if ((opts.adUnitNames || []).length && !ids.adUnitIds.length) return null;
  if ((opts.countryNames || []).length && !ids.countryIds.length) return null;

  const { params, whereRange } = buildInventoryCoreWhere(
    clientId, startDate, endDate, { ...opts, sites, domains }, ids
  );
  const dayCount = inclusiveDayCount(startDate, endDate);

  const [totalsRes, trendRes, tableRows] = await Promise.all([
    query(
      `SELECT
         COALESCE(SUM(g.impressions), 0)::float8 AS impressions,
         COALESCE(SUM(g.revenue), 0)::float8 AS revenue,
         COALESCE(SUM(COALESCE(g.impressions, 0) * COALESCE(g.viewable_pct, 0)), 0)::float8 AS viewable_weight,
         COALESCE(SUM(g.clicks), 0)::float8 AS clicks,
         COUNT(*)::int AS row_count
       FROM report_grain g
       WHERE ${whereRange}`,
      params
    ),
    query(
      `SELECT
         to_char(g.report_date, 'YYYY-MM-DD') AS date,
         COALESCE(SUM(g.revenue), 0)::float8 AS earning,
         COALESCE(SUM(g.impressions), 0)::float8 AS impressions
       FROM report_grain g
       WHERE ${whereRange}
       GROUP BY g.report_date
       ORDER BY g.report_date`,
      params
    ),
    fetchInventoryCoreTableFast(startDate, endDate, { ...opts, sites, domains }),
  ]);

  const t = totalsRes.rows[0] || {};
  const impressions = Number(t.impressions) || 0;
  const revenue = coerceWarehouseRevenue(t.revenue, impressions);
  const viewableWeight = Number(t.viewable_weight) || 0;
  const clicks = Number(t.clicks) || 0;
  const grainCount = Number(t.row_count) || 0;
  if ((!grainCount || (impressions <= 0 && revenue <= 0)) && !tableRows.length) return null;

  const trend = (trendRes.rows || []).map((r) => {
    const imps = Math.round(Number(r.impressions) || 0);
    return {
      date: r.date,
      earning: coerceWarehouseRevenue(r.earning, imps),
      impressions: imps,
    };
  });
  const summaryImpressions = Math.round(impressions);
  const summaryRevenue = +Number(revenue).toFixed(2);
  const summaryClicks = Math.round(clicks);
  const summaryViewability = impressions > 0 ? +(viewableWeight / impressions).toFixed(1) : 0;

  logger.info(
    `inventory_core id-fast ${startDate}..${endDate}`
    + ` grain≈${grainCount} table=${tableRows.length} days=${dayCount} in ${Date.now() - t0}ms`
  );

  return {
    summary: {
      totalEarning: summaryRevenue,
      totalEarningChange: 0,
      selectRange: summaryRevenue,
      selectRangeChange: 0,
      last7Days: +trend.slice(-7).reduce((a, x) => a + (x.earning || 0), 0).toFixed(2),
      last7DaysChange: 0,
      pageViews: summaryImpressions,
      pageViewsChange: 0,
      impressions: summaryImpressions,
      impressionsChange: 0,
      clicks: summaryClicks,
      clicksChange: 0,
      ctr: summaryImpressions > 0 ? +((summaryClicks / summaryImpressions) * 100).toFixed(4) : 0,
      revenue: summaryRevenue,
      revenueChange: 0,
      ecpm: summaryImpressions > 0 ? +((summaryRevenue / summaryImpressions) * 1000).toFixed(2) : 0,
      ecpmChange: 0,
      viewability: summaryViewability,
      viewabilityChange: 0,
      totalDomains: countAppAndWebsiteDomainsFromRows(tableRows),
      currency: opts.currency || 'USD',
    },
    trend,
    charts: { revenue: [], device: [], country: [], performance: [] },
    rows: tableRows,
    pagination: {
      totalRows: tableRows.length,
      returnedRows: tableRows.length,
      truncated: grainCount > tableRows.length,
      allRows: !!(opts.reportingFast || opts.skipCharts) && grainCount <= tableRows.length,
      compact: true,
    },
    grainCount,
    source: 'grain-inventory-core',
  };
}

/**
 * Site (+ optional domain / country / ad unit) table/trend from inventory_core.
 * Fair per-day sampling so 30d / 3m / 12m ranges keep every day in the table
 * (plain ORDER BY date DESC LIMIT would collapse to recent/today only).
 */
async function fetchInventorySiteDashboardBundle(startDate, endDate, opts = {}) {
  const sites = (opts.sites || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
  if (!sites.length) return null;
  return fetchInventoryCoreDashboardBundle(startDate, endDate, opts);
}

/**
 * Fast overview KPIs: SUM in SQL instead of loading 100k+ detail rows into Node.
 * Optional inventory opts (domains/sites/apps) keep domain-user overview as fast as admin.
 * Returns null when no lean rows exist for the range.
 */
async function fetchLeanOverviewTotalsFromDB(startDate, endDate, opts = {}) {
  const hasWeb = (opts.domains?.length || 0)
    || (opts.sites?.length || 0)
    || (opts.adUnitNames?.length || 0);
  const hasApp = (opts.apps?.length || 0) > 0;
  const siteKind = classifySiteHostSelection(opts.sites);

  // App-only: channel rollups have empty inv_app — read app_id grain slice.
  if (hasApp && !hasWeb) {
    const appTotals = await fetchAppSliceOverviewFromGrain(startDate, endDate, opts);
    if (appTotals) return appTotals;
  }

  // Site filter: grain SITE_NAME for request hosts; rollups only for d1.* slot hosts.
  if ((opts.sites || []).length) {
    const siteTotals = await fetchInventorySiteOverviewFromGrain(startDate, endDate, opts);
    if (siteKind === 'request') {
      if (siteTotals) return siteTotals;
    } else {
      const rollupSiteTotals = await fetchRollupSiteOverview(startDate, endDate, opts);
      const merged = mergeSiteOverviewTotals(rollupSiteTotals, siteTotals, opts.sites);
      if (merged) return merged;
    }
  }

  // Web + app assignment: OR semantics — two fast SUMs in parallel (never AND).
  if (hasWeb && hasApp) {
    const [web, app] = await Promise.all([
      fetchLeanOverviewTotalsFromDB(startDate, endDate, { ...opts, apps: [] }),
      fetchLeanOverviewTotalsFromDB(startDate, endDate, {
        ...opts,
        domains: [],
        sites: [],
        adUnitNames: [],
      }),
    ]);
    if (!web && !app) return null;
    const impressions = (web?.impressions || 0) + (app?.impressions || 0);
    const revenue = +(((web?.revenue || 0) + (app?.revenue || 0))).toFixed(2);
    const viewableWeight = ((web?.viewability || 0) / 100) * (web?.impressions || 0)
      + ((app?.viewability || 0) / 100) * (app?.impressions || 0);
    const rowCount = (web?.rowCount || 0) + (app?.rowCount || 0);
    if (!rowCount || (impressions <= 0 && revenue <= 0)) return null;
    return {
      impressions: Math.round(impressions),
      revenue,
      viewability: impressions > 0 ? +((viewableWeight / impressions) * 100).toFixed(1) : 0,
      rowCount,
      source: web?.source === 'rollup' || app?.source === 'rollup' ? 'rollup' : 'grain',
    };
  }

  // Prefer typed rollups (fast). Fall back to grain JSONB scan if rollups empty.
  if (siteKind !== 'request') {
    try {
      const filterParams = [startDate, endDate];
      let filterExtra = ` AND report_date BETWEEN $1::date AND $2::date`;
      filterExtra = appendRollupInventoryFilters(filterParams, filterExtra, opts);
      const { rows } = await query(
        `SELECT
         COALESCE(SUM(impressions), 0)::float8 AS impressions,
         COALESCE(SUM(revenue), 0)::float8 AS revenue,
         COALESCE(SUM(viewable_weight), 0)::float8 AS viewable_weight,
         COALESCE(SUM(grain_count), 0)::int AS row_count
       FROM rollup_kpi_daily
       WHERE TRUE${filterExtra}`,
        filterParams
      );
      const t = rows[0] || {};
      const impressions = Number(t.impressions) || 0;
      const revenue = coerceWarehouseRevenue(t.revenue, impressions);
      const viewableWeight = Number(t.viewable_weight) || 0;
      const rowCount = Number(t.row_count) || 0;
      if (rowCount > 0 && (impressions > 0 || revenue > 0)) {
        const viewability = impressions > 0 ? +(viewableWeight / impressions).toFixed(1) : 0;
        return {
          impressions: Math.round(impressions),
          revenue,
          viewability,
          rowCount,
          source: 'rollup',
        };
      }
    } catch (e) {
      logger.warn('Overview rollup read failed, falling back to grain:', e.message);
    }
  }

  const leanRows = await fetchLeanRowsFromDB(startDate, endDate, { ...opts, kpiSliceOnly: true });
  if (!leanRows.length) return null;

  let impressions = 0;
  let revenue = 0;
  let viewableWeight = 0;
  let clicks = 0;
  for (const r of leanRows) {
    impressions += Number(r.impression) || 0;
    revenue += Number(r.revenue) || 0;
    clicks += Number(r.clicks) || 0;
    viewableWeight += ((Number(r.viewableRate) || 0) / 100) * (Number(r.impression) || 0);
  }
  const rowCount = leanRows.length;
  if (!rowCount || (impressions <= 0 && revenue <= 0)) return null;

  const viewability = impressions > 0 ? +(viewableWeight / impressions * 100).toFixed(1) : 0;
  return {
    impressions: Math.round(impressions),
    revenue: +Number(revenue).toFixed(2),
    clicks: Math.round(clicks),
    ctr: impressions > 0 ? +((clicks / impressions) * 100).toFixed(4) : 0,
    viewability,
    rowCount,
    source: 'grain',
  };
}

/** Shared metric SQL fragments for lean dashboard aggregates. */
function leanMetricSql() {
  const impressionExpr = `COALESCE(
    NULLIF(metrics->>'TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS','')::double precision,
    NULLIF(metrics->>'impression','')::double precision,
    0
  )`;
  const { revenueExpr } = leanRevenueSqlFragments();
  const viewableRawExpr = `COALESCE(
    NULLIF(metrics->>'TOTAL_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE','')::double precision,
    NULLIF(metrics->>'viewableRate','')::double precision,
    NULLIF(metrics->>'total_active_view_viewable_impressions_rate','')::double precision,
    0
  )`;
  const viewablePctExpr = `CASE
    WHEN ${viewableRawExpr} > 0 AND ${viewableRawExpr} <= 1 THEN ${viewableRawExpr} * 100.0
    ELSE ${viewableRawExpr}
  END`;
  const clickExpr = `COALESCE(
    NULLIF(metrics->>'TOTAL_LINE_ITEM_LEVEL_CLICKS','')::double precision,
    NULLIF(metrics->>'clicks','')::double precision,
    NULLIF(metrics->>'total_line_item_level_clicks','')::double precision,
    0
  )`;
  const domainExpr = `COALESCE(NULLIF(inv_domain,''), dimensions->>'domainName', dimensions->>'domain', dimensions->>'DOMAIN', '')`;
  const siteExpr = `COALESCE(NULLIF(inv_site,''), dimensions->>'siteUrl', dimensions->>'gamSite', dimensions->>'siteName', dimensions->>'URL_NAME', dimensions->>'SITE_NAME', '')`;
  const adUnitExpr = `COALESCE(NULLIF(inv_ad_unit,''), dimensions->>'AD_UNIT_NAME', dimensions->>'ad_unit_name', dimensions->>'site', '')`;
  const appExpr = `COALESCE(NULLIF(inv_app,''), dimensions->>'appPackage', dimensions->>'appId', dimensions->>'MOBILE_APP_NAME', dimensions->>'mobile_app_name', '')`;
  const countryExpr = `COALESCE(dimensions->>'COUNTRY_NAME', dimensions->>'country_name', dimensions->>'country', '')`;
  const deviceExpr = `COALESCE(dimensions->>'DEVICE_CATEGORY_NAME', dimensions->>'device_category_name', dimensions->>'device', '')`;
  return {
    impressionExpr,
    revenueExpr,
    viewablePctExpr,
    clickExpr,
    domainExpr,
    siteExpr,
    adUnitExpr,
    appExpr,
    countryExpr,
    deviceExpr,
  };
}

/**
 * Rebuild dashboard rollups for the given dates from lean grain tables.
 * Collapses country×device so request-time scans stay small.
 */
async function rebuildRollupsForDates(dates, syncType = 'rollup') {
  return rebuildRollupsFromGrain(dates, syncType);
}

/** One-shot: rebuild rollups for lean dates not yet covered (post-deploy warm). */
async function backfillAllRollups(syncType = 'rollup-backfill') {
  try {
    const { rows } = await query(`
      SELECT DISTINCT to_char(g.report_date, 'YYYY-MM-DD') AS d
      FROM report_grain g
      WHERE NOT EXISTS (
        SELECT 1 FROM rollup_kpi_daily r
        WHERE r.client_id = g.client_id AND r.report_date = g.report_date
      )
      ORDER BY 1
    `);
    const dates = rows.map((r) => r.d).filter(Boolean);
    if (!dates.length) {
      logger.info(`[${syncType}] Rollups already up to date`);
      return 0;
    }
    logger.info(`[${syncType}] Backfilling rollups for ${dates.length} missing day(s)…`);
    return rebuildRollupsForDates(dates, syncType);
  } catch (e) {
    logger.warn(`[${syncType}] backfill skipped:`, e.message);
    return 0;
  }
}

function appendRollupInventoryFilters(params, extra, opts = {}) {
  const { sanitizeInventoryFilters, MAX_INVENTORY_FILTER_VALUES } = require('../utils/inventoryFilters');
  const safeOpts = sanitizeInventoryFilters({
    domain: opts.domains,
    site: opts.sites,
    domainName: opts.adUnitNames,
    domainId: opts.apps,
  });
  const adUnitNames = (safeOpts.domainName || [])
    .map((s) => String(s || '').trim().toLowerCase())
    .filter(Boolean);
  const adUnitPatterns = (opts.adUnitPatterns || [])
    .map((s) => String(s || '').trim().toLowerCase())
    .filter(Boolean)
    .slice(0, MAX_INVENTORY_FILTER_VALUES);
  const domains = (safeOpts.domain || [])
    .map((s) => String(s || '').trim().toLowerCase())
    .filter(Boolean);
  const sites = (safeOpts.site || [])
    .map((s) => String(s || '').trim().toLowerCase())
    .filter(Boolean);
  const apps = (safeOpts.domainId || [])
    .map((s) => String(s || '').trim().toLowerCase())
    .filter(Boolean);

  // GAM-style: Domain × Site is an intersection (AND). Loose LIKE is opt-in only.
  const exact = opts.skipAdUnitLike !== false;
  const domainExpr = rollupInvDomainExprSql();
  const siteExpr = `LOWER(TRIM(COALESCE(inv_site, '')))`;

  let clause = extra || '';
  if (adUnitNames.length) {
    params.push(adUnitNames);
    clause += ` AND LOWER(inv_ad_unit) = ANY($${params.length}::text[])`;
  }
  const webParts = [];
  if (domains.length) {
    params.push(domains);
    const i = params.length;
    webParts.push(exact
      ? `(${domainExpr} = ANY($${i}::text[]))`
      : `(
      ${domainExpr} = ANY($${i}::text[])
      OR LOWER(inv_ad_unit) LIKE ANY(ARRAY(SELECT '%' || d || '%' FROM unnest($${i}::text[]) AS d))
    )`);
  }
  if (sites.length) {
    params.push(sites);
    const i = params.length;
    // Exact site host match (GAM Site filter). Do NOT LIKE '%domain%' — that equals domain-wide.
    webParts.push(exact
      ? `(${siteExpr} = ANY($${i}::text[]))`
      : `(
      ${siteExpr} = ANY($${i}::text[])
      OR LOWER(inv_ad_unit) LIKE ANY(ARRAY(SELECT '%' || s || '%' FROM unnest($${i}::text[]) AS s))
    )`);
  }
  if (webParts.length === 1) {
    clause += ` AND ${webParts[0]}`;
  } else if (webParts.length > 1) {
    // Default AND = Domain ∩ Site (GAM). OR only when scoped assignment opts in.
    clause += opts.webInventoryOr
      ? ` AND (${webParts.join(' OR ')})`
      : ` AND ${webParts[0]} AND ${webParts[1]}`;
  }
  if (apps.length) {
    clause += sqlAppMatchClause(params, apps, 'LOWER(inv_app)', 'LOWER(inv_ad_unit)');
  }
  if (!domains.length && !sites.length && !adUnitNames.length && !apps.length && adUnitPatterns.length) {
    params.push(adUnitPatterns);
    clause += ` AND LOWER(inv_ad_unit) LIKE ANY($${params.length}::text[])`;
  }
  return clause;
}

function hasRollupInventoryOpts(opts = {}) {
  return Boolean(
    (opts.domains && opts.domains.length)
    || (opts.sites && opts.sites.length)
    || (opts.adUnitNames && opts.adUnitNames.length)
    || (opts.apps && opts.apps.length)
    || (opts.adUnitPatterns && opts.adUnitPatterns.length)
    || (opts.countryNames && opts.countryNames.length)
  );
}

function appendLeanInventoryFilters(params, extra, opts = {}) {
  const { sanitizeInventoryFilters, MAX_INVENTORY_FILTER_VALUES } = require('../utils/inventoryFilters');
  const safeOpts = sanitizeInventoryFilters({
    domain: opts.domains,
    site: opts.sites,
    domainName: opts.adUnitNames,
    domainId: opts.apps,
  });
  const adUnitNames = (safeOpts.domainName || [])
    .map((s) => String(s || '').trim().toLowerCase())
    .filter(Boolean);
  const adUnitPatterns = (opts.adUnitPatterns || [])
    .map((s) => String(s || '').trim().toLowerCase())
    .filter(Boolean)
    .slice(0, MAX_INVENTORY_FILTER_VALUES);
  const domains = (safeOpts.domain || [])
    .map((s) => String(s || '').trim().toLowerCase())
    .filter(Boolean);
  const sites = (safeOpts.site || [])
    .map((s) => String(s || '').trim().toLowerCase())
    .filter(Boolean);
  const apps = (safeOpts.domainId || [])
    .map((s) => String(s || '').trim().toLowerCase())
    .filter(Boolean);
  const countryNames = (opts.countryNames || [])
    .map((s) => String(s || '').trim().toLowerCase())
    .filter(Boolean);

  const adUnitExpr = `LOWER(COALESCE(NULLIF(inv_ad_unit,''), dimensions->>'AD_UNIT_NAME', dimensions->>'ad_unit_name', dimensions->>'site', ''))`;
  const domainExpr = `LOWER(COALESCE(NULLIF(inv_domain,''), dimensions->>'domainName', dimensions->>'domain', dimensions->>'DOMAIN', ''))`;
  const siteExpr = `LOWER(COALESCE(NULLIF(inv_site,''), dimensions->>'siteUrl', dimensions->>'gamSite', dimensions->>'siteName', dimensions->>'URL_NAME', dimensions->>'SITE_NAME', ''))`;
  const appExpr = `LOWER(COALESCE(NULLIF(inv_app,''), dimensions->>'appPackage', dimensions->>'appId', dimensions->>'MOBILE_APP_NAME', dimensions->>'mobile_app_name', dimensions->>'MOBILE_APP_RESOLVED_ID', ''))`;
  const exact = opts.skipAdUnitLike !== false;

  let clause = extra || '';
  if (adUnitNames.length) {
    params.push(adUnitNames);
    clause += ` AND ${adUnitExpr} = ANY($${params.length}::text[])`;
  }
  const webParts = [];
  if (domains.length) {
    params.push(domains);
    const i = params.length;
    webParts.push(exact
      ? `(${domainExpr} = ANY($${i}::text[]))`
      : `(
      ${domainExpr} = ANY($${i}::text[])
      OR ${adUnitExpr} LIKE ANY(ARRAY(SELECT '%' || d || '%' FROM unnest($${i}::text[]) AS d))
    )`);
  }
  if (sites.length) {
    params.push(sites);
    const i = params.length;
    webParts.push(exact
      ? `(${siteExpr} = ANY($${i}::text[]))`
      : `(
      ${siteExpr} = ANY($${i}::text[])
      OR ${adUnitExpr} LIKE ANY(ARRAY(SELECT '%' || s || '%' FROM unnest($${i}::text[]) AS s))
    )`);
  }
  if (webParts.length === 1) {
    clause += ` AND ${webParts[0]}`;
  } else if (webParts.length > 1) {
    clause += opts.webInventoryOr
      ? ` AND (${webParts.join(' OR ')})`
      : ` AND ${webParts[0]} AND ${webParts[1]}`;
  }
  if (apps.length) {
    clause += sqlAppMatchClause(params, apps, appExpr, adUnitExpr);
  }
  if (!domains.length && !sites.length && !adUnitNames.length && !apps.length && adUnitPatterns.length) {
    params.push(adUnitPatterns);
    clause += ` AND ${adUnitExpr} LIKE ANY($${params.length}::text[])`;
  }
  if (countryNames.length) {
    params.push(countryNames);
    clause += ` AND LOWER(TRIM(COALESCE(
      dc.name,
      dimensions->>'COUNTRY_NAME',
      dimensions->>'country_name',
      dimensions->>'country',
      ''
    ))) = ANY($${params.length}::text[])`;
  }
  return clause;
}

function friendlyDeviceBucket(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (/tablet|ipad/.test(s)) return 'Tablet';
  if (/smart.?phone|mobile|phone|feature.?phone|android|ios/.test(s)) return 'Mobile';
  if (/desktop|laptop|computer|pc|macintosh|windows/.test(s)) return 'Laptop';
  if (/connected.?tv|smart.?tv|set.?top|tv/.test(s)) return 'TV';
  return String(raw).trim();
}

/** Dashboard table grain: domain+site by default; finer when inventory filters are active. */
function resolveTableRollupGroup(opts = {}) {
  // Ad unit filter → finest grain (date × domain × site × ad unit).
  if (opts.adUnitNames?.length) return 'ad_unit';
  // App-only → app grain.
  if (opts.apps?.length && !opts.domains?.length && !opts.sites?.length) return 'app';
  // Site filter, explicit groupBySite, or default inventory table → date × domain × site.
  if (opts.sites?.length || opts.groupBySite || opts.tableGrain === 'site') return 'site';
  // Domain-only when explicitly requested.
  if (opts.tableGrain === 'domain') return 'domain';
  // Default: include site so Domain + Site columns both populate.
  return 'site';
}

/** True when Reporting (or filters) need country / device kept in table rows. */
function wantsGeoTableDims(opts = {}) {
  return Boolean(
    opts.groupByCountry
    || opts.groupByDevice
    || (opts.countryNames && opts.countryNames.length)
  );
}

/** Map rollup/grain aggregate row → dashboard table row shape (revenue already in dollars). */
function mapDomainTableRow(r) {
  const impression = Math.round(Number(r.impression) || 0);
  const revenue = coerceWarehouseRevenue(r.revenue_raw, impression);
  const clicks = Math.round(Number(r.clicks) || 0);
  let viewableRate = Number(r.viewable_raw) || 0;
  if (viewableRate > 0 && viewableRate <= 1) viewableRate = +(viewableRate * 100).toFixed(2);
  else viewableRate = +Number(viewableRate || 0).toFixed(2);
  const adUnit = r.ad_unit || '';
  const fromUnit = domainFromAdUnit(adUnit);
  const siteUrl = String(r.site_url || '').trim().toLowerCase();
  // Prefer SQL domain (site-root → ad-unit → dim); fall back to ad-unit root.
  const domainName = String(r.domain_name || fromUnit || '').trim().toLowerCase();
  const appId = r.app_id || '';
  const country = r.country || '';
  const device = r.device || '';
  const ecpm = impression > 0 && revenue > 0 ? +((revenue / impression) * 1000).toFixed(2) : 0;
  return {
    date: r.report_date,
    report_date: r.report_date,
    country,
    device,
    COUNTRY_NAME: country,
    DEVICE_CATEGORY_NAME: device,
    // Keep ad-unit off `site` so Site column shows real SITE_NAME hosts.
    site: siteUrl || '',
    AD_UNIT_NAME: adUnit,
    ad_unit_name: adUnit,
    domainName: domainName || '',
    domain: domainName || '',
    gamDomain: domainName || '',
    siteUrl: siteUrl || '',
    gamSite: siteUrl || '',
    siteName: siteUrl || '',
    appId: appId || '',
    appPackage: appId || '',
    impression,
    revenue,
    revenueDollars: true,
    clicks,
    ctr: impression > 0 && clicks > 0 ? +((clicks / impression) * 100).toFixed(4) : 0,
    viewableRate,
    ecpm,
    currency: r.currency || 'USD',
  };
}

/** Distinct domain/app count from inventory Site rollups (full range, not truncated table). */
async function countInventoryRollupEntities(startDate, endDate, opts = {}) {
  const domainExpr = rollupInvDomainExprSql();
  const params = [startDate, endDate];
  let filterExtra = ` AND report_date BETWEEN $1::date AND $2::date`;
  filterExtra = appendRollupInventoryFilters(params, filterExtra, opts);
  try {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM (
         SELECT DISTINCT ${domainExpr} AS k
         FROM rollup_inventory_kpi_daily
         WHERE TRUE${filterExtra}
           AND ${domainExpr} IS NOT NULL AND ${domainExpr} <> ''
         UNION
         SELECT DISTINCT LOWER(TRIM(inv_app)) AS k
         FROM rollup_inventory_kpi_daily
         WHERE TRUE${filterExtra}
           AND NULLIF(TRIM(inv_app), '') IS NOT NULL
       ) entities`,
      params
    );
    return Number(rows?.[0]?.n) || 0;
  } catch (_) {
    return 0;
  }
}

/**
 * Distinct website domains + apps (not ad units). Used for "Total App & Website Domain".
 * Prefer SQL COUNT DISTINCT over this — truncated table samples under-count badly.
 */
function countAppAndWebsiteDomainsFromRows(rows = []) {
  const keys = new Set();
  for (const r of rows || []) {
    const domain = String(
      r.domainName || r.domain || r.gamDomain || r.DOMAIN || r.domain_name || ''
    ).trim().toLowerCase();
    const app = String(r.appId || r.appPackage || r.app_id || '').trim().toLowerCase();
    if (domain) keys.add(`web:${domain}`);
    if (app) keys.add(`app:${app}`);
  }
  return keys.size;
}

async function fetchBundleDomainTableFromRollup(startDate, endDate, opts, limit) {
  const domainExpr = rollupInvDomainExprSql();
  const filterParams = [startDate, endDate];
  let filterExtra = ` AND report_date BETWEEN $1::date AND $2::date`;
  filterExtra = appendRollupInventoryFilters(filterParams, filterExtra, opts);

  const grain = resolveTableRollupGroup(opts);
  const rangeDays = inclusiveDayCount(startDate, endDate);
  // Always keep daily rows so Inventory Breakdown DATE spans the full selected range
  // (period collapse stamped every row with endDate — looked like "only today").
  const periodAggregate = false;
  // Prefer inventory_core rollups for Site/Domain (real SITE_NAME). Channel rollups invent d1.* hosts.
  const rollupTable = opts.rollupTable === 'channel'
    ? 'rollup_kpi_daily'
    : (opts.rollupTable === 'inventory' || grain === 'site' || grain === 'domain')
      ? 'rollup_inventory_kpi_daily'
      : 'rollup_kpi_daily';
  const fromTable = rollupTable === 'rollup_inventory_kpi_daily'
    ? 'rollup_inventory_kpi_daily'
    : 'rollup_kpi_daily';

  let groupBy;
  let selectCols;
  let domainHaving = ` AND ${domainExpr} IS NOT NULL AND ${domainExpr} <> ''`;

  if (grain === 'ad_unit') {
    groupBy = periodAggregate
      ? `${domainExpr}, NULLIF(LOWER(TRIM(inv_site)), ''), NULLIF(TRIM(inv_ad_unit), '')`
      : `report_date, ${domainExpr}, NULLIF(LOWER(TRIM(inv_site)), ''), NULLIF(TRIM(inv_ad_unit), '')`;
    selectCols = `
       ${domainExpr} AS domain_name,
       COALESCE(NULLIF(LOWER(TRIM(inv_site)), ''), '') AS site_url,
       COALESCE(NULLIF(TRIM(inv_ad_unit), ''), '') AS ad_unit,
       '' AS app_id`;
  } else if (grain === 'app') {
    groupBy = periodAggregate
      ? `NULLIF(TRIM(inv_app), '')`
      : `report_date, NULLIF(TRIM(inv_app), '')`;
    selectCols = `
       '' AS domain_name,
       '' AS site_url,
       '' AS ad_unit,
       COALESCE(NULLIF(TRIM(inv_app), ''), '') AS app_id`;
    domainHaving = ` AND NULLIF(TRIM(inv_app), '') IS NOT NULL`;
  } else if (grain === 'site') {
    groupBy = periodAggregate
      ? `${domainExpr}, NULLIF(LOWER(TRIM(inv_site)), '')`
      : `report_date, ${domainExpr}, NULLIF(LOWER(TRIM(inv_site)), '')`;
    selectCols = `
       ${domainExpr} AS domain_name,
       COALESCE(NULLIF(LOWER(TRIM(inv_site)), ''), '') AS site_url,
       '' AS ad_unit,
       '' AS app_id`;
    // Keep unlabeled site hosts (empty domain) — channel rollups used to drop these.
    domainHaving = ` AND (
      (${domainExpr} IS NOT NULL AND ${domainExpr} <> '')
      OR NULLIF(LOWER(TRIM(inv_site)), '') IS NOT NULL
    )`;
  } else {
    groupBy = periodAggregate ? `${domainExpr}` : `report_date, ${domainExpr}`;
    selectCols = `
       ${domainExpr} AS domain_name,
       '' AS site_url,
       '' AS ad_unit,
       '' AS app_id`;
  }

  const runFrom = async (table) => {
    const params = [...filterParams];
    const dayCount = Math.max(1, rangeDays);
    // Enough capacity that every day in the range keeps top sites (3m/6m/12m full span).
    const perDayTarget = table === 'rollup_inventory_kpi_daily'
      ? Math.max(40, Math.min(200, Math.ceil(Math.max(limit, 8000) / dayCount)))
      : Math.max(15, Math.min(100, Math.ceil(limit / dayCount)));
    const outerLimit = Math.min(20000, Math.max(limit, dayCount * perDayTarget));
    params.push(perDayTarget);
    const perDayIdx = params.length;
    params.push(outerLimit);
    const limitIdx = params.length;
    const { rows } = await query(
      `WITH agg AS (
         SELECT
           report_date,
           ${selectCols},
           COALESCE(SUM(impressions), 0)::float8 AS impression,
           COALESCE(SUM(revenue), 0)::float8 AS revenue_raw,
           CASE WHEN COALESCE(SUM(impressions), 0) > 0
             THEN COALESCE(SUM(viewable_weight), 0) / COALESCE(SUM(impressions), 0)
             ELSE 0
           END AS viewable_raw,
           COALESCE(SUM(clicks), 0)::float8 AS clicks,
           COALESCE(MAX(currency), 'USD') AS currency
         FROM ${table}
         WHERE TRUE${filterExtra}${domainHaving}
         GROUP BY ${groupBy}
         HAVING COALESCE(SUM(impressions), 0) > 0 OR COALESCE(SUM(revenue), 0) > 0
       ),
       ranked AS (
         SELECT *,
           ROW_NUMBER() OVER (
             PARTITION BY report_date
             ORDER BY revenue_raw DESC, impression DESC
           ) AS day_rank
         FROM agg
       )
       SELECT
         to_char(report_date, 'YYYY-MM-DD') AS report_date,
         domain_name, site_url, ad_unit, app_id,
         impression, revenue_raw, viewable_raw, clicks, currency
       FROM ranked
       WHERE day_rank <= $${perDayIdx}
       ORDER BY report_date ASC, revenue_raw DESC, impression DESC
       LIMIT $${limitIdx}`,
      params
    );
    return (rows || []).map(mapDomainTableRow);
  };

  if (fromTable === 'rollup_inventory_kpi_daily') {
    try {
      const invRows = await runFrom('rollup_inventory_kpi_daily');
      if (invRows.length) return invRows;
    } catch (e) {
      // Table may not exist yet on first boot — fall through to channel rollups.
      if (!/does not exist|relation/i.test(e.message || '')) {
        logger.warn('Inventory rollup table read failed:', e.message);
      }
    }
    // Empty inventory rollups: never fall back to channel hosts on long ranges (wrong Site).
    if (
      opts.rollupTable === 'inventory'
      || opts.preferInventoryRollup
      || rangeDays > DASHBOARD_ROLLUP_FIRST_DAYS
    ) return [];
  }

  return runFrom('rollup_kpi_daily');
}

/** Full domain-level table rows (SQL aggregates — no raw-row sampling). */
async function fetchBundleTableRows(startDate, endDate, opts, tableLimit) {
  const limit = Math.min(Math.max(parseInt(tableLimit, 10) || 2500, 50), 10000);
  const tableOpts = {
    countryNames: opts.countryNames,
    adUnitNames: opts.adUnitNames,
    domains: opts.domains,
    sites: opts.sites,
    apps: opts.apps,
    tableLimit: limit,
    groupByCountry: opts.groupByCountry,
    groupByDevice: opts.groupByDevice,
  };

  // Country/device dims (or country filter): rollups lack geo — aggregate from grain.
  if (wantsGeoTableDims(opts)) {
    const rows = await fetchGrainDomainTableRows(startDate, endDate, tableOpts);
    return rows.map(mapDomainTableRow);
  }

  const rollupRows = await fetchBundleDomainTableFromRollup(startDate, endDate, opts, limit);
  if (rollupRows.length) return rollupRows;

  const grainRows = await fetchGrainDomainTableRows(startDate, endDate, tableOpts);
  return grainRows.map(mapDomainTableRow);
}

/**
 * Fast dashboard bundle from precomputed rollups (same numbers as lean grain aggregates).
 * Country filter forces grain fallback (dim rollups are network-wide).
 */
async function fetchDashboardBundleFromRollups(startDate, endDate, opts = {}) {
  if (opts.countryNames && opts.countryNames.length) return null;

  const tableLimit = reportingTableLimit(startDate, endDate, opts.tableLimit);
  const skipCharts = Boolean(opts.skipCharts || opts.reportingFast);
  const skipTable = Boolean(opts.skipTable);
  const filterParams = [startDate, endDate];
  let filterExtra = ` AND report_date BETWEEN $1::date AND $2::date`;
  filterExtra = appendRollupInventoryFilters(filterParams, filterExtra, opts);
  const kpiFrom = `FROM rollup_kpi_daily WHERE TRUE${filterExtra}`;

  const domainExpr = rollupInvDomainExprSql();
  const [{ rows: totalsRows }, { rows: trendRaw }, { rows: entityRows }, tableRowsEarly] = await Promise.all([
    query(
      `SELECT
         COALESCE(SUM(impressions), 0)::float8 AS impressions,
         COALESCE(SUM(revenue), 0)::float8 AS revenue,
         COALESCE(SUM(viewable_weight), 0)::float8 AS viewable_weight,
         COALESCE(SUM(clicks), 0)::float8 AS clicks,
         COALESCE(SUM(grain_count), 0)::int AS row_count
       ${kpiFrom}`,
      filterParams
    ),
    query(
      `SELECT
         to_char(report_date, 'YYYY-MM-DD') AS date,
         COALESCE(SUM(revenue), 0)::float8 AS earning,
         COALESCE(SUM(impressions), 0)::float8 AS impressions
       ${kpiFrom}
       GROUP BY report_date
       ORDER BY report_date`,
      filterParams
    ),
    query(
      `SELECT COUNT(*)::int AS n FROM (
         SELECT DISTINCT ${domainExpr} AS k
         ${kpiFrom}
           AND ${domainExpr} IS NOT NULL AND ${domainExpr} <> ''
         UNION
         SELECT DISTINCT LOWER(TRIM(inv_app)) AS k
         ${kpiFrom}
           AND NULLIF(TRIM(inv_app), '') IS NOT NULL
       ) entities`,
      filterParams
    ),
    (skipCharts && !skipTable)
      ? fetchBundleTableRows(startDate, endDate, opts, tableLimit)
      : Promise.resolve(null),
  ]);

  const t = totalsRows[0] || {};
  let impressions = Number(t.impressions) || 0;
  let revenue = coerceWarehouseRevenue(t.revenue, impressions);
  let viewableWeight = Number(t.viewable_weight) || 0;
  let clicks = Number(t.clicks) || 0;
  let grainCount = Number(t.row_count) || 0;
  const totalDomains = Number(entityRows?.[0]?.n) || 0;
  if (!grainCount || (impressions <= 0 && revenue <= 0)) return null;

  const trend = (trendRaw || []).map((r) => {
    const impressions = Math.round(Number(r.impressions) || 0);
    return {
      date: r.date,
      earning: coerceWarehouseRevenue(r.earning, impressions),
      impressions,
    };
  });

  if (skipCharts) {
    const tableRows = tableRowsEarly || [];
    const viewability = impressions > 0 ? +(viewableWeight / impressions).toFixed(1) : 0;
    return {
      summary: {
        totalEarning: +Number(revenue).toFixed(2),
        totalEarningChange: 0,
        selectRange: +Number(revenue).toFixed(2),
        selectRangeChange: 0,
        last7Days: +trend.slice(-7).reduce((a, x) => a + (x.earning || 0), 0).toFixed(2),
        last7DaysChange: 0,
        pageViews: Math.round(impressions),
        pageViewsChange: 0,
        impressions: Math.round(impressions),
        impressionsChange: 0,
        clicks: Math.round(clicks),
        clicksChange: 0,
        ctr: impressions > 0 ? +((clicks / impressions) * 100).toFixed(4) : 0,
        revenue: +Number(revenue).toFixed(2),
        revenueChange: 0,
        ecpm: impressions > 0 ? +((revenue / impressions) * 1000).toFixed(2) : 0,
        ecpmChange: 0,
        viewability,
        viewabilityChange: 0,
        totalDomains: totalDomains || countAppAndWebsiteDomainsFromRows(tableRows),
        currency: opts.currency || 'USD',
      },
      trend,
      charts: { revenue: [], device: [], country: [], performance: [] },
      rows: tableRows,
      pagination: {
        totalRows: tableRows.length,
        returnedRows: tableRows.length,
        truncated: grainCount > tableRows.length,
        allRows: false,
        compact: true,
      },
      grainCount,
      source: 'rollup',
    };
  }

  const { rows: domainRaw } = await query(
    `SELECT
       ${rollupInvDomainExprSql()} AS name,
       COALESCE(SUM(revenue), 0)::float8 AS value
     ${kpiFrom}
     GROUP BY 1
     HAVING ${rollupInvDomainExprSql()} IS NOT NULL
       AND ${rollupInvDomainExprSql()} <> ''
     ORDER BY value DESC
     LIMIT 10`,
    filterParams
  );
  let revenueShare = domainRaw
    .map((r) => ({
      name: String(r.name || '').trim(),
      value: coerceWarehouseRevenue(r.value, impressions),
    }))
    .filter((r) => r.name && r.value > 0);

  const { rows: perfRaw } = await query(
    `SELECT
       NULLIF(TRIM(inv_ad_unit), '') AS name,
       COALESCE(SUM(revenue), 0)::float8 AS revenue,
       COALESCE(SUM(impressions), 0)::float8 AS impressions
     ${kpiFrom}
     GROUP BY 1
     HAVING NULLIF(TRIM(inv_ad_unit), '') IS NOT NULL
     ORDER BY revenue DESC
     LIMIT 6`,
    filterParams
  );
  const performance = perfRaw.map((e) => {
    const imp = Number(e.impressions) || 0;
    const rev = coerceWarehouseRevenue(e.revenue, imp);
    return {
      name: String(e.name || '').trim(),
      revenue: rev,
      impressions: Math.round(imp),
      ecpm: imp > 0 ? +((rev / imp) * 1000).toFixed(2) : 0,
      ctr: 0,
      viewability: 0,
      score: rev,
    };
  }).filter((e) => e.name && (e.revenue > 0 || e.impressions > 0));

  // Country/device from dim rollups when unfiltered; when inventory-filtered, derive skip
  // (cannot correctly filter network-wide dim rollups) — leave empty arrays.
  let deviceShare = [];
  let countryShare = [];
  if (!hasRollupInventoryOpts(opts)) {
    const dimParams = [startDate, endDate];
    const { rows: deviceRaw } = await query(
      `SELECT dim_value AS name, COALESCE(SUM(revenue), 0)::float8 AS value
       FROM rollup_dim_daily
       WHERE report_date BETWEEN $1::date AND $2::date AND dim_kind = 'device'
       GROUP BY dim_value`,
      dimParams
    );
    const deviceMap = new Map();
    for (const r of deviceRaw) {
      const bucket = friendlyDeviceBucket(r.name);
      if (!bucket) continue;
      const value = Number(r.value) || 0;
      if (value <= 0) continue;
      deviceMap.set(bucket, (deviceMap.get(bucket) || 0) + value);
    }
    deviceShare = Array.from(deviceMap.entries())
      .map(([name, value]) => ({ name, value: +Number(value).toFixed(2) }))
      .sort((a, b) => b.value - a.value);

    const { rows: countryRaw } = await query(
      `SELECT dim_value AS name, COALESCE(SUM(revenue), 0)::float8 AS value
       FROM rollup_dim_daily
       WHERE report_date BETWEEN $1::date AND $2::date AND dim_kind = 'country'
       GROUP BY dim_value
       ORDER BY value DESC
       LIMIT 10`,
      dimParams
    );
    countryShare = countryRaw
      .map((r) => ({ name: String(r.name || '').trim(), value: +Number(r.value || 0).toFixed(2) }))
      .filter((r) => r.name && r.value > 0);
  }

  const tableRows = await fetchBundleTableRows(startDate, endDate, opts, tableLimit);

  const viewability = impressions > 0 ? +(viewableWeight / impressions).toFixed(1) : 0;
  const summary = {
    totalEarning: +Number(revenue).toFixed(2),
    totalEarningChange: 0,
    selectRange: +Number(revenue).toFixed(2),
    selectRangeChange: 0,
    last7Days: +trend.slice(-7).reduce((a, x) => a + (x.earning || 0), 0).toFixed(2),
    last7DaysChange: 0,
    pageViews: Math.round(impressions),
    pageViewsChange: 0,
    impressions: Math.round(impressions),
    impressionsChange: 0,
    clicks: Math.round(clicks),
    clicksChange: 0,
    ctr: impressions > 0 ? +((clicks / impressions) * 100).toFixed(4) : 0,
    revenue: +Number(revenue).toFixed(2),
    revenueChange: 0,
    ecpm: impressions > 0 ? +((revenue / impressions) * 1000).toFixed(2) : 0,
    ecpmChange: 0,
    viewability,
    viewabilityChange: 0,
    totalDomains: totalDomains || countAppAndWebsiteDomainsFromRows(tableRows),
    currency: opts.currency || 'USD',
  };

  const selectedDomains = (opts.selectedDomains || [])
    .map((d) => String(d || '').trim())
    .filter(Boolean);
  if (selectedDomains.length > 0 && selectedDomains.length < 10 && !selectedDomains.includes('__ALL__')) {
    const by = new Map(revenueShare.map((x) => [x.name.toLowerCase(), x]));
    revenueShare = selectedDomains.map((sel) => {
      const hit = by.get(sel.toLowerCase());
      return { name: hit?.name || sel, value: hit?.value || 0 };
    });
  }

  return {
    summary,
    trend,
    charts: {
      revenue: revenueShare,
      device: deviceShare,
      country: countryShare,
      performance,
    },
    rows: tableRows,
    pagination: {
      totalRows: tableRows.length,
      returnedRows: tableRows.length,
      truncated: grainCount > tableRows.length,
      allRows: false,
      compact: true,
    },
    grainCount,
    source: 'rollup',
  };
}

/**
 * Resolve inventory filter names → typed dim IDs (one query per dim table).
 * Lets Reporting filter report_grain by integer IDs with no JOINs on the hot path.
 */
async function resolveInventoryFilterIds(clientId, opts = {}) {
  const domains = (opts.domains || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
  const sites = expandSiteHostAliases(
    (opts.sites || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean)
  );
  const adUnits = (opts.adUnitNames || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
  const countries = (opts.countryNames || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);

  const [domainRows, siteRows, adUnitRows, countryRows] = await Promise.all([
    domains.length
      ? query(
        `SELECT id, LOWER(TRIM(name)) AS n FROM dim_domain
         WHERE client_id = $1::uuid AND LOWER(TRIM(name)) = ANY($2::text[])`,
        [clientId, domains]
      )
      : Promise.resolve({ rows: [] }),
    sites.length
      ? query(
        `SELECT id, LOWER(TRIM(name)) AS n FROM dim_site
         WHERE client_id = $1::uuid AND LOWER(TRIM(name)) = ANY($2::text[])`,
        [clientId, sites]
      )
      : Promise.resolve({ rows: [] }),
    adUnits.length
      ? query(
        `SELECT id, LOWER(TRIM(name)) AS n FROM dim_ad_unit
         WHERE client_id = $1::uuid AND LOWER(TRIM(name)) = ANY($2::text[])`,
        [clientId, adUnits]
      )
      : Promise.resolve({ rows: [] }),
    countries.length
      ? query(
        `SELECT id, LOWER(TRIM(name)) AS n FROM dim_country
         WHERE LOWER(TRIM(name)) = ANY($1::text[])`,
        [countries]
      )
      : Promise.resolve({ rows: [] }),
  ]);

  return {
    domainIds: domainRows.rows.map((r) => Number(r.id)).filter((n) => n > 0),
    siteIds: siteRows.rows.map((r) => Number(r.id)).filter((n) => n > 0),
    adUnitIds: adUnitRows.rows.map((r) => Number(r.id)).filter((n) => n > 0),
    countryIds: countryRows.rows.map((r) => Number(r.id)).filter((n) => n > 0),
  };
}

async function hydrateGrainIdRows(rawRows) {
  if (!rawRows?.length) return [];
  const { rootDomainFromHost } = require('../utils/adUnit');
  const domainIds = [...new Set(rawRows.map((r) => Number(r.domain_id) || 0).filter((n) => n > 0))];
  const siteIds = [...new Set(rawRows.map((r) => Number(r.site_id) || 0).filter((n) => n > 0))];
  const adUnitIds = [...new Set(rawRows.map((r) => Number(r.ad_unit_id) || 0).filter((n) => n > 0))];
  const countryIds = [...new Set(rawRows.map((r) => Number(r.country_id) || 0).filter((n) => n > 0))];
  const deviceIds = [...new Set(rawRows.map((r) => Number(r.device_id) || 0).filter((n) => n > 0))];

  const [domains, sites, adUnits, countries, devices] = await Promise.all([
    domainIds.length
      ? query(`SELECT id, name FROM dim_domain WHERE id = ANY($1::int[])`, [domainIds])
      : Promise.resolve({ rows: [] }),
    siteIds.length
      ? query(`SELECT id, name FROM dim_site WHERE id = ANY($1::int[])`, [siteIds])
      : Promise.resolve({ rows: [] }),
    adUnitIds.length
      ? query(`SELECT id, name FROM dim_ad_unit WHERE id = ANY($1::int[])`, [adUnitIds])
      : Promise.resolve({ rows: [] }),
    countryIds.length
      ? query(`SELECT id, name FROM dim_country WHERE id = ANY($1::int[])`, [countryIds])
      : Promise.resolve({ rows: [] }),
    deviceIds.length
      ? query(`SELECT id, name FROM dim_device WHERE id = ANY($1::int[])`, [deviceIds])
      : Promise.resolve({ rows: [] }),
  ]);

  const dMap = new Map(domains.rows.map((r) => [Number(r.id), r.name]));
  const sMap = new Map(sites.rows.map((r) => [Number(r.id), r.name]));
  const aMap = new Map(adUnits.rows.map((r) => [Number(r.id), r.name]));
  const cMap = new Map(countries.rows.map((r) => [Number(r.id), r.name]));
  const vMap = new Map(devices.rows.map((r) => [Number(r.id), r.name]));

  return rawRows.map((r) => {
    const siteUrl = String(sMap.get(Number(r.site_id)) || '').trim().toLowerCase();
    const adUnit = aMap.get(Number(r.ad_unit_id)) || '';
    const domainName = rootDomainFromHost(siteUrl)
      || String(dMap.get(Number(r.domain_id)) || '').trim().toLowerCase()
      || domainFromAdUnit(adUnit)
      || '';
    return mapDomainTableRow({
      report_date: r.report_date,
      domain_name: domainName,
      site_url: siteUrl,
      ad_unit: adUnit,
      app_id: r.app_id || '',
      country: cMap.get(Number(r.country_id)) || '',
      device: vMap.get(Number(r.device_id)) || '',
      impression: r.impression,
      revenue_raw: r.revenue_raw,
      viewable_raw: r.viewable_raw,
      clicks: r.clicks,
      currency: r.currency,
    });
  });
}

/**
 * Reporting-only fast path: rollups when safe; otherwise ID-filtered grain
 * aggregates (no dim JOINs on millions of rows). Target: seconds, not minutes.
 */
async function fetchReportingBundleFromDB(startDate, endDate, opts = {}) {
  const t0 = Date.now();
  const dayCount = inclusiveDayCount(startDate, endDate);
  const hasAppsOnly = (opts.apps || []).length > 0
    && !(opts.domains || []).length
    && !(opts.sites || []).length
    && !(opts.adUnitNames || []).length;

  // Long ranges: rollup KPIs + inventory Site/Domain rollups (real SITE_NAME).
  if (
    dayCount > DASHBOARD_ROLLUP_FIRST_DAYS
    && !hasAppsOnly
    && !wantsGeoTableDims(opts)
    && !opts.countryNames?.length
  ) {
    try {
      const rolled = await fetchDashboardBundleFromRollups(startDate, endDate, {
        ...opts,
        skipCharts: true,
        reportingFast: true,
        skipTable: true,
      });
      if (rolled) {
        const tableLimit = Math.max(
          reportingTableLimit(startDate, endDate, opts.tableLimit),
          inclusiveDayCount(startDate, endDate) * 50,
          8000
        );
        const tableRows = await fetchBundleDomainTableFromRollup(
          startDate,
          endDate,
          { ...opts, preferInventoryRollup: true, groupBySite: opts.groupBySite !== false },
          tableLimit
        ).catch(() => []);
        if (!tableRows.length) {
          enqueueInventoryRollupBackfill(startDate, endDate).catch(() => {});
        }
        if (tableRows.length) {
          const entityCount = await countInventoryRollupEntities(startDate, endDate, opts);
          rolled.rows = tableRows;
          rolled.pagination = {
            ...rolled.pagination,
            returnedRows: tableRows.length,
            totalRows: tableRows.length,
            truncated: entityCount > tableRows.length
              || (rolled.grainCount || 0) > tableRows.length,
          };
          rolled.summary.totalDomains = entityCount || countAppAndWebsiteDomainsFromRows(tableRows);
          logger.info(
            `Reporting rollup+inventory ${startDate}..${endDate}`
            + ` grain≈${rolled.grainCount || 0} table=${tableRows.length} in ${Date.now() - t0}ms`
          );
          return { ...rolled, source: 'reporting-rollup+inventory-core' };
        }
        rolled.rows = [];
        rolled.pagination = { ...rolled.pagination, returnedRows: 0, totalRows: 0 };
        logger.info(
          `Reporting rollup-first ${startDate}..${endDate}`
          + ` grain≈${rolled.grainCount || 0} in ${Date.now() - t0}ms`
        );
        return { ...rolled, source: 'reporting-rollup' };
      }
    } catch (e) {
      logger.warn('Reporting rollup+inventory hybrid failed:', e.message);
    }
  }

  // Short ranges: inventory_core for GAM-accurate Site/Domain.
  if (
    dayCount <= DASHBOARD_ROLLUP_FIRST_DAYS
    && !hasAppsOnly
    && !wantsGeoTableDims(opts)
    && !opts.countryNames?.length
  ) {
    try {
      const core = await fetchInventoryCoreDashboardBundle(startDate, endDate, {
        ...opts,
        skipCharts: true,
        reportingFast: true,
        groupBySite: opts.groupBySite !== false,
      });
      if (core) {
        logger.info(
          `Reporting inventory-core ${startDate}..${endDate}`
          + ` grain≈${core.grainCount || 0} in ${Date.now() - t0}ms`
        );
        return { ...core, source: 'reporting-inventory-core' };
      }
    } catch (e) {
      logger.warn('Reporting inventory-core failed:', e.message);
    }
  }

  // Long ranges: do not fall back to id-grain scan (same timeout class as inventory_core).
  if (
    dayCount > DASHBOARD_ROLLUP_FIRST_DAYS
    && !hasAppsOnly
    && !wantsGeoTableDims(opts)
    && !opts.countryNames?.length
  ) {
    return null;
  }

  const clientId = requireClientId();
  const ids = await resolveInventoryFilterIds(clientId, opts);
  // Filters were provided but nothing resolved — empty result, not a full scan.
  // Domain names can still match via ad-unit / site roots when dim_domain id is missing.
  if ((opts.sites || []).length && !ids.siteIds.length) return null;
  if ((opts.adUnitNames || []).length && !ids.adUnitIds.length) return null;
  if ((opts.countryNames || []).length && !ids.countryIds.length) return null;

  const tableLimit = reportingTableLimit(startDate, endDate, opts.tableLimit);
  const perDay = Math.max(6, Math.min(40, Math.ceil(tableLimit / dayCount)));

  const byCountry = Boolean(opts.groupByCountry || ids.countryIds.length);
  const byDevice = Boolean(opts.groupByDevice);
  const byAdUnit = Boolean(ids.adUnitIds.length || (opts.adUnitNames || []).length);
  const byApp = hasAppsOnly;

  const params = [clientId, startDate, endDate];
  let whereCore = `g.client_id = $1::uuid AND g.slice_key = '${byApp ? 'app_id' : 'inventory_core'}'`;

  if ((opts.domains || []).length) {
    const domainNames = (opts.domains || [])
      .map((s) => String(s || '').trim().toLowerCase())
      .filter(Boolean);
    params.push(domainNames);
    const domIdx = params.length;
    const idClause = ids.domainIds.length
      ? (() => {
        params.push(ids.domainIds);
        return `g.domain_id = ANY($${params.length}::int[]) OR `;
      })()
      : '';
    // Also match ad-unit / site roots so mis-tagged domain_id rows still filter correctly.
    whereCore += ` AND (
      ${idClause}
      EXISTS (
        SELECT 1 FROM dim_ad_unit da
        WHERE da.id = g.ad_unit_id AND da.client_id = g.client_id
          AND LOWER(SPLIT_PART(REGEXP_REPLACE(COALESCE(da.name, ''), '\\s*\\(\\d+\\)\\s*$', ''), '_', 1))
              = ANY($${domIdx}::text[])
      )
      OR EXISTS (
        SELECT 1 FROM dim_site ds
        WHERE ds.id = g.site_id AND ds.client_id = g.client_id
          AND NULLIF(LOWER(SUBSTRING(TRIM(COALESCE(ds.name, '')) FROM '[^.]+\\.[^.]+$')), '')
              = ANY($${domIdx}::text[])
      )
    )`;
  }
  if (ids.siteIds.length) {
    params.push(ids.siteIds);
    whereCore += ` AND g.site_id = ANY($${params.length}::int[])`;
  }
  if (ids.adUnitIds.length) {
    params.push(ids.adUnitIds);
    whereCore += ` AND g.ad_unit_id = ANY($${params.length}::int[])`;
  }
  if (ids.countryIds.length) {
    params.push(ids.countryIds);
    whereCore += ` AND g.country_id = ANY($${params.length}::int[])`;
  }
  if ((opts.apps || []).length) {
    const apps = (opts.apps || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
    params.push(apps);
    whereCore += ` AND (LOWER(COALESCE(g.app_id, '')) = ANY($${params.length}::text[])
      OR LOWER(COALESCE(g.app_name, '')) = ANY($${params.length}::text[]))`;
  }
  const whereRange = `${whereCore} AND g.report_date BETWEEN $2::date AND $3::date`;
  const whereDay = `${whereCore} AND g.report_date = d.day::date`;

  const groupCols = ['g.report_date'];
  const selectIds = [`g.report_date`];
  if (byApp) {
    groupCols.push(`COALESCE(NULLIF(TRIM(g.app_id), ''), NULLIF(TRIM(g.app_name), ''), '')`);
    selectIds.push(`COALESCE(NULLIF(TRIM(g.app_id), ''), NULLIF(TRIM(g.app_name), ''), '') AS app_id`);
    selectIds.push(`0 AS domain_id`, `0 AS site_id`, `0 AS ad_unit_id`);
  } else {
    groupCols.push('g.domain_id', 'g.site_id');
    selectIds.push('g.domain_id', 'g.site_id');
    if (byAdUnit) {
      groupCols.push('g.ad_unit_id');
      selectIds.push('g.ad_unit_id');
    } else {
      selectIds.push('0 AS ad_unit_id');
    }
    selectIds.push(`'' AS app_id`);
  }
  if (byCountry) {
    groupCols.push('g.country_id');
    selectIds.push('g.country_id');
  } else {
    selectIds.push('0 AS country_id');
  }
  if (byDevice) {
    groupCols.push('g.device_id');
    selectIds.push('g.device_id');
  } else {
    selectIds.push('0 AS device_id');
  }

  const tableParams = [...params, perDay, tableLimit];
  const perDayIdx = tableParams.length - 1;
  const limitIdx = tableParams.length;

  const [totalsRes, trendRes, entityRes, tableRes] = await Promise.all([
    query(
      `SELECT
         COALESCE(SUM(g.impressions), 0)::float8 AS impressions,
         COALESCE(SUM(g.revenue), 0)::float8 AS revenue,
         COALESCE(SUM(COALESCE(g.impressions, 0) * COALESCE(g.viewable_pct, 0)), 0)::float8 AS viewable_weight,
         COALESCE(SUM(g.clicks), 0)::float8 AS clicks,
         COUNT(*)::int AS row_count
       FROM report_grain g
       WHERE ${whereRange}`,
      params
    ),
    query(
      `SELECT
         to_char(g.report_date, 'YYYY-MM-DD') AS date,
         COALESCE(SUM(g.revenue), 0)::float8 AS earning,
         COALESCE(SUM(g.impressions), 0)::float8 AS impressions
       FROM report_grain g
       WHERE ${whereRange}
       GROUP BY g.report_date
       ORDER BY g.report_date`,
      params
    ),
    query(
      `SELECT COUNT(*)::int AS n FROM (
         SELECT DISTINCT g.domain_id::text AS k
         FROM report_grain g
         WHERE ${whereRange}
           AND g.domain_id IS NOT NULL AND g.domain_id <> 0
         UNION
         SELECT DISTINCT LOWER(TRIM(COALESCE(NULLIF(g.app_id, ''), NULLIF(g.app_name, ''), ''))) AS k
         FROM report_grain g
         WHERE ${whereRange}
           AND NULLIF(TRIM(COALESCE(NULLIF(g.app_id, ''), NULLIF(g.app_name, ''), '')), '') IS NOT NULL
       ) entities`,
      params
    ),
    query(
      `SELECT
         to_char(day_rows.report_date, 'YYYY-MM-DD') AS report_date,
         day_rows.domain_id, day_rows.site_id, day_rows.ad_unit_id,
         day_rows.country_id, day_rows.device_id, day_rows.app_id,
         day_rows.impression, day_rows.revenue_raw, day_rows.viewable_raw,
         day_rows.clicks, day_rows.currency
       FROM generate_series($2::date, $3::date, '1 day'::interval) AS d(day)
       CROSS JOIN LATERAL (
         SELECT
           ranked.*,
           ROW_NUMBER() OVER (
             ORDER BY ranked.revenue_raw DESC, ranked.impression DESC
           ) AS day_rank
         FROM (
           SELECT
             ${selectIds.join(',\n             ')},
             COALESCE(SUM(g.impressions), 0)::float8 AS impression,
             COALESCE(SUM(g.revenue), 0)::float8 AS revenue_raw,
             CASE WHEN COALESCE(SUM(g.impressions), 0) > 0
               THEN COALESCE(SUM(COALESCE(g.impressions, 0) * COALESCE(g.viewable_pct, 0)), 0)
                    / COALESCE(SUM(g.impressions), 0)
               ELSE 0
             END AS viewable_raw,
             COALESCE(SUM(g.clicks), 0)::float8 AS clicks,
             COALESCE(MAX(g.currency), 'USD') AS currency
           FROM report_grain g
           WHERE ${whereDay}
           GROUP BY ${groupCols.join(', ')}
           HAVING COALESCE(SUM(g.impressions), 0) > 0 OR COALESCE(SUM(g.revenue), 0) > 0
           ORDER BY COALESCE(SUM(g.revenue), 0) DESC, COALESCE(SUM(g.impressions), 0) DESC
           LIMIT $${perDayIdx}
         ) ranked
       ) AS day_rows
       ORDER BY day_rows.day_rank ASC, day_rows.report_date DESC, day_rows.revenue_raw DESC
       LIMIT $${limitIdx}`,
      tableParams
    ),
  ]);

  const t = totalsRes.rows[0] || {};
  const impressions = Number(t.impressions) || 0;
  const revenue = coerceWarehouseRevenue(t.revenue, impressions);
  const viewableWeight = Number(t.viewable_weight) || 0;
  const clicks = Number(t.clicks) || 0;
  const grainCount = Number(t.row_count) || 0;
  const totalDomains = Number(entityRes.rows?.[0]?.n) || 0;
  const tableRows = await hydrateGrainIdRows(tableRes.rows || []);
  if (!grainCount && !tableRows.length) return null;

  const trend = (trendRes.rows || []).map((r) => {
    const imps = Math.round(Number(r.impressions) || 0);
    return {
      date: r.date,
      earning: coerceWarehouseRevenue(r.earning, imps),
      impressions: imps,
    };
  });
  const viewability = impressions > 0 ? +(viewableWeight / impressions).toFixed(1) : 0;

  logger.info(
    `Reporting id-grain-fast ${startDate}..${endDate}`
    + ` grain≈${grainCount} table=${tableRows.length} in ${Date.now() - t0}ms`
  );

  return {
    summary: {
      totalEarning: +Number(revenue).toFixed(2),
      totalEarningChange: 0,
      selectRange: +Number(revenue).toFixed(2),
      selectRangeChange: 0,
      last7Days: +trend.slice(-7).reduce((a, x) => a + (x.earning || 0), 0).toFixed(2),
      last7DaysChange: 0,
      pageViews: Math.round(impressions),
      pageViewsChange: 0,
      impressions: Math.round(impressions),
      impressionsChange: 0,
      clicks: Math.round(clicks),
      clicksChange: 0,
      ctr: impressions > 0 ? +((clicks / impressions) * 100).toFixed(4) : 0,
      revenue: +Number(revenue).toFixed(2),
      revenueChange: 0,
      ecpm: impressions > 0 ? +((revenue / impressions) * 1000).toFixed(2) : 0,
      ecpmChange: 0,
      viewability,
      viewabilityChange: 0,
      totalDomains: totalDomains || countAppAndWebsiteDomainsFromRows(tableRows),
      currency: opts.currency || 'USD',
    },
    trend,
    charts: { revenue: [], device: [], country: [], performance: [] },
    rows: tableRows,
    pagination: {
      totalRows: tableRows.length,
      returnedRows: tableRows.length,
      truncated: grainCount > tableRows.length,
      allRows: false,
      compact: true,
    },
    grainCount: grainCount || tableRows.length,
    source: 'reporting-id-grain',
  };
}

/**
 * Dashboard miss path without shipping hundreds of thousands of grain rows:
 * SQL aggregates for KPIs/charts + a capped collapsed table payload.
 * Prefer rollups; fall back to lean grain JSONB aggregates.
 * Returns null when lean tables have no metric rows for the range.
 */
async function fetchLeanDashboardBundleFromDB(startDate, endDate, opts = {}) {
  const hasWeb = (opts.domains?.length || 0)
    || (opts.sites?.length || 0)
    || (opts.adUnitNames?.length || 0);
  const hasApp = (opts.apps?.length || 0) > 0;
  const siteKind = classifySiteHostSelection(opts.sites);
  const wantsGeo = wantsGeoTableDims(opts);
  const dayCount = inclusiveDayCount(startDate, endDate);

  // App-only filter: channel rollups have no inv_app — use app_id grain slice.
  if (hasApp && !hasWeb) {
    const appBundle = await fetchAppSliceDashboardBundle(startDate, endDate, opts);
    if (appBundle) return appBundle;
  }

  // Long ranges: rollup KPIs/trend (fast) + inventory rollups for real SITE_NAME table.
  // Channel rollups invent d1.* slot hosts — never use them for Inventory Breakdown Site/Domain.
  const requestSiteOnly = siteKind === 'request' && (opts.sites || []).length && !hasApp;
  if (!wantsGeo && dayCount > DASHBOARD_ROLLUP_FIRST_DAYS && !requestSiteOnly && !hasApp) {
    try {
      const rolled = await fetchDashboardBundleFromRollups(startDate, endDate, {
        ...opts,
        skipCharts: true,
        reportingFast: true,
        // Avoid double-fetching wrong channel table — hybrid fills inventory rows next.
        skipTable: true,
      });
      if (rolled) {
        const tableLimit = Math.max(
          reportingTableLimit(startDate, endDate, opts.tableLimit),
          inclusiveDayCount(startDate, endDate) * 50,
          8000
        );
        let tableRows = await fetchBundleDomainTableFromRollup(
          startDate, endDate, { ...opts, preferInventoryRollup: true }, tableLimit
        ).catch(() => []);
        if (!tableRows.length) {
          // Inventory rollups not ready — enqueue backfill; avoid multi-minute grain scans.
          enqueueInventoryRollupBackfill(startDate, endDate).catch(() => {});
        }
        if (tableRows.length) {
          const entityCount = await countInventoryRollupEntities(startDate, endDate, opts);
          rolled.rows = tableRows;
          rolled.pagination = {
            ...rolled.pagination,
            returnedRows: tableRows.length,
            totalRows: tableRows.length,
            truncated: entityCount > tableRows.length
              || (rolled.grainCount || 0) > tableRows.length,
          };
          rolled.summary.totalDomains = entityCount || countAppAndWebsiteDomainsFromRows(tableRows);
          rolled.source = 'rollup+inventory-core-table';
          return rolled;
        }
        rolled.rows = [];
        rolled.pagination = { ...rolled.pagination, returnedRows: 0, totalRows: 0 };
        rolled.source = 'rollup';
        return rolled;
      }
    } catch (e) {
      logger.warn(`Dashboard rollup+inventory hybrid (${dayCount}d) failed:`, e.message);
    }
  }

  // Site filter (request hosts): inventory_core path. Apply country/ad-unit in the same query.
  // Do not early-return when apps are also set — caller uses compat-union for web|app.
  if ((opts.sites || []).length && !hasApp) {
    const siteBundle = await fetchInventorySiteDashboardBundle(startDate, endDate, opts);
    if (siteKind === 'request') {
      if (siteBundle) return siteBundle;
    } else {
      // Slot-host filters: merge inventory_core with rollup for hosts only in channel.
      const rolled = await fetchDashboardBundleFromRollups(startDate, endDate, opts).catch((e) => {
        logger.warn('Dashboard rollup (site filter) failed:', e.message);
        return null;
      });
      const merged = mergeSiteFilterBundles(rolled, siteBundle, opts.sites);
      if (merged) return merged;
      if (siteBundle) return siteBundle;
    }
  }

  // Request-style site filters must not fall back to channel rollups (totals ≠ grain-site table).
  if (requestSiteOnly) {
    return null;
  }

  // Short ranges: inventory_core for GAM-accurate Site/Domain (≤14d default).
  if (!hasApp && !wantsGeo && !(opts.sites || []).length && dayCount <= DASHBOARD_ROLLUP_FIRST_DAYS) {
    const useInventoryCore = (opts.domains || []).length > 0
      || opts.groupBySite
      || opts.tableGrain === 'site'
      || resolveTableRollupGroup(opts) === 'site';
    if (useInventoryCore) {
      const core = await fetchInventoryCoreDashboardBundle(startDate, endDate, opts).catch((e) => {
        logger.warn('Dashboard inventory_core bundle failed:', e.message);
        return null;
      });
      if (core) return core;
    }
  }

  if (siteKind !== 'request') {
    try {
      const rolled = await fetchDashboardBundleFromRollups(startDate, endDate, opts);
      if (rolled) return rolled;
    } catch (e) {
      logger.warn('Dashboard rollup bundle failed, falling back to grain:', e.message);
    }
  }

  // Long ranges: never full-scan report_grain (multi-minute timeouts). Rollups already tried.
  if (dayCount > DASHBOARD_ROLLUP_FIRST_DAYS && !requestSiteOnly) {
    return null;
  }

  const { typedGrainMetricSql, GRAIN_JOIN_SQL, kpiSliceFilterSql } = require('./reportGrainStore');
  const tableLimit = Math.min(Math.max(parseInt(opts.tableLimit, 10) || 2500, 50), 5000);
  const m = typedGrainMetricSql('g');

  const params = [startDate, endDate, requireClientId()];
  let extra = ` AND g.report_date BETWEEN $1::date AND $2::date AND g.client_id = $3::uuid AND ${kpiSliceFilterSql('g')}`;
  extra = appendLeanInventoryFilters(params, extra, opts);
  const branches = [{ sql: `${GRAIN_JOIN_SQL} WHERE TRUE${extra}`, params }];
  if (!branches.length) return null;

  // Prefer one query per table then merge — avoids fragile param remapping.
  const runAgg = async (selectSql, orderLimit = '') => {
    const merged = [];
    for (const b of branches) {
      const { rows } = await query(
        `${selectSql} ${b.sql} ${orderLimit}`.replace(/\s+/g, ' ').trim(),
        b.params
      );
      merged.push(...rows);
    }
    return merged;
  };

  const totalsRows = await runAgg(`
    SELECT
      COALESCE(SUM(${m.impressionExpr}), 0)::float8 AS impressions,
      COALESCE(SUM(${m.revenueExpr}), 0)::float8 AS revenue,
      COALESCE(SUM((${m.impressionExpr}) * (${m.viewablePctExpr})), 0)::float8 AS viewable_weight,
      COALESCE(SUM(${m.clickExpr}), 0)::float8 AS clicks,
      COUNT(*)::int AS row_count
  `);
  let impressions = 0;
  let revenue = 0;
  let viewableWeight = 0;
  let clicks = 0;
  let grainCount = 0;
  for (const t of totalsRows) {
    impressions += Number(t.impressions) || 0;
    revenue += Number(t.revenue) || 0;
    viewableWeight += Number(t.viewable_weight) || 0;
    clicks += Number(t.clicks) || 0;
    grainCount += Number(t.row_count) || 0;
  }
  if (!grainCount || (impressions <= 0 && revenue <= 0)) return null;

  const trendRaw = await runAgg(`
    SELECT
      to_char(g.report_date, 'YYYY-MM-DD') AS date,
      COALESCE(SUM(${m.revenueExpr}), 0)::float8 AS earning,
      COALESCE(SUM(${m.impressionExpr}), 0)::float8 AS impressions
    `, 'GROUP BY g.report_date');
  const trendMap = new Map();
  for (const r of trendRaw) {
    const date = r.date;
    const prev = trendMap.get(date) || { date, earning: 0, impressions: 0 };
    prev.earning += Number(r.earning) || 0;
    prev.impressions += Number(r.impressions) || 0;
    trendMap.set(date, prev);
  }
  const trend = Array.from(trendMap.values())
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map((t) => ({
      date: t.date,
      earning: +Number(t.earning).toFixed(2),
      impressions: Math.round(t.impressions),
    }));

  const mergeNamed = (rows, nameKey = 'name') => {
    const map = new Map();
    for (const r of rows) {
      const name = String(r[nameKey] || r.name || '').trim();
      if (!name) continue;
      const value = Number(r.value) || 0;
      if (value <= 0) continue;
      map.set(name, (map.get(name) || 0) + value);
    }
    return Array.from(map.entries())
      .map(([name, value]) => ({ name, value: +Number(value).toFixed(2) }))
      .sort((a, b) => b.value - a.value);
  };

  const domainRaw = await runAgg(`
    SELECT
      NULLIF(TRIM(${m.domainExpr}), '') AS name,
      COALESCE(SUM(${m.revenueExpr}), 0)::float8 AS value
    `, `GROUP BY 1 HAVING NULLIF(TRIM(${m.domainExpr}), '') IS NOT NULL`);
  let revenueShare = mergeNamed(domainRaw).slice(0, 10);

  const deviceRaw = await runAgg(`
    SELECT
      NULLIF(TRIM(${m.deviceExpr}), '') AS name,
      COALESCE(SUM(${m.revenueExpr}), 0)::float8 AS value
    `, `GROUP BY 1 HAVING NULLIF(TRIM(${m.deviceExpr}), '') IS NOT NULL`);
  const deviceMap = new Map();
  for (const r of deviceRaw) {
    const bucket = friendlyDeviceBucket(r.name);
    if (!bucket) continue;
    const value = Number(r.value) || 0;
    if (value <= 0) continue;
    deviceMap.set(bucket, (deviceMap.get(bucket) || 0) + value);
  }
  const deviceShare = Array.from(deviceMap.entries())
    .map(([name, value]) => ({ name, value: +Number(value).toFixed(2) }))
    .sort((a, b) => b.value - a.value);

  const countryRaw = await runAgg(`
    SELECT
      NULLIF(TRIM(${m.countryExpr}), '') AS name,
      COALESCE(SUM(${m.revenueExpr}), 0)::float8 AS value
    `, `GROUP BY 1 HAVING NULLIF(TRIM(${m.countryExpr}), '') IS NOT NULL`);
  const countryShare = mergeNamed(countryRaw).slice(0, 10);

  const perfRaw = await runAgg(`
    SELECT
      NULLIF(TRIM(${m.adUnitExpr}), '') AS name,
      COALESCE(SUM(${m.revenueExpr}), 0)::float8 AS revenue,
      COALESCE(SUM(${m.impressionExpr}), 0)::float8 AS impressions
    `, `GROUP BY 1 HAVING NULLIF(TRIM(${m.adUnitExpr}), '') IS NOT NULL`);
  const perfMap = new Map();
  for (const r of perfRaw) {
    const name = String(r.name || '').trim();
    if (!name) continue;
    const prev = perfMap.get(name) || { name, revenue: 0, impressions: 0 };
    prev.revenue += Number(r.revenue) || 0;
    prev.impressions += Number(r.impressions) || 0;
    perfMap.set(name, prev);
  }
  const performance = Array.from(perfMap.values())
    .map((e) => ({
      ...e,
      revenue: +Number(e.revenue).toFixed(2),
      impressions: Math.round(e.impressions),
      ecpm: e.impressions > 0 ? +((e.revenue / e.impressions) * 1000).toFixed(2) : 0,
      ctr: 0,
      viewability: 0,
      score: e.revenue,
    }))
    .filter((e) => e.revenue > 0 || e.impressions > 0)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 6);

  const tableRows = await fetchBundleTableRows(startDate, endDate, opts, tableLimit);

  const viewability = impressions > 0 ? +(viewableWeight / impressions).toFixed(1) : 0;
  const summary = {
    totalEarning: +Number(revenue).toFixed(2),
    totalEarningChange: 0,
    selectRange: +Number(revenue).toFixed(2),
    selectRangeChange: 0,
    last7Days: +trend.slice(-7).reduce((a, t) => a + (t.earning || 0), 0).toFixed(2),
    last7DaysChange: 0,
    pageViews: Math.round(impressions),
    pageViewsChange: 0,
    impressions: Math.round(impressions),
    impressionsChange: 0,
    clicks: Math.round(clicks),
    clicksChange: 0,
    ctr: impressions > 0 ? +((clicks / impressions) * 100).toFixed(4) : 0,
    revenue: +Number(revenue).toFixed(2),
    revenueChange: 0,
    ecpm: impressions > 0 ? +((revenue / impressions) * 1000).toFixed(2) : 0,
    ecpmChange: 0,
    viewability,
    viewabilityChange: 0,
    currency: opts.currency || 'USD',
  };

  // If caller asked to restrict domain share to a selection of names:
  const selectedDomains = (opts.selectedDomains || [])
    .map((d) => String(d || '').trim())
    .filter(Boolean);
  if (selectedDomains.length > 0 && selectedDomains.length < 10 && !selectedDomains.includes('__ALL__')) {
    const by = new Map(revenueShare.map((x) => [x.name.toLowerCase(), x]));
    revenueShare = selectedDomains.map((sel) => {
      const hit = by.get(sel.toLowerCase());
      return { name: hit?.name || sel, value: hit?.value || 0 };
    });
  }

  return {
    summary,
    trend,
    charts: {
      revenue: revenueShare,
      device: deviceShare,
      country: countryShare,
      performance,
    },
    rows: tableRows,
    pagination: {
      totalRows: tableRows.length,
      returnedRows: tableRows.length,
      truncated: grainCount > tableRows.length,
      allRows: false,
      compact: true,
    },
    grainCount,
    source: 'grain',
  };
}

function shiftDate(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function normalizeGAMRows(rawRows, currency = 'USD', sliceKey = '') {
  return rawRows.map((row) => {
    const dimensions = {};
    const metrics = {};
    for (const [k, v] of Object.entries(row)) {
      if (k === '__slice_key') continue;
      if (k.startsWith('Dimension.')) {
        dimensions[k.replace('Dimension.', '')] = v;
      } else if (k.startsWith('Column.')) {
        const api = k.replace('Column.', '');
        metrics[api] = parseGamMetricValue(api, v);
      }
    }
    const report_date = dimensions.DATE || dimensions.date || todayInTZ();
    if (dimensions.COUNTRY_NAME) {
      dimensions.country_name = dimensions.COUNTRY_NAME;
      dimensions.country = dimensions.COUNTRY_NAME;
    }
    if (dimensions.DEVICE_CATEGORY_NAME) {
      dimensions.device_category_name = dimensions.DEVICE_CATEGORY_NAME;
      dimensions.device = dimensions.DEVICE_CATEGORY_NAME;
    }
    if (dimensions.MOBILE_APP_NAME) {
      dimensions.mobile_app_name = dimensions.MOBILE_APP_NAME;
      dimensions.appName = dimensions.MOBILE_APP_NAME;
    }
    if (dimensions.MOBILE_APP_RESOLVED_ID) {
      dimensions.mobile_app_resolved_id = dimensions.MOBILE_APP_RESOLVED_ID;
      dimensions.appId = dimensions.MOBILE_APP_RESOLVED_ID;
    }
    // Always attach inventory filter fields (domain / site URL / ad unit / app).
    const { dimensions: enriched } = attachInventoryDimensions(dimensions);
    const sk = sliceKey || row.__slice_key || '';
    return { report_date, dimensions: enriched, metrics, currency, slice_key: sk };
  });
}

/**
 * Lean warehouse sync: pull compatible dim slices (always keep country + device +
 * app/site/domain where GAM allows). Shrink metrics before dropping rich dims.
 */
function buildSyncReportXML(dimensions, metrics, buildDateXML, startDate, endDate) {
  const dimXML = dimensions.map((d) => `<dimensions>${d}</dimensions>`).join('\n    ');
  const cols = (metrics && metrics.length) ? metrics : UNIFIED_GRAIN_METRICS;
  const colXML = cols.map((c) => `<columns>${c}</columns>`).join('\n    ');
  return `
    ${dimXML}
    ${colXML}
    ${buildDateXML(startDate, endDate)}
    <dateRangeType>CUSTOM_DATE</dateRangeType>`;
}

function metricAttemptKey(metrics) {
  return (metrics || []).join(',');
}

/**
 * Try one dim slice with metric fallbacks. Returns { count } when streaming,
 * or a row array when not. Null when every attempt fails / returns empty.
 */
async function pullLeanSlice(dims, label, token, buildDateXML, startDate, endDate, onBatch) {
  const { runReportAndDownload } = require('../gam/reportTransport');
  const stream = typeof onBatch === 'function';
  const seen = new Set();
  let lastErr;
  for (const metrics of LEAN_SYNC_METRIC_ATTEMPTS) {
    const key = metricAttemptKey(metrics);
    if (!metrics.length || seen.has(key)) continue;
    seen.add(key);
    try {
      const xml = buildSyncReportXML(dims, metrics, buildDateXML, startDate, endDate);
      const raw = await runReportAndDownload(xml, token, stream ? { onBatch } : {});
      if (stream) {
        const count = Number(raw?.count) || 0;
        if (count > 0) {
          logger.info(
            `GAM lean slice ${label} OK dims=[${dims.join(', ')}] metrics=${metrics.length}`
            + ` rows=${count} range=${startDate}..${endDate} (streamed)`
          );
          return { streamed: true, count, dims, metrics };
        }
        logger.warn(`GAM lean slice ${label} returned 0 rows (metrics=${metrics.length})`);
        continue;
      }
      if (Array.isArray(raw) && raw.length) {
        logger.info(
          `GAM lean slice ${label} OK dims=[${dims.join(', ')}] metrics=${metrics.length}`
          + ` rows=${raw.length} range=${startDate}..${endDate}`
        );
        return raw;
      }
      logger.warn(`GAM lean slice ${label} returned 0 rows (metrics=${metrics.length})`);
    } catch (err) {
      lastErr = err;
      logger.warn(
        `GAM lean slice ${label} failed dims=[${dims.join(', ')}] metrics=${metrics.length}: ${err.message}`
      );
    }
  }
  if (lastErr) {
    logger.warn(`GAM lean slice ${label} exhausted metric fallbacks: ${lastErr.message}`);
  }
  return null;
}

/**
 * Fetch lean warehouse rows for a date range.
 * Runs each LEAN_SYNC_DIM_SLICES pull (country + device always retained).
 * When onBatch is provided, streams each successful slice into the callback.
 * Non-stream mode concatenates rows (for small range-fetch callers).
 */
async function fetchFromGAM(startDate, endDate, onBatch) {
  const { getToken, buildDateXML } = require('../gam/reportTransport');
  const token = await getToken();
  const stream = typeof onBatch === 'function';
  let okSlices = 0;
  let totalRows = 0;
  const collected = [];
  let lastErr;

  for (const slice of LEAN_SYNC_DIM_SLICES) {
    try {
      const sliceOnBatch = stream && onBatch
        ? async (rawChunk) => onBatch(rawChunk, slice.key)
        : onBatch;
      const got = await pullLeanSlice(
        slice.dims,
        slice.key,
        token,
        buildDateXML,
        startDate,
        endDate,
        sliceOnBatch
      );
      if (!got) continue;
      okSlices += 1;
      if (stream) {
        totalRows += Number(got.count) || 0;
      } else if (Array.isArray(got)) {
        for (let i = 0; i < got.length; i++) {
          collected.push({ __slice_key: slice.key, ...got[i] });
        }
        totalRows += got.length;
      }
    } catch (err) {
      lastErr = err;
      logger.warn(`GAM lean slice ${slice.key} error: ${err.message}`);
    }
  }

  if (!okSlices) {
    throw lastErr || new Error(
      'GAM lean sync failed for all rich dimension slices (country/device/app).'
    );
  }

  logger.info(
    `GAM lean sync ${startDate}..${endDate}: ${okSlices}/${LEAN_SYNC_DIM_SLICES.length}`
    + ` slices ok, rows≈${totalRows}${stream ? ' (streamed)' : ''}`
  );

  if (stream) return { streamed: true, count: totalRows };
  return collected;
}

function listSyncWindows(startDate, endDate, opts = {}) {
  const maxDays = Math.max(1, parseInt(process.env.GAM_SYNC_MAX_DAYS || '7', 10) || 7);
  if (opts.oldestFirst) {
    return listDateWindowsOldestFirst(startDate, endDate, maxDays);
  }
  return listDateWindowsNewestFirst(startDate, endDate, maxDays);
}

/**
 * Stream GAM CSV → upsert in batches. Never holds a month of grain rows in heap.
 */
async function streamSyncFromGAM(startDate, endDate, syncType = 'sync-backfill') {
  const currency = process.env.GAM_CURRENCY || 'USD';
  const syncStartedAt = new Date();
  let total = 0;
  let grainCount = 0;
  const touchedDates = new Set();

  const result = await fetchFromGAM(startDate, endDate, async (rawChunk, sliceKey) => {
    if (!rawChunk?.length) return;
    const normalized = normalizeGAMRows(rawChunk, currency, sliceKey);
    const n = await insertRowsInto('report_grain', normalized, `${syncType}:${startDate}`);
    grainCount += n;
    total += normalized.length;
    for (const row of normalized) {
      const day = toYmd(row.report_date);
      if (day) touchedDates.add(day);
    }
  });

  const count = Number(result?.count) || total;
  const dates = [...touchedDates];
  if (dates.length) {
    try {
      await deleteStaleGrain(dates, syncStartedAt);
    } catch (e) {
      logger.warn(`[${syncType}] stale grain cleanup skipped:`, e.message);
    }
    try {
      await deleteThinGrainRows(dates);
    } catch (e) {
      logger.warn(`[${syncType}] thin-row cleanup skipped:`, e.message);
    }
    try {
      await rebuildRollupsForDates(dates, syncType);
    } catch (e) {
      logger.warn(`[${syncType}] rollup rebuild skipped:`, e.message);
    }
  }
  await invalidateCacheForDate(endDate);
  logger.info(
    `[${syncType}] ${startDate}..${endDate} streamed rows≈${count} → report_grain=${grainCount}`
  );
  return grainCount;
}

const RICH_DIM_SQL = `(
  (dimensions ? 'COUNTRY_NAME' OR dimensions ? 'country_name' OR dimensions ? 'country')
  AND
  (dimensions ? 'DEVICE_CATEGORY_NAME' OR dimensions ? 'device_category_name' OR dimensions ? 'device')
)`;

async function tableHasCountryAndDevice(table) {
  if (table !== 'report_daily' && table !== 'report_present') {
    throw new Error(`Unsupported report table: ${table}`);
  }
  try {
    const { rows } = await query(
      `SELECT 1 AS ok
       FROM ${table}
       WHERE ${RICH_DIM_SQL}
       LIMIT 1`
    );
    return rows.length > 0;
  } catch (e) {
    logger.warn(`${table} country/device check failed:`, e.message);
    return false;
  }
}

/** True when historical rows already carry country + device dimensions. */
async function dailyHasCountryAndDevice() {
  const { rows } = await query(
    `SELECT 1 AS ok FROM report_grain g
     WHERE g.country_id <> 0 AND g.device_id <> 0 LIMIT 1`
  );
  return rows.length > 0;
}

async function presentHasCountryAndDevice() {
  const today = todayInTZ();
  return grainHasRichDimsForDate(today);
}

/** Days with no KPI-ready grain rows (warehouse gap). */
async function listMissingGrainDates(startDate, endDate) {
  const clientId = requireClientId();
  const { kpiSliceFilterSql } = require('./reportGrainStore');
  const { rows } = await query(
    `WITH days AS (
       SELECT d::date AS d
       FROM generate_series($2::date, $3::date, '1 day'::interval) AS d
     )
     SELECT to_char(days.d, 'YYYY-MM-DD') AS report_date
     FROM days
     LEFT JOIN LATERAL (
       SELECT COALESCE(SUM(g.impressions), 0)::bigint AS imps
       FROM report_grain g
       WHERE g.client_id = $1::uuid AND g.report_date = days.d
         AND ${kpiSliceFilterSql('g')}
     ) k ON true
     WHERE COALESCE(k.imps, 0) <= 0
     ORDER BY 1`,
    [clientId, startDate, endDate]
  );
  return rows.map((r) => r.report_date);
}

/** Pull GAM for each day missing canonical KPI grain in range (oldest first). */
async function fillMissingGrainDates(startDate, endDate, syncType = 'fill-gaps') {
  const missing = await listMissingGrainDates(startDate, endDate);
  if (!missing.length) {
    logger.info(`[${syncType}] No missing grain days in ${startDate}..${endDate}`);
    return 0;
  }
  logger.info(
    `[${syncType}] Filling ${missing.length} missing day(s) in ${startDate}..${endDate}`
    + ` (${missing[0]} → ${missing[missing.length - 1]})`
  );

  // Batch consecutive missing days into windows (oldest first) — faster than 1 GAM report/day.
  const maxDays = Math.max(1, parseInt(process.env.GAM_SYNC_MAX_DAYS || '7', 10) || 7);
  const windows = [];
  let runStart = missing[0];
  let runEnd = missing[0];
  for (let i = 1; i < missing.length; i += 1) {
    const prev = missing[i - 1];
    const cur = missing[i];
    const nextOfPrev = shiftDate(prev, 1);
    const span = daysBetweenYmd(runStart, cur) + 1;
    if (cur === nextOfPrev && span <= maxDays) {
      runEnd = cur;
    } else {
      windows.push({ startDate: runStart, endDate: runEnd });
      runStart = cur;
      runEnd = cur;
    }
  }
  windows.push({ startDate: runStart, endDate: runEnd });

  let total = 0;
  for (const win of windows) {
    try {
      total += await streamSyncFromGAM(win.startDate, win.endDate, syncType);
    } catch (e) {
      logger.warn(
        `[${syncType}] Window ${win.startDate}..${win.endDate} failed, falling back day-by-day: ${e.message}`
      );
      let cursor = win.startDate;
      while (cursor <= win.endDate) {
        try {
          total += await streamSyncFromGAM(cursor, cursor, syncType);
        } catch (dayErr) {
          logger.warn(`[${syncType}] Failed to sync ${cursor}:`, dayErr.message);
        }
        cursor = shiftDate(cursor, 1);
      }
    }
  }
  return total;
}

function daysBetweenYmd(a, b) {
  const ms = new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`);
  return Math.round(ms / 86400000);
}

async function listDatesMissingRichDims(startDate, endDate) {
  const cutoff = archiveService.getArchiveCutoff();
  const clientId = requireClientId();
  let missing = [];

  const hotStart = startDate >= cutoff ? startDate : cutoff;
  const hotEnd = endDate;
  if (hotStart <= hotEnd) {
    try {
      missing = missing.concat(await listGrainDatesMissingRichDims(hotStart, hotEnd));
    } catch (e) {
      logger.warn('listGrainDatesMissingRichDims failed:', e.message);
    }
  }

  const coldEnd = endDate < cutoff ? endDate : archiveService.splitDateRange(startDate, endDate).coldEnd;
  if (startDate < cutoff && coldEnd && startDate <= coldEnd && archiveService.isArchiveEnabled()) {
    let cursor = startDate;
    while (cursor <= coldEnd) {
      const archived = await archiveService.isDayFullyArchived(clientId, cursor);
      if (!archived) missing.push(cursor);
      cursor = shiftDate(cursor, 1);
    }
  }

  return [...new Set(missing)].sort();
}

async function hasCompleteDbCoverage(startDate, endDate) {
  if (!startDate || !endDate || startDate > endDate) return false;
  const missing = await listDatesMissingRichDims(startDate, endDate);
  return missing.length === 0;
}

/**
 * Day coverage for a range — used so the UI can show August while July still builds.
 */
async function getRangeCoverage(startDate, endDate) {
  if (!startDate || !endDate || startDate > endDate) {
    return { totalDays: 0, coveredDays: 0, missingDays: 0, complete: false };
  }
  const today = todayInTZ();
  let cursor = startDate;
  let totalDays = 0;
  while (cursor <= endDate) {
    totalDays += 1;
    cursor = shiftDate(cursor, 1);
  }

  let missing = [];
  const pastEnd = endDate < today ? endDate : shiftDate(today, -1);
  if (startDate <= pastEnd) {
    const [richMissing, grainMissing] = await Promise.all([
      listDatesMissingRichDims(startDate, pastEnd),
      listMissingGrainDates(startDate, pastEnd),
    ]);
    missing = [...new Set([...richMissing, ...grainMissing])].sort();
  }
  let presentMissing = 0;
  if (startDate <= today && endDate >= today) {
    const todayGaps = await listMissingGrainDates(today, today);
    if (todayGaps.length) presentMissing = 1;
  }
  const missingDays = missing.length + presentMissing;
  const coveredDays = Math.max(0, totalDays - missingDays);
  return {
    totalDays,
    coveredDays,
    missingDays,
    complete: missingDays === 0,
    newestFilled: missing.length ? null : (endDate < today ? endDate : shiftDate(today, -1)),
  };
}

/**
 * Pull a date range from GAM in small windows (newest first)
 * and stream each window into report_present / report_daily.
 */
async function syncDateRangeFromGAM(startDate, endDate, syncType = 'sync-backfill') {
  const windows = listSyncWindows(startDate, endDate);
  if (!windows.length) return 0;
  let total = 0;
  for (const win of windows) {
    total += await streamSyncFromGAM(win.startDate, win.endDate, syncType);
  }
  return total;
}

/**
 * Ensure every day in [startDate, endDate] has KPI grain — full month completeness.
 * Prefer missing-day fill (oldest first) so early-month gaps are not left until last.
 * Verifies coverage and retries once; does not stop after only scraping month-end windows.
 */
async function syncCompleteDateRangeFromGAM(startDate, endDate, syncType = 'sync-backfill') {
  if (!startDate || !endDate || startDate > endDate) return 0;

  let missing = await listMissingGrainDates(startDate, endDate);
  if (!missing.length) {
    logger.info(`[${syncType}] Range ${startDate}..${endDate} already complete — skip`);
    return 0;
  }

  logger.info(
    `[${syncType}] Completing ${startDate}..${endDate}: ${missing.length} missing day(s)`
    + ` (oldest ${missing[0]}, newest ${missing[missing.length - 1]})`
  );

  let total = await fillMissingGrainDates(startDate, endDate, syncType);

  missing = await listMissingGrainDates(startDate, endDate);
  if (missing.length) {
    logger.warn(
      `[${syncType}] ${missing.length} day(s) still missing after fill —`
      + ` window-sync oldest-first ${missing[0]}..${missing[missing.length - 1]}`
    );
    const windows = listSyncWindows(missing[0], missing[missing.length - 1], { oldestFirst: true });
    for (const win of windows) {
      try {
        total += await streamSyncFromGAM(win.startDate, win.endDate, syncType);
      } catch (e) {
        logger.warn(`[${syncType}] Window ${win.startDate}..${win.endDate} failed: ${e.message}`);
      }
    }
    total += await fillMissingGrainDates(startDate, endDate, `${syncType}:gap-retry`);
    missing = await listMissingGrainDates(startDate, endDate);
  }

  if (missing.length) {
    logger.warn(
      `[${syncType}] INCOMPLETE ${startDate}..${endDate}: ${missing.length} day(s) still missing`
      + ` (${missing[0]} → ${missing[missing.length - 1]})`
    );
  } else {
    logger.info(`[${syncType}] COMPLETE ${startDate}..${endDate} — all days have KPI grain`);
  }
  return total;
}

async function syncOneGamRange(startDate, endDate, syncType) {
  return streamSyncFromGAM(startDate, endDate, syncType);
}

/**
 * Invalidate Redis cache keys that cover a given date.
 * Called after every upsert so the next API hit reloads from Postgres → Redis.
 */
async function invalidateCacheForDate(date) {
  const exact = [
    tenantKey(`report:rows:${date}:${date}`),
    tenantKey(`overview:${date}`),
    tenantKey(`detailed:${date}:${date}`),
  ];
  if (date === todayInTZ()) exact.push(tenantKey('overview:today'));
  await redisDel(...exact);

  // Date-scoped patterns only — never SCAN global report_*_resp_v*_ (burned Upstash 500k cmds).
  const patterns = [
    tenantKey(`report:rows:${date}:*`),
    tenantKey(`report:rows:*:${date}`),
    tenantKey(`report_dashboard_raw_${date}_*`),
    tenantKey(`report_dashboard_raw_v2_${date}_*`),
    tenantKey(`report_dashboard_full_${date}_*`),
    tenantKey(`report_detailed_raw_${date}_*`),
    tenantKey(`report_domain_user_${date}_*`),
    tenantKey(`report_programmatic_${date}_*`),
  ];
  let scanned = 0;
  for (const pattern of patterns) {
    scanned += await redisDelByPattern(pattern, { maxRounds: 4 });
  }
  // Response caches embed cache:gen — bumping invalidates without SCAN.
  const gen = await bumpCacheGeneration(tenantKey(''));
  logger.info(`Cache invalidated for ${date}: exact=${exact.length} scanned=${scanned} gen=${gen}`);
}

async function logSync(syncType, status, rowsUpserted = 0, errorMsg = null) {
  try {
    await query(
      `INSERT INTO sync_log (client_id, sync_type, finished_at, status, error_msg, rows_upserted)
       VALUES ($1, $2, NOW(), $3, $4, $5)`,
      [requireClientId(), syncType, status, errorMsg, rowsUpserted]
    );
  } catch (e) {
    logger.warn('Failed to write sync_log:', e.message);
  }
}

/**
 * Get report rows for a date range.
 * Pipeline: Redis (fast) → PostgreSQL (present + daily) → live GAM.
 */
async function getReportRange(startDate, endDate, userId = null) {
  const cacheKey = tenantKey(`report:rows:${startDate}:${endDate}`);
  try {
    const cached = await redisGet(cacheKey);
    if (cached) return { rows: cached, cached: true };
  } catch (e) {
    logger.warn('redisGet failed in getReportRange:', e.message);
  }

  try {
    const covered = await hasCompleteDbCoverage(startDate, endDate);
    if (covered) {
      let normalizedRows;
      if (typeof fetchLeanRowsFromDB === 'function') {
        normalizedRows = await fetchLeanRowsFromDB(startDate, endDate);
      } else {
        const rows = await fetchFromDB(startDate, endDate);
        normalizedRows = normalizeReportRows(rows);
      }
      if (normalizedRows && normalizedRows.length && rowsHaveLeanMetrics(normalizedRows)) {
        // Never cache huge grain arrays in Redis (heap + command burn).
        if (normalizedRows.length <= MAX_REDIS_ARRAY_ITEMS) {
          try { await redisSet(cacheKey, normalizedRows, TTL.REPORT); } catch (e) { logger.warn('redisSet failed in getReportRange:', e.message); }
        }
        return { rows: normalizedRows, source: 'db' };
      }
    }
  } catch (e) {
    logger.warn('fetchFromDB failed in getReportRange:', e.message);
  }

  try {
    const rawGamRows = await fetchFromGAM(startDate, endDate);
    if (!Array.isArray(rawGamRows) || !rawGamRows.length) {
      return { rows: [] };
    }

    const normalizedRows = normalizeReportRows(rawGamRows.map((row) => {
      const dimensions = {};
      const metrics = {};
      for (const [k, v] of Object.entries(row)) {
        if (k.startsWith('Dimension.')) {
          dimensions[k.replace('Dimension.', '')] = v;
        } else if (k.startsWith('Column.')) {
          metrics[k.replace('Column.', '')] = parseFloat(v) || 0;
        }
      }
      return { dimensions, metrics };
    }));

    try {
      const normalizedForUpsert = normalizeGAMRows(rawGamRows);
      await persistSyncedRows(normalizedForUpsert, 'range-fetch');
    } catch (e) {
      logger.warn('Failed to persist GAM rows to Postgres:', e.message);
    }

    if (normalizedRows.length <= MAX_REDIS_ARRAY_ITEMS) {
      try { await redisSet(cacheKey, normalizedRows, TTL.REPORT); } catch (e) { logger.warn('redisSet failed in getReportRange after GAM fetch:', e.message); }
    }
    return { rows: normalizedRows, source: 'gam' };
  } catch (e) {
    logger.error('GAM fallback failed in getReportRange:', e.message);
    return { rows: [] };
  }
}

/**
 * Stable hash for a Reporting-page query (dims/metrics/country/date range).
 * Inventory filters are applied after the dump so one GAM/adhoc rowset is reused.
 */
function buildAdhocQueryHash(filters = {}) {
  const part = (v) => {
    if (v == null || v === '') return '';
    if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean).sort().join('|');
    return String(v).trim();
  };
  const stable = [
    part(filters.startDate),
    part(filters.endDate),
    part(filters.country),
    part(filters.reportDimensions),
    part(filters.reportMetrics),
  ].join('\n');
  return crypto.createHash('md5').update(stable).digest('hex').slice(0, 24);
}

async function hasAdhocCoverage(startDate, endDate, queryHash) {
  if (!queryHash || !startDate || !endDate) return false;
  const { rows } = await query(
    `SELECT row_count
     FROM report_adhoc_coverage
     WHERE query_hash = $1 AND start_date = $2::date AND end_date = $3::date
     LIMIT 1`,
    [queryHash, startDate, endDate]
  );
  // Only treat as covered when real rows were stored. Empty markers must not
  // block a live GAM fetch for past Reporting queries.
  return rows.length > 0 && Number(rows[0].row_count) > 0;
}

/**
 * Read Reporting-page rows from report_adhoc for an exact query_hash + date range.
 * Returns canonical flat rows (via normalizeReportRows).
 */
async function fetchAdhocFromDB(startDate, endDate, queryHash) {
  if (!queryHash) return [];
  const { rows } = await query(
    `SELECT
       to_char(report_date, 'YYYY-MM-DD') AS report_date,
       dimensions,
       metrics,
       currency,
       inv_domain,
       inv_site,
       inv_ad_unit,
       inv_app
     FROM report_adhoc
     WHERE query_hash = $1
       AND report_date BETWEEN $2::date AND $3::date
     ORDER BY report_date DESC`,
    [queryHash, startDate, endDate]
  );

  return normalizeReportRows(rows.map((row) => {
    const dimensions = { ...(row.dimensions || {}) };
    const metrics = { ...(row.metrics || {}) };
    if (row.inv_domain && !dimensions.domainName) {
      dimensions.domainName = row.inv_domain;
      dimensions.domain = row.inv_domain;
    }
    if (row.inv_site && !dimensions.siteUrl) {
      dimensions.siteUrl = row.inv_site;
      dimensions.gamSite = dimensions.gamSite || row.inv_site;
    }
    if (row.inv_ad_unit && !dimensions.AD_UNIT_NAME && !dimensions.site) {
      dimensions.AD_UNIT_NAME = row.inv_ad_unit;
      dimensions.ad_unit_name = row.inv_ad_unit;
      dimensions.site = row.inv_ad_unit;
    }
    if (row.inv_app && !dimensions.appId) {
      dimensions.appId = row.inv_app;
      dimensions.appPackage = dimensions.appPackage || row.inv_app;
    }
    return {
      ...dimensions,
      ...metrics,
      report_date: row.report_date,
      date: row.report_date || dimensions.date || dimensions.DATE,
      dimensions,
      metrics,
      currency: row.currency || 'USD',
    };
  }));
}

/**
 * Persist Reporting-page GAM rows into report_adhoc (never report_daily/present).
 * Also writes a coverage marker for the exact date range + query_hash.
 */
async function persistAdhocRows(rows, opts = {}) {
  const {
    queryHash,
    startDate,
    endDate,
    dimKeys = [],
    metricKeys = [],
    syncType = 'report-adhoc',
  } = opts;
  if (!queryHash) {
    logger.warn(`[${syncType}] persistAdhocRows skipped — missing queryHash`);
    return 0;
  }

  const list = Array.isArray(rows) ? rows : [];
  let upserted = 0;

  for (const row of list) {
    const reportDate = toYmd(row.report_date || row.date) || toYmd(startDate);
    if (!reportDate) continue;

    const srcDims = { ...(row.dimensions || {}) };
    const srcMetrics = { ...(row.metrics || {}) };
    for (const [k, v] of Object.entries(row)) {
      if (k === 'dimensions' || k === 'metrics') continue;
      if (v == null || v === '') continue;
      if (typeof v === 'number' || typeof v === 'boolean') {
        if (srcMetrics[k] == null) srcMetrics[k] = v;
      } else if (typeof v === 'string' || typeof v === 'object') {
        if (srcDims[k] == null && !['currency', 'report_date', 'date'].includes(k)) {
          // Prefer known metric names into metrics bag.
          const metricLike = /revenue|impression|click|ecpm|ctr|viewable|rate|unfilled|fill/i.test(k);
          if (metricLike && typeof v !== 'object') srcMetrics[k] = v;
          else if (typeof v !== 'object') srcDims[k] = v;
        }
      }
    }

    const { dimensions, inv } = attachInventoryDimensions(srcDims);
    const hash = dimHash(dimensions);
    try {
      await query(
        `INSERT INTO report_adhoc
           (client_id, report_date, query_hash, dim_hash, dimensions, metrics,
            dim_keys, metric_keys, currency, synced_at,
            inv_domain, inv_site, inv_ad_unit, inv_app)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10, $11, $12, $13)
         ON CONFLICT (client_id, report_date, query_hash, dim_hash)
         DO UPDATE SET
           dimensions  = EXCLUDED.dimensions,
           metrics     = EXCLUDED.metrics,
           dim_keys    = EXCLUDED.dim_keys,
           metric_keys = EXCLUDED.metric_keys,
           currency    = EXCLUDED.currency,
           synced_at   = EXCLUDED.synced_at,
           inv_domain  = EXCLUDED.inv_domain,
           inv_site    = EXCLUDED.inv_site,
           inv_ad_unit = EXCLUDED.inv_ad_unit,
           inv_app     = EXCLUDED.inv_app`,
        [
          requireClientId(),
          reportDate,
          queryHash,
          hash,
          dimensions,
          srcMetrics,
          dimKeys,
          metricKeys,
          row.currency || 'USD',
          inv.domainName || null,
          inv.siteUrl || null,
          inv.adUnit || null,
          inv.appId || null,
        ]
      );
      upserted += 1;
    } catch (e) {
      logger.error(`[${syncType}] ❌ Upsert FAILED into report_adhoc date=${reportDate}:`, e.message);
      throw e;
    }
  }

  const covStart = toYmd(startDate) || (list[0] && toYmd(list[0].report_date || list[0].date));
  const covEnd = toYmd(endDate) || covStart;
  if (covStart && covEnd) {
    await query(
      `INSERT INTO report_adhoc_coverage (client_id, query_hash, start_date, end_date, row_count, synced_at)
       VALUES ($1, $2, $3::date, $4::date, $5, NOW())
       ON CONFLICT (client_id, query_hash, start_date, end_date)
       DO UPDATE SET row_count = EXCLUDED.row_count, synced_at = EXCLUDED.synced_at`,
      [requireClientId(), queryHash, covStart, covEnd, upserted]
    );
  }

  logger.info(`[${syncType}] Upserted ${upserted} rows into report_adhoc (query=${queryHash.slice(0, 8)}…)`);
  return upserted;
}

function buildFullSyncReportXML(dimensions, metrics, buildDateXML, startDate, endDate) {
  const dimXML = dimensions.map((d) => `<dimensions>${d}</dimensions>`).join('\n    ');
  const colXML = metrics.map((m) => `<columns>${m}</columns>`).join('\n    ');
  return `
    ${dimXML}
    ${colXML}
    ${buildDateXML(startDate, endDate)}
    <dateRangeType>CUSTOM_DATE</dateRangeType>`;
}

/**
 * Fetch Reporting-builder fields from GAM using compatible dim slices × metric batches.
 * Streams each slice via onSlice when provided so Node never holds all slices in heap.
 */
async function fetchFullFromGAM(startDate, endDate, { onSlice } = {}) {
  const { getToken, runReportAndDownload, buildDateXML } = require('../gam/reportTransport');
  const token = await getToken();
  const currency = process.env.GAM_CURRENCY || 'USD';
  const out = [];
  let okSlices = 0;
  let failSlices = 0;
  let totalRows = 0;

  async function tryPull(dims, metrics, label) {
    const attempts = [
      metrics,
      metrics.slice(0, Math.min(4, metrics.length)),
      SAFE_METRICS.slice(0, 4),
    ];
    // Dedupe identical attempts
    const seen = new Set();
    for (const cols of attempts) {
      const key = cols.join(',');
      if (!cols.length || seen.has(key)) continue;
      seen.add(key);
      try {
        const xml = buildFullSyncReportXML(dims, cols, buildDateXML, startDate, endDate);
        const raw = await runReportAndDownload(xml, token);
        if (Array.isArray(raw) && raw.length) {
          return { raw, metrics: cols };
        }
        logger.warn(`[full-sync] ${label} returned 0 rows (metrics=${cols.length})`);
      } catch (err) {
        logger.warn(`[full-sync] ${label} failed (${cols.length} metrics): ${String(err.message || err).slice(0, 140)}`);
      }
    }
    // Last resort: drop trailing dims one-by-one down to DATE + 2 dims
    let thin = [...dims];
    while (thin.length > 3) {
      thin = thin.slice(0, -1);
      try {
        const cols = SAFE_METRICS.slice(0, 4);
        const xml = buildFullSyncReportXML(thin, cols, buildDateXML, startDate, endDate);
        const raw = await runReportAndDownload(xml, token);
        if (Array.isArray(raw) && raw.length) {
          logger.info(`[full-sync] ${label} OK via thin dims=[${thin.join(',')}]`);
          return { raw, metrics: cols, dims: thin };
        }
      } catch (err) {
        logger.warn(`[full-sync] ${label} thin dims failed: ${String(err.message || err).slice(0, 100)}`);
      }
    }
    return null;
  }

  for (const slice of FULL_SYNC_DIM_SLICES) {
    for (const batch of FULL_SYNC_METRIC_BATCHES) {
      const sliceKey = `${slice.key}__${batch.key}`;
      const got = await tryPull(slice.dims, batch.metrics, sliceKey);
      if (!got?.raw?.length) {
        failSlices += 1;
        continue;
      }
      const usedDims = got.dims || slice.dims;
      const normalized = normalizeGAMRows(got.raw, currency).map((row) => ({
        ...row,
        slice_key: sliceKey,
        dim_keys: usedDims,
        metric_keys: got.metrics,
      }));
      // Drop raw ASAP — keep only normalized for upsert.
      got.raw.length = 0;
      totalRows += normalized.length;
      okSlices += 1;
      logger.info(
        `[full-sync] ${sliceKey} OK rows=${normalized.length} dims=${usedDims.length} metrics=${got.metrics.length}`
      );
      if (typeof onSlice === 'function') {
        await onSlice(normalized);
      } else {
        for (let i = 0; i < normalized.length; i += 1) out.push(normalized[i]);
      }
    }
  }

  logger.info(
    `[full-sync] range ${startDate}..${endDate} → ${totalRows} rows`
    + ` (${okSlices} slices ok, ${failSlices} failed/empty)`
    + (typeof onSlice === 'function' ? ' [streamed]' : '')
  );
  return typeof onSlice === 'function' ? [] : out;
}

async function insertFullRowsInto(table, rows, syncType) {
  if (table !== 'report_full_daily' && table !== 'report_full_present') {
    throw new Error(`Unsupported full report table: ${table}`);
  }
  if (!rows.length) return 0;

  const order = [];
  const byKey = new Map();
  for (const row of rows) {
    const { dimensions, inv } = attachInventoryDimensions(row.dimensions || {});
    const hash = dimHash(dimensions);
    const sliceKey = String(row.slice_key || 'default');
    const key = `${row.report_date}\0${sliceKey}\0${hash}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        report_date: row.report_date,
        slice_key: sliceKey,
        dimensions,
        metrics: { ...(row.metrics || {}) },
        dim_keys: row.dim_keys || [],
        metric_keys: row.metric_keys || [],
        currency: row.currency || 'USD',
        inv,
      });
      order.push(key);
    } else {
      existing.metrics = mergeMetricObjects(existing.metrics, row.metrics);
    }
  }
  const deduped = order.map((k) => byKey.get(k));
  if (deduped.length < rows.length) {
    logger.info(`[${syncType}] Deduped ${rows.length} → ${deduped.length} rows before upsert into ${table}`);
  }

  const BATCH = Math.max(50, parseInt(process.env.PG_UPSERT_BATCH || '200', 10));
  let upserted = 0;

  for (let i = 0; i < deduped.length; i += BATCH) {
    const chunk = deduped.slice(i, i + BATCH);
    const values = [];
    const params = [];
    let p = 1;
    for (const row of chunk) {
      const inv = row.inv || {};
      const hash = dimHash(row.dimensions || {});
      values.push(
        `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}::jsonb, $${p++}::jsonb, $${p++}::text[], $${p++}::text[], $${p++}, NOW(), $${p++}, $${p++}, $${p++}, $${p++})`
      );
      params.push(
        requireClientId(),
        row.report_date,
        row.slice_key || 'default',
        hash,
        JSON.stringify(row.dimensions || {}),
        JSON.stringify(row.metrics || {}),
        row.dim_keys || [],
        row.metric_keys || [],
        row.currency || 'USD',
        inv.domainName || null,
        inv.siteUrl || null,
        inv.adUnit || null,
        inv.appId || null,
      );
    }
    try {
      await query(
        `INSERT INTO ${table}
           (client_id, report_date, slice_key, dim_hash, dimensions, metrics,
            dim_keys, metric_keys, currency, synced_at,
            inv_domain, inv_site, inv_ad_unit, inv_app)
         VALUES ${values.join(',\n')}
         ON CONFLICT (client_id, report_date, slice_key, dim_hash)
         DO UPDATE SET
           dimensions  = EXCLUDED.dimensions,
           metrics     = EXCLUDED.metrics,
           dim_keys    = EXCLUDED.dim_keys,
           metric_keys = EXCLUDED.metric_keys,
           currency    = EXCLUDED.currency,
           synced_at   = EXCLUDED.synced_at,
           inv_domain  = EXCLUDED.inv_domain,
           inv_site    = EXCLUDED.inv_site,
           inv_ad_unit = EXCLUDED.inv_ad_unit,
           inv_app     = EXCLUDED.inv_app`,
        params
      );
      upserted += chunk.length;
    } catch (e) {
      logger.error(`[${syncType}] ❌ Batch upsert FAILED into ${table} (batch@${i}):`, e.message);
      throw e;
    }
  }
  return upserted;
}

async function replaceFullPresentRows(rows, syncType = 'sync-full-today') {
  // Any leftover past days in present must move to daily before we wipe present.
  try {
    await migrateStaleFullPresentToDaily(syncType);
  } catch (e) {
    logger.warn(`[${syncType}] stale full-present migrate skipped:`, e.message);
  }

  const today = todayInTZ();
  // Present table is today-only — drop any accidental non-today rows from the payload.
  const todayRows = (rows || []).filter((r) => toYmd(r.report_date) === today);

  await query('DELETE FROM report_full_present WHERE client_id = $1::uuid', [requireClientId()]);
  logger.info(`[${syncType}] Cleared previous report_full_present data`);
  if (!todayRows.length) return 0;
  const upserted = await insertFullRowsInto('report_full_present', todayRows, syncType);
  logger.info(`[${syncType}] Stored ${upserted} rows in report_full_present (today=${today})`);
  return upserted;
}

/**
 * Move any non-today rows out of report_full_present → report_full_daily.
 * Keeps present = current day only (same contract as report_present).
 */
async function migrateStaleFullPresentToDaily(syncType = 'migrate-full-present') {
  const today = todayInTZ();
  const { rows } = await query(
    `SELECT report_date, slice_key, dimensions, metrics, dim_keys, metric_keys, currency
     FROM report_full_present
     WHERE report_date < $1::date`,
    [today]
  );
  if (!rows.length) return 0;

  const mapped = rows.map((row) => ({
    report_date: toYmd(row.report_date),
    slice_key: row.slice_key,
    dimensions: row.dimensions || {},
    metrics: row.metrics || {},
    dim_keys: row.dim_keys || [],
    metric_keys: row.metric_keys || [],
    currency: row.currency || 'USD',
  })).filter((r) => r.report_date);

  const upserted = await replaceFullHistoricalRows(mapped, `${syncType}-stale`);
  await query(
    `DELETE FROM report_full_present WHERE client_id = $2::uuid AND report_date < $1::date`,
    [today, requireClientId()]
  );
  logger.info(
    `[${syncType}] Migrated ${upserted} stale full-present row(s) → report_full_daily (before ${today})`
  );
  return upserted;
}

async function replaceFullHistoricalRows(rows, syncType = 'sync-full-day') {
  const dates = [...new Set((rows || []).map((r) => toYmd(r.report_date)).filter(Boolean))];
  if (dates.length) {
    await query(
      `DELETE FROM report_full_daily WHERE client_id = $2::uuid AND report_date = ANY($1::date[])`,
      [dates, requireClientId()]
    );
    logger.info(`[${syncType}] Cleared report_full_daily for ${dates.length} date(s)`);
  }
  if (!rows?.length) return 0;
  const upserted = await insertFullRowsInto('report_full_daily', rows, syncType);
  logger.info(`[${syncType}] Upserted ${upserted} rows into report_full_daily`);
  return upserted;
}

async function promoteFullPresentToDaily(syncType = 'promote-full-present') {
  const { rows } = await query(
    `SELECT report_date, slice_key, dimensions, metrics, dim_keys, metric_keys, currency
     FROM report_full_present`
  );
  if (!rows.length) {
    logger.info(`[${syncType}] No full-present rows to promote`);
    return 0;
  }
  const mapped = rows.map((row) => ({
    report_date: toYmd(row.report_date),
    slice_key: row.slice_key,
    dimensions: row.dimensions || {},
    metrics: row.metrics || {},
    dim_keys: row.dim_keys || [],
    metric_keys: row.metric_keys || [],
    currency: row.currency || 'USD',
  })).filter((r) => r.report_date);
  const upserted = await replaceFullHistoricalRows(mapped, syncType);
  // After end-of-day promote, present still holds today until next day's sync clears it.
  // If promoting a completed calendar day that is no longer "today", clear those dates.
  const today = todayInTZ();
  await query(
    `DELETE FROM report_full_present WHERE client_id = $2::uuid AND report_date < $1::date`,
    [today, requireClientId()]
  );
  logger.info(`[${syncType}] Promoted ${upserted} rows → report_full_daily`);
  return upserted;
}

/**
 * Lean + full sync for one day. Lean keeps dashboard fast; full covers Reporting fields.
 */
async function syncFullDateRangeFromGAM(startDate, endDate, syncType = 'sync-full-backfill') {
  if (process.env.FULL_SYNC_DISABLED === 'true') {
    logger.info(`[${syncType}] FULL_SYNC_DISABLED=true — skipping full tables`);
    return 0;
  }
  const today = todayInTZ();
  const days = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    days.push(cursor);
    cursor = shiftDate(cursor, 1);
  }

  let total = 0;
  for (const day of days) {
    try {
      // Stream slice → upsert → discard (never hold 7×3 CSVs in heap at once).
      if (day === today) {
        try {
          await migrateStaleFullPresentToDaily(`${syncType}:${day}`);
        } catch (e) {
          logger.warn(`[${syncType}] stale full-present migrate skipped:`, e.message);
        }
        await query('DELETE FROM report_full_present WHERE client_id = $1::uuid', [requireClientId()]);
        await fetchFullFromGAM(day, day, {
          onSlice: async (sliceRows) => {
            const todayRows = (sliceRows || []).filter((r) => toYmd(r.report_date) === today);
            if (!todayRows.length) return;
            total += await insertFullRowsInto('report_full_present', todayRows, `${syncType}:${day}`);
          },
        });
        logger.info(`[${syncType}] full day ${day} → report_full_present (streamed, total≈${total})`);
      } else {
        await query(
          `DELETE FROM report_full_daily WHERE client_id = $2::uuid AND report_date = $1::date`,
          [day, requireClientId()]
        );
        await fetchFullFromGAM(day, day, {
          onSlice: async (sliceRows) => {
            if (!sliceRows?.length) return;
            total += await insertFullRowsInto('report_full_daily', sliceRows, `${syncType}:${day}`);
          },
        });
        logger.info(`[${syncType}] full day ${day} → report_full_daily (streamed, total≈${total})`);
      }
    } catch (e) {
      logger.error(`[${syncType}] full day ${day} failed:`, e.message);
      // Don't fail the whole lean sync — full is best-effort enrichment.
      if (process.env.FULL_SYNC_STRICT === 'true') throw e;
    }
  }
  return total;
}

/**
 * Map a report_full_* SQL row into the canonical Reporting row shape.
 * Stored metrics use GAM Column enums (revenue often in micros).
 */
function mapFullDbRowToReportRow(row) {
  const dimensions = { ...(row.dimensions || {}) };
  const rawMetrics = { ...(row.metrics || {}) };
  if (row.inv_domain && !dimensions.domainName) {
    dimensions.domainName = row.inv_domain;
    dimensions.domain = row.inv_domain;
    dimensions.DOMAIN = dimensions.DOMAIN || row.inv_domain;
  }
  if (row.inv_site && !dimensions.siteUrl) {
    dimensions.siteUrl = row.inv_site;
    dimensions.gamSite = dimensions.gamSite || row.inv_site;
  }
  if (row.inv_ad_unit && !dimensions.AD_UNIT_NAME && !dimensions.site) {
    dimensions.AD_UNIT_NAME = row.inv_ad_unit;
    dimensions.ad_unit_name = row.inv_ad_unit;
    dimensions.site = row.inv_ad_unit;
  }
  if (row.inv_app && !dimensions.appId) {
    dimensions.appId = row.inv_app;
    dimensions.appPackage = dimensions.appPackage || row.inv_app;
  }

  const metrics = {};
  for (const [api, raw] of Object.entries(rawMetrics)) {
    const catalogId = String(api).toLowerCase();
    metrics[catalogId] = parseGamMetricValue(api, raw);
    // Keep uppercase keys too for callers that look at GAM enums.
    metrics[api] = metrics[catalogId];
  }

  const impression = Math.round(
    Number(metrics.total_line_item_level_impressions
      ?? metrics.TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS
      ?? 0) || 0
  );
  const clicks = Math.round(
    Number(metrics.total_line_item_level_clicks
      ?? metrics.TOTAL_LINE_ITEM_LEVEL_CLICKS
      ?? 0) || 0
  );
  const ctr = impression > 0 && clicks > 0
    ? +((clicks / impression) * 100).toFixed(4)
    : Number(metrics.total_line_item_level_ctr ?? metrics.TOTAL_LINE_ITEM_LEVEL_CTR) || 0;
  const revenue = pickRowRevenueDollars({
    metrics,
    TOTAL_LINE_ITEM_LEVEL_ALL_REVENUE: metrics.TOTAL_LINE_ITEM_LEVEL_ALL_REVENUE,
    TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE: metrics.TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE,
    total_line_item_level_all_revenue: metrics.total_line_item_level_all_revenue,
    total_line_item_level_cpm_and_cpc_revenue: metrics.total_line_item_level_cpm_and_cpc_revenue,
  });

  let viewableRate = Number(
    metrics.total_active_view_viewable_impressions_rate
      ?? metrics.TOTAL_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE
      ?? 0
  ) || 0;
  if (viewableRate > 0 && viewableRate <= 1) viewableRate = +(viewableRate * 100).toFixed(2);

  const date = row.report_date || dimensions.DATE || dimensions.date || '';
  return normalizeReportRows([{
    report_date: date,
    date,
    dimensions,
    metrics,
    currency: row.currency || 'USD',
    impression,
    revenue,
    clicks,
    ctr,
    viewableRate,
    site: dimensions.site || dimensions.AD_UNIT_NAME || dimensions.ad_unit_name || '—',
    domainName: dimensions.domainName || dimensions.DOMAIN || dimensions.domain || '',
    siteUrl: dimensions.siteUrl || dimensions.gamSite || '',
    gamSite: dimensions.gamSite || dimensions.siteUrl || '',
    appId: dimensions.appId || dimensions.appPackage || '',
    appPackage: dimensions.appPackage || dimensions.appId || '',
    country: dimensions.COUNTRY_NAME || dimensions.country_name || dimensions.country || '',
    device: dimensions.DEVICE_CATEGORY_NAME || dimensions.device_category_name || dimensions.device || '',
  }])[0];
}

/**
 * Fast Reporting bundle from report_full_present / report_full_daily.
 * Picks a covering slice, aggregates summary/trend in SQL, caps table rows.
 * Returns null when the warehouse has no rows for the chosen slice + range.
 */
async function fetchFullReportBundleFromDB(startDate, endDate, opts = {}) {
  const tableLimit = Math.min(Math.max(parseInt(opts.tableLimit, 10) || 2500, 50), 5000);
  const dimApis = (opts.dimensionApis || []).map((d) => String(d).toUpperCase()).filter(Boolean);
  const metricApis = (opts.metricApis || []).map((m) => String(m).toUpperCase()).filter(Boolean);
  const pick = pickBestFullSlice(dimApis, metricApis);
  if (!pick) return null;

  const today = todayInTZ();
  const buildBranch = (table, from, to) => {
    const params = [pick.sliceKey, from, to];
    let extra = ` AND slice_key = $1 AND report_date BETWEEN $2::date AND $3::date`;
    extra = appendLeanInventoryFilters(params, extra, opts);
    return { table, sql: `FROM ${table} WHERE TRUE${extra}`, params };
  };

  const branches = [];
  if (startDate <= today && endDate >= today) {
    branches.push(buildBranch('report_full_present', startDate, endDate));
  }
  if (startDate < today) {
    const pastEnd = endDate < today ? endDate : shiftDate(today, -1);
    if (startDate <= pastEnd) {
      branches.push(buildBranch('report_full_daily', startDate, pastEnd));
    }
  }
  if (!branches.length) return null;

  const { revenueExpr } = leanRevenueSqlFragments();
  const revExpr = revenueExpr;
  const impExpr = `COALESCE((metrics->>'TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS')::float8, 0)`;

  const runAgg = async (selectSql, orderLimit = '') => {
    const merged = [];
    for (const b of branches) {
      const { rows } = await query(
        `${selectSql} ${b.sql} ${orderLimit}`.replace(/\s+/g, ' ').trim(),
        b.params
      );
      merged.push(...rows);
    }
    return merged;
  };

  const totalsRows = await runAgg(`
    SELECT
      COALESCE(SUM(${impExpr}), 0)::float8 AS impressions,
      COALESCE(SUM(${revExpr}), 0)::float8 AS revenue_raw,
      COUNT(*)::int AS row_count
  `);
  let impressions = 0;
  let revenueRaw = 0;
  let grainCount = 0;
  for (const t of totalsRows) {
    impressions += Number(t.impressions) || 0;
    revenueRaw += Number(t.revenue_raw) || 0;
    grainCount += Number(t.row_count) || 0;
  }
  if (!grainCount) return null;

  // Stored revenue is typically dollars after sync; only treat clear micros.
  let revenue = coerceWarehouseRevenue(revenueRaw, impressions);
  impressions = Math.round(impressions);

  const trendRaw = await runAgg(`
    SELECT
      to_char(report_date, 'YYYY-MM-DD') AS date,
      COALESCE(SUM(${revExpr}), 0)::float8 AS earning_raw,
      COALESCE(SUM(${impExpr}), 0)::float8 AS impressions
    `, 'GROUP BY report_date');
  const trendMap = new Map();
  for (const r of trendRaw) {
    const imps = Math.round(Number(r.impressions) || 0);
    const earning = coerceWarehouseRevenue(r.earning_raw, imps);
    const prev = trendMap.get(r.date) || { date: r.date, earning: 0, impressions: 0 };
    prev.earning = +(prev.earning + earning).toFixed(2);
    prev.impressions += imps;
    trendMap.set(r.date, prev);
  }
  const trend = [...trendMap.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));

  // Cap table source — prefer rows with real metrics (date DESC alone surfaces many $0 rows).
  const tableRowsRaw = [];
  for (const b of branches) {
    if (tableRowsRaw.length >= tableLimit) break;
    const remaining = tableLimit - tableRowsRaw.length;
    const { rows } = await query(
      `SELECT
         to_char(report_date, 'YYYY-MM-DD') AS report_date,
         dimensions, metrics, currency,
         inv_domain, inv_site, inv_ad_unit, inv_app
       ${b.sql}
         AND ${impExpr} > 0
       ORDER BY report_date DESC, ${revExpr} DESC NULLS LAST, ${impExpr} DESC NULLS LAST
       LIMIT ${remaining}`.replace(/\s+/g, ' ').trim(),
      b.params
    );
    tableRowsRaw.push(...rows);
  }
  // If every row was zero-metric, still return a capped sample so UI isn't blank.
  if (!tableRowsRaw.length) {
    for (const b of branches) {
      if (tableRowsRaw.length >= tableLimit) break;
      const remaining = tableLimit - tableRowsRaw.length;
      const { rows } = await query(
        `SELECT
           to_char(report_date, 'YYYY-MM-DD') AS report_date,
           dimensions, metrics, currency,
           inv_domain, inv_site, inv_ad_unit, inv_app
         ${b.sql}
         ORDER BY report_date DESC
         LIMIT ${remaining}`.replace(/\s+/g, ' ').trim(),
        b.params
      );
      tableRowsRaw.push(...rows);
    }
  }
  const rows = tableRowsRaw.map(mapFullDbRowToReportRow).map((r) => {
    // Keep metrics bag in dollars (same as legacy revenue/impression) for the Reporting table.
    const metrics = { ...(r.metrics || {}) };
    if (r.revenue != null) {
      metrics.total_line_item_level_cpm_and_cpc_revenue = Number(r.revenue) || 0;
      metrics.TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE = metrics.total_line_item_level_cpm_and_cpc_revenue;
    }
    if (r.impression != null) {
      metrics.total_line_item_level_impressions = Number(r.impression) || 0;
      metrics.TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS = metrics.total_line_item_level_impressions;
    }
    return { ...r, metrics };
  });

  const skipped = [
    ...(pick.missingDims || []),
    ...(pick.missingMetrics || []),
  ];
  const GAM_DIM_LABEL = {
    DATE: 'Date', COUNTRY_NAME: 'Country', DEVICE_CATEGORY_NAME: 'Device',
    AD_UNIT_NAME: 'Ad unit', SITE_NAME: 'Site', DOMAIN: 'Domain',
    MOBILE_APP_NAME: 'App names', MOBILE_APP_RESOLVED_ID: 'App ID',
    PROGRAMMATIC_CHANNEL_NAME: 'Programmatic channel', DEMAND_CHANNEL_NAME: 'Demand channel',
    REGION_NAME: 'Region', CITY_NAME: 'City', HOUR: 'Hour',
    BROWSER_NAME: 'Browser', OPERATING_SYSTEM_NAME: 'Operating system',
    COUNTRY_CODE: 'Country code',
  };
  const labelOf = (api) => GAM_DIM_LABEL[api]
    || String(api).replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

  return {
    rows,
    trend,
    summary: {
      totalRevenue: revenue,
      totalDomains: countAppAndWebsiteDomainsFromRows(rows),
      offeredRecords: grainCount,
      impressions,
      revenue,
      currency: opts.currency || 'USD',
    },
    pagination: {
      totalRows: grainCount,
      truncated: grainCount > rows.length,
      allRows: false,
      compact: true,
    },
    grainCount,
    source: 'report_full',
    sliceKey: pick.sliceKey,
    reportWarning: skipped.length ? 'partial' : null,
    reportWarningSkipped: skipped.map(labelOf),
    reportWarningUsed: (pick.usedDims || []).map(labelOf),
    reportWarningUsedIds: (opts.dimensionIds || []).filter((id) => {
      const api = String(id).toUpperCase();
      return (pick.usedDims || []).includes(api) || api === 'DATE';
    }),
    reportWarningUsedMetricIds: (opts.metricIds || []).filter((id) => {
      const api = String(id).toUpperCase();
      return (pick.usedMetrics || []).includes(api);
    }),
  };
}

module.exports = {
  upsertRows,
  replacePresentRows,
  replaceHistoricalRows,
  promotePresentToDaily,
  migrateStalePresentToDaily,
  persistSyncedRows,
  fetchFromDB,
  fetchLeanRowsFromDB,
  fetchLeanOverviewTotalsFromDB,
  fetchLeanDashboardBundleFromDB,
  fetchReportingBundleFromDB,
  fetchFullReportBundleFromDB,
  countAppAndWebsiteDomainsFromRows,
  pickBestFullSlice,
  rebuildRollupsForDates,
  backfillAllRollups,
  rowsHaveLeanMetrics,
  fetchFromGAM,
  streamSyncFromGAM,
  syncDateRangeFromGAM,
  syncCompleteDateRangeFromGAM,
  dailyHasCountryAndDevice,
  presentHasCountryAndDevice,
  listDatesMissingRichDims,
  listMissingGrainDates,
  fillMissingGrainDates,
  hasCompleteDbCoverage,
  getRangeCoverage,
  normalizeGAMRows,
  invalidateCacheForDate,
  logSync,
  dimHash,
  getReportRange,
  LEAN_SYNC_DIM_SLICES,
  buildSyncReportXML,
  buildAdhocQueryHash,
  hasAdhocCoverage,
  fetchAdhocFromDB,
  persistAdhocRows,
  fetchFullFromGAM,
  replaceFullPresentRows,
  replaceFullHistoricalRows,
  promoteFullPresentToDaily,
  migrateStaleFullPresentToDaily,
  syncFullDateRangeFromGAM,
  archiveColdDaysForClient: archiveService.archiveColdDaysForClient,
};
