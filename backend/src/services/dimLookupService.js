/**
 * Resolve GAM dimension strings → lookup table IDs for typed report_grain storage.
 */
const { schemaQuery, query } = require('../db');
const { requireClientId } = require('../utils/clientContext');
const { parseGamMetricValue, gamMoneyToDollars } = require('../utils/gamReportMetrics');
const logger = require('../utils/logger');

const countryCache = new Map();
const deviceCache = new Map();
const adUnitCache = new Map();
const domainCache = new Map();
const siteCache = new Map();

let nextCountryId = 1;
let nextDeviceId = 1;

function normName(v) {
  return String(v || '').trim();
}

function cacheKey(clientId, name) {
  return `${clientId}\0${normName(name).toLowerCase()}`;
}

async function loadCountryDeviceIds() {
  try {
    const { rows: countries } = await schemaQuery('SELECT id, name FROM dim_country');
    for (const r of countries) {
      countryCache.set(normName(r.name).toLowerCase(), r.id);
      if (r.id >= nextCountryId) nextCountryId = r.id + 1;
    }
    const { rows: devices } = await schemaQuery('SELECT id, name FROM dim_device');
    for (const r of devices) {
      deviceCache.set(normName(r.name).toLowerCase(), r.id);
      if (r.id >= nextDeviceId) nextDeviceId = r.id + 1;
    }
  } catch (e) {
    logger.warn('dimLookupService: loadCountryDeviceIds failed:', e.message);
  }
}

loadCountryDeviceIds().catch(() => {});

async function resolveCountryId(name) {
  const n = normName(name);
  if (!n) return 0;
  const key = n.toLowerCase();
  if (countryCache.has(key)) return countryCache.get(key);

  const { rows: existing } = await schemaQuery(
    'SELECT id FROM dim_country WHERE LOWER(name) = LOWER($1) LIMIT 1',
    [n]
  );
  if (existing[0]) {
    countryCache.set(key, existing[0].id);
    return existing[0].id;
  }

  const { rows: maxRows } = await schemaQuery(
    'SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM dim_country WHERE id > 0 AND id < 30000'
  );
  const id = maxRows[0]?.next_id || nextCountryId++;
  await schemaQuery(
    'INSERT INTO dim_country (id, name) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
    [id, n]
  );
  const { rows: final } = await schemaQuery(
    'SELECT id FROM dim_country WHERE LOWER(name) = LOWER($1) LIMIT 1',
    [n]
  );
  const resolved = final[0]?.id || id;
  countryCache.set(key, resolved);
  return resolved;
}

async function resolveDeviceId(name) {
  const n = normName(name);
  if (!n) return 0;
  const key = n.toLowerCase();
  if (deviceCache.has(key)) return deviceCache.get(key);

  const { rows: existing } = await schemaQuery(
    'SELECT id FROM dim_device WHERE LOWER(name) = LOWER($1) LIMIT 1',
    [n]
  );
  if (existing[0]) {
    deviceCache.set(key, existing[0].id);
    return existing[0].id;
  }

  const { rows: maxRows } = await schemaQuery(
    'SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM dim_device WHERE id > 0 AND id < 30000'
  );
  const id = maxRows[0]?.next_id || nextDeviceId++;
  await schemaQuery(
    'INSERT INTO dim_device (id, name) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
    [id, n]
  );
  const { rows: final } = await schemaQuery(
    'SELECT id FROM dim_device WHERE LOWER(name) = LOWER($1) LIMIT 1',
    [n]
  );
  const resolved = final[0]?.id || id;
  deviceCache.set(key, resolved);
  return resolved;
}

