const {
  FULL_SYNC_DIM_SLICES,
  FULL_SYNC_METRIC_BATCHES,
  SAFE_METRICS,
  pickBestFullSlice,
} = require('../utils/fullReportSyncCatalog');
const { parseGamMetricValue, gamMoneyToDollars, pickRowRevenueDollars } = require('../utils/gamReportMetrics');

/**
 * gamSyncService — fetches data from GAM and writes into PostgreSQL.
 * Called by BullMQ workers. Does NOT touch HTTP request/response.
 *
 * Tables:
 *   report_present / report_daily — lean dashboard sync (country/device/ad unit + core metrics)
 *   report_full_present / report_full_daily — Reporting builder fields via multi-slice cron
 *   report_adhoc — on-demand Reporting page custom queries
 */
const crypto  = require('crypto');
const { query } = require('../db');
const { requireClientId, tenantKey } = require('../utils/clientContext');
const {
  redisDel, redisDelByPattern, bumpCacheGeneration, TTL, redisGet, redisSet, MAX_REDIS_ARRAY_ITEMS,
} = require('../redisClient');
const { todayInTZ } = require('../utils/datetime');
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

async function insertRowsInto(table, rows, syncType) {
  if (table !== 'report_daily' && table !== 'report_present') {
    throw new Error(`Unsupported report table: ${table}`);
  }
  if (!rows.length) return 0;

  const deduped = dedupeRowsByDimHash(rows);
  if (deduped.length < rows.length) {
    logger.info(`[${syncType}] Deduped ${rows.length} → ${deduped.length} rows before upsert into ${table}`);
  }

  const BATCH = Math.max(50, parseInt(process.env.PG_UPSERT_BATCH || '250', 10));
  let upserted = 0;

  for (let i = 0; i < deduped.length; i += BATCH) {
    const chunk = deduped.slice(i, i + BATCH);
    const values = [];
    const params = [];
    let p = 1;
    for (const row of chunk) {
      const inv = row.inv || inventoryFieldsFromDimensions(row.dimensions || {});
      const hash = dimHash(row.dimensions || {});
      values.push(
        `($${p++}, $${p++}, $${p++}, $${p++}::jsonb, $${p++}::jsonb, $${p++}, NOW(), $${p++}, $${p++}, $${p++}, $${p++})`
      );
      params.push(
        requireClientId(),
        row.report_date,
        hash,
        JSON.stringify(row.dimensions || {}),
        JSON.stringify(row.metrics || {}),
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
           (client_id, report_date, dim_hash, dimensions, metrics, currency, synced_at,
            inv_domain, inv_site, inv_ad_unit, inv_app)
         VALUES ${values.join(',\n')}
         ON CONFLICT (client_id, report_date, dim_hash)
         DO UPDATE SET
           dimensions = EXCLUDED.dimensions,
           metrics    = EXCLUDED.metrics,
           currency   = EXCLUDED.currency,
           synced_at  = EXCLUDED.synced_at,
           inv_domain = EXCLUDED.inv_domain,
           inv_site   = EXCLUDED.inv_site,
           inv_ad_unit = EXCLUDED.inv_ad_unit,
           inv_app    = EXCLUDED.inv_app`,
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

/**
 * Historical past data → report_daily (yesterday / 7d / 30d / backfill).
 */
async function upsertRows(rows, syncType) {
  const upserted = await insertRowsInto('report_daily', rows, syncType);
  logger.info(`[${syncType}] Upserted ${upserted} rows into report_daily`);
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
      await query(
        `DELETE FROM report_daily WHERE client_id = $2::uuid AND report_date = ANY($1::date[])`,
        [dates, requireClientId()]
      );
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
  // Write new/updated rich rows first (no empty-window for dashboard readers).
  const upserted = await upsertRows(rows, syncType);

  if (dates.length) {
    try {
      // Drop stale grains from older dimension sets (prevents 2× totals on re-sync).
      await query(
        `DELETE FROM report_daily
         WHERE client_id = $2::uuid
           AND report_date = ANY($1::date[])
           AND synced_at < $3`,
        [dates, requireClientId(), syncStartedAt]
      );
    } catch (e) {
      logger.warn(`[${syncType}] stale historical cleanup skipped:`, e.message);
    }
    try {
      await query(
        `DELETE FROM report_daily
         WHERE client_id = $2::uuid
           AND report_date = ANY($1::date[])
           AND NOT ${RICH_DIM_SQL}`,
        [dates, requireClientId()]
      );
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
  // Never leave yesterday in present — dashboard Today only reads this table.
  try {
    await migrateStalePresentToDaily(syncType);
  } catch (e) {
    logger.warn(`[${syncType}] stale present migrate skipped:`, e.message);
  }

  const today = todayInTZ();
  const todayRows = (rows || []).filter((r) => toYmd(r.report_date) === today);

  if (!todayRows.length) {
    await query(
      'DELETE FROM report_present WHERE client_id = $2::uuid AND report_date = $1::date',
      [today, requireClientId()]
    );
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
    logger.info(`[${syncType}] No today rows — cleared today's report_present`);
    return 0;
  }

  const syncStartedAt = new Date();
  const upserted = await insertRowsInto('report_present', todayRows, syncType);
  logger.info(`[${syncType}] Upserted ${upserted} rows into report_present (today=${today})`);

  try {
    await query(
      `DELETE FROM report_present WHERE client_id = $2::uuid AND synced_at < $1`,
      [syncStartedAt, requireClientId()]
    );
  } catch (e) {
    logger.warn(`[${syncType}] stale present cleanup skipped:`, e.message);
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
 * Copy leftover (non-today) rows from report_present → report_daily, then delete them.
 * This is the 24h handoff: yesterday's snapshot becomes history and Today stays empty
 * until the next sync-today fills it.
 */
async function migrateStalePresentToDaily(syncType = 'migrate-present') {
  const today = todayInTZ();
  const { rows } = await query(
    `SELECT report_date, dimensions, metrics, currency
     FROM report_present
     WHERE report_date < $1::date`,
    [today]
  );
  if (!rows.length) return 0;

  const mapped = rows.map((row) => ({
    report_date: toYmd(row.report_date),
    dimensions: row.dimensions || {},
    metrics: row.metrics || {},
    currency: row.currency || 'USD',
  })).filter((row) => row.report_date);

  const upserted = await replaceHistoricalRows(mapped, `${syncType}-stale`);
  await query(
    `DELETE FROM report_present WHERE client_id = $2::uuid AND report_date < $1::date`,
    [today, requireClientId()]
  );
  logger.info(
    `[${syncType}] Migrated ${upserted} stale present row(s) → report_daily and deleted them (before ${today})`
  );
  return upserted;
}

/**
 * End-of-day: copy the current present snapshot into report_daily.
 * Keeps today's rows in report_present until the next calendar day, then
 * migrateStalePresentToDaily deletes them.
 */
async function promotePresentToDaily(syncType = 'promote-present') {
  const stale = await migrateStalePresentToDaily(syncType);
  const { rows } = await query(
    `SELECT report_date, dimensions, metrics, currency
     FROM report_present`
  );
  if (!rows.length) {
    logger.info(`[${syncType}] No present rows to promote into report_daily`);
    return stale;
  }

  const mapped = rows.map((row) => ({
    report_date: toYmd(row.report_date),
    dimensions: row.dimensions || {},
    metrics: row.metrics || {},
    currency: row.currency || 'USD',
  })).filter((row) => row.report_date);

  const upserted = await replaceHistoricalRows(mapped, syncType);
  logger.info(`[${syncType}] Promoted ${upserted} present rows into report_daily`);
  return upserted + stale;
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
  const today = todayInTZ();
  const parts = [];
  const params = [];

  if (rangeIncludesToday(startDate, endDate)) {
    params.push(today);
    parts.push(`
      SELECT report_date, dimensions, metrics, currency, synced_at, 'present' AS source
      FROM report_present
      WHERE report_date = $${params.length}::date
    `);
  }

  const pastEnd = endDate < today ? endDate : shiftDate(today, -1);
  if (startDate <= pastEnd) {
    params.push(startDate, pastEnd);
    const i = params.length;
    parts.push(`
        SELECT report_date, dimensions, metrics, currency, synced_at, 'daily' AS source
        FROM report_daily
        WHERE report_date BETWEEN $${i - 1} AND $${i}
    `);
  }

  if (!parts.length) return [];

  const { rows } = await query(
    `${parts.join(' UNION ALL ')} ORDER BY report_date DESC`,
    params
  );
  return rows;
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
  const revenueExpr = `CASE
    WHEN ABS(${revenueRawExpr}) >= 1000 THEN ${revenueRawExpr} / 1000000.0
    WHEN ABS(${revenueRawExpr}) > 0 AND ABS(${revenueRawExpr}) < 1 THEN ${revenueRawExpr}
    WHEN ABS(${revenueRawExpr}) >= 1 AND ABS(${revenueRawExpr}) < 1000
      AND ${revenueRawExpr} = FLOOR(${revenueRawExpr}) THEN ${revenueRawExpr} / 1000000.0
    ELSE ${revenueRawExpr}
  END`;
  return { revenueRawExpr, revenueExpr };
}

/** Map flat SQL dashboard rows into the canonical report shape (no heavy JSONB normalize). */
function mapLeanDbRow(r) {
  const impression = Math.round(Number(r.impression) || 0);
  const revenue = toDollarsLean(r.revenue_raw);
  let viewableRate = Number(r.viewable_raw) || 0;
  if (viewableRate > 0 && viewableRate <= 1) viewableRate = +(viewableRate * 100).toFixed(2);
  else viewableRate = +Number(viewableRate || 0).toFixed(2);
  const ecpm = impression > 0 && revenue > 0 ? +((revenue / impression) * 1000).toFixed(2) : 0;
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
  const today = todayInTZ();
  const { sanitizeInventoryFilters, MAX_INVENTORY_FILTER_VALUES } = require('../utils/inventoryFilters');
  // Cap oversized "select all" lists before building SQL — LIKE ANY with thousands of
  // patterns freezes Postgres and the API (looks like a hung / logged-out UI).
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
  const siteExpr = `LOWER(COALESCE(NULLIF(inv_site,''), dimensions->>'siteUrl', dimensions->>'gamSite', dimensions->>'siteName', dimensions->>'site_name', dimensions->>'URL_NAME', dimensions->>'SITE_NAME', ''))`;
  const appExpr = `LOWER(COALESCE(NULLIF(inv_app,''), dimensions->>'appPackage', dimensions->>'appId', dimensions->>'MOBILE_APP_NAME', dimensions->>'mobile_app_name', dimensions->>'MOBILE_APP_RESOLVED_ID', ''))`;

  const runBranch = async (table, from, to, excludeDates = null) => {
    const params = [from, to];
    let extra = '';
    if (excludeDates && excludeDates.length) {
      params.push(excludeDates);
      extra += ` AND report_date <> ALL($${params.length}::date[])`;
    }

    if (adUnitNames.length) {
      params.push(adUnitNames);
      extra += ` AND ${adUnitExpr} = ANY($${params.length}::text[])`;
    }

    const webParts = [];
    if (domains.length) {
      params.push(domains);
      const i = params.length;
      webParts.push(opts.skipAdUnitLike
        ? `(${domainExpr} = ANY($${i}::text[]))`
        : `(
        ${domainExpr} = ANY($${i}::text[])
        OR ${adUnitExpr} LIKE ANY(ARRAY(SELECT '%' || d || '%' FROM unnest($${i}::text[]) AS d))
      )`);
    }

    if (sites.length) {
      params.push(sites);
      const i = params.length;
      webParts.push(opts.skipAdUnitLike
        ? `(${siteExpr} = ANY($${i}::text[]))`
        : `(
        ${siteExpr} = ANY($${i}::text[])
        OR ${adUnitExpr} LIKE ANY(ARRAY(SELECT '%' || s || '%' FROM unnest($${i}::text[]) AS s))
      )`);
    }

    if (webParts.length === 1) {
      extra += ` AND ${webParts[0]}`;
    } else if (webParts.length > 1) {
      extra += opts.webInventoryOr
        ? ` AND (${webParts.join(' OR ')})`
        : ` AND ${webParts[0]} AND ${webParts[1]}`;
    }

    if (apps.length) {
      extra += sqlAppMatchClause(params, apps, appExpr, adUnitExpr);
    }

    if (!domains.length && !sites.length && !adUnitNames.length && !apps.length && adUnitPatterns.length) {
      params.push(adUnitPatterns);
      extra += ` AND ${adUnitExpr} LIKE ANY($${params.length}::text[])`;
    }

    if (countryNames.length) {
      params.push(countryNames);
      extra += ` AND LOWER(COALESCE(
        dimensions->>'COUNTRY_NAME',
        dimensions->>'country_name',
        dimensions->>'country',
        ''
      )) = ANY($${params.length}::text[])`;
    }

    const { revenueExpr } = leanRevenueSqlFragments();
    const maxRows = Math.max(
      1000,
      parseInt(process.env.MAX_LEAN_GRAIN_ROWS || '25000', 10) || 25000
    );
    const { rows } = await query(
      `SELECT
         to_char(report_date, 'YYYY-MM-DD') AS report_date,
         COALESCE(dimensions->>'COUNTRY_NAME', dimensions->>'country_name', dimensions->>'country', '') AS country,
         COALESCE(dimensions->>'DEVICE_CATEGORY_NAME', dimensions->>'device_category_name', dimensions->>'device', '') AS device,
         COALESCE(NULLIF(inv_ad_unit,''), dimensions->>'AD_UNIT_NAME', dimensions->>'ad_unit_name', dimensions->>'site', '') AS ad_unit,
         COALESCE(NULLIF(inv_domain,''), dimensions->>'domainName', dimensions->>'domain', dimensions->>'DOMAIN', '') AS domain_name,
         COALESCE(NULLIF(inv_site,''), dimensions->>'siteUrl', dimensions->>'gamSite', dimensions->>'siteName', dimensions->>'URL_NAME', dimensions->>'SITE_NAME', '') AS site_url,
         COALESCE(NULLIF(inv_app,''), dimensions->>'appPackage', dimensions->>'appId', dimensions->>'MOBILE_APP_NAME', dimensions->>'mobile_app_name', '') AS app_id,
         COALESCE(
           NULLIF(metrics->>'TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS','')::double precision,
           NULLIF(metrics->>'impression','')::double precision,
           0
         ) AS impression,
         ${revenueExpr} AS revenue_raw,
         COALESCE(
           NULLIF(metrics->>'TOTAL_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE','')::double precision,
           NULLIF(metrics->>'viewableRate','')::double precision,
           NULLIF(metrics->>'total_active_view_viewable_impressions_rate','')::double precision,
           0
         ) AS viewable_raw,
         currency
       FROM ${table}
       WHERE report_date BETWEEN $1 AND $2
       ${extra}
       ORDER BY report_date DESC
       LIMIT ${maxRows}`,
      params
    );
    return rows;
  };

  const parts = [];
  if (rangeIncludesToday(startDate, endDate)) {
    parts.push(await runBranch('report_present', today, today));
  }
  const pastEnd = endDate < today ? endDate : shiftDate(today, -1);
  if (startDate <= pastEnd) {
    parts.push(await runBranch('report_daily', startDate, pastEnd));
  }

  const merged = parts.length === 0 ? [] : parts.length === 1 ? parts[0] : parts.flat();
  return merged.map(mapLeanDbRow);
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
    const revenue = Number(t.revenue) || 0;
    const viewableWeight = Number(t.viewable_weight) || 0;
    const rowCount = Number(t.row_count) || 0;
    if (rowCount > 0 && (impressions > 0 || revenue > 0)) {
      const viewability = impressions > 0 ? +(viewableWeight / impressions).toFixed(1) : 0;
      return {
        impressions: Math.round(impressions),
        revenue: +Number(revenue).toFixed(2),
        viewability,
        rowCount,
        source: 'rollup',
      };
    }
  } catch (e) {
    logger.warn('Overview rollup read failed, falling back to grain:', e.message);
  }

  const today = todayInTZ();
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

  const run = async (table, from, to) => {
    const params = [from, to];
    let extra = ` AND report_date BETWEEN $1::date AND $2::date`;
    extra = appendLeanInventoryFilters(params, extra, opts);
    const { rows } = await query(
      `SELECT
         COALESCE(SUM(${impressionExpr}), 0)::float8 AS impressions,
         COALESCE(SUM(${revenueExpr}), 0)::float8 AS revenue,
         COALESCE(SUM((${impressionExpr}) * (${viewablePctExpr})), 0)::float8 AS viewable_weight,
         COUNT(*)::int AS row_count
       FROM ${table}
       WHERE TRUE${extra}`,
      params
    );
    return rows[0] || { impressions: 0, revenue: 0, viewable_weight: 0, row_count: 0 };
  };

  let impressions = 0;
  let revenue = 0;
  let viewableWeight = 0;
  let rowCount = 0;

  if (rangeIncludesToday(startDate, endDate)) {
    const t = await run('report_present', today, today);
    impressions += Number(t.impressions) || 0;
    revenue += Number(t.revenue) || 0;
    viewableWeight += Number(t.viewable_weight) || 0;
    rowCount += Number(t.row_count) || 0;
  }
  const pastEnd = endDate < today ? endDate : shiftDate(today, -1);
  if (startDate <= pastEnd) {
    const t = await run('report_daily', startDate, pastEnd);
    impressions += Number(t.impressions) || 0;
    revenue += Number(t.revenue) || 0;
    viewableWeight += Number(t.viewable_weight) || 0;
    rowCount += Number(t.row_count) || 0;
  }

  if (!rowCount || (impressions <= 0 && revenue <= 0)) return null;

  const viewability = impressions > 0 ? +(viewableWeight / impressions).toFixed(1) : 0;
  return {
    impressions: Math.round(impressions),
    revenue: +Number(revenue).toFixed(2),
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
  const uniq = [...new Set((dates || []).map((d) => toYmd(d)).filter(Boolean))];
  if (!uniq.length) return 0;

  const m = leanMetricSql();
  const today = todayInTZ();
  let totalKpi = 0;

  for (const day of uniq) {
    const sourceTable = day === today ? 'report_present' : 'report_daily';
    try {
      await query(
        `DELETE FROM rollup_kpi_daily WHERE client_id = $2::uuid AND report_date = $1::date`,
        [day, requireClientId()]
      );
      await query(
        `DELETE FROM rollup_dim_daily WHERE client_id = $2::uuid AND report_date = $1::date`,
        [day, requireClientId()]
      );

      const kpiRes = await query(
        `INSERT INTO rollup_kpi_daily (
           client_id, report_date, inv_domain, inv_site, inv_ad_unit, inv_app,
           impressions, revenue, viewable_weight, grain_count, currency
         )
         SELECT
           $2::uuid,
           report_date,
           COALESCE(NULLIF(TRIM(${m.domainExpr}), ''), ''),
           COALESCE(NULLIF(TRIM(${m.siteExpr}), ''), ''),
           COALESCE(NULLIF(TRIM(${m.adUnitExpr}), ''), ''),
           COALESCE(NULLIF(TRIM(${m.appExpr}), ''), ''),
           COALESCE(SUM(${m.impressionExpr}), 0),
           COALESCE(SUM(${m.revenueExpr}), 0),
           COALESCE(SUM((${m.impressionExpr}) * (${m.viewablePctExpr})), 0),
           COUNT(*)::int,
           COALESCE(MAX(currency), 'USD')
         FROM ${sourceTable}
         WHERE client_id = $2::uuid AND report_date = $1::date
         GROUP BY report_date,
           COALESCE(NULLIF(TRIM(${m.domainExpr}), ''), ''),
           COALESCE(NULLIF(TRIM(${m.siteExpr}), ''), ''),
           COALESCE(NULLIF(TRIM(${m.adUnitExpr}), ''), ''),
           COALESCE(NULLIF(TRIM(${m.appExpr}), ''), '')
         HAVING COALESCE(SUM(${m.impressionExpr}), 0) > 0
             OR COALESCE(SUM(${m.revenueExpr}), 0) > 0`,
        [day, requireClientId()]
      );
      totalKpi += kpiRes.rowCount || 0;

      // Domain / ad_unit / country / device chart dims
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
             report_date,
             $2::text,
             NULLIF(TRIM(${expr}), ''),
             COALESCE(SUM(${m.revenueExpr}), 0),
             COALESCE(SUM(${m.impressionExpr}), 0)
           FROM ${sourceTable}
           WHERE client_id = $3::uuid AND report_date = $1::date
           GROUP BY report_date, NULLIF(TRIM(${expr}), '')
           HAVING NULLIF(TRIM(${expr}), '') IS NOT NULL
              AND (COALESCE(SUM(${m.revenueExpr}), 0) > 0 OR COALESCE(SUM(${m.impressionExpr}), 0) > 0)`,
          [day, kind, requireClientId()]
        );
      }
    } catch (e) {
      logger.warn(`[${syncType}] rollup rebuild failed for ${day}:`, e.message);
    }
  }

  logger.info(`[${syncType}] Rebuilt rollups for ${uniq.length} day(s); kpi rows≈${totalKpi}`);
  return totalKpi;
}

/** One-shot: rebuild rollups for lean dates not yet covered (post-deploy warm). */
async function backfillAllRollups(syncType = 'rollup-backfill') {
  try {
    const { rows } = await query(`
      SELECT DISTINCT to_char(d, 'YYYY-MM-DD') AS d FROM (
        SELECT report_date AS d FROM report_daily
        UNION
        SELECT report_date AS d FROM report_present
      ) x
      WHERE d NOT IN (SELECT report_date FROM rollup_kpi_daily)
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

  let clause = extra || '';
  if (adUnitNames.length) {
    params.push(adUnitNames);
    clause += ` AND LOWER(inv_ad_unit) = ANY($${params.length}::text[])`;
  }
  const webParts = [];
  if (domains.length) {
    params.push(domains);
    const i = params.length;
    webParts.push(opts.skipAdUnitLike
      ? `(LOWER(inv_domain) = ANY($${i}::text[]))`
      : `(
      LOWER(inv_domain) = ANY($${i}::text[])
      OR LOWER(inv_ad_unit) LIKE ANY(ARRAY(SELECT '%' || d || '%' FROM unnest($${i}::text[]) AS d))
    )`);
  }
  if (sites.length) {
    params.push(sites);
    const i = params.length;
    webParts.push(opts.skipAdUnitLike
      ? `(LOWER(inv_site) = ANY($${i}::text[]))`
      : `(
      LOWER(inv_site) = ANY($${i}::text[])
      OR LOWER(inv_ad_unit) LIKE ANY(ARRAY(SELECT '%' || s || '%' FROM unnest($${i}::text[]) AS s))
    )`);
  }
  if (webParts.length === 1) {
    clause += ` AND ${webParts[0]}`;
  } else if (webParts.length > 1) {
    // Scoped children: domain+site assignment must OR (AND wipes lean rows).
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

  let clause = extra || '';
  if (adUnitNames.length) {
    params.push(adUnitNames);
    clause += ` AND ${adUnitExpr} = ANY($${params.length}::text[])`;
  }
  const webParts = [];
  if (domains.length) {
    params.push(domains);
    const i = params.length;
    webParts.push(opts.skipAdUnitLike
      ? `(${domainExpr} = ANY($${i}::text[]))`
      : `(
      ${domainExpr} = ANY($${i}::text[])
      OR ${adUnitExpr} LIKE ANY(ARRAY(SELECT '%' || d || '%' FROM unnest($${i}::text[]) AS d))
    )`);
  }
  if (sites.length) {
    params.push(sites);
    const i = params.length;
    webParts.push(opts.skipAdUnitLike
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
    clause += ` AND LOWER(COALESCE(
      dimensions->>'COUNTRY_NAME',
      dimensions->>'country_name',
      dimensions->>'country',
      ''
    )) = ANY($${params.length}::text[])`;
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

/**
 * Fast dashboard bundle from precomputed rollups (same numbers as lean grain aggregates).
 * Country filter forces grain fallback (dim rollups are network-wide).
 */
async function fetchDashboardBundleFromRollups(startDate, endDate, opts = {}) {
  if (opts.countryNames && opts.countryNames.length) return null;

  const tableLimit = Math.min(Math.max(parseInt(opts.tableLimit, 10) || 2500, 50), 5000);
  const filterParams = [startDate, endDate];
  let filterExtra = ` AND report_date BETWEEN $1::date AND $2::date`;
  filterExtra = appendRollupInventoryFilters(filterParams, filterExtra, opts);
  const kpiFrom = `FROM rollup_kpi_daily WHERE TRUE${filterExtra}`;

  const { rows: totalsRows } = await query(
    `SELECT
       COALESCE(SUM(impressions), 0)::float8 AS impressions,
       COALESCE(SUM(revenue), 0)::float8 AS revenue,
       COALESCE(SUM(viewable_weight), 0)::float8 AS viewable_weight,
       COALESCE(SUM(grain_count), 0)::int AS row_count
     ${kpiFrom}`,
    filterParams
  );
  const t = totalsRows[0] || {};
  let impressions = Number(t.impressions) || 0;
  let revenue = Number(t.revenue) || 0;
  let viewableWeight = Number(t.viewable_weight) || 0;
  let grainCount = Number(t.row_count) || 0;
  if (!grainCount || (impressions <= 0 && revenue <= 0)) return null;

  const { rows: trendRaw } = await query(
    `SELECT
       to_char(report_date, 'YYYY-MM-DD') AS date,
       COALESCE(SUM(revenue), 0)::float8 AS earning,
       COALESCE(SUM(impressions), 0)::float8 AS impressions
     ${kpiFrom}
     GROUP BY report_date
     ORDER BY report_date`,
    filterParams
  );
  const trend = trendRaw.map((r) => ({
    date: r.date,
    earning: +Number(r.earning).toFixed(2),
    impressions: Math.round(Number(r.impressions) || 0),
  }));

  const { rows: domainRaw } = await query(
    `SELECT
       NULLIF(TRIM(inv_domain), '') AS name,
       COALESCE(SUM(revenue), 0)::float8 AS value
     ${kpiFrom}
     GROUP BY 1
     HAVING NULLIF(TRIM(inv_domain), '') IS NOT NULL
     ORDER BY value DESC
     LIMIT 10`,
    filterParams
  );
  let revenueShare = domainRaw
    .map((r) => ({ name: String(r.name || '').trim(), value: +Number(r.value || 0).toFixed(2) }))
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
    const rev = Number(e.revenue) || 0;
    const imp = Number(e.impressions) || 0;
    return {
      name: String(e.name || '').trim(),
      revenue: +rev.toFixed(2),
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

  const { rows: tableRaw } = await query(
    `SELECT
       to_char(report_date, 'YYYY-MM-DD') AS report_date,
       inv_domain AS domain_name,
       inv_site AS site_url,
       inv_ad_unit AS ad_unit,
       inv_app AS app_id,
       COALESCE(SUM(impressions), 0)::float8 AS impression,
       COALESCE(SUM(revenue), 0)::float8 AS revenue_raw,
       CASE
         WHEN SUM(impressions) > 0 THEN SUM(viewable_weight) / SUM(impressions)
         ELSE 0
       END AS viewable_raw,
       MAX(currency) AS currency
     ${kpiFrom}
     GROUP BY report_date, inv_domain, inv_site, inv_ad_unit, inv_app
     ORDER BY SUM(revenue) DESC
     LIMIT ${tableLimit}`,
    filterParams
  );

  const tableRows = tableRaw.map((r) => {
    const impression = Math.round(Number(r.impression) || 0);
    const rev = +Number(r.revenue_raw || 0).toFixed(2);
    let viewableRate = Number(r.viewable_raw) || 0;
    if (viewableRate > 0 && viewableRate <= 1) viewableRate = +(viewableRate * 100).toFixed(2);
    else viewableRate = +Number(viewableRate || 0).toFixed(2);
    const adUnit = r.ad_unit || '';
    const domainName = r.domain_name || '';
    const siteUrl = r.site_url || '';
    const appId = r.app_id || '';
    return {
      date: r.report_date,
      report_date: r.report_date,
      country: '',
      device: '',
      site: adUnit || '—',
      AD_UNIT_NAME: adUnit,
      ad_unit_name: adUnit,
      domainName,
      domain: domainName,
      siteUrl,
      gamSite: siteUrl,
      siteName: siteUrl,
      appId,
      appPackage: appId,
      impression,
      revenue: rev,
      viewableRate,
      ecpm: impression > 0 && rev > 0 ? +((rev / impression) * 1000).toFixed(2) : 0,
      currency: r.currency || 'USD',
    };
  });

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
    clicks: 0,
    clicksChange: 0,
    revenue: +Number(revenue).toFixed(2),
    revenueChange: 0,
    ecpm: impressions > 0 ? +((revenue / impressions) * 1000).toFixed(2) : 0,
    ecpmChange: 0,
    viewability,
    viewabilityChange: 0,
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
 * Dashboard miss path without shipping hundreds of thousands of grain rows:
 * SQL aggregates for KPIs/charts + a capped collapsed table payload.
 * Prefer rollups; fall back to lean grain JSONB aggregates.
 * Returns null when lean tables have no metric rows for the range.
 */
async function fetchLeanDashboardBundleFromDB(startDate, endDate, opts = {}) {
  try {
    const rolled = await fetchDashboardBundleFromRollups(startDate, endDate, opts);
    if (rolled) return rolled;
  } catch (e) {
    logger.warn('Dashboard rollup bundle failed, falling back to grain:', e.message);
  }

  const today = todayInTZ();
  const tableLimit = Math.min(Math.max(parseInt(opts.tableLimit, 10) || 2500, 50), 5000);
  const m = leanMetricSql();

  const buildFromClause = (table, from, to, baseParams) => {
    const params = [...baseParams, from, to];
    const dateIdx = params.length;
    let extra = ` AND report_date BETWEEN $${dateIdx - 1}::date AND $${dateIdx}::date`;
    extra = appendLeanInventoryFilters(params, extra, opts);
    return {
      sql: `FROM ${table} WHERE TRUE${extra}`,
      params,
    };
  };

  const branches = [];
  if (rangeIncludesToday(startDate, endDate)) {
    branches.push(buildFromClause('report_present', today, today, []));
  }
  const pastEnd = endDate < today ? endDate : shiftDate(today, -1);
  if (startDate <= pastEnd) {
    branches.push(buildFromClause('report_daily', startDate, pastEnd, []));
  }
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
      COUNT(*)::int AS row_count
  `);
  let impressions = 0;
  let revenue = 0;
  let viewableWeight = 0;
  let grainCount = 0;
  for (const t of totalsRows) {
    impressions += Number(t.impressions) || 0;
    revenue += Number(t.revenue) || 0;
    viewableWeight += Number(t.viewable_weight) || 0;
    grainCount += Number(t.row_count) || 0;
  }
  if (!grainCount || (impressions <= 0 && revenue <= 0)) return null;

  const trendRaw = await runAgg(`
    SELECT
      to_char(report_date, 'YYYY-MM-DD') AS date,
      COALESCE(SUM(${m.revenueExpr}), 0)::float8 AS earning,
      COALESCE(SUM(${m.impressionExpr}), 0)::float8 AS impressions
    `, 'GROUP BY report_date');
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

  // Collapse country×device grain for the table — hard-cap in SQL so Node never holds 100k+ groups.
  const tableRaw = await runAgg(`
    SELECT
      to_char(report_date, 'YYYY-MM-DD') AS report_date,
      ${m.domainExpr} AS domain_name,
      ${m.siteExpr} AS site_url,
      ${m.adUnitExpr} AS ad_unit,
      ${m.appExpr} AS app_id,
      COALESCE(SUM(${m.impressionExpr}), 0)::float8 AS impression,
      COALESCE(SUM(${m.revenueExpr}), 0)::float8 AS revenue_raw,
      CASE
        WHEN SUM(${m.impressionExpr}) > 0
          THEN SUM((${m.impressionExpr}) * (${m.viewablePctExpr})) / SUM(${m.impressionExpr})
        ELSE 0
      END AS viewable_raw,
      MAX(currency) AS currency
    `, `GROUP BY report_date, ${m.domainExpr}, ${m.siteExpr}, ${m.adUnitExpr}, ${m.appExpr}
       ORDER BY SUM(${m.revenueExpr}) DESC
       LIMIT ${tableLimit}`);

  tableRaw.sort((a, b) => (Number(b.revenue_raw) || 0) - (Number(a.revenue_raw) || 0));
  const tableRows = tableRaw.slice(0, tableLimit).map((r) => {
    const impression = Math.round(Number(r.impression) || 0);
    const revenueRow = +Number(r.revenue_raw || 0).toFixed(2);
    let viewableRate = Number(r.viewable_raw) || 0;
    if (viewableRate > 0 && viewableRate <= 1) viewableRate = +(viewableRate * 100).toFixed(2);
    else viewableRate = +Number(viewableRate || 0).toFixed(2);
    const adUnit = r.ad_unit || '';
    const domainName = r.domain_name || '';
    const siteUrl = r.site_url || '';
    const appId = r.app_id || '';
    return {
      date: r.report_date,
      report_date: r.report_date,
      country: '',
      device: '',
      site: adUnit || '—',
      AD_UNIT_NAME: adUnit,
      ad_unit_name: adUnit,
      domainName,
      domain: domainName,
      siteUrl,
      gamSite: siteUrl,
      siteName: siteUrl,
      appId,
      appPackage: appId,
      impression,
      revenue: revenueRow,
      viewableRate,
      ecpm: impression > 0 && revenueRow > 0 ? +((revenueRow / impression) * 1000).toFixed(2) : 0,
      currency: r.currency || 'USD',
    };
  });

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
    clicks: 0,
    clicksChange: 0,
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

function normalizeGAMRows(rawRows, currency = 'USD') {
  return rawRows.map((row) => {
    const dimensions = {};
    const metrics = {};
    for (const [k, v] of Object.entries(row)) {
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
    // Always attach inventory filter fields (domain / site URL / ad unit / app).
    const { dimensions: enriched } = attachInventoryDimensions(dimensions);
    return { report_date, dimensions: enriched, metrics, currency };
  });
}

/**
 * Preferred → fallback dimension sets for cron / historical sync.
 * Include inventory dims used by dashboard filters when GAM allows the combo.
 */
const SYNC_DIMENSION_SETS = [
  ['DATE', 'COUNTRY_NAME', 'DEVICE_CATEGORY_NAME', 'AD_UNIT_NAME', 'SITE_NAME', 'MOBILE_APP_NAME'],
  ['DATE', 'COUNTRY_NAME', 'DEVICE_CATEGORY_NAME', 'AD_UNIT_NAME', 'SITE_NAME'],
  ['DATE', 'COUNTRY_NAME', 'DEVICE_CATEGORY_NAME', 'AD_UNIT_NAME', 'DOMAIN'],
  ['DATE', 'COUNTRY_NAME', 'DEVICE_CATEGORY_NAME', 'AD_UNIT_NAME', 'MOBILE_APP_NAME'],
  ['DATE', 'COUNTRY_NAME', 'DEVICE_CATEGORY_NAME', 'AD_UNIT_NAME'],
  ['DATE', 'COUNTRY_NAME', 'DEVICE_CATEGORY_NAME'],
  ['DATE', 'COUNTRY_NAME', 'AD_UNIT_NAME'],
  ['DATE', 'DEVICE_CATEGORY_NAME', 'AD_UNIT_NAME'],
  ['DATE', 'AD_UNIT_NAME'],
];

function buildSyncReportXML(dimensions, buildDateXML, startDate, endDate) {
  const dimXML = dimensions.map((d) => `<dimensions>${d}</dimensions>`).join('\n    ');
  return `
    ${dimXML}
    <columns>TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS</columns>
    <columns>TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE</columns>
    <columns>TOTAL_LINE_ITEM_LEVEL_ALL_REVENUE</columns>
    <columns>TOTAL_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE</columns>
    ${buildDateXML(startDate, endDate)}
    <dateRangeType>CUSTOM_DATE</dateRangeType>`;
}

async function fetchFromGAM(startDate, endDate) {
  const helpers = require('../routes/reports').__gamHelpers;
  if (!helpers) {
    throw new Error('GAM helpers unavailable');
  }
  const { getToken, runReportAndDownload, buildDateXML } = helpers;
  const token = await getToken();
  let lastErr;
  for (const dims of SYNC_DIMENSION_SETS) {
    try {
      const xml = buildSyncReportXML(dims, buildDateXML, startDate, endDate);
      const raw = await runReportAndDownload(xml, token);
      if (Array.isArray(raw) && raw.length) {
        logger.info(`GAM sync OK dims=[${dims.join(', ')}] rows=${raw.length} range=${startDate}..${endDate}`);
        return raw;
      }
      logger.warn(`GAM sync dims=[${dims.join(', ')}] returned 0 rows, trying fallback`);
    } catch (err) {
      lastErr = err;
      logger.warn(`GAM sync dims=[${dims.join(', ')}] failed: ${err.message}`);
    }
  }
  throw lastErr || new Error('GAM sync failed for all dimension sets');
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
  return tableHasCountryAndDevice('report_daily');
}

/** True when today's present snapshot already carries country + device dimensions. */
async function presentHasCountryAndDevice() {
  const today = todayInTZ();
  try {
    const { rows } = await query(
      `SELECT 1 AS ok
       FROM report_present
       WHERE report_date = $1::date
         AND ${RICH_DIM_SQL}
       LIMIT 1`,
      [today]
    );
    return rows.length > 0;
  } catch (e) {
    logger.warn('report_present country/device check failed:', e.message);
    return false;
  }
}

/**
 * Calendar dates in [startDate, endDate] that lack country+device in report_daily.
 * Used to decide whether 7d / 30d / last-month history needs a re-fetch.
 */
async function listDatesMissingRichDims(startDate, endDate) {
  try {
    const { rows } = await query(
      `WITH days AS (
         SELECT generate_series($1::date, $2::date, interval '1 day')::date AS d
       )
       SELECT to_char(days.d, 'YYYY-MM-DD') AS report_date
       FROM days
       LEFT JOIN (
         SELECT DISTINCT report_date
         FROM report_daily
         WHERE report_date BETWEEN $1 AND $2
           AND ${RICH_DIM_SQL}
       ) rich ON rich.report_date = days.d
       WHERE rich.report_date IS NULL
       ORDER BY 1`,
      [startDate, endDate]
    );
    return rows.map((r) => r.report_date);
  } catch (e) {
    logger.warn('listDatesMissingRichDims failed:', e.message);
    return [];
  }
}

/**
 * True when every day in [startDate, endDate] is covered:
 *   today → report_present (rich dims)
 *   past  → report_daily (rich dims)
 * Used so dashboard/report APIs can serve from Postgres instead of live GAM.
 */
async function hasCompleteDbCoverage(startDate, endDate) {
  if (!startDate || !endDate || startDate > endDate) return false;
  const today = todayInTZ();

  const pastEnd = endDate < today ? endDate : shiftDate(today, -1);
  if (startDate <= pastEnd) {
    const missing = await listDatesMissingRichDims(startDate, pastEnd);
    if (missing.length) return false;
  }

  if (startDate <= today && endDate >= today) {
    try {
      const { rows } = await query(
        `SELECT 1 AS ok
         FROM report_present
         WHERE report_date = $1
           AND ${RICH_DIM_SQL}
         LIMIT 1`,
        [today]
      );
      if (!rows.length) return false;
    } catch (e) {
      logger.warn('hasCompleteDbCoverage present check failed:', e.message);
      return false;
    }
  }

  return true;
}

/**
 * Pull a date range from GAM and write into the correct table(s).
 * Processes one calendar day at a time so 7d/30d/last-month backfills stay reliable.
 */
async function syncDateRangeFromGAM(startDate, endDate, syncType = 'sync-backfill') {
  const currency = process.env.GAM_CURRENCY || 'USD';
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
      const raw = await fetchFromGAM(day, day);
      const normalized = normalizeGAMRows(raw, currency);
      // Today always lands in report_present; past days in report_daily.
      if (day === today) {
        total += await replacePresentRows(normalized, `${syncType}:${day}`);
      } else {
        total += await replaceHistoricalRows(normalized, `${syncType}:${day}`);
      }
      // Multi-day: defer invalidation to once at end (avoids N× SCAN/INCR storms).
      if (days.length === 1) await invalidateCacheForDate(day);
      logger.info(`[${syncType}] day ${day} → ${day === today ? 'report_present' : 'report_daily'} (${normalized.length} rows)`);
    } catch (e) {
      logger.error(`[${syncType}] day ${day} failed:`, e.message);
      throw e;
    }
  }
  if (days.length > 1) {
    await invalidateCacheForDate(endDate);
  }
  return total;
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
 * Stable hash for a Reporting-page query (dims/metrics/filters/date range).
 * Used as the key into report_adhoc / report_adhoc_coverage.
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
    part(filters.domain),
    part(filters.site),
    part(filters.domainName),
    part(filters.domainId),
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
  const helpers = require('../routes/reports').__gamHelpers;
  if (!helpers) throw new Error('GAM helpers unavailable');
  const { getToken, runReportAndDownload, buildDateXML } = helpers;
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

  // Stored revenue is typically micros from GAM Column.*; convert when large.
  let revenue = revenueRaw;
  if (Math.abs(revenue) >= 1000) revenue = +(revenue / 1e6).toFixed(2);
  else revenue = +Number(revenue).toFixed(2);
  impressions = Math.round(impressions);

  const trendRaw = await runAgg(`
    SELECT
      to_char(report_date, 'YYYY-MM-DD') AS date,
      COALESCE(SUM(${revExpr}), 0)::float8 AS earning_raw,
      COALESCE(SUM(${impExpr}), 0)::float8 AS impressions
    `, 'GROUP BY report_date');
  const trendMap = new Map();
  for (const r of trendRaw) {
    let earning = Number(r.earning_raw) || 0;
    if (Math.abs(earning) >= 1000) earning = +(earning / 1e6).toFixed(2);
    else earning = +earning.toFixed(2);
    const prev = trendMap.get(r.date) || { date: r.date, earning: 0, impressions: 0 };
    prev.earning = +(prev.earning + earning).toFixed(2);
    prev.impressions += Math.round(Number(r.impressions) || 0);
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
      totalDomains: new Set(rows.map((r) => r.site).filter(Boolean)).size
        + new Set(rows.map((r) => r.appId).filter(Boolean)).size,
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
  fetchFullReportBundleFromDB,
  pickBestFullSlice,
  rebuildRollupsForDates,
  backfillAllRollups,
  rowsHaveLeanMetrics,
  fetchFromGAM,
  syncDateRangeFromGAM,
  dailyHasCountryAndDevice,
  presentHasCountryAndDevice,
  listDatesMissingRichDims,
  hasCompleteDbCoverage,
  normalizeGAMRows,
  invalidateCacheForDate,
  logSync,
  dimHash,
  getReportRange,
  SYNC_DIMENSION_SETS,
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
};