async function resolveClientDimId(table, clientId, name) {
  const n = normName(name);
  if (!n) return 0;
  const ck = cacheKey(clientId, n);
  const cache = table === 'ad_unit' ? adUnitCache
    : table === 'domain' ? domainCache : siteCache;
  if (cache.has(ck)) return cache.get(ck);

  const tableName = table === 'ad_unit' ? 'dim_ad_unit'
    : table === 'domain' ? 'dim_domain' : 'dim_site';

  const { rows } = await query(
    `INSERT INTO ${tableName} (client_id, name) VALUES ($1::uuid, $2)
     ON CONFLICT (client_id, name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [clientId, n]
  );
  const id = rows[0]?.id || 0;
  cache.set(ck, id);
  return id;
}

async function resolveAdUnitId(clientId, name) {
  return resolveClientDimId('ad_unit', clientId, name);
}

async function resolveDomainId(clientId, name) {
  return resolveClientDimId('domain', clientId, name);
}

async function resolveSiteId(clientId, name) {
  return resolveClientDimId('site', clientId, name);
}

function dimFromRow(dimensions = {}) {
  const d = dimensions || {};
  return {
    country: normName(d.COUNTRY_NAME || d.country_name || d.country),
    device: normName(d.DEVICE_CATEGORY_NAME || d.device_category_name || d.device),
    adUnit: normName(d.AD_UNIT_NAME || d.ad_unit_name || d.site),
    domain: normName(d.DOMAIN || d.domain || d.domainName),
    site: normName(d.SITE_NAME || d.site_name || d.siteUrl || d.gamSite || d.URL_NAME || d.url_name),
    channel: normName(d.PROGRAMMATIC_CHANNEL_NAME || d.programmatic_channel_name),
    appName: normName(d.MOBILE_APP_NAME || d.mobile_app_name || d.appName),
    appId: normName(d.MOBILE_APP_RESOLVED_ID || d.mobile_app_resolved_id || d.appPackage || d.appId),
  };
}

function pickMetric(m, apiKey, ...fallbackKeys) {
  const keys = [apiKey, ...fallbackKeys];
  for (const k of keys) {
    const v = m[k];
    if (v != null && v !== '') return v;
  }
  return 0;
}

/** Sync path stores dollars. Values may already be converted by parseGamMetricValue. */
function moneyFromMetric(m, ...keys) {
  for (const k of keys) {
    const v = m[k];
    if (v == null || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n === 0) continue;
    const abs = Math.abs(n);
    // Already dollars (fractional cents).
    if (n !== Math.floor(n)) return +n.toFixed(4);
    // Raw sub-$1 micros left untouched by parseGamMetricValue (1000..999999).
    if (abs >= 1000 && abs < 1e6) return +(n / 1e6).toFixed(4);
    // Whole dollars from parseGamMetricValue (e.g. 5 from 5_000_000 micros) — keep.
    // Do NOT divide again (that zeroed most ≥$1 line items).
    return +n.toFixed(4);
  }
  return 0;
}

function metricsFromRow(metrics = {}) {
  const m = metrics || {};

  const impressions = Math.round(parseGamMetricValue(
    'TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS',
    pickMetric(m, 'TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS', 'impression', 'impressions')
  ) || 0);

  const clicks = Math.round(parseGamMetricValue(
    'TOTAL_LINE_ITEM_LEVEL_CLICKS',
    pickMetric(m, 'TOTAL_LINE_ITEM_LEVEL_CLICKS', 'clicks')
  ) || 0);

  let revenue = moneyFromMetric(
    m,
    'revenue',
    'TOTAL_LINE_ITEM_LEVEL_ALL_REVENUE',
    'TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE'
  );
  if (!Number.isFinite(revenue)) revenue = 0;

  let viewablePct = parseGamMetricValue(
    'TOTAL_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE',
    pickMetric(m, 'TOTAL_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE', 'viewableRate')
  ) || 0;
  if (viewablePct > 0 && viewablePct <= 1) viewablePct *= 100;

  let ecpm = parseGamMetricValue(
    'TOTAL_LINE_ITEM_LEVEL_WITHOUT_CPD_AVERAGE_ECPM',
    pickMetric(m, 'TOTAL_LINE_ITEM_LEVEL_WITHOUT_CPD_AVERAGE_ECPM', 'ecpm')
  ) || 0;
  if (ecpm >= 1000) ecpm = ecpm / 1_000_000;
  if ((!ecpm || ecpm === 0) && impressions > 0 && revenue > 0) {
    ecpm = +((revenue / impressions) * 1000).toFixed(4);
  }

  const unfilled = Math.round(parseGamMetricValue(
    'TOTAL_INVENTORY_LEVEL_UNFILLED_IMPRESSIONS',
    pickMetric(m, 'TOTAL_INVENTORY_LEVEL_UNFILLED_IMPRESSIONS', 'unfilled')
  ) || 0);

  return { impressions, clicks, revenue, viewablePct, ecpm, unfilled };
}

/**
 * Convert a normalized GAM sync row → typed grain insert tuple.
 */
async function normalizeRowToGrain(row, clientId) {
  const dims = dimFromRow(row.dimensions);
  const met = metricsFromRow(row.metrics);
  const cid = clientId || requireClientId();

  const [countryId, deviceId, adUnitId, domainId, siteId] = await Promise.all([
    resolveCountryId(dims.country),
    resolveDeviceId(dims.device),
    resolveAdUnitId(cid, dims.adUnit),
    resolveDomainId(cid, dims.domain),
    resolveSiteId(cid, dims.site),
  ]);

  return {
    client_id: cid,
    report_date: String(row.report_date || '').slice(0, 10),
    country_id: countryId,
    device_id: deviceId,
    ad_unit_id: adUnitId,
    domain_id: domainId,
    site_id: siteId,
    channel_name: dims.channel || '',
    app_name: dims.appName || '',
    app_id: dims.appId || '',
    slice_key: String(row.slice_key || '').trim() || 'inventory_core',
    impressions: met.impressions,
    clicks: met.clicks,
    revenue: met.revenue,
    viewable_pct: met.viewablePct || null,
    ecpm: met.ecpm || null,
    unfilled: met.unfilled || null,
    currency: row.currency || 'USD',
  };
}

/**
 * Parse legacy JSONB row (report_daily/present) → grain tuple.
 */
async function jsonbRowToGrain(dbRow, clientId) {
  const dimensions = typeof dbRow.dimensions === 'string'
    ? JSON.parse(dbRow.dimensions) : (dbRow.dimensions || {});
  const metrics = typeof dbRow.metrics === 'string'
    ? JSON.parse(dbRow.metrics) : (dbRow.metrics || {});
  return normalizeRowToGrain({
    report_date: dbRow.report_date,
    dimensions,
    metrics,
    currency: dbRow.currency,
  }, clientId);
}

function grainRowToLegacyDimensions(grainRow, lookups = {}) {
  const { country = '', device = '', adUnit = '', domain = '', site = '' } = lookups;
  return {
    DATE: grainRow.report_date,
    COUNTRY_NAME: country,
    DEVICE_CATEGORY_NAME: device,
    AD_UNIT_NAME: adUnit,
    DOMAIN: domain,
    SITE_NAME: site,
    domainName: domain,
    siteUrl: site,
    PROGRAMMATIC_CHANNEL_NAME: grainRow.channel_name || '',
    MOBILE_APP_NAME: grainRow.app_name || '',
    MOBILE_APP_RESOLVED_ID: grainRow.app_id || '',
  };
}

function grainRowToLegacyMetrics(grainRow) {
  return {
    TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS: grainRow.impressions,
    TOTAL_LINE_ITEM_LEVEL_CLICKS: grainRow.clicks,
    TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE: grainRow.revenue,
    TOTAL_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE: grainRow.viewable_pct,
    TOTAL_LINE_ITEM_LEVEL_WITHOUT_CPD_AVERAGE_ECPM: grainRow.ecpm,
    impression: grainRow.impressions,
    revenue: grainRow.revenue,
    clicks: grainRow.clicks,
  };
}

module.exports = {
  resolveCountryId,
  resolveDeviceId,
  resolveAdUnitId,
  resolveDomainId,
  resolveSiteId,
  normalizeRowToGrain,
  jsonbRowToGrain,
  grainRowToLegacyDimensions,
  grainRowToLegacyMetrics,
  dimFromRow,
  metricsFromRow,
};
