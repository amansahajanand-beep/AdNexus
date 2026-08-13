const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { cache } = require('../gamClient');
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const {
  scopeRowsToUser,
  applyScopedOverviewSiteTightening,
  trendFromRows,
  buildVisibility,
  canAccessPage,
  scopeCatalogOptionsForUser,
  getUserInventoryScope,
  userHasAssignedInventory,
  resolveScopedSqlInventoryOpts,
} = require('../utils/permissions');
const { todayInTZ, dateRangeInTZ, dateRangeYMDInTZ } = require('../utils/datetime');
const { resolveAppFields, buildAppPackageMapsFromGamRows, buildAppPackageMapsFromMobileApps, mergeAppPackageMapData, mapsToPlain, packageListFromMapData, enrichRowsWithAppPackages, rehydrateAppPackageMaps, isLikelyAppPackage, isMobileAppRow } = require('../utils/appIdentity');
const { domainFromAdUnit, enrichReportRow, resolveInventoryFields, rootDomainFromHost, pickSiteHost, adUnitAlignsWithSiteHost } = require('../utils/adUnit');
const {
  findCachedInventoryRows,
  dedupeCatalogRows,
  enrichCatalogRow,
  CATALOG_CACHE_KEY,
  mapGamRowInventory,
  buildAdUnitNameToIdMap,
  buildReportSiteMap,
  mergeUrlScanIntoCatalog,
  buildAdUnitsByHost,
  augmentAdUnitsByHost,
  findCachedAdUnitsByHost,
  applyCatalogSiteHosts,
  supplementCatalogWithSites,
  buildCatalogFilterOptions,
  collectHostsFromRawReport,
  buildDomainUserSiteContext,
  buildAssignedAdUnitHostMap,
  buildAdUnitSiteMapFromUrlScan,
  buildFilterAdUnitHostMap,
  fillAssignedSiteHostsForRows,
  sanitizeRowsSiteHosts,
} = require('../utils/inventoryCatalog');
const { fetchGAMInventoryData } = require('../utils/gamInventoryServices');
const { paginateRows, parsePaginationQuery } = require('../utils/pagination');
const { applyDateRestrictionToFilters } = require('../utils/dateRestriction');
const {
  aggregateDomainUserRows,
  filterDomainUserRows,
  summarizeDomainUserRows,
  enrichRowsWithCatalogSites,
} = require('../utils/domainUserAggregate');
const { getReportRange } = require('../services/gamSyncService');
const {
  rowMatchesInventoryFilters,
  hasInventoryFilters,
  filterRowsByInventory,
  toFilterArray,
  lookupCatalogAdUnitHost,
  rowMatchesAppFilter,
  inventoryFilterFamilyLabels,
  hasMixedWebAndAppFilters,
} = require('../utils/inventoryFilters');
const { normalizeReportRows, rowsHaveMetrics } = require('../utils/rowNormalize');
const { kvGet, kvSet } = require('../utils/kvCache');
const {
  catalogIdToGamEnum,
  attachMetricsToRows,
  attachDimensionsToRows,
  parseMetricsFromGamRow,
  parseDimensionsFromGamRow,
  parseAllDimensionsFromGamRow,
  syncLegacyFields,
  pickRowRevenueDollars,
} = require('../utils/gamReportMetrics');

const { isMockClient, getClient, getClientId } = require('../utils/clientContext');

// ─── Redis + PostgreSQL helpers (graceful — if not configured, fall through to GAM) ─
let _redis = null, _db = null, _syncSvc = null, _gamSyncQueue = null;
function getRedis() {
  if (!_redis) try { _redis = require('../redisClient'); } catch (_) {}
  return _redis;
}
function getDB() {
  if (!_db) try { _db = require('../db'); } catch (_) {}
  return _db;
}
function getSyncSvc() {
  if (!_syncSvc) try { _syncSvc = require('../services/gamSyncService'); } catch (_) {}
  return _syncSvc;
}
function getQueue() {
  if (!_gamSyncQueue) try { _gamSyncQueue = require('../queues/gamSync').gamSyncQueue; } catch (_) {}
  return _gamSyncQueue;
}

// All report data requires an authenticated dashboard user.
router.use(requireAuth);

/**
 * GET|POST /api/reports/range?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 * Returns rows from Redis or Postgres, or queues an on-demand job when no data exists.
 */
function buildRangeResponse(allRows, filters, user, currency, isMock) {
  const rows = prepareScopedReportRows(allRows, filters, user);
  const trend = trendFromRows(rows);
  const summary = deriveDashboardSummary(rows, trend, currency, isMock);
  const pagination = { totalRows: rows.length, allRows: true };
  return applyVisibility({ summary, rows, trend, isMock, pagination }, user, {});
}

async function handleRangeReport(req, res) {
  const { startDate, endDate } = req.query || {};
  if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate are required (YYYY-MM-DD)' });
  try {
    logger.info('handleRangeReport called', { startDate, endDate, userId: req.user?.id });
    if (isMockClient()) {
      const base = mockDetailed(req.query);
      return res.json(buildRangeResponse(base.rows, req.query, req.user, 'USD', true));
    }

      const { rows: allRows } = await getReportRange(startDate, endDate, req.user?.id);
      const currency = process.env.GAM_CURRENCY || null;
      const preparedRows = Array.isArray(allRows) ? normalizeReportRows(allRows) : [];
      logger.info('handleRangeReport normalized rows', { normalizedCount: preparedRows.length });
      return res.json(buildRangeResponse(preparedRows, req.query, req.user, currency, false));
  } catch (e) {
    logger.error('Range report error:', e.message);
    return res.status(500).json({ error: 'Failed to fetch report range' });
  }
}
registerFilterReportRoute('/range', handleRangeReport);

/** Merge JSON body into req.query for POST report requests (large filter lists). */
function mergePostFilters(req, res, next) {
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    Object.assign(req.query, req.body);
  }
  next();
}

function registerFilterReportRoute(path, handler) {
  router.get(path, handler);
  router.post(path, mergePostFilters, handler);
}

// ─── Mock data generators ─────────────────────────────────────────────────────
function mockSummary() {
  return {
    revenue: (Math.random() * 200000 + 300000).toFixed(2),
    impressions: Math.floor(Math.random() * 500000000 + 2000000000),
    clicks: Math.floor(Math.random() * 5000000 + 7000000),
    ctr: (Math.random() * 0.1 + 0.28).toFixed(4),
    fillRate: (Math.random() * 5 + 83).toFixed(1),
    ecpm: (Math.random() * 50 + 150).toFixed(2),
    revenueChange: +(Math.random() * 20 - 5).toFixed(1),
    impressionsChange: +(Math.random() * 15 - 3).toFixed(1),
    clicksChange: +(Math.random() * 10 - 4).toFixed(1),
    ctrChange: +(Math.random() * 0.05 - 0.01).toFixed(2),
    fillRateChange: +(Math.random() * 4 - 1).toFixed(1),
    ecpmChange: +(Math.random() * 10 - 2).toFixed(1),
    isMock: true
  };
}

function mockTrend(days, metric) {
  const result = [];
  const now = new Date();
  let base = metric === 'revenue' ? 12000 : metric === 'impressions' ? 90000000 : 0.003;
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    base = base * (1 + (Math.random() * 0.1 - 0.04));
    result.push({ date: dateStr, value: +base.toFixed(metric === 'ctr' ? 5 : 0) });
  }
  return result;
}

function mockAdTypes() {
  return [
    { name: 'Display', revenue: 198450, impressions: 1120000000 },
    { name: 'Video', revenue: 147200, impressions: 872000000 },
    { name: 'Native', revenue: 84600, impressions: 510000000 },
    { name: 'Mobile', revenue: 52300, impressions: 340000000 },
    { name: 'Interstitial', revenue: 31800, impressions: 180000000 },
  ];
}

function mockAdvertisers() {
  return [
    { name: 'Flipkart', revenue: 124000, impressions: 284000000, clicks: 912000 },
    { name: 'Amazon India', revenue: 101000, impressions: 196000000, clicks: 620000 },
    { name: 'HDFC Bank', revenue: 78000, impressions: 142000000, clicks: 398000 },
    { name: 'Swiggy', revenue: 52000, impressions: 98000000, clicks: 288000 },
    { name: "Byju's", revenue: 46000, impressions: 89000000, clicks: 242000 },
    { name: 'MakeMyTrip', revenue: 39000, impressions: 76000000, clicks: 198000 },
    { name: 'OnePlus India', revenue: 35000, impressions: 68000000, clicks: 188000 },
    { name: 'LIC', revenue: 28000, impressions: 52000000, clicks: 134000 },
  ];
}

// ─── REAL API helpers ─────────────────────────────────────────────────────────

// Cache OAuth access token for 55 min (tokens expire after 60 min).
// This avoids one Google OAuth round-trip (~300ms) on every uncached GAM request.
const _tokenCache = new Map();

async function getToken() {
  const now = Date.now();
  const cacheId = getClientId() || 'env';
  const hit = _tokenCache.get(cacheId);
  if (hit && now < hit.expiry) {
    logger.info('OAuth token: cache hit');
    return hit.token;
  }
  const t0 = Date.now();
  const { getGAMClient } = require('../gamClient');
  const auth = await getGAMClient();
  const t = await auth.getAccessToken();
  _tokenCache.set(cacheId, { token: t.token, expiry: now + 55 * 60 * 1000 });
  logger.info(`OAuth token: fetched from Google in ${Date.now() - t0}ms`);
  return t.token;
}

const axios = require('axios');
const { GAM_API_VERSION: API_VER } = require('../utils/gamVersion');
const NETWORK_CODE = () => (getClient()?.networkCode || process.env.GAM_NETWORK_CODE);

function reportEnvelope(method, innerXML) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:dfp="https://www.google.com/apis/ads/publisher/${API_VER}">
  <soapenv:Header>
    <dfp:RequestHeader>
      <dfp:networkCode>${NETWORK_CODE()}</dfp:networkCode>
      <dfp:applicationName>AdNexus</dfp:applicationName>
    </dfp:RequestHeader>
  </soapenv:Header>
  <soapenv:Body><${method} xmlns="https://www.google.com/apis/ads/publisher/${API_VER}">${innerXML}</${method}></soapenv:Body>
</soapenv:Envelope>`;
}

function decodeEntities(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}

// Submit a report job, poll until done, return parsed CSV rows
async function runReportAndDownload(reportQueryXML, token, opts = {}) {
  const t0 = Date.now();
  const submitXML = await gamSOAP('ReportService', 'runReportJob', `<reportJob><reportQuery>${reportQueryXML}</reportQuery></reportJob>`, token);
  const jobId = extractTag(submitXML, 'id');
  if (!jobId) throw new Error('Failed to submit report job');
  logger.info(`GAM job submitted id=${jobId} (${Date.now() - t0}ms)`);

  const t1 = Date.now();
  await pollReport(jobId, token, opts);
  logger.info(`GAM job completed id=${jobId} poll=${Date.now() - t1}ms`);

  const t2 = Date.now();
  const dlXML = await gamSOAP('ReportService', 'getReportDownloadUrlWithOptions',
    `<reportJobId>${jobId}</reportJobId><reportDownloadOptions><exportFormat>CSV_DUMP</exportFormat><useGzipCompression>true</useGzipCompression></reportDownloadOptions>`, token);
  let url = extractTag(dlXML, 'rval');
  if (!url) throw new Error('Failed to get report download URL');
  url = decodeEntities(url);

  logger.info(`GAM download URL ready (${Date.now() - t2}ms)`);

  const t3 = Date.now();
  const zlib = require('zlib');
  const csvRes = await axios.get(url, { responseType: 'arraybuffer', timeout: 300000 });
  const buf = Buffer.isBuffer(csvRes.data) ? csvRes.data : Buffer.from(csvRes.data);
  const csvText = await new Promise((resolve, reject) =>
    zlib.gunzip(buf, (err, out) => err ? reject(err) : resolve(out.toString('utf8')))
  );
  const rows = parseCSV(csvText);
  logger.info(`GAM CSV download+parse ${rows.length} rows in ${Date.now() - t3}ms (total job=${Date.now() - t0}ms)`);
  return rows;
}

// Prevent duplicate in-flight GAM jobs for the same cache key.
const inflightReports = new Map();

// TTL for report data: 30 min default, overridable per call.
const REPORT_CACHE_TTL = parseInt(process.env.CACHE_TTL) || 3600;

async function fetchWithDedup(cacheKey, fetchFn, ttl = REPORT_CACHE_TTL) {
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  if (inflightReports.has(cacheKey)) {
    return inflightReports.get(cacheKey);
  }

  const promise = fetchFn()
    .then((result) => {
      cache.set(cacheKey, result, ttl);
      return result;
    })
    .finally(() => inflightReports.delete(cacheKey));

  inflightReports.set(cacheKey, promise);
  return promise;
}

async function gamSOAP(service, method, body, token, retries = 2) {
  const url = `https://ads.google.com/apis/ads/publisher/${API_VER}/${service}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios.post(url, reportEnvelope(method, body), {
        headers: {
          'Content-Type': 'text/xml; charset=UTF-8',
          'SOAPAction': '',
          'Authorization': `Bearer ${token}`
        },
        timeout: 300000, // 5 min
      });
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      // 429 rate limit — wait then retry
      if (status === 429 && attempt < retries) {
        const retryAfter = parseInt(err.response?.headers?.['retry-after'] || '60', 10);
        const wait = Math.min(retryAfter, 120) * 1000;
        logger.warn(`GAM rate limited (429), waiting ${wait / 1000}s before retry ${attempt + 1}/${retries}`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (status === 429) {
        const e = new Error('GAM_RATE_LIMITED');
        e.status = 429;
        throw e;
      }
      // GAM returns the SOAP fault (with the real reason) in the 500 response body.
      const fault = err.response?.data;
      if (fault) {
        const reason = String(fault).match(/<(?:.*:)?errorString>([^<]+)<\/(?:.*:)?errorString>/i)
          || String(fault).match(/<faultstring>([^<]+)<\/faultstring>/i);
        logger.error(`GAM SOAP ${method} fault: ${reason ? reason[1] : String(fault).slice(0, 600)}`);
      }
      throw err;
    }
  }
}

// Date range anchored on "today" in the app timezone (Asia/Singapore).
function getDateRange(days) {
  return dateRangeInTZ(days);
}

function extractTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]+)<\/${tag}>`));
  return m ? m[1].trim() : null;
}

async function pollReport(jobId, token, opts = {}) {
  const fastMode = Boolean(opts.fastMode);
  // Short first delay: most jobs are COMPLETED well before the old 8s sleep.
  // Env override for tuning without redeploying poll logic.
  const firstDelay = Math.max(
    200,
    parseInt(process.env.GAM_REPORT_FIRST_POLL_MS || '400', 10) || 400
  );
  // More attempts than the old schedule because each wait is shorter.
  const maxAttempts = fastMode ? 40 : 80;
  let status = 'IN_PROGRESS', tries = 0;
  while (status === 'IN_PROGRESS' && tries < maxAttempts) {
    const delay = tries === 0
      ? firstDelay
      : tries < 3
        ? (fastMode ? 800 : 1000)
        : tries < 10
          ? (fastMode ? 1200 : 2000)
          : (fastMode ? 1500 : 3000);
    await new Promise(r => setTimeout(r, delay));
    const xml = await gamSOAP('ReportService', 'getReportJobStatus',
      `<reportJobId>${jobId}</reportJobId>`, token);
    status = extractTag(xml, 'rval');
    tries++;
  }
  if (status !== 'COMPLETED') throw new Error(`Report failed: ${status}`);
}

// Split a single CSV line, honoring quoted fields that may contain commas.
// GAM's CSV_DUMP quotes dimension values like MOBILE_APP_NAME ("News, Daily"),
// so a naive split(',') misaligns every column after it and corrupts metrics.
function splitCSVLine(line) {
  const out = [];
  let field = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(field); field = '';
    } else {
      field += c;
    }
  }
  out.push(field);
  return out.map(v => v.trim());
}

function parseCSV(csvText) {
  const lines = csvText.replace(/\r/g, '').trim().split('\n');
  if (lines.length < 2) return [];
  const headers = splitCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const vals = splitCSVLine(line);
    return headers.reduce((o, h, i) => ({ ...o, [h]: vals[i] ?? '' }), {});
  });
}

// Normalize a query param that may arrive as a single value, a repeated key
// (Express → array), or be absent, into a clean array of trimmed strings.
function asArray(v) {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).map(s => String(s).trim()).filter(Boolean);
}

function enrichRowsWithCountryFilter(rows, countryIds) {
  const ids = asArray(countryIds).map(String).filter(Boolean);
  if (!ids.length) return rows;
  const list = cache.get('report_countries') || [];
  const names = ids
    .map((id) => list.find((c) => String(c.id) === id)?.name)
    .filter(Boolean);
  if (!names.length) return rows;
  const label = names.length === 1 ? names[0] : names.join(', ');
  return rows.map((row) => {
    if (row.country || row.dimensions?.country_name) return row;
    return {
      ...row,
      country: label,
      dimensions: { ...(row.dimensions || {}), country_name: label },
    };
  });
}

/** Narrow Postgres rows by country id and/or name (GAM uses criteria ids). */
function filterRowsByCountrySelection(rows, country) {
  const ids = asArray(country).map(String).filter(Boolean);
  if (!ids.length) return rows;
  const list = cache.get('report_countries') || [];
  const names = new Set();
  for (const id of ids) {
    const fromList = list.find((c) => String(c.id) === id)?.name;
    if (fromList) names.add(String(fromList).toLowerCase());
    else if (!/^\d+$/.test(id)) names.add(id.toLowerCase());
  }
  if (!names.size) return null; // cannot map → caller should skip DB
  return rows.filter((r) => {
    const c = String(r.country || r.COUNTRY_NAME || r.country_name || '').toLowerCase();
    return c && names.has(c);
  });
}

function resolveCountryNamesForDb(country) {
  const ids = asArray(country).map(String).filter(Boolean);
  if (!ids.length) return [];
  const list = cache.get('report_countries') || [];
  const names = [];
  for (const id of ids) {
    const fromList = list.find((c) => String(c.id) === id)?.name;
    if (fromList) names.push(String(fromList));
    else if (!/^\d+$/.test(id)) names.push(id);
  }
  return names;
}

/** Build SQL LIKE patterns so inventory filters run in Postgres, not on 100k+ JS rows. */
function buildAdUnitSqlPatterns(filters = {}) {
  const patterns = new Set();
  const addHost = (raw) => {
    const h = String(raw || '').trim().toLowerCase();
    if (!h) return;
    // One contains-pattern per host (avoid 3x explosion which made LIKE ANY tiny-scan slow).
    patterns.add(`%${h}%`);
  };
  for (const d of toFilterArray(filters.domain)) addHost(d);
  for (const s of toFilterArray(filters.site)) addHost(s);
  return [...patterns];
}

function buildExactAdUnitNames(filters = {}) {
  return toFilterArray(filters.domainName)
    .map((s) => String(s || '').trim())
    .filter(Boolean);
}

function buildDomainSiteFilters(filters = {}) {
  return {
    domains: toFilterArray(filters.domain).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean),
    sites: toFilterArray(filters.site).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean),
  };
}

/**
 * Redis/memory already checked by callers.
 * Postgres-first lean read: report_present (today) + report_daily (past).
 * Inventory/country filters are pushed into SQL when possible.
 */
async function tryLoadReportRowsFromDb(startDate, endDate, { country, domain, site, domainName, domainId } = {}) {
  const svc = getSyncSvc();
  if (!svc?.fetchLeanRowsFromDB && !svc?.fetchFromDB) return null;

  // Prefer complete coverage, but still serve whatever lean rows exist so a
  // mid-sync gap never forces a ~70s live GAM round-trip for the dashboard.
  const covered = svc.hasCompleteDbCoverage
    ? await svc.hasCompleteDbCoverage(startDate, endDate)
    : false;

  const countryNames = resolveCountryNamesForDb(country);
  if (asArray(country).length && !countryNames.length) return null;

  const adUnitNames = buildExactAdUnitNames({ domainName });
  const { domains, sites } = buildDomainSiteFilters({ domain, site });
  const apps = toFilterArray(domainId).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
  const adUnitPatterns = (!domains.length && !sites.length && !adUnitNames.length && !apps.length)
    ? buildAdUnitSqlPatterns({ domain, site })
    : [];

  const t0 = Date.now();
  let rows;
  if (svc.fetchLeanRowsFromDB) {
    rows = await svc.fetchLeanRowsFromDB(startDate, endDate, {
      countryNames,
      adUnitNames,
      domains,
      sites,
      apps,
      adUnitPatterns,
    });
    if (svc.rowsHaveLeanMetrics ? !svc.rowsHaveLeanMetrics(rows) : !rowsHaveMetrics(rows)) {
      return null;
    }
  } else {
    const dbRows = await svc.fetchFromDB(startDate, endDate);
    if (!dbRows.length) return null;
    rows = normalizeReportRows(dbRows.map((row) => ({
      ...row.dimensions,
      ...row.metrics,
      report_date: row.report_date,
    })));
    if (!rowsHaveMetrics(rows)) return null;
    if (countryNames.length) {
      const filtered = filterRowsByCountrySelection(rows, country);
      if (filtered == null || !filtered.length) return null;
      rows = filtered;
    }
  }

  if (!covered) {
    logger.info(
      `Postgres lean load ${startDate}..${endDate} → ${rows.length} rows in ${Date.now() - t0}ms`
      + ' (partial coverage — serving DB anyway to avoid GAM)'
    );
  } else {
    logger.info(
      `Postgres lean load ${startDate}..${endDate} → ${rows.length} rows in ${Date.now() - t0}ms`
      + ((domains.length || sites.length || adUnitPatterns.length || adUnitNames.length || apps.length)
        ? ' (SQL inventory filter)' : '')
    );
  }
  return rows;
}

function buildCountryFilter(country) {
  const ids = asArray(country)
    .map((c) => parseInt(c, 10))
    .filter((n) => Number.isFinite(n));
  if (!ids.length) return '';
  if (ids.length === 1) {
    return `\n    <statement><query>WHERE COUNTRY_CRITERIA_ID = ${ids[0]}</query></statement>`;
  }
  return `\n    <statement><query>WHERE COUNTRY_CRITERIA_ID IN (${ids.join(',')})</query></statement>`;
}

// Stable cache key for a filter set (arrays sorted so order doesn't matter).
function filterCacheKey({
  startDate, endDate, country, domainId, domainName, domain, site,
  reportDimensions, reportMetrics,
}) {
  // Upstash Redis rejects keys > 32KB. Full assigned domain/site/app lists
  // easily exceed that when joined with "|", so hash any oversized part.
  const part = (v) => {
    const sorted = asArray(v).map((x) => String(x)).slice().sort();
    const joined = sorted.join('|');
    if (Buffer.byteLength(joined, 'utf8') <= 512) return joined;
    return `h${crypto.createHash('sha256').update(joined).digest('hex').slice(0, 24)}x${sorted.length}`;
  };
  return [
    startDate, endDate, part(country),
    part(domainId), part(domainName), part(domain), part(site),
    part(reportDimensions), part(reportMetrics),
  ].join('_');
}

// ─── Detailed report (mock generator) ─────────────────────────────────────────
// Each entry is one inventory combination so the four levels are clearly
// distinct in mock mode:
//   appId   → App ID    (MOBILE_APP_NAME)
//   site    → Ad Unit   (AD_UNIT_NAME, full name with id)
//   siteUrl / gamSite → Site      (SITE_NAME / subdomain host)
//   gamDomain         → Domain name (GAM DOMAIN / top private domain)
const MOCK_SITES = [
  { appId: 'com.arena.hub',     site: 'arenahubply.com_inter (23353334942)', siteUrl: 'arenahubply.com',     country: 'India' },
  { appId: 'com.arena.hub',     site: 'arenahubply.com_d1 (23353334943)',    siteUrl: 'm.arenahubply.com',   country: 'India' },
  { appId: 'com.arena.hub',     site: 'arenahubply.com_d2 (23353334944)',    siteUrl: 'amp.arenahubply.com', country: 'United States' },
  { appId: 'com.freez.games',   site: 'Freezgames.com_inter (23339683599)',  siteUrl: 'freezgames.com',      country: 'United States' },
  { appId: 'com.freez.games',   site: 'Freezgames.com_rewarded (23339683600)', siteUrl: 'play.freezgames.com', country: 'United Kingdom' },
  { appId: 'com.news.dailyfeed', site: 'newsdaily.com_top (23341110021)',    siteUrl: 'newsdaily.com',       country: 'India' },
  { appId: 'com.news.dailyfeed', site: 'newsdaily.com_side (23341110022)',   siteUrl: 'in.newsdaily.com',    country: 'United Arab Emirates' },
  { appId: 'com.shop.dealsnow', site: 'dealsnow.com_home (23344550010)',     siteUrl: 'dealsnow.com',        country: 'United Kingdom' },
  { appId: 'com.video.streamhub', site: 'streamhub.com_pre (23346770088)',   siteUrl: 'watch.streamhub.com', country: 'India' },
];

function eachDate(startDate, endDate) {
  const out = [];
  const s = new Date(startDate + 'T00:00:00Z');
  const e = new Date(endDate + 'T00:00:00Z');
  for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function mockDetailed({
  startDate, endDate, country, domainId, domainName, domain, site,
  reportDimensions, reportMetrics,
}) {
  const apps = asArray(domainId);       // App ID  (MOBILE_APP_NAME)
  const adUnits = asArray(domainName);  // Ad Unit (AD_UNIT_NAME)
  const domains = asArray(domain);      // Domain  (root of ad-unit name)
  const siteUrls = asArray(site);       // Site    (DOMAIN dimension)

  let sites = MOCK_SITES.slice();
  if (country) {
    const countries = asArray(country).map((c) => c.toLowerCase());
    sites = sites.filter((s) => countries.includes(s.country.toLowerCase()));
  }
  if (apps.length) sites = sites.filter(s => apps.includes(s.appId));
  if (adUnits.length) sites = sites.filter(s => adUnits.includes(s.site));
  if (domains.length) {
    sites = sites.filter(s => domains.includes(resolveInventoryFields(s.site, s.siteUrl).domainName));
  }
  if (siteUrls.length) {
    sites = sites.filter(s => siteUrls.includes(resolveInventoryFields(s.site, s.siteUrl).siteName));
  }

  const dates = eachDate(startDate, endDate);
  const rows = [];
  const trendMap = {};

  dates.forEach(date => {
    sites.forEach(s => {
      const impression = Math.floor(Math.random() * 6000 + 1500);
      const revenue = +(impression * (Math.random() * 0.004 + 0.001)).toFixed(2);
      const ectr = +(Math.random() * 1.2 + 0.2).toFixed(2);
      const ctr = +(Math.random() * 1.0 + 0.1).toFixed(2);
      const adxMatchRate = +(Math.random() * 25 + 70).toFixed(2);
      const fillRate = +(Math.random() * 30 + 60).toFixed(2);
      const viewableRate = +(Math.random() * 35 + 45).toFixed(2);
      const ecpm = impression > 0 ? +((revenue / impression) * 1000).toFixed(2) : 0;
      const inv = resolveInventoryFields(s.site, s.siteUrl);
      const dimensions = {};
      asArray(reportDimensions).forEach((dimId) => {
        if (dimId === 'date') dimensions.date = date;
        else if (dimId === 'mobile_app_name') dimensions.mobile_app_name = s.appId;
        else if (dimId === 'ad_unit_name') dimensions.ad_unit_name = s.site;
        else if (dimId === 'domain') dimensions.domain = inv.domainName;
        else if (dimId === 'site_name') dimensions.site_name = inv.siteName;
        else if (dimId === 'url_name') dimensions.url_name = s.siteUrl;
        else dimensions[dimId] = `${dimId}:${s.site}`;
      });
      rows.push(enrichReportRow({
        date, appId: s.appId, site: s.site, siteUrl: s.siteUrl, country: s.country,
        gamDomain: rootDomainFromHost(s.siteUrl) || domainFromAdUnit(s.site),
        gamSite: s.siteUrl,
        revenue, impression, ectr, ctr, adxMatchRate, fillRate, viewableRate, ecpm,
        dimensions,
      }));
      trendMap[date] = (trendMap[date] || 0) + revenue;
    });
  });

  const enriched = attachDimensionsToRows(
    attachMetricsToRows(rows.map(syncLegacyFields), asArray(reportMetrics)),
    asArray(reportDimensions)
  );
  const totalRevenue = +enriched.reduce((a, r) => a + r.revenue, 0).toFixed(2);
  const totalDomains = new Set(enriched.map(r => r.site)).size + new Set(enriched.map(r => r.appId)).size;
  const trend = dates.map(date => ({ date, earning: +(trendMap[date] || 0).toFixed(2) }));

  return {
    summary: { totalRevenue, totalDomains, offeredRecords: enriched.length, currency: 'USD' },
    rows: enriched,
    trend,
    isMock: true,
    reportDimensions: asArray(reportDimensions),
    reportMetrics: asArray(reportMetrics),
  };
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

// GAM dimension sets in order from most-to-least specific.
// Fewer sets = fewer costly retries when a set fails. Keep only the 3 most
// reliable combos; DOMAIN is excluded from early attempts (often unsupported).
const DETAILED_REPORT_DIMENSIONS = [
  // Prefer sets GAM accepts with country + device (DOMAIN+URL_NAME combo often fails).
  ['DATE', 'COUNTRY_NAME', 'DEVICE_CATEGORY_NAME', 'MOBILE_APP_NAME', 'SITE_NAME', 'AD_UNIT_NAME', 'AD_UNIT_ID'],
  ['DATE', 'COUNTRY_NAME', 'DEVICE_CATEGORY_NAME', 'AD_UNIT_NAME', 'AD_UNIT_ID'],
  ['DATE', 'COUNTRY_NAME', 'DEVICE_CATEGORY_NAME', 'AD_UNIT_NAME'],
  ['DATE', 'COUNTRY_NAME', 'DEVICE_CATEGORY_NAME', 'MOBILE_APP_NAME', 'DOMAIN', 'SITE_NAME', 'AD_UNIT_NAME', 'AD_UNIT_ID'],
  ['DATE', 'COUNTRY_NAME', 'MOBILE_APP_NAME', 'SITE_NAME', 'AD_UNIT_NAME', 'AD_UNIT_ID'],
  ['DATE', 'COUNTRY_NAME', 'AD_UNIT_NAME', 'AD_UNIT_ID'],
  ['DATE', 'DEVICE_CATEGORY_NAME', 'AD_UNIT_NAME'],
  ['DATE', 'MOBILE_APP_NAME', 'SITE_NAME', 'AD_UNIT_NAME', 'AD_UNIT_ID'],
  ['DATE', 'MOBILE_APP_NAME', 'AD_UNIT_NAME', 'AD_UNIT_ID'],
  ['DATE', 'AD_UNIT_NAME'],
];

/** Dimension sets that return line-item revenue (skip URL_NAME-only combos with empty metrics). */
const DOMAIN_USER_DIMENSION_SETS = [
  ['DATE', 'COUNTRY_NAME', 'DEVICE_CATEGORY_NAME', 'MOBILE_APP_NAME', 'SITE_NAME', 'AD_UNIT_NAME', 'AD_UNIT_ID'],
  ['DATE', 'COUNTRY_NAME', 'DEVICE_CATEGORY_NAME', 'MOBILE_APP_NAME', 'DOMAIN', 'SITE_NAME', 'AD_UNIT_NAME', 'AD_UNIT_ID'],
  ['DATE', 'COUNTRY_NAME', 'DEVICE_CATEGORY_NAME', 'MOBILE_APP_NAME', 'AD_UNIT_NAME', 'AD_UNIT_ID'],
  ['DATE', 'COUNTRY_NAME', 'DEVICE_CATEGORY_NAME', 'AD_UNIT_NAME'],
  ['DATE', 'MOBILE_APP_RESOLVED_ID', 'MOBILE_APP_NAME', 'DOMAIN', 'SITE_NAME', 'AD_UNIT_NAME', 'AD_UNIT_ID'],
  ['DATE', 'MOBILE_APP_NAME', 'DOMAIN', 'SITE_NAME', 'AD_UNIT_NAME', 'AD_UNIT_ID'],
  ['DATE', 'MOBILE_APP_RESOLVED_ID', 'MOBILE_APP_NAME', 'AD_UNIT_NAME', 'AD_UNIT_ID'],
  ['DATE', 'MOBILE_APP_NAME', 'AD_UNIT_NAME', 'AD_UNIT_ID'],
  ['DATE', 'AD_UNIT_NAME'],
];

// Filter dropdown catalogue — prefer DOMAIN + URL_NAME for correct root domain / subdomain lists.
const CATALOG_REPORT_DIMENSIONS = ['DATE', 'MOBILE_APP_NAME', 'DOMAIN', 'URL_NAME', 'SITE_NAME', 'AD_UNIT_NAME', 'AD_UNIT_ID'];
const CATALOG_REPORT_DIMENSIONS_FALLBACK = ['DATE', 'MOBILE_APP_NAME', 'URL_NAME', 'SITE_NAME', 'AD_UNIT_NAME', 'AD_UNIT_ID'];
/** GAM report scans for App + App ID (package) — merge all successful runs. */
const APP_PACKAGE_SCAN_DIMENSIONS_LIST = [
  ['DATE', 'MOBILE_APP_RESOLVED_ID', 'MOBILE_APP_NAME'],
  ['MOBILE_APP_RESOLVED_ID', 'MOBILE_APP_NAME'],
  ['DATE', 'MOBILE_APP_RESOLVED_ID'],
];
const APP_PACKAGE_SCAN_DAYS = 90;
const APP_PACKAGE_SCAN_METRICS = ['TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS'];
// Extra GAM scans for URL_NAME (often empty alongside MOBILE_APP_NAME on this network).
const SITE_URL_SCAN_DIMENSIONS_LIST = [
  ['DATE', 'SITE_NAME', 'COUNTRY_NAME'],
  ['DATE', 'SITE_NAME'],
  ['DATE', 'DOMAIN', 'SITE_NAME', 'URL_NAME'],
  ['DATE', 'DOMAIN', 'SITE_NAME', 'URL_NAME', 'AD_UNIT_NAME'],
  ['DATE', 'URL_NAME', 'SITE_NAME', 'AD_UNIT_NAME'],
];

const BASE_DETAIL_METRICS = [
  'TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE',
  'TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS',
  'TOTAL_LINE_ITEM_LEVEL_CLICKS',
  'TOTAL_LINE_ITEM_LEVEL_CTR',
  'TOTAL_INVENTORY_LEVEL_UNFILLED_IMPRESSIONS',
];

const DEFAULT_DETAIL_METRICS = [
  ...BASE_DETAIL_METRICS,
  'TOTAL_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE',
];

function buildDetailedReportQuery(startDate, endDate, countryFilter, dimensions, metrics = DEFAULT_DETAIL_METRICS) {
  const sd = startDate.split('-');
  const ed = endDate.split('-');
  const dimXML = dimensions.map((d) => `<dimensions>${d}</dimensions>`).join('\n    ');
  const colXML = [...new Set(metrics)].map((c) => `<columns>${c}</columns>`).join('\n    ');
  return `
    ${dimXML}
    <adUnitView>FLAT</adUnitView>
    ${colXML}
    <startDate><year>${sd[0]}</year><month>${+sd[1]}</month><day>${+sd[2]}</day></startDate>
    <endDate><year>${ed[0]}</year><month>${+ed[1]}</month><day>${+ed[2]}</day></endDate>
    <dateRangeType>CUSTOM_DATE</dateRangeType>${countryFilter}`;
}

function resolveDimensionSets(reportDimensions, opts = {}) {
  const custom = asArray(reportDimensions).map(catalogIdToGamEnum).filter(Boolean);
  const sets = [];
  const seen = new Set();
  const add = (dims) => {
    const list = [...new Set(dims.filter(Boolean))];
    if (!list.length) return;
    const key = list.join(',');
    if (seen.has(key)) return;
    seen.add(key);
    sets.push(list);
  };

  // Reporting custom queries: only try the user's dimensions (progressive shrink).
  // Do not inject unrelated default inventory dims — that would show non-requested data.
  const compatOnly = Boolean(opts.compatOnly);

  if (custom.length) {
    add(custom);
    if (!custom.includes('DATE')) add(['DATE', ...custom]);
    for (const n of [10, 8, 6, 4, 3, 2]) {
      if (custom.length > n) add(custom.slice(0, n));
    }
    const inventory = custom.filter((d) => !/PROGRAMMATIC|DEMAND_CHANNEL|ADVERTISER/i.test(d));
    if (inventory.length && inventory.length !== custom.length) add(inventory);
    if (inventory.length > 6) add(inventory.slice(0, 6));
    // Probe a capped set of single dims so "select all" stays GAM-compatible without
    // exploding into hundreds of report jobs.
    const singles = custom.filter((d) => d !== 'DATE').slice(0, 8);
    for (const d of singles) {
      add(['DATE', d]);
      add([d]);
    }
    if (custom.includes('DATE')) add(['DATE']);
  } else if (opts.useDomainUserSets) {
    for (const fallback of DOMAIN_USER_DIMENSION_SETS) add(fallback);
  }
  if (!compatOnly || !custom.length) {
    for (const fallback of DETAILED_REPORT_DIMENSIONS) add(fallback);
  }
  return sets.length ? sets : DETAILED_REPORT_DIMENSIONS;
}

function buildMetricAttempts(metricApis, opts = {}) {
  const compatOnly = Boolean(opts.compatOnly);
  const attempts = [];
  const seen = new Set();
  const add = (mets) => {
    const list = [...new Set((mets || []).filter(Boolean))];
    if (!list.length) return;
    const key = list.join(',');
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push(list);
  };

  if (metricApis.length) {
    add(metricApis);
    for (const n of [10, 8, 6, 4, 2]) {
      if (metricApis.length > n) add(metricApis.slice(0, n));
    }
    const core = metricApis.filter((m) => BASE_DETAIL_METRICS.includes(m));
    if (core.length) add(core);
    for (const m of metricApis.slice(0, 6)) add([m]);
  }
  if (!compatOnly || !metricApis.length) {
    add(DEFAULT_DETAIL_METRICS);
    add(BASE_DETAIL_METRICS);
  }
  return attempts.length ? attempts : [DEFAULT_DETAIL_METRICS, BASE_DETAIL_METRICS];
}

function isGamCompatError(err) {
  const msg = String(err?.message || '');
  return /COLUMNS_NOT_SUPPORTED|INVALID_DIMENSIONS|columns not supported|invalid_dimensions/i.test(msg);
}

function resolveMetricApis(reportMetrics) {
  const custom = asArray(reportMetrics).map(catalogIdToGamEnum).filter(Boolean);
  if (!custom.length) return DEFAULT_DETAIL_METRICS;
  const apis = [...new Set(custom)];
  if (!apis.includes('TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE')) {
    apis.unshift('TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE');
  }
  if (!apis.includes('TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS')) {
    apis.unshift('TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS');
  }
  return apis;
}

function rawRowsHaveMetrics(raw = []) {
  if (!raw?.length) return false;
  return raw.some((r) => {
    const imp = parseInt(r['Column.TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS'] || 0, 10);
    const rev = parseFloat(r['Column.TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE'] || 0);
    const clicks = parseInt(r['Column.TOTAL_LINE_ITEM_LEVEL_CLICKS'] || 0, 10);
    return imp > 0 || rev > 0 || clicks > 0;
  });
}

async function downloadDetailedReport(startDate, endDate, countryFilter, dimensionSets, metricApis, token, opts = {}) {
  let lastErr;
  const fastMode = Boolean(opts.fastMode);
  const compatOnly = Boolean(opts.compatOnly);
  // Always forward poll opts — previously fastMode never reached pollReport.
  const pollOpts = { fastMode };
  const dimensionCandidates = fastMode ? dimensionSets.slice(0, 1) : dimensionSets;
  const metricAttempts = fastMode
    ? (metricApis.length ? [metricApis] : [DEFAULT_DETAIL_METRICS, BASE_DETAIL_METRICS])
    : buildMetricAttempts(metricApis, { compatOnly });

  for (const dimensions of dimensionCandidates) {
    for (const metrics of metricAttempts) {
      try {
        const xml = buildDetailedReportQuery(startDate, endDate, countryFilter, dimensions, metrics);
        const raw = await runReportAndDownload(xml, token, pollOpts);
        if (!rawRowsHaveMetrics(raw)) {
          logger.warn(`Detailed report dims=[${dimensions.join(', ')}] returned zero metrics, retrying`);
          continue;
        }
        const userDimKey = (dimensionSets[0] || []).join(',');
        const userMetKey = metricApis.join(',');
        const partial = dimensions.join(',') !== userDimKey || metrics.join(',') !== userMetKey;
        logger.info(
          `Detailed report OK dims=[${dimensions.join(', ')}] metrics=${metrics.length}${partial ? ' (partial)' : ''}`
        );
        return { raw, dimensions, fetchedMetrics: metrics, partial, fallback: false };
      } catch (err) {
        lastErr = err;
        if (isGamCompatError(err)) {
          logger.warn(
            `GAM incompatible dims=[${dimensions.join(', ')}] mets=${metrics.length}: ${err.message}`
          );
          continue;
        }
        logger.warn(`Detailed report failed for [${dimensions.join(', ')}]: ${err.message}`);
      }
    }
  }

  // Reporting (compatOnly): never substitute unrelated default dims — treat as no data.
  if (compatOnly) {
    logger.info(
      `Detailed report: no GAM-compatible combination for requested dims/metrics (${lastErr?.message || 'exhausted'})`
    );
    return {
      raw: [],
      dimensions: [],
      fetchedMetrics: [],
      partial: false,
      fallback: false,
      emptyCompat: true,
    };
  }

  if (fastMode) {
    logger.info('Fast dashboard report mode enabled; using a shorter fallback path');
  }

  // Guaranteed fallback for dashboard/lean paths — never 500 for valid GAM credentials.
  const fallbackDims = fastMode ? DETAILED_REPORT_DIMENSIONS.slice(0, 2) : DETAILED_REPORT_DIMENSIONS;
  for (const dimensions of fallbackDims) {
    for (const metrics of [DEFAULT_DETAIL_METRICS, BASE_DETAIL_METRICS]) {
      try {
        const xml = buildDetailedReportQuery(startDate, endDate, countryFilter, dimensions, metrics);
        const raw = await runReportAndDownload(xml, token, pollOpts);
        if (!rawRowsHaveMetrics(raw)) {
          logger.warn(`Detailed fallback dims=[${dimensions.join(', ')}] returned zero metrics, retrying`);
          continue;
        }
        logger.info(`Detailed report fallback OK dims=[${dimensions.join(', ')}]`);
        return {
          raw,
          dimensions,
          fetchedMetrics: metrics,
          partial: true,
          fallback: true,
        };
      } catch (err) {
        lastErr = err;
        logger.warn(`Detailed fallback failed for [${dimensions.join(', ')}]: ${err.message}`);
      }
    }
  }
  throw lastErr || new Error('Failed to run detailed report');
}

// Fetch + parse the real GAM detailed report (used by /detailed and /dashboard)
async function runDetailedReport({
  startDate, endDate, country, domainId, domainName, domain, site,
  reportDimensions, reportMetrics,
}, token, opts = {}) {
  try {
    // Country is filtered SERVER-SIDE via the report statement (by criteria id) so
    // GAM returns only that country's rows — keeping the report small and fast.
    const countryFilter = buildCountryFilter(country);

    const numOr0 = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
    const intOr0 = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };

    const metricIds = asArray(reportMetrics);
    let dimensionIds = asArray(reportDimensions);
    if (asArray(country).length && !dimensionIds.includes('country_name')) {
      dimensionIds = [...dimensionIds, 'country_name'];
    }
    const metricApis = resolveMetricApis(reportMetrics);
    const compatOnly = Boolean(opts.compatOnly);
    const invOnly = hasInventoryFilters({ domain, site, domainName, domainId })
      && !dimensionIds.length;
    const dimensionSets = opts.dimensionSets || resolveDimensionSets(dimensionIds, {
      useDomainUserSets: invOnly,
      compatOnly,
    });
    // Overlap inventory SOAP with the (much slower) report job.
    const inventoryPromise = fetchGAMInventoryData(token)
      .catch(() => ({ siteMap: {}, adUnits: [] }));
    const {
      raw,
      dimensions: actualDims,
      fetchedMetrics: actualMetrics,
      partial,
      fallback,
      emptyCompat,
    } = await downloadDetailedReport(
      startDate, endDate, countryFilter, dimensionSets, metricApis, token, {
        fastMode: opts.fastMode,
        compatOnly,
      }
    );

    if (emptyCompat || !Array.isArray(raw) || raw.length === 0) {
      const skippedDims = dimensionIds
        .map((id) => catalogIdToGamEnum(id))
        .filter(Boolean);
      const skippedMets = metricIds
        .map((id) => catalogIdToGamEnum(id))
        .filter(Boolean);
      return {
        rows: [],
        trend: [],
        reportWarning: 'incompatible',
        reportWarningSkipped: [...skippedDims, ...skippedMets],
        reportWarningUsed: [],
        reportWarningUsedIds: [],
        reportWarningUsedMetricIds: [],
      };
    }

    const inventoryData = await inventoryPromise;
    const adUnitByName = buildAdUnitNameToIdMap(inventoryData.adUnits || []);
    const mergedSiteMap = {
      ...(inventoryData.siteMap || {}),
      ...buildReportSiteMap(raw, adUnitByName),
    };

    let rows = raw.map((r) => {
      const revenue = +(numOr0(r['Column.TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE']) / 1e6).toFixed(2);
      const impression = intOr0(r['Column.TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS']);
      const clicks = intOr0(r['Column.TOTAL_LINE_ITEM_LEVEL_CLICKS']);
      const unfilled = intOr0(r['Column.TOTAL_INVENTORY_LEVEL_UNFILLED_IMPRESSIONS']);
      const ctr = impression > 0 ? +((clicks / impression) * 100).toFixed(2) : 0;
      const fillRate = (impression + unfilled) > 0 ? +((impression / (impression + unfilled)) * 100).toFixed(2) : 0;
      let viewableRate = numOr0(r['Column.TOTAL_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE']);
      if (viewableRate > 0 && viewableRate <= 1) viewableRate = +(viewableRate * 100).toFixed(2);
      else viewableRate = +viewableRate.toFixed(2);
      const inv = mapGamRowInventory(r, mergedSiteMap, adUnitByName);
      const metrics = parseMetricsFromGamRow(r, [
        ...metricIds,
        'total_active_view_viewable_impressions_rate',
      ]);
      if (viewableRate > 0) {
        metrics.total_active_view_viewable_impressions_rate = viewableRate;
      }
      const dimensions = {
        ...parseAllDimensionsFromGamRow(r),
        ...parseDimensionsFromGamRow(r, dimensionIds),
      };
      return syncLegacyFields(enrichReportRow({
        date: r['Dimension.DATE'] || dimensions.date,
        ...resolveAppFields({ raw: r, dimensions }),
        country: dimensions.country_name || r['Dimension.COUNTRY_NAME'] || '',
        device: dimensions.device_category_name || r['Dimension.DEVICE_CATEGORY_NAME'] || '',
        site: inv.adUnit,
        gamDomain: inv.gamDomain,
        gamSite: inv.gamSite,
        siteUrl: inv.siteUrl || dimensions.url_name || null,
        revenue, impression, clicks, unfilled,
        ectr: ctr, ctr,
        adxMatchRate: fillRate, fillRate,
        viewableRate,
        metrics,
        dimensions,
      }));
    });

    const catalogRows = findCachedInventoryRows(cache);
    if (catalogRows?.length) {
      const catalogCache = cache.get(CATALOG_CACHE_KEY);
      const adUnitsByHost = catalogCache?.adUnitsByHost || findCachedAdUnitsByHost(cache);
      const siteHosts = buildCatalogFilterOptions(catalogRows, catalogCache?.rawHosts || {}).siteHosts || [];
      rows = applyCatalogSiteHosts(rows, catalogRows, adUnitsByHost, siteHosts);
    }

    // Resolve numeric MOBILE_APP_RESOLVED_ID → store package BEFORE filtering by app.
    // Without this, app rows whose resolved id isn't package-like never match the
    // selected App ID and get dropped — which drops whole apps and halves revenue.
    const appPackageMaps = rehydrateAppPackageMaps(cache.get(CATALOG_CACHE_KEY)?.appPackageMaps);
    if (appPackageMaps.byPackage.size || appPackageMaps.byResolvedId.size) {
      rows = enrichRowsWithAppPackages(rows, appPackageMaps);
    }

    rows = attachDimensionsToRows(attachMetricsToRows(rows, metricIds), dimensionIds);
    rows = enrichRowsWithCountryFilter(rows, country);

    // Friendly label map for GAM enum → human name (must match frontend gamReportCatalogData labels).
    const GAM_DIM_LABEL = {
      DATE: 'Date', MOBILE_APP_RESOLVED_ID: 'App ID', MOBILE_APP_NAME: 'App names', AD_UNIT_NAME: 'Ad unit', SITE_NAME: 'Site',
      DOMAIN: 'Domain', URL_NAME: 'URL', WEB_PROPERTY_CODE: 'Web Property Code',
      PROGRAMMATIC_CHANNEL_NAME: 'Programmatic channel', DEMAND_CHANNEL_NAME: 'Demand channel',
      CHANNEL_NAME: 'Channel', ADVERTISER_NAME: 'Advertiser', ORDER_NAME: 'Order',
      LINE_ITEM_NAME: 'Line item', CREATIVE_NAME: 'Creative', COUNTRY_NAME: 'Country',
      DEVICE_CATEGORY_NAME: 'Device category', BROWSER_NAME: 'Browser',
      OPERATING_SYSTEM_NAME: 'OS', CUSTOM_TARGETING_VALUE_ID: 'Custom targeting',
      AD_TECHNOLOGY_PROVIDER_DOMAIN: 'Ad tech provider',
      ADVERTISER_DOMAIN_NAME: 'Advertiser domain',
    };
    const GAM_MET_LABEL = {
      TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE: 'Revenue',
      TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS: 'Impressions',
      TOTAL_LINE_ITEM_LEVEL_CLICKS: 'Clicks',
      TOTAL_LINE_ITEM_LEVEL_CTR: 'CTR',
      TOTAL_INVENTORY_LEVEL_UNFILLED_IMPRESSIONS: 'Unfilled impressions',
      PROGRAMMATIC_ELIGIBLE_IMPRESSIONS: 'Eligible impressions',
      PROGRAMMATIC_MATCHED_IMPRESSIONS: 'Matched impressions',
      PROGRAMMATIC_REVENUE: 'Programmatic revenue',
      TOTAL_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS: 'Viewable impressions',
      TOTAL_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE: 'Viewable rate',
      TOTAL_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS_RATE: 'Measurable rate',
    };

    let reportWarning = null;
    let reportWarningSkipped = [];   // dims/metrics that could NOT run
    let reportWarningUsed = [];      // dims that DID run (display labels)
    let reportWarningUsedIds = [];   // dims that DID run (catalog ids — reliable for UI columns)
    let reportWarningUsedMetricIds = []; // metrics that DID run (catalog ids)

    const userRequestedDims = dimensionIds.length > 0;
    const userRequestedMets = metricIds.length > 0;

    if ((partial || fallback) && (userRequestedDims || userRequestedMets)) {
      const actualDimSet = new Set((actualDims || []).map(d => d.toUpperCase()));
      const actualMetSet = new Set((actualMetrics || []).map(m => m.toUpperCase()));

      const skippedDims = dimensionIds
        .map(id => catalogIdToGamEnum(id))
        .filter(api => api && !actualDimSet.has(api))
        .map(api => GAM_DIM_LABEL[api] || api);

      const skippedMets = metricIds
        .map(id => catalogIdToGamEnum(id))
        .filter(api => api && !actualMetSet.has(api))
        .map(api => GAM_MET_LABEL[api] || api);

      // Dims that actually ran and were requested (DATE kept when requested)
      const requestedDimApis = new Set(dimensionIds.map(catalogIdToGamEnum).filter(Boolean));
      const usedApis = [...actualDimSet].filter((api) => {
        if (api === 'DATE') return requestedDimApis.has('DATE') || !requestedDimApis.size;
        return requestedDimApis.has(api) || !requestedDimApis.size;
      });

      reportWarningSkipped = [...skippedDims, ...skippedMets];
      reportWarningUsed = usedApis.map(api => GAM_DIM_LABEL[api] || api);
      // Catalog ids (not GAM enums) so the Reporting UI can keep matching columns.
      reportWarningUsedIds = dimensionIds.filter((id) => {
        const api = catalogIdToGamEnum(id);
        if (!api) return false;
        return actualDimSet.has(api);
      });
      // If GAM added DATE and user asked for it via enum-only path, keep any DATE catalog id.
      if (actualDimSet.has('DATE') && !reportWarningUsedIds.length && dimensionIds.length) {
        reportWarningUsedIds = dimensionIds.filter((id) => {
          const api = catalogIdToGamEnum(id);
          return api && actualDimSet.has(api);
        });
      }
      reportWarningUsedMetricIds = metricIds.filter((id) => {
        const api = catalogIdToGamEnum(id);
        return api && actualMetSet.has(api);
      });
      reportWarning = reportWarningSkipped.length > 0 ? 'partial' : 'fallback';
    }

    const trendMap = {};
    rows.forEach(r => { trendMap[r.date] = (trendMap[r.date] || 0) + r.revenue; });
    const trend = Object.keys(trendMap).sort().map(date => ({ date, earning: +trendMap[date].toFixed(2) }));

    return {
      rows,
      trend,
      reportWarning,
      reportWarningSkipped,
      reportWarningUsed,
      reportWarningUsedIds,
      reportWarningUsedMetricIds,
    };
  } catch (err) {
    logger.warn('Detailed report failed; returning empty rows to keep dashboard responsive:', err.message);
    return {
      rows: [],
      trend: [],
      reportWarning: null,
      reportWarningSkipped: [],
      reportWarningUsed: [],
      reportWarningUsedIds: [],
      reportWarningUsedMetricIds: [],
    };
  }
}

/** Fast inventory catalogue for filter dropdowns — last 30 days, single GAM query. */
async function runCatalogReport(token) {
  const { startDate, endDate } = dateRangeYMDInTZ(30);
  const inventoryData = await fetchGAMInventoryData(token);
  const { siteMap, sites: gamSites } = inventoryData;
  const adUnitByName = buildAdUnitNameToIdMap(inventoryData.adUnits || []);

  let raw;
  let usedDims = CATALOG_REPORT_DIMENSIONS;
  for (const dims of [CATALOG_REPORT_DIMENSIONS, CATALOG_REPORT_DIMENSIONS_FALLBACK]) {
    try {
      raw = await runReportAndDownload(
        buildDetailedReportQuery(startDate, endDate, '', dims, DEFAULT_DETAIL_METRICS),
        token
      );
      usedDims = dims;
      break;
    } catch (err) {
      if (dims === CATALOG_REPORT_DIMENSIONS_FALLBACK) throw err;
      logger.warn(`Catalog report failed for [${dims.join(', ')}]: ${err.message}`);
    }
  }

  let rawUrlScan = [];
  for (const dims of SITE_URL_SCAN_DIMENSIONS_LIST) {
    try {
      const scan = await runReportAndDownload(
        buildDetailedReportQuery(startDate, endDate, '', dims, DEFAULT_DETAIL_METRICS),
        token
      );
      if (scan?.length) {
        rawUrlScan = scan;
        logger.info('[catalog] urlScan dims:', dims.join(','), '| rows:', scan.length);
        break;
      }
    } catch (err) {
      logger.warn(`Site URL scan failed for [${dims.join(', ')}]: ${err.message}`);
    }
  }

  let appPackageMaps = { byPackage: {}, byName: {}, byResolvedId: {} };

  if (inventoryData.mobileApps?.length) {
    const invMaps = buildAppPackageMapsFromMobileApps(inventoryData.mobileApps);
    appPackageMaps = mergeAppPackageMapData(appPackageMaps, mapsToPlain(invMaps));
    logger.info(
      '[catalog] mobileApps service | registered:', inventoryData.mobileApps.length,
      '| packages:', Object.keys(appPackageMaps.byPackage).length,
      '| idMap:', Object.keys(appPackageMaps.byResolvedId || {}).length,
      '| noPackage:', invMaps.missingPackage || 0
    );
  }

  const resolvedIdMap = rehydrateAppPackageMaps(appPackageMaps).byResolvedId;
  const { startDate: appStart, endDate: appEnd } = dateRangeYMDInTZ(APP_PACKAGE_SCAN_DAYS);
  for (const dims of APP_PACKAGE_SCAN_DIMENSIONS_LIST) {
    try {
      const appRaw = await runReportAndDownload(
        buildDetailedReportQuery(appStart, appEnd, '', dims, APP_PACKAGE_SCAN_METRICS),
        token
      );
      if (!appRaw?.length) continue;
      const maps = buildAppPackageMapsFromGamRows(appRaw, resolvedIdMap);
      appPackageMaps = mergeAppPackageMapData(appPackageMaps, mapsToPlain(maps));
      logger.info(
        '[catalog] appScan dims:', dims.join(','),
        '| rows:', appRaw.length,
        '| packages:', Object.keys(appPackageMaps.byPackage).length
      );
    } catch (err) {
      logger.warn(`App package scan failed for [${dims.join(', ')}]: ${err.message}`);
    }
  }

  const appPackages = packageListFromMapData(appPackageMaps);

  const rawHosts = collectHostsFromRawReport([...raw, ...rawUrlScan]);
  const reportSiteMap = {
    ...buildReportSiteMap(raw, adUnitByName),
    ...buildReportSiteMap(rawUrlScan, adUnitByName),
  };
  const mergedSiteMap = { ...siteMap, ...reportSiteMap };
  let rows = dedupeCatalogRows(raw.map((r) => enrichCatalogRow(r, mergedSiteMap, adUnitByName)));
  rows = mergeUrlScanIntoCatalog(rows, rawUrlScan, adUnitByName);
  rows = supplementCatalogWithSites(rows, gamSites || []);
  rows = enrichRowsWithAppPackages(rows, rehydrateAppPackageMaps(appPackageMaps));
  let adUnitsByHost = buildAdUnitsByHost(rows, mergedSiteMap);
  adUnitsByHost = augmentAdUnitsByHost(adUnitsByHost, rows, rawHosts.sitesByDomain || {});
  const adUnitSiteMapFromScan = Object.fromEntries(
    buildAdUnitSiteMapFromUrlScan(rawUrlScan, adUnitByName)
  );
  const withSite = rows.filter((r) => pickSiteHost(r.siteUrl, r.siteName, r.gamSite)).length;
  const withApp = rows.filter((r) => r.appPackage && r.appPackage !== '—').length;
  logger.info(
    '[catalog] dims:', usedDims.join(','),
    '| rows:', rows.length,
    '| siteMap:', Object.keys(mergedSiteMap).length,
    '| withSite:', withSite,
    '| withApp:', withApp,
    '| appPackages:', appPackages.length,
    '| adUnitsByHost:', Object.keys(adUnitsByHost).length,
    '| siteService:', (gamSites || []).length,
    '| urlScanRows:', rawUrlScan.length,
    '| subdomains:', rawHosts.siteHosts.length,
    '| domainsWithSites:', Object.keys(rawHosts.sitesByDomain || {}).length
  );
  return { rows, startDate, endDate, rawHosts, adUnitsByHost, appPackages, appPackageMaps, adUnitSiteMapFromScan };
}

// ─── Programmatic channel report (GAM screenshots 1–2) ───────────────────────
// Dimension: PROGRAMMATIC_CHANNEL_NAME
// Metrics: impressions, all revenue, average eCPM, Active View viewable rate

const MOCK_PROGRAMMATIC_CHANNELS = [
  'Open auction',
  'Private auction',
  'Preferred deals',
  'Programmatic guaranteed',
  'Reserved',
  '(Not applicable)',
];

function mockProgrammatic({ startDate, endDate }) {
  const rows = MOCK_PROGRAMMATIC_CHANNELS.map((channel) => {
    const impressions = Math.floor(Math.random() * 800000 + 120000);
    const revenue = +(impressions * (Math.random() * 0.003 + 0.0008)).toFixed(2);
    const ecpm = impressions > 0 ? +((revenue / impressions) * 1000).toFixed(2) : 0;
    const viewableRate = +(Math.random() * 35 + 45).toFixed(2);
    return { channel, impressions, revenue, ecpm, viewableRate };
  });
  return { rows, startDate, endDate, isMock: true };
}

async function runProgrammaticReport({ startDate, endDate, country }, token) {
  const sd = startDate.split('-');
  const ed = endDate.split('-');
  const countryFilter = buildCountryFilter(country);

  const reportQueryXML = `
    <dimensions>PROGRAMMATIC_CHANNEL_NAME</dimensions>
    <columns>TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS</columns>
    <columns>TOTAL_LINE_ITEM_LEVEL_ALL_REVENUE</columns>
    <columns>TOTAL_LINE_ITEM_LEVEL_WITHOUT_CPD_AVERAGE_ECPM</columns>
    <columns>TOTAL_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE</columns>
    <startDate><year>${sd[0]}</year><month>${+sd[1]}</month><day>${+sd[2]}</day></startDate>
    <endDate><year>${ed[0]}</year><month>${+ed[1]}</month><day>${+ed[2]}</day></endDate>
    <dateRangeType>CUSTOM_DATE</dateRangeType>${countryFilter}`;

  const numOr0 = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const intOr0 = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };

  const raw = await runReportAndDownload(reportQueryXML, token);
  const rows = raw.map(r => {
    const impressions = intOr0(r['Column.TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS']);
    const revenue = +(numOr0(r['Column.TOTAL_LINE_ITEM_LEVEL_ALL_REVENUE']) / 1e6).toFixed(2);
    const ecpm = +(numOr0(r['Column.TOTAL_LINE_ITEM_LEVEL_WITHOUT_CPD_AVERAGE_ECPM']) / 1e6).toFixed(2);
    let viewableRate = numOr0(r['Column.TOTAL_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE']);
    if (viewableRate > 0 && viewableRate <= 1) viewableRate = +(viewableRate * 100).toFixed(2);
    else viewableRate = +viewableRate.toFixed(2);
    return {
      channel: r['Dimension.PROGRAMMATIC_CHANNEL_NAME'] || '—',
      impressions, revenue, ecpm, viewableRate,
    };
  });

  return { rows };
}

function applyProgrammaticVisibility(payload, user, opts = {}) {
  const vis = buildVisibility(user);
  const overviewOnly = opts.overviewOnly === true;
  if (!overviewOnly && (!vis.generate || !vis.programmatic)) {
    payload.rows = [];
    payload.visibility = vis;
    return payload;
  }
  if (!vis.programmatic) {
    payload.rows = [];
    payload.visibility = vis;
    return payload;
  }
  payload.rows = (payload.rows || []).map((r) => ({
    ...r,
    impressions: vis.impressions ? r.impressions : 0,
    revenue: vis.revenue ? r.revenue : 0,
    ecpm: vis.revenue ? r.ecpm : 0,
    viewableRate: vis.impressions ? r.viewableRate : 0,
  }));
  payload.visibility = vis;
  return payload;
}

// Enforce per-resource permissions: redact (zero out) any metric the user is
// not allowed to see so restricted values never leave the server, and attach
// the `visibility` flags the frontend uses to hide the matching widgets.
function applyVisibility(payload, user, opts = {}) {
  const vis = buildVisibility(user);
  const domainUserView = opts.domainUserView === true;

  // No report-generation permission → withhold all data server-side.
  // Domain User page may still show scoped earnings when the user has that page access.
  if (!vis.generate && !domainUserView) {
    payload.rows = [];
    payload.trend = [];
    if (payload.summary) {
      Object.keys(payload.summary).forEach((k) => {
        if (typeof payload.summary[k] === 'number') payload.summary[k] = 0;
      });
    }
    payload.visibility = vis;
    return payload;
  }

  if (!vis.revenue || !vis.impressions || !vis.ctr || !vis.ecpm) {
    payload.rows = (payload.rows || []).map((r) => ({
      ...r,
      revenue: vis.revenue ? r.revenue : 0,
      impression: vis.impressions ? r.impression : 0,
      ctr: vis.ctr ? r.ctr : 0,
      ectr: vis.ctr ? r.ectr : 0,
      clicks: vis.ctr ? r.clicks : 0,
      adxMatchRate: vis.ecpm ? r.adxMatchRate : 0,
      fillRate: vis.ecpm ? r.fillRate : 0,
    }));

    if (Array.isArray(payload.trend) && !vis.revenue) {
      payload.trend = payload.trend.map((t) => ({ ...t, earning: 0 }));
    }

    const s = payload.summary;
    if (s) {
      if (!vis.revenue) {
        ['totalRevenue', 'totalEarning', 'selectRange', 'last7Days'].forEach((k) => {
          if (k in s) s[k] = 0;
        });
      }
      if (!vis.impressions) {
        ['impressions', 'pageViews'].forEach((k) => { if (k in s) s[k] = 0; });
      }
      if (!vis.ctr && 'clicks' in s) s.clicks = 0;
    }
  }

  payload.visibility = vis;
  return payload;
}

// GAM Home overview — programmatic channels (impressions, revenue, eCPM, viewability).
function deriveProgrammaticOverviewSummary(rows, currency, isMock) {
  const impressions = rows.reduce((a, r) => a + (r.impressions || 0), 0);
  const revenue = +rows.reduce((a, r) => a + (r.revenue || 0), 0).toFixed(2);
  const impWeight = rows.reduce((a, r) => a + (r.impressions || 0), 0);

  let ecpm = impressions > 0 ? +((revenue / impressions) * 1000).toFixed(2) : 0;
  if (impWeight > 0) {
    const weighted = rows.reduce((a, r) => a + (r.ecpm || 0) * (r.impressions || 0), 0) / impWeight;
    if (weighted > 0) ecpm = +weighted.toFixed(2);
  }

  const viewability = impWeight > 0
    ? +(rows.reduce((a, r) => a + (r.viewableRate || 0) * (r.impressions || 0), 0) / impWeight).toFixed(1)
    : 0;
  const rnd = () => +(Math.random() * 16 - 5).toFixed(1);

  return {
    impressions, impressionsChange: isMock ? rnd() : 0,
    revenue, revenueChange: isMock ? rnd() : 0,
    ecpm, ecpmChange: isMock ? rnd() : 0,
    viewability, viewabilityChange: isMock ? rnd() : 0,
    currency,
  };
}

/** Overview KPIs aligned with Domain User totals (same aggregation path). */
function deriveOverviewSummaryFromPreparedRows(prepared = [], currency, isMock = false) {
  const stats = summarizeDomainUserRows(aggregateDomainUserRows(prepared));
  const impressions = stats.impressions;
  const revenue = stats.totalRevenue;
  const ecpm = impressions > 0 ? +((revenue / impressions) * 1000).toFixed(2) : 0;
  const viewability = impressions > 0
    ? +(prepared.reduce((a, r) => a + (Number(r.viewableRate) || 0) * (Number(r.impression) || 0), 0) / impressions).toFixed(1)
    : 0;
  const rnd = () => +(Math.random() * 16 - 5).toFixed(1);
  return {
    impressions, impressionsChange: isMock ? rnd() : 0,
    revenue, revenueChange: isMock ? rnd() : 0,
    ecpm, ecpmChange: isMock ? rnd() : 0,
    viewability, viewabilityChange: isMock ? rnd() : 0,
    currency,
  };
}

/** Overview KPIs from scoped line-item rows (inventory filters applied). */
function deriveScopedOverviewSummary(rows = [], currency, isMock = false) {
  const impressions = rows.reduce((a, r) => a + (Number(r.impression) || 0), 0);
  const revenue = +rows.reduce((a, r) => a + (Number(r.revenue) || 0), 0).toFixed(2);
  const ecpm = impressions > 0 ? +((revenue / impressions) * 1000).toFixed(2) : 0;
  const viewability = impressions > 0
    ? +(rows.reduce((a, r) => a + (Number(r.viewableRate) || 0) * (Number(r.impression) || 0), 0) / impressions).toFixed(1)
    : 0;
  const rnd = () => +(Math.random() * 16 - 5).toFixed(1);
  return {
    impressions, impressionsChange: isMock ? rnd() : 0,
    revenue, revenueChange: isMock ? rnd() : 0,
    ecpm, ecpmChange: isMock ? rnd() : 0,
    viewability, viewabilityChange: isMock ? rnd() : 0,
    currency,
  };
}

/** Shared cache key for line-item reports (overview + domain user use the same raw rows). */
function sharedDetailedCacheKey(filters) {
  return `report_domain_user_${filterCacheKey({
    startDate: filters.startDate,
    endDate: filters.endDate,
  })}`;
}

/** Warm filter catalog so scoped users can resolve ad-unit → site host before scope filter. */
async function ensureInventoryCatalog(token) {
  try {
    return await getFilterCatalog(token, { allowStale: true });
  } catch (err) {
    logger.warn('Inventory catalog warmup failed:', err.message);
    return cache.get(CATALOG_CACHE_KEY) || {};
  }
}

let catalogBgRefresh = null;
const CATALOG_STALE_MS = 60 * 60 * 1000; // refresh from GAM in background after 1h

function scheduleCatalogBackgroundRefresh(token) {
  if (!token || catalogBgRefresh) return;
  catalogBgRefresh = (async () => {
    try {
      logger.info('Filter catalog: background GAM refresh…');
      const fresh = await runCatalogReport(token);
      cache.set(CATALOG_CACHE_KEY, fresh, REPORT_CACHE_TTL);
      await kvSet(CATALOG_CACHE_KEY, fresh);
      const r = getRedis();
      if (r?.redisSet) await r.redisSet(CATALOG_CACHE_KEY, fresh, r.TTL?.INVENTORY || 3600);
      logger.info(`Filter catalog: background refresh saved (${fresh.rows?.length || 0} rows)`);
    } catch (err) {
      logger.warn('Filter catalog background refresh failed:', err.message);
    } finally {
      catalogBgRefresh = null;
    }
  })();
}

/**
 * Filter catalog ladder (survives restart without Redis):
 *   memory → Redis → Postgres app_kv_cache → live GAM (then persist)
 */
async function getFilterCatalog(token, { allowStale = true, forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const mem = cache.get(CATALOG_CACHE_KEY);
    if (mem?.rows?.length) return mem;

    const r = getRedis();
    if (r?.redisGet) {
      try {
        const redisData = await r.redisGet(CATALOG_CACHE_KEY);
        if (redisData?.rows?.length) {
          cache.set(CATALOG_CACHE_KEY, redisData, REPORT_CACHE_TTL);
          logger.info(`Filter catalog served from Redis (${redisData.rows.length} rows)`);
          return redisData;
        }
      } catch (_) { /* ignore */ }
    }

    if (allowStale) {
      const db = await kvGet(CATALOG_CACHE_KEY);
      if (db?.payload?.rows?.length) {
        cache.set(CATALOG_CACHE_KEY, db.payload, REPORT_CACHE_TTL);
        if (r?.redisSet) {
          try { await r.redisSet(CATALOG_CACHE_KEY, db.payload, r.TTL?.INVENTORY || 3600); } catch (_) { /* ignore */ }
        }
        const ageMs = db.updatedAt ? (Date.now() - new Date(db.updatedAt).getTime()) : 0;
        logger.info(
          `Filter catalog served from PostgreSQL (${db.payload.rows.length} rows`
          + (ageMs ? `, age=${Math.round(ageMs / 1000)}s` : '')
          + ')'
        );
        if (token && ageMs > CATALOG_STALE_MS) scheduleCatalogBackgroundRefresh(token);
        return db.payload;
      }
    }
  }

  if (!token) return cache.get(CATALOG_CACHE_KEY) || { rows: [] };

  const fresh = await fetchWithDedup(CATALOG_CACHE_KEY, () => runCatalogReport(token));
  await kvSet(CATALOG_CACHE_KEY, fresh);
  const r = getRedis();
  if (r?.redisSet) {
    try { await r.redisSet(CATALOG_CACHE_KEY, fresh, r.TTL?.INVENTORY || 3600); } catch (_) { /* ignore */ }
  }
  logger.info(`Filter catalog fetched from GAM and saved to Postgres (${fresh.rows?.length || 0} rows)`);
  return fresh;
}

/** Site-resolution context for scoped child users (catalog + assigned sites). */
function buildScopeSiteContextForUser(user) {
  const catalogPayload = cache.get(CATALOG_CACHE_KEY) || {};
  const catalogRows = findCachedInventoryRows(cache) || catalogPayload.rows || [];
  const ctx = buildDomainUserSiteContext(catalogPayload);
  const scope = getUserInventoryScope(user);
  const assignedSites = scope?.sites ? [...scope.sites] : [];
  if (assignedSites.length) {
    const merged = new Set([
      ...(ctx.siteHosts || []).map((h) => String(h).toLowerCase()),
      ...assignedSites.map((h) => String(h).toLowerCase()),
    ]);
    ctx.siteHosts = [...merged].sort((a, b) => a.localeCompare(b));
    const assignedMap = buildAssignedAdUnitHostMap(catalogRows, assignedSites);
    assignedMap.forEach((host, adUnit) => {
      if (!ctx.adUnitToHost.has(adUnit)) ctx.adUnitToHost.set(adUnit, host);
    });
  }
  return ctx;
}

/** Catalog enrichment before inventory scope — must match across overview and domain user. */
function enrichRowsForInventoryScope(allRows, user = null) {
  let rows = normalizeReportRows(allRows);
  const catalogCache = cache.get(CATALOG_CACHE_KEY);
  const catalogRows = findCachedInventoryRows(cache);
  const scope = user ? getUserInventoryScope(user) : null;
  const assignedSites = scope?.sites ? [...scope.sites] : [];

  if (catalogRows?.length) {
    const adUnitsByHost = catalogCache?.adUnitsByHost || findCachedAdUnitsByHost(cache);
    const baseSiteHosts = buildCatalogFilterOptions(catalogRows, catalogCache?.rawHosts || {}).siteHosts || [];
    const siteHosts = assignedSites.length
      ? [...new Set([...baseSiteHosts, ...assignedSites])]
      : baseSiteHosts;
    const assignedAdUnitMap = buildAssignedAdUnitHostMap(catalogRows, assignedSites);
    rows = applyCatalogSiteHosts(rows, catalogRows, adUnitsByHost, siteHosts);
    rows = enrichRowsWithCatalogSites(rows, catalogRows, adUnitsByHost, siteHosts);
    rows = fillAssignedSiteHostsForRows(rows, assignedSites, assignedAdUnitMap);
  } else if (assignedSites.length) {
    rows = fillAssignedSiteHostsForRows(rows, assignedSites);
  }
  const appMaps = rehydrateAppPackageMaps(catalogCache?.appPackageMaps);
  if (appMaps.byPackage.size) {
    rows = enrichRowsWithAppPackages(rows, appMaps);
  }
  return sanitizeRowsSiteHosts(rows);
}

/** Normalize, enrich site hosts, apply user scope, then optional inventory narrowing. */
function prepareScopedReportRows(allRows, filters, user) {
  const siteCtx = buildScopeSiteContextForUser(user);
  let rows = enrichRowsForInventoryScope(allRows, user);
  const isScopedChild = user?.role !== 'admin' && userHasAssignedInventory(user);

  if (isScopedChild) {
    rows = scopeRowsToUser(rows, user, siteCtx);
    if (hasInventoryFilters(filters)) {
      const selectedSites = toFilterArray(filters.site);
      let adUnitToHost = null;
      if (selectedSites.length) {
        const catalogPayload = cache.get(CATALOG_CACHE_KEY) || {};
        const catalogRows = findCachedInventoryRows(cache) || [];
        adUnitToHost = buildFilterAdUnitHostMap({
          catalogRows,
          selectedSites,
          adUnitsByHost: catalogPayload.adUnitsByHost || {},
          urlScanMap: catalogPayload.adUnitSiteMapFromScan || {},
        });
      }
      rows = filterRowsByInventory(rows, filters, { scopedChild: true, adUnitToHost });
      if (adUnitToHost?.size) {
        rows = rows.map((row) => {
          const host = lookupCatalogAdUnitHost(row, adUnitToHost);
          if (!host || !adUnitAlignsWithSiteHost(row.site, host)) return row;
          return { ...row, siteUrl: host, gamSite: host, siteName: host };
        });
      }
    }
    return rows;
  }

  if (hasInventoryFilters(filters)) {
    const selectedSites = toFilterArray(filters.site);
    let adUnitToHost = null;
    if (selectedSites.length) {
      const catalogPayload = cache.get(CATALOG_CACHE_KEY) || {};
      const catalogRows = findCachedInventoryRows(cache) || [];
      adUnitToHost = buildFilterAdUnitHostMap({
        catalogRows,
        selectedSites,
        adUnitsByHost: catalogPayload.adUnitsByHost || {},
        urlScanMap: catalogPayload.adUnitSiteMapFromScan || {},
      });
    }
    rows = filterRowsByInventory(rows, filters, { adUnitToHost });
    if (adUnitToHost?.size) {
      rows = rows.map((row) => {
        const host = lookupCatalogAdUnitHost(row, adUnitToHost);
        if (!host || !adUnitAlignsWithSiteHost(row.site, host)) return row;
        return { ...row, siteUrl: host, gamSite: host, siteName: host };
      });
    }
  }
  return scopeRowsToUser(rows, user, siteCtx);
}

/** Normalize, enrich site hosts, then apply user inventory scope (domain / site / app). */
function prepareDomainUserRows(allRows, user) {
  const siteCtx = buildScopeSiteContextForUser(user);
  return scopeRowsToUser(enrichRowsForInventoryScope(allRows, user), user, siteCtx);
}

/** Dedupe line-item rows when merging web + app overview slices. */
function mergeReportRowsByLineKey(primary = [], extra = []) {
  const seen = new Set();
  const keyOf = (r) => [
    r.date, r.site, r.appId, r.siteUrl, r.gamSite, r.revenue, r.impression,
  ].join('\0');
  const out = [];
  for (const row of [...primary, ...extra]) {
    const key = keyOf(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/** Scoped user overview KPIs — same strict filter path as dashboard Apply Filter on assigned inventory. */
function prepareScopedOverviewRows(allRows, user) {
  const scope = getUserInventoryScope(user);
  if (!scope) return enrichRowsForInventoryScope(allRows, user);

  // Prefer sites over domains for web; never AND domains+sites+apps (empties KPIs).
  const invFilters = {};
  if (scope.sites?.size) invFilters.site = [...scope.sites];
  else if (scope.domains?.size) invFilters.domain = [...scope.domains];
  else if (scope.appIds?.size) invFilters.domainId = [...scope.appIds];

  if (!Object.keys(invFilters).length) {
    return prepareDomainUserRows(allRows, user);
  }

  let rows = prepareScopedReportRows(allRows, invFilters, user);

  // Domains/sites + apps: add mobile-app rows (web∪app), not network-wide.
  if ((scope.sites?.size || scope.domains?.size) && scope.appIds?.size) {
    const siteCtx = buildScopeSiteContextForUser(user);
    const scoped = scopeRowsToUser(enrichRowsForInventoryScope(allRows, user), user, siteCtx);
    const appRows = applyScopedOverviewSiteTightening(
      scoped.filter((row) => isMobileAppRow(row) && rowMatchesAppFilter(row, [...scope.appIds])),
      user,
      siteCtx
    );
    rows = mergeReportRowsByLineKey(rows, appRows);
  }

  return rows;
}

/** Load raw detailed rows — memory → Redis → PostgreSQL → GAM (shared by overview + domain user). */
async function loadSharedDetailedReportRows(filters, token, user = null) {
  if (user && user.role !== 'admin' && userHasAssignedInventory(user)) {
    await ensureInventoryCatalog(token);
  }
  return loadReportRowsCacheAside(filters, token, {
    cachePrefix: 'report_domain_user_v2',
    dimensionSets: DOMAIN_USER_DIMENSION_SETS,
    fastMode: true,
    persistOnGam: true,
    enqueueSyncOnMiss: true,
    logLabel: 'Shared detailed',
  });
}

/** Dashboard raw rows — same cache/GAM path as /dashboard chart+table (site filter friendly). */
async function loadDashboardRawReportRows(filters, token, user = null) {
  if (user && user.role !== 'admin' && userHasAssignedInventory(user)) {
    await ensureInventoryCatalog(token);
  }
  return loadReportRowsCacheAside(filters, token, {
    cachePrefix: 'report_dashboard_raw_v3',
    fastMode: true,
    persistOnGam: true,
    enqueueSyncOnMiss: true,
    logLabel: 'Dashboard raw',
  });
}

function reportRowsCacheKey(filters, prefix = 'report_rows_v1') {
  return `${prefix}_${filterCacheKey({
    startDate: filters.startDate,
    endDate: filters.endDate,
    country: filters.country,
    domain: filters.domain,
    site: filters.site,
    domainName: filters.domainName,
    domainId: filters.domainId,
    reportDimensions: filters.reportDimensions,
    reportMetrics: filters.reportMetrics,
  })}`;
}

function rowsToPersistShape(rows, fallbackDate, currency = 'USD') {
  const keepDim = new Set([
    'DATE', 'date', 'COUNTRY_NAME', 'country_name', 'country',
    'DEVICE_CATEGORY_NAME', 'device_category_name', 'device',
    'AD_UNIT_NAME', 'ad_unit_name', 'site',
    'domainName', 'domain', 'siteUrl', 'gamSite', 'siteName', 'site_name',
  ]);
  const keepMetric = new Set([
    'revenue', 'impression', 'clicks', 'viewableRate',
    'TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS', 'TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE',
    'TOTAL_LINE_ITEM_LEVEL_ALL_REVENUE', 'TOTAL_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE',
    'total_active_view_viewable_impressions_rate',
  ]);
  return (rows || []).map((row) => {
    const dimensions = {};
    const metrics = {};
    const srcDims = { ...(row.dimensions || {}) };
    const srcMetrics = { ...(row.metrics || {}) };
    for (const [k, v] of Object.entries(row)) {
      if (k === 'dimensions' || k === 'metrics') continue;
      if (keepMetric.has(k) || typeof v === 'number') srcMetrics[k] = v;
      else if (v != null && v !== '' && keepDim.has(k)) srcDims[k] = v;
    }
    for (const [k, v] of Object.entries(srcDims)) {
      if (keepDim.has(k) && v != null && v !== '') dimensions[k] = v;
    }
    for (const [k, v] of Object.entries(srcMetrics)) {
      if (keepMetric.has(k) && v != null && v !== '') metrics[k] = v;
    }
    const country = row.country || dimensions.country_name || dimensions.COUNTRY_NAME || dimensions.country;
    const device = row.device || dimensions.device_category_name || dimensions.DEVICE_CATEGORY_NAME || dimensions.device;
    const adUnit = row.site || dimensions.AD_UNIT_NAME || dimensions.ad_unit_name || dimensions.site;
    if (country) {
      dimensions.country = country;
      dimensions.country_name = country;
      dimensions.COUNTRY_NAME = country;
    }
    if (device) {
      dimensions.device = device;
      dimensions.device_category_name = device;
      dimensions.DEVICE_CATEGORY_NAME = device;
    }
    if (adUnit) {
      dimensions.site = adUnit;
      dimensions.ad_unit_name = adUnit;
      dimensions.AD_UNIT_NAME = adUnit;
    }
    return {
      report_date: row.date || row.report_date || fallbackDate,
      dimensions,
      metrics,
      currency: currency || 'USD',
    };
  });
}

function persistReportRowsToStore(rows, syncType, fallbackDate, currency) {
  const svc = getSyncSvc();
  if (!svc?.persistSyncedRows || !rows?.length) return;
  svc.persistSyncedRows(rowsToPersistShape(rows, fallbackDate, currency), syncType)
    .catch((e) => logger.warn(`Persist ${syncType} failed:`, e.message));
}

/** Persist Reporting-page custom queries into report_adhoc (not lean dashboard tables). */
function persistAdhocRowsToStore(rows, filters, syncType = 'report-adhoc') {
  const svc = getSyncSvc();
  if (!svc?.persistAdhocRows || !svc?.buildAdhocQueryHash) return;
  const queryHash = svc.buildAdhocQueryHash(filters);
  const dimKeys = asArray(filters.reportDimensions);
  const metricKeys = asArray(filters.reportMetrics);
  svc.persistAdhocRows(rows || [], {
    queryHash,
    startDate: filters.startDate,
    endDate: filters.endDate,
    dimKeys,
    metricKeys,
    syncType,
  }).catch((e) => logger.warn(`Persist ${syncType} (adhoc) failed:`, e.message));
}

/**
 * Postgres read for Reporting page: report_adhoc by exact query_hash + date range.
 * Returns null on miss; [] when the query was previously fetched and had no rows.
 */
async function tryLoadAdhocRowsFromDb(filters) {
  const svc = getSyncSvc();
  if (!svc?.fetchAdhocFromDB || !svc?.buildAdhocQueryHash || !svc?.hasAdhocCoverage) return null;
  const queryHash = svc.buildAdhocQueryHash(filters);
  const covered = await svc.hasAdhocCoverage(filters.startDate, filters.endDate, queryHash);
  if (!covered) return null;
  const t0 = Date.now();
  const rows = await svc.fetchAdhocFromDB(filters.startDate, filters.endDate, queryHash);
  // No rows / no metrics → miss so Reporting falls through to live GAM.
  if (!rows?.length || !rowsHaveMetrics(rows)) {
    logger.info(
      `Postgres adhoc miss ${filters.startDate}..${filters.endDate}`
      + ` (query=${queryHash.slice(0, 8)}… rows=${rows?.length || 0}) → will call GAM`
    );
    return null;
  }
  logger.info(
    `Postgres adhoc load ${filters.startDate}..${filters.endDate} → ${rows.length} rows in ${Date.now() - t0}ms`
    + ` (query=${queryHash.slice(0, 8)}…)`
  );
  return rows;
}

async function enqueueRangeSync(startDate, endDate) {
  const queue = getQueue();
  if (!queue || isMockClient()) return false;
  const today = todayInTZ();
  const { getClientId } = require('../utils/clientContext');
  const clientId = getClientId();
  try {
    const isTodayOnly = startDate === endDate && startDate === today;
    if (isTodayOnly) {
      // BullMQ custom jobId cannot contain ':'
      const jobId = `sync-today-${startDate}`;
      const existing = await queue.getJob(jobId);
      if (!existing) {
        await queue.add('sync-today', { date: startDate, includeFull: false, clientId }, {
          jobId,
          priority: 1,
          attempts: 3,
          backoff: { type: 'exponential', delay: 10000 },
        });
        logger.info(`Enqueued ${jobId} → report_present (lean)`);
      }
    } else {
      const jobId = `sync-backfill-${startDate}-${endDate}`;
      const existing = await queue.getJob(jobId);
      if (!existing) {
        await queue.add('sync-backfill', { startDate, endDate, includeFull: false, clientId }, {
          jobId,
          priority: 10,
          attempts: 2,
          backoff: { type: 'fixed', delay: 60000 },
        });
        logger.info(`Enqueued ${jobId} → report_daily (lean)`);
      }
    }
    return true;
  } catch (qErr) {
    logger.warn('BullMQ enqueue failed:', qErr.message);
    return false;
  }
}

/** Enqueue full-only sync for Reporting warehouse miss (jobId without ':'). */
async function enqueueFullReportSync(startDate, endDate) {
  const queue = getQueue();
  if (!queue || isMockClient()) return null;
  const today = todayInTZ();
  const { getClientId } = require('../utils/clientContext');
  const clientId = getClientId();
  try {
    if (startDate === endDate && startDate === today) {
      const jobId = `sync-full-today-${today}-req`;
      const existing = await queue.getJob(jobId);
      if (!existing) {
        await queue.add('sync-full-today', { startDate: today, endDate: today, clientId }, {
          jobId,
          attempts: 2,
          backoff: { type: 'fixed', delay: 20000 },
        });
      }
      return jobId;
    }
    const jobId = `sync-full-backfill-${startDate}-${endDate}`.slice(0, 120);
    const existing = await queue.getJob(jobId);
    if (!existing) {
      await queue.add('sync-full-backfill', { startDate, endDate, clientId }, {
        jobId,
        attempts: 2,
        backoff: { type: 'fixed', delay: 60000 },
      });
    }
    return jobId;
  } catch (e) {
    logger.warn('enqueueFullReportSync failed:', e.message);
    return null;
  }
}

/**
 * Universal ladder for present + past report queries:
 *   1) memory  2) Redis  3) Postgres (lean tables OR report_adhoc for Reporting)
 *   4) GAM only if missing  5) persist GAM → Postgres + Redis
 *
 * opts.useAdhocStore — Reporting page custom dims/metrics → report_adhoc table
 *   (never writes into report_present / report_daily).
 */
async function loadReportRowsCacheAside(filters, token, opts = {}) {
  const {
    cachePrefix = 'report_rows_v1',
    dimensionSets = null,
    fastMode = true,
    skipDb = false,
    useAdhocStore = false,
    persistOnGam = true,
    enqueueSyncOnMiss = false,
    /** When true, miss → enqueue job and return empty+building (never block on live GAM). */
    asyncOnMiss = false,
    logLabel = 'Report',
  } = opts;

  const cacheKey = reportRowsCacheKey(filters, cachePrefix);

  // 1. Memory
  const cached = cache.get(cacheKey);
  if (cached?.rows?.length && rowsHaveMetrics(cached.rows)) {
    return {
      rows: cached.rows,
      cacheKey,
      source: 'memory',
      reportWarning: cached.reportWarning || null,
      reportWarningSkipped: cached.reportWarningSkipped || [],
      reportWarningUsed: cached.reportWarningUsed || [],
      reportWarningUsedIds: cached.reportWarningUsedIds || [],
      reportWarningUsedMetricIds: cached.reportWarningUsedMetricIds || [],
    };
  }

  // 2. Redis
  const r = getRedis();
  if (r?.redisGet) {
    try {
      const rData = await r.redisGet(cacheKey);
      if (rData?.rows?.length && rowsHaveMetrics(rData.rows)) {
        cache.set(cacheKey, rData, REPORT_CACHE_TTL);
        logger.info(`${logLabel} from Redis (${rData.rows.length} rows)`);
        return {
          rows: rData.rows,
          cacheKey,
          source: 'redis',
          reportWarning: rData.reportWarning || null,
          reportWarningSkipped: rData.reportWarningSkipped || [],
          reportWarningUsed: rData.reportWarningUsed || [],
          reportWarningUsedIds: rData.reportWarningUsedIds || [],
          reportWarningUsedMetricIds: rData.reportWarningUsedMetricIds || [],
        };
      }
      if (rData?.rows?.length) await r.redisDel(cacheKey);
    } catch (_) { /* ignore */ }
  }

  // 3. Postgres — lean (dashboard) or adhoc (Reporting page)
  if (!skipDb) {
    try {
      let rows = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          rows = useAdhocStore
            ? await tryLoadAdhocRowsFromDb(filters)
            : await tryLoadReportRowsFromDb(filters.startDate, filters.endDate, filters);
          break;
        } catch (pgAttemptErr) {
          if (attempt === 1 && /timeout|ECONNRESET|terminat/i.test(pgAttemptErr.message)) {
            logger.warn(`${logLabel} Postgres busy, retrying once:`, pgAttemptErr.message);
            await new Promise((r) => setTimeout(r, 750));
            continue;
          }
          throw pgAttemptErr;
        }
      }
      // Adhoc (Reporting): only a real non-empty metric result is a hit.
      // Missing / empty past data must fall through to live GAM.
      // Lean (Dashboard): non-empty rows count as a hit.
      const dbHit = useAdhocStore
        ? Boolean(rows?.length && rowsHaveMetrics(rows))
        : Boolean(rows?.length);
      if (dbHit) {
        const payload = { rows: rows || [] };
        cache.set(cacheKey, payload, REPORT_CACHE_TTL);
        if (r?.redisSet) await r.redisSet(cacheKey, payload, r.TTL?.REPORT || REPORT_CACHE_TTL);
        logger.info(
          `${logLabel} from PostgreSQL${useAdhocStore ? ' (report_adhoc)' : ''} (${(rows || []).length} rows) ${filters.startDate}..${filters.endDate}`
          + (hasInventoryFilters(filters) ? ' (SQL query filter)' : '')
        );
        return { rows: rows || [], cacheKey, source: 'db' };
      }
      logger.info(`${logLabel}: no Postgres data for query ${filters.startDate}..${filters.endDate} → ${asyncOnMiss ? 'async job' : 'GAM'}`);
    } catch (pgErr) {
      logger.warn(`${logLabel} PostgreSQL read failed, falling through to ${asyncOnMiss ? 'async' : 'GAM'}:`, pgErr.message);
    }
  }

  if (enqueueSyncOnMiss || asyncOnMiss) {
    await enqueueRangeSync(filters.startDate, filters.endDate);
  }

  // Async miss: never block HTTP on live GAM (Dashboard parity).
  // If enqueue fails, still return building — worker/cron will catch up.
  if (asyncOnMiss) {
    let jobId = null;
    if (useAdhocStore) {
      jobId = await enqueueAdhocReportJob(filters, cacheKey);
      if (!jobId) {
        logger.warn(`${logLabel}: async adhoc enqueue failed — returning building (no live GAM)`);
      }
    }
    return {
      rows: [],
      cacheKey,
      source: 'building',
      status: 'building',
      jobId,
      reportWarning: null,
      reportWarningSkipped: [],
      reportWarningUsed: [],
      reportWarningUsedIds: [],
      reportWarningUsedMetricIds: [],
    };
  }

  // 4. GAM last resort (blocking) — only when asyncOnMiss is false
  if (!token) {
    return { rows: [], cacheKey, source: 'empty' };
  }

  const gamFilters = {
    startDate: filters.startDate,
    endDate: filters.endDate,
    country: filters.country,
    reportDimensions: filters.reportDimensions,
    reportMetrics: filters.reportMetrics,
  };
  const gamOpts = { fastMode, compatOnly: Boolean(useAdhocStore) };
  if (dimensionSets) gamOpts.dimensionSets = dimensionSets;

  const result = await fetchWithDedup(cacheKey, async () => {
    const data = await runDetailedReport(gamFilters, token, gamOpts);
    return {
      rows: data.rows,
      trend: data.trend,
      reportWarning: data.reportWarning,
      reportWarningSkipped: data.reportWarningSkipped,
      reportWarningUsed: data.reportWarningUsed,
      reportWarningUsedIds: data.reportWarningUsedIds,
      reportWarningUsedMetricIds: data.reportWarningUsedMetricIds,
    };
  });

  if (!rowsHaveMetrics(result.rows)) {
    cache.del(cacheKey);
    logger.warn(`${logLabel}: GAM returned rows without revenue/impressions`);
    // Do NOT persist empty adhoc coverage — that would block future GAM calls
    // for the same past date range ("no data present → call GAM").
  } else {
    const payload = {
      rows: result.rows,
      reportWarning: result.reportWarning || null,
      reportWarningSkipped: result.reportWarningSkipped || [],
      reportWarningUsed: result.reportWarningUsed || [],
      reportWarningUsedIds: result.reportWarningUsedIds || [],
      reportWarningUsedMetricIds: result.reportWarningUsedMetricIds || [],
    };
    cache.set(cacheKey, payload, REPORT_CACHE_TTL);
    if (r?.redisSet) await r.redisSet(cacheKey, payload, r.TTL?.REPORT || REPORT_CACHE_TTL);
    // 5. Store for next request
    if (persistOnGam) {
      if (useAdhocStore) {
        persistAdhocRowsToStore(
          result.rows,
          filters,
          `${String(logLabel).toLowerCase().replace(/\s+/g, '-')}-gam`
        );
      } else {
        persistReportRowsToStore(
          result.rows,
          `${String(logLabel).toLowerCase().replace(/\s+/g, '-')}-gam`,
          filters.startDate,
          process.env.GAM_CURRENCY || 'USD'
        );
      }
    }
    logger.info(
      `${logLabel} from GAM (${result.rows.length} rows) — persisted to ${useAdhocStore ? 'report_adhoc' : 'DB'}/Redis`
    );
  }

  return {
    rows: result.rows || [],
    cacheKey,
    source: 'gam',
    reportWarning: result.reportWarning || null,
    reportWarningSkipped: result.reportWarningSkipped || [],
    reportWarningUsed: result.reportWarningUsed || [],
    reportWarningUsedIds: result.reportWarningUsedIds || [],
    reportWarningUsedMetricIds: result.reportWarningUsedMetricIds || [],
  };
}

async function enqueueAdhocReportJob(filters, cacheKey) {
  try {
    const { gamReportQueue } = require('../queues/gamSync');
    if (!gamReportQueue) return null;
    const hash = (() => {
      try {
        const { buildAdhocQueryHash } = require('../services/gamSyncService');
        return buildAdhocQueryHash(filters);
      } catch (_) {
        return 'adhoc';
      }
    })();
    const jobId = `adhoc-${String(getClientId() || '').slice(0, 8)}-${hash}-${filters.startDate}-${filters.endDate}`.slice(0, 120);
    const existing = await gamReportQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState().catch(() => null);
      if (state === 'completed') return jobId;
      if (state === 'active' || state === 'waiting' || state === 'delayed') return jobId;
    }
    await gamReportQueue.add('adhoc-report', {
      startDate: filters.startDate,
      endDate: filters.endDate,
      reportDimensions: filters.reportDimensions,
      reportMetrics: filters.reportMetrics,
      country: filters.country,
      cacheKey,
      queryHash: hash,
      clientId: getClientId(),
    }, {
      jobId,
      attempts: 2,
      backoff: { type: 'fixed', delay: 15000 },
    });
    logger.info(`Enqueued adhoc-report ${jobId}`);
    return jobId;
  } catch (e) {
    logger.warn('enqueueAdhocReportJob failed:', e.message);
    return null;
  }
}

function applyOverviewVisibility(payload, user) {
  const vis = buildVisibility(user);
  const s = payload.summary;
  if (s) {
    if (!vis.impressions) {
      s.impressions = 0;
      s.viewability = 0;
    }
    if (!vis.revenue) {
      s.revenue = 0;
      s.ecpm = 0;
    }
  }
  payload.visibility = vis;
  return payload;
}

// Derive the dashboard summary cards from detailed rows + daily trend
function deriveDashboardSummary(rows, trend, currency, isMock) {
  const impressions = rows.reduce((a, r) => a + (r.impression || 0), 0);
  const selectRange = +rows.reduce((a, r) => a + pickRowRevenueDollars(r), 0).toFixed(2);
  const clicks = rows.reduce((a, r) => a + (
    typeof r.clicks === 'number' ? r.clicks : Math.round((r.impression || 0) * ((r.ctr || 0) / 100))
  ), 0);
  const avgFill = rows.length ? rows.reduce((a, r) => a + (r.fillRate || 0), 0) / rows.length : 0;
  const pageViews = avgFill > 0 ? Math.round(impressions / (avgFill / 100)) : impressions;
  const last7Days = +trend.slice(-7).reduce((a, t) => a + (t.earning || 0), 0).toFixed(2);
  const totalEarning = selectRange;
  const revenue = selectRange;
  const ecpm = impressions > 0 ? +((revenue / impressions) * 1000).toFixed(2) : 0;
  const impWeight = rows.reduce((a, r) => a + (Number(r.impression) || 0), 0);
  const viewability = impWeight > 0
    ? +(rows.reduce((a, r) => a + (Number(r.viewableRate) || 0) * (Number(r.impression) || 0), 0) / impWeight).toFixed(1)
    : 0;
  const rnd = () => +(Math.random() * 16 - 5).toFixed(1);

  return {
    totalEarning, totalEarningChange: isMock ? rnd() : 0,
    selectRange, selectRangeChange: isMock ? rnd() : 0,
    last7Days, last7DaysChange: isMock ? rnd() : 0,
    pageViews, pageViewsChange: isMock ? rnd() : 0,
    impressions, impressionsChange: isMock ? rnd() : 0,
    clicks, clicksChange: isMock ? rnd() : 0,
    revenue, revenueChange: isMock ? rnd() : 0,
    ecpm, ecpmChange: isMock ? rnd() : 0,
    viewability, viewabilityChange: isMock ? rnd() : 0,
    currency
  };
}

/** Compact chart series from in-memory rows (fallback when SQL bundle is unavailable). */
function buildDashboardChartsFromRows(rows = [], opts = {}) {
  const topN = Math.max(1, Number(opts.topN) || 10);
  const sumBy = (keyFn) => {
    const map = new Map();
    for (const row of rows) {
      const name = keyFn(row);
      if (!name) continue;
      const value = Number(row.revenue) || 0;
      if (value <= 0) continue;
      map.set(name, (map.get(name) || 0) + value);
    }
    return Array.from(map.entries())
      .map(([name, value]) => ({ name, value: +Number(value).toFixed(2) }))
      .sort((a, b) => b.value - a.value);
  };
  const domainOf = (r) => String(r.domain || r.domainName || r.gamDomain || '').trim() || null;
  const countryOf = (r) => String(r.country || r.countryName || r.dimensions?.COUNTRY_NAME || '').trim() || null;
  const deviceOf = (r) => {
    const raw = String(r.device || r.deviceCategory || r.dimensions?.DEVICE_CATEGORY_NAME || '').trim();
    if (!raw) return null;
    const s = raw.toLowerCase();
    if (/tablet|ipad/.test(s)) return 'Tablet';
    if (/smart.?phone|mobile|phone|feature.?phone|android|ios/.test(s)) return 'Mobile';
    if (/desktop|laptop|computer|pc|macintosh|windows/.test(s)) return 'Laptop';
    if (/connected.?tv|smart.?tv|set.?top|tv/.test(s)) return 'TV';
    return raw;
  };
  const adUnitOf = (r) => String(r.site || r.ad_unit_name || r.AD_UNIT_NAME || '').trim() || null;

  const revenue = sumBy(domainOf).slice(0, topN);
  const device = sumBy(deviceOf);
  const country = sumBy(countryOf).slice(0, topN);

  const perfMap = new Map();
  for (const row of rows) {
    const name = adUnitOf(row);
    if (!name) continue;
    const prev = perfMap.get(name) || { name, revenue: 0, impressions: 0 };
    prev.revenue += Number(row.revenue) || 0;
    prev.impressions += Number(row.impression) || 0;
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

  return { revenue, device, country, performance };
}

/** Never ship unbounded grain rows to the browser — caps payload + freezes. */
const MAX_DASHBOARD_CLIENT_ROWS = 2500;

function emptyDashboardCompatPayload(filters, currency) {
  const skipped = inventoryFilterFamilyLabels(filters);
  return {
    summary: {
      impressions: 0,
      revenue: 0,
      ecpm: 0,
      viewability: 0,
      currency: currency || 'USD',
    },
    rows: [],
    trend: [],
    charts: { revenue: [], device: [], country: [], performance: [] },
    isMock: false,
    reportWarning: 'incompatible',
    reportWarningSkipped: skipped,
    reportWarningUsed: [],
    reportWarningUsedIds: [],
    reportWarningUsedMetricIds: [],
  };
}

/**
 * When Domain/Site/Ad Unit + App ID are AND'd, lean SQL often returns nothing (rows rarely
 * match both). Fall back to web-only / app-only subsets — same idea as Reporting's
 * compatible dim/metric subset — and flag what could not be combined.
 */
async function fetchLeanDashboardBundleCompatible(svc, startDate, endDate, baseOpts) {
  const hasWeb = (baseOpts.domains?.length || 0)
    || (baseOpts.sites?.length || 0)
    || (baseOpts.adUnitNames?.length || 0);
  const hasApp = (baseOpts.apps?.length || 0) > 0;

  // Mixed web+app: skip the doomed AND query — go straight to parallel union (faster).
  if (!(hasWeb && hasApp)) {
    const primary = await svc.fetchLeanDashboardBundleFromDB(startDate, endDate, baseOpts);
    if (primary) return { bundle: primary, skipped: [], usedOpts: baseOpts };
    return null;
  }

  const webOpts = { ...baseOpts, apps: [] };
  const appOpts = {
    ...baseOpts,
    domains: [],
    sites: [],
    adUnitNames: [],
  };
  const [webBundle, appBundle] = await Promise.all([
    svc.fetchLeanDashboardBundleFromDB(startDate, endDate, webOpts),
    svc.fetchLeanDashboardBundleFromDB(startDate, endDate, appOpts),
  ]);

  if (webBundle && !appBundle) {
    return {
      bundle: webBundle,
      skipped: ['App ID'],
      usedOpts: webOpts,
    };
  }
  if (appBundle && !webBundle) {
    const skipped = [];
    if (baseOpts.domains?.length) skipped.push('Domain name');
    if (baseOpts.sites?.length) skipped.push('Site');
    if (baseOpts.adUnitNames?.length) skipped.push('Ad Unit');
    return {
      bundle: appBundle,
      skipped,
      usedOpts: appOpts,
    };
  }
  if (!webBundle && !appBundle) return null;

  // Both sides have data — merge like scoped OR (web rows + app rows).
  const webRows = webBundle.rows || [];
  const appRows = appBundle.rows || [];
  const rows = [...webRows, ...appRows].slice(0, MAX_DASHBOARD_CLIENT_ROWS);
  const impressions = (webBundle.summary?.impressions || 0) + (appBundle.summary?.impressions || 0);
  const revenue = +((webBundle.summary?.revenue || 0) + (appBundle.summary?.revenue || 0)).toFixed(2);
  const trendMap = new Map();
  for (const t of [...(webBundle.trend || []), ...(appBundle.trend || [])]) {
    const key = t.date;
    const prev = trendMap.get(key) || { date: key, earning: 0, revenue: 0, impressions: 0 };
    prev.earning = +((prev.earning || prev.revenue || 0) + (t.earning ?? t.revenue ?? 0)).toFixed(2);
    prev.revenue = prev.earning;
    prev.impressions += Math.round(t.impressions || 0);
    trendMap.set(key, prev);
  }
  const trend = [...trendMap.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const charts = buildDashboardChartsFromRows(rows);
  return {
    bundle: {
      summary: {
        impressions,
        revenue,
        ecpm: impressions > 0 ? +((revenue / impressions) * 1000).toFixed(2) : 0,
        viewability: webBundle.summary?.viewability || appBundle.summary?.viewability || 0,
        currency: webBundle.summary?.currency || appBundle.summary?.currency,
      },
      rows,
      trend,
      charts,
      grainCount: (webBundle.grainCount || 0) + (appBundle.grainCount || 0),
      source: 'compat-union',
      pagination: {
        totalRows: rows.length,
        truncated: (webRows.length + appRows.length) > rows.length,
      },
    },
    skipped: ['Domain/Site + App ID (combined)'],
    usedOpts: baseOpts,
    effectiveFilters: {
      domain: baseOpts.domains || [],
      site: baseOpts.sites || [],
      domainName: baseOpts.adUnitNames || [],
      domainId: baseOpts.apps || [],
    },
  };
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// GET|POST /api/reports/dashboard/overview — overview KPIs (programmatic or inventory-scoped)
async function handleDashboardOverview(req, res) {
  if (!canAccessPage(req.user, 'dashboard')) {
    return res.status(403).json({ error: 'You do not have permission to access the dashboard.' });
  }
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');

  const today = todayInTZ();
  const startDate = req.query.startDate || today;
  const endDate = req.query.endDate || today;
  const { country, domainId, domainName, domain, site } = req.query;
  const filters = applyDateRestrictionToFilters(
    { startDate, endDate, country, domainId, domainName, domain, site },
    req.user
  );
  const currency = process.env.GAM_CURRENCY || null;
  const isScopedUser = req.user?.role !== 'admin';
  const scopeRows = (rows) => applyProgrammaticVisibility({ rows }, req.user, { overviewOnly: true }).rows || [];
  const invFilterActive = hasInventoryFilters(filters);
  const inventoryFilters = invFilterActive ? filters : {};

  if (isMockClient()) {
    if (!isScopedUser && !invFilterActive) {
      const { rows } = mockProgrammatic(filters);
      const summary = deriveProgrammaticOverviewSummary(scopeRows(rows), 'USD', true);
      return res.json(applyOverviewVisibility({ summary, isMock: true, currency: 'USD' }, req.user));
    }
    const base = mockDetailed(filters);
    if (invFilterActive) {
      const scoped = prepareScopedReportRows(base.rows, inventoryFilters, req.user);
      const trend = trendFromRows(scoped);
      const summary = deriveDashboardSummary(scoped, trend, 'USD', true);
      return res.json(applyOverviewVisibility({ summary, isMock: true, currency: 'USD' }, req.user));
    }
    const prepared = isScopedUser
      ? prepareScopedOverviewRows(base.rows, req.user)
      : enrichRowsForInventoryScope(base.rows);
    const trend = trendFromRows(prepared);
    const summary = deriveDashboardSummary(prepared, trend, 'USD', true);
    return res.json(applyOverviewVisibility({ summary, isMock: true, currency: 'USD' }, req.user));
  }

  // Always: memory → Redis → Postgres (present/past for this query) → GAM
  if (isScopedUser && !userHasAssignedInventory(req.user)) {
    const summary = deriveScopedOverviewSummary([], currency, false);
    return res.json(applyOverviewVisibility({ summary, isMock: false, currency }, req.user));
  }

  try {
    const token = await getToken();

    // Admin / domain-user overview: same fast SQL SUM path (rollups).
    // Domain users pass assigned inventory opts so KPIs stay tenant-scoped without loading grain rows.
    {
      const svc = getSyncSvc();
      if (svc?.fetchLeanOverviewTotalsFromDB) {
        try {
          const t0 = Date.now();
          let overviewOpts = {};
          if (isScopedUser && userHasAssignedInventory(req.user)) {
            const scoped = resolveScopedSqlInventoryOpts(
              req.user,
              invFilterActive ? filters : {}
            );
            overviewOpts = {
              domains: scoped.domains,
              sites: scoped.sites,
              apps: scoped.apps,
              adUnitNames: scoped.adUnitNames,
              webInventoryOr: scoped.webInventoryOr,
              skipAdUnitLike: scoped.skipAdUnitLike,
            };
          } else if (invFilterActive) {
            overviewOpts = {
              domains: toFilterArray(filters.domain),
              sites: toFilterArray(filters.site),
              apps: toFilterArray(filters.domainId),
              adUnitNames: toFilterArray(filters.domainName),
            };
          }
          const totals = await svc.fetchLeanOverviewTotalsFromDB(
            filters.startDate,
            filters.endDate,
            overviewOpts
          );
          if (totals) {
            const impressions = totals.impressions || 0;
            const revenue = totals.revenue || 0;
            const ecpm = impressions > 0 ? +((revenue / impressions) * 1000).toFixed(2) : 0;
            const summary = {
              totalEarning: revenue,
              totalEarningChange: 0,
              selectRange: revenue,
              selectRangeChange: 0,
              last7Days: revenue,
              last7DaysChange: 0,
              pageViews: impressions,
              pageViewsChange: 0,
              impressions,
              impressionsChange: 0,
              clicks: 0,
              clicksChange: 0,
              revenue,
              revenueChange: 0,
              ecpm,
              ecpmChange: 0,
              viewability: totals.viewability || 0,
              viewabilityChange: 0,
              currency,
            };
            logger.info(
              `Overview from PostgreSQL ${totals.source === 'rollup' ? 'rollups' : 'aggregates'} (${totals.rowCount} rows summed)`
              + ` ${filters.startDate}..${filters.endDate} revenue=${revenue} impressions=${impressions}`
              + (isScopedUser ? ` user=${req.user.username}` : '')
              + ` in ${Date.now() - t0}ms`
            );
            return res.json(applyOverviewVisibility({ summary, isMock: false, currency }, req.user));
          }
        } catch (aggErr) {
          logger.warn('Overview SQL aggregate failed, falling through:', aggErr.message);
        }
      }
    }

    // Legacy fallback only if SQL totals miss — avoid for domain users when possible.
    if (isScopedUser && userHasAssignedInventory(req.user)) {
      const svc = getSyncSvc();
      if (typeof svc?.fetchLeanDashboardBundleFromDB === 'function') {
        try {
          const t0 = Date.now();
          const scoped = resolveScopedSqlInventoryOpts(
            req.user,
            invFilterActive ? filters : {}
          );
          const compat = await fetchLeanDashboardBundleCompatible(
            svc,
            filters.startDate,
            filters.endDate,
            {
              domains: scoped.domains,
              sites: scoped.sites,
              apps: scoped.apps,
              adUnitNames: scoped.adUnitNames,
              webInventoryOr: scoped.webInventoryOr,
              skipAdUnitLike: scoped.skipAdUnitLike,
              currency,
              tableLimit: 50,
              selectedDomains: scoped.domains,
            }
          );
          if (compat?.bundle?.summary) {
            const b = compat.bundle.summary;
            const impressions = Math.round(Number(b.impressions) || 0);
            const revenue = +Number(b.revenue || 0).toFixed(2);
            const ecpm = impressions > 0
              ? +((revenue / impressions) * 1000).toFixed(2)
              : (Number(b.ecpm) || 0);
            const summary = {
              totalEarning: revenue,
              totalEarningChange: 0,
              selectRange: revenue,
              selectRangeChange: 0,
              last7Days: revenue,
              last7DaysChange: 0,
              pageViews: impressions,
              pageViewsChange: 0,
              impressions,
              impressionsChange: 0,
              clicks: 0,
              clicksChange: 0,
              revenue,
              revenueChange: 0,
              ecpm,
              ecpmChange: 0,
              viewability: Number(b.viewability) || 0,
              viewabilityChange: 0,
              currency: currency || b.currency,
            };
            logger.info(
              `Overview scoped lean SQL user=${req.user.username}`
              + ` source=${compat.bundle.source || 'lean'}`
              + ` revenue=${revenue} impressions=${impressions}`
              + ` range=${filters.startDate}..${filters.endDate}`
              + ` in ${Date.now() - t0}ms`
            );
            return res.json(applyOverviewVisibility({ summary, isMock: false, currency }, req.user));
          }
        } catch (scopedErr) {
          logger.warn('Overview scoped lean SQL failed, falling through:', scopedErr.message);
        }
      }
    }

    const { rows: rawRows } = await loadReportRowsCacheAside(filters, token, {
      cachePrefix: 'report_overview_v3',
      fastMode: true,
      persistOnGam: true,
      enqueueSyncOnMiss: true,
      asyncOnMiss: true,
      logLabel: 'Overview',
    });
    const prepared = invFilterActive
      ? prepareScopedReportRows(rawRows, inventoryFilters, req.user)
      : (isScopedUser
        ? prepareScopedOverviewRows(rawRows, req.user)
        : enrichRowsForInventoryScope(rawRows));
    const trend = trendFromRows(prepared);
    const summary = deriveDashboardSummary(prepared, trend, currency, false);
    if (isScopedUser || invFilterActive) {
      logger.info(
        `Overview user=${req.user.username}${invFilterActive ? ' filtered' : ''}`
        + ` raw=${rawRows.length} prepared=${prepared.length}`
        + ` revenue=${summary.revenue} impressions=${summary.impressions}`
        + ` range=${filters.startDate}..${filters.endDate}`
      );
    }
    return res.json(applyOverviewVisibility({ summary, isMock: false, currency }, req.user));
  } catch (err) {
    logger.error('Dashboard overview error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
registerFilterReportRoute('/dashboard/overview', handleDashboardOverview);

// GET|POST /api/reports/dashboard — summary cards + detailed rows + daily trend (realtime)
async function handleDashboard(req, res) {
  const forDomainUser = req.query.for === 'domain-user';
  const canDashboard = canAccessPage(req.user, 'dashboard');
  const canDomainUser = canAccessPage(req.user, 'domain-user');
  if (!canDashboard && !(forDomainUser && canDomainUser)) {
    return res.status(403).json({
      error: forDomainUser
        ? 'You do not have permission to access domain user reports.'
        : 'You do not have permission to access the dashboard.',
    });
  }
  const today = todayInTZ();
  const startDate = req.query.startDate || today;
  const endDate = req.query.endDate || today;
  const { country, domainId, domainName, domain, site, cursor, limit, sortColumn, sortDir } = req.query;
  const filters = applyDateRestrictionToFilters(
    { startDate, endDate, country, domainId, domainName, domain, site },
    req.user
  );
  const paginationOpts = parsePaginationQuery({ cursor, limit, sortColumn, sortDir });

  const wantAllRows = false; // Never return full grain dumps — freezes browsers on wide date ranges.

  const visibilityOpts = forDomainUser ? { domainUserView: true } : {};
  const isScopedChild = req.user?.role !== 'admin' && userHasAssignedInventory(req.user);

  // Builds the per-user scoped response from a full (unscoped) rows set.
  const buildScoped = (allRows, currency, isMock) => {
    const rows = prepareScopedReportRows(allRows, filters, req.user);
    if (isScopedChild && hasInventoryFilters(filters)) {
      logger.info(
        `Dashboard scoped filtered user=${req.user.username}`
        + ` raw=${allRows.length} prepared=${rows.length}`
        + ` sites=${toFilterArray(filters.site).length}`
        + ` revenue=${rows.reduce((a, r) => a + (Number(r.revenue) || 0), 0).toFixed(2)}`
      );
    }
    const trend = trendFromRows(rows);
    const summary = deriveDashboardSummary(rows, trend, currency, isMock);
    const charts = buildDashboardChartsFromRows(rows);
    // Cap payload even if a client still sends allRows.
    const capped = rows.length > MAX_DASHBOARD_CLIENT_ROWS
      ? rows.slice(0, MAX_DASHBOARD_CLIENT_ROWS)
      : rows;
    const emptyCompat = hasInventoryFilters(filters)
      && !capped.length
      && !(Number(summary?.impressions) > 0 || Number(summary?.revenue) > 0);
    const warningFields = emptyCompat
      ? {
        reportWarning: 'incompatible',
        reportWarningSkipped: inventoryFilterFamilyLabels(filters),
        reportWarningUsed: [],
        reportWarningUsedIds: [],
        reportWarningUsedMetricIds: [],
      }
      : {
        reportWarning: null,
        reportWarningSkipped: [],
        reportWarningUsed: [],
        reportWarningUsedIds: [],
        reportWarningUsedMetricIds: [],
      };
    if (wantAllRows && rows.length <= MAX_DASHBOARD_CLIENT_ROWS) {
      return applyVisibility({
        summary,
        rows: capped,
        trend,
        charts,
        isMock,
        pagination: { totalRows: rows.length, allRows: true, truncated: false },
        ...warningFields,
      }, req.user, visibilityOpts);
    }
    const { rows: pageRows, pagination } = paginateRows(capped, {
      ...paginationOpts,
      limit: Math.min(paginationOpts.limit || 50, MAX_DASHBOARD_CLIENT_ROWS),
    });
    return applyVisibility({
      summary,
      rows: pageRows,
      trend,
      charts,
      isMock,
      pagination: {
        ...pagination,
        totalRows: rows.length,
        truncated: rows.length > MAX_DASHBOARD_CLIENT_ROWS,
      },
      ...warningFields,
    }, req.user, visibilityOpts);
  };

  if (isMockClient()) {
    logger.info('Mock mode: returning mock dashboard');
    const base = mockDetailed(filters);
    return res.json(buildScoped(base.rows, 'USD', true));
  }

  const currency = process.env.GAM_CURRENCY || null;

  // Compact response cache (fits Redis 10MB) — warm clicks return in ms.
  const dashRespKey = `report_dashboard_resp_v4_${req.user?.id || 'anon'}_${filterCacheKey({
    startDate: filters.startDate,
    endDate: filters.endDate,
    country: filters.country,
    domain: filters.domain,
    site: filters.site,
    domainName: filters.domainName,
    domainId: filters.domainId,
  })}`;
  try {
    const hit = cache.get(dashRespKey);
    if (hit?.summary) {
      logger.info(`Dashboard from memory response cache ${filters.startDate}..${filters.endDate}`);
      return res.json(hit);
    }
    const r = getRedis();
    if (r?.redisGet) {
      const rHit = await r.redisGet(dashRespKey);
      if (rHit?.summary) {
        cache.set(dashRespKey, rHit, REPORT_CACHE_TTL);
        logger.info(`Dashboard from Redis response cache ${filters.startDate}..${filters.endDate}`);
        return res.json(rHit);
      }
    }
  } catch (_) { /* ignore cache errors */ }

  // Fast path: rollups / SQL aggregates + capped table — avoids loading 100k–700k grain rows.
  try {
    const svc = require('../services/gamSyncService');
    if (typeof svc.fetchLeanDashboardBundleFromDB === 'function') {
      const t0 = Date.now();
      let domains = toFilterArray(filters.domain);
      let sites = toFilterArray(filters.site);
      let apps = toFilterArray(filters.domainId);
      let webInventoryOr = false;
      let skipAdUnitLike = false;
      // Scoped children must never see network-wide SQL aggregates.
      // Domains+sites+apps must not be AND'd — that returns empty for assigned-all users.
      if (isScopedChild) {
        const scoped = resolveScopedSqlInventoryOpts(req.user, filters);
        domains = scoped.domains;
        sites = scoped.sites;
        apps = scoped.apps;
        webInventoryOr = !!scoped.webInventoryOr;
        skipAdUnitLike = !!scoped.skipAdUnitLike;
      }
      const compat = await fetchLeanDashboardBundleCompatible(svc, filters.startDate, filters.endDate, {
        domains,
        sites,
        adUnitNames: toFilterArray(filters.domainName),
        apps,
        countryNames: toFilterArray(filters.country).map((c) => String(c)),
        currency,
        tableLimit: MAX_DASHBOARD_CLIENT_ROWS,
        selectedDomains: domains,
        webInventoryOr,
        skipAdUnitLike,
      });
      if (compat?.bundle) {
        const bundle = compat.bundle;
        // SQL already applied inventory scope — skip heavy catalog re-filter (that made domain users slower than admin).
        const rowFilters = bundle.source === 'compat-union'
          ? { ...filters, domain: [], site: [], domainName: [], domainId: [] }
          : {
            ...filters,
            domain: compat.usedOpts?.domains ?? filters.domain,
            site: compat.usedOpts?.sites ?? filters.site,
            domainName: compat.usedOpts?.adUnitNames ?? filters.domainName,
            domainId: compat.usedOpts?.apps ?? filters.domainId,
          };
        const scopedRows = (isScopedChild && (bundle.source === 'rollup' || bundle.source === 'compat-union' || bundle.source === 'lean'))
          ? normalizeReportRows(bundle.rows || [])
          : prepareScopedReportRows(bundle.rows, rowFilters, req.user);
        logger.info(
          `Dashboard ${bundle.source === 'rollup' ? 'rollup' : (bundle.source || 'lean SQL')} bundle ${filters.startDate}..${filters.endDate}`
          + ` grain≈${bundle.grainCount} table=${scopedRows.length}`
          + (isScopedChild ? ` user=${req.user.username}` : '')
          + (compat.skipped?.length ? ` compatSkipped=[${compat.skipped.join(', ')}]` : '')
          + ` in ${Date.now() - t0}ms`
        );
        const warningFields = compat.skipped?.length
          ? {
            reportWarning: 'partial',
            reportWarningSkipped: compat.skipped,
            reportWarningUsed: inventoryFilterFamilyLabels(filters)
              .filter((l) => !compat.skipped.includes(l)),
            reportWarningUsedIds: [],
            reportWarningUsedMetricIds: [],
          }
          : {
            reportWarning: null,
            reportWarningSkipped: [],
            reportWarningUsed: [],
            reportWarningUsedIds: [],
            reportWarningUsedMetricIds: [],
          };
        const payload = applyVisibility({
          summary: { ...bundle.summary, currency: currency || bundle.summary.currency },
          rows: scopedRows,
          trend: bundle.trend,
          charts: bundle.charts,
          isMock: false,
          pagination: bundle.pagination,
          ...warningFields,
        }, req.user, visibilityOpts);
        cache.set(dashRespKey, payload, REPORT_CACHE_TTL);
        try {
          const r = getRedis();
          if (r?.redisSet) await r.redisSet(dashRespKey, payload, r.TTL?.REPORT || REPORT_CACHE_TTL);
        } catch (_) { /* ignore */ }
        return res.json(payload);
      }
      // Scoped children: same speed as admin — never block on GAM when rollup SQL misses.
      // Enqueue backfill in the background; return empty KPIs immediately.
      if (isScopedChild) {
        logger.info(
          `Dashboard scoped SQL miss ${filters.startDate}..${filters.endDate}`
          + ` user=${req.user.username} — empty response (no GAM wait) in ${Date.now() - t0}ms`
        );
        enqueueRangeSync(filters.startDate, filters.endDate).catch(() => {});
        const empty = applyVisibility({
          summary: {
            impressions: 0,
            revenue: 0,
            ecpm: 0,
            viewability: 0,
            currency: currency || 'USD',
          },
          rows: [],
          trend: [],
          charts: { revenue: [], device: [], country: [], performance: [] },
          isMock: false,
          pagination: { totalRows: 0, truncated: false },
        }, req.user, visibilityOpts);
        cache.set(dashRespKey, empty, Math.min(60, REPORT_CACHE_TTL));
        return res.json(empty);
      }
      // Mixed web+app with no compatible subset → Reporting-style empty warning (don't hang on GAM).
      if (hasMixedWebAndAppFilters({
        domain: domains,
        site: sites,
        domainName: toFilterArray(filters.domainName),
        domainId: apps,
      })) {
        const empty = applyVisibility(
          emptyDashboardCompatPayload(filters, currency),
          req.user,
          visibilityOpts
        );
        return res.json(empty);
      }
    }
  } catch (bundleErr) {
    logger.warn(`Dashboard lean SQL bundle failed, falling back: ${bundleErr.message}`);
    if (isScopedChild) {
      enqueueRangeSync(filters.startDate, filters.endDate).catch(() => {});
      return res.json(applyVisibility({
        summary: {
          impressions: 0,
          revenue: 0,
          ecpm: 0,
          viewability: 0,
          currency: currency || 'USD',
        },
        rows: [],
        trend: [],
        charts: { revenue: [], device: [], country: [], performance: [] },
        isMock: false,
        pagination: { totalRows: 0, truncated: false },
      }, req.user, visibilityOpts));
    }
  }

  // memory → Redis → Postgres (present/past for this query) → GAM → persist
  try {
    const token = await getToken();
    const { rows } = await loadReportRowsCacheAside(filters, token, {
      cachePrefix: 'report_dashboard_raw_v3',
      fastMode: true,
      persistOnGam: true,
      enqueueSyncOnMiss: true,
      asyncOnMiss: true,
      logLabel: 'Dashboard',
    });
    return res.json(buildScoped(rows, currency, false));
  } catch (err) {
    logger.error('Dashboard report error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
registerFilterReportRoute('/dashboard', handleDashboard);

// GET|POST /api/reports/domain-user — aggregated domain earnings with cursor pagination
async function handleDomainUserReport(req, res) {
  if (!canAccessPage(req.user, 'domain-user')) {
    return res.status(403).json({ error: 'You do not have permission to access domain user reports.' });
  }

  const today = todayInTZ();
  const startDate = req.query.startDate || today;
  const endDate = req.query.endDate || today;
  const { cursor, limit, sortColumn, sortDir, search } = req.query;
  const filters = applyDateRestrictionToFilters({ startDate, endDate }, req.user);
  const paginationOpts = parsePaginationQuery({ cursor, limit, sortColumn, sortDir });
  const wantAllRows = req.query.allRows === '1' || req.query.allRows === 'true';

  const buildResponse = (allRows, currency, isMock, siteCtx = null) => {
    const prepared = req.user?.role === 'admin'
      ? prepareDomainUserRows(allRows, req.user)
      : (userHasAssignedInventory(req.user)
        ? prepareScopedOverviewRows(allRows, req.user)
        : []);
    const aggregated = wantAllRows
      ? aggregateDomainUserRows(prepared, siteCtx)
      : filterDomainUserRows(aggregateDomainUserRows(prepared, siteCtx), search);
    const stats = summarizeDomainUserRows(aggregated);
    if (wantAllRows) {
      return applyVisibility({
        summary: { ...stats, currency },
        rows: aggregated,
        isMock,
        pagination: { totalRows: aggregated.length, allRows: true },
      }, req.user, { domainUserView: true });
    }
    const { rows: pageRows, pagination } = paginateRows(aggregated, paginationOpts);
    return applyVisibility({
      summary: { ...stats, currency },
      rows: pageRows,
      isMock,
      pagination,
    }, req.user, { domainUserView: true });
  };

  if (isMockClient()) {
    const base = mockDetailed(filters);
    return res.json(buildResponse(base.rows, 'USD', true, null));
  }

  const currency = process.env.GAM_CURRENCY || null;

  try {
    const token = await getToken();
    let catalogPayload = cache.get(CATALOG_CACHE_KEY);
    if (!catalogPayload?.adUnitsByHost || !Object.keys(catalogPayload.adUnitsByHost).length) {
      try {
        catalogPayload = await getFilterCatalog(token, { allowStale: true });
      } catch (catErr) {
        logger.warn('Domain user catalog warmup failed:', catErr.message);
        catalogPayload = catalogPayload || {};
      }
    }
    const siteCtx = buildDomainUserSiteContext(catalogPayload || {});
    const { rows } = await loadSharedDetailedReportRows(filters, token, req.user);
    return res.json(buildResponse(rows, currency, false, siteCtx));
  } catch (err) {
    logger.error('Domain user report error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
registerFilterReportRoute('/domain-user', handleDomainUserReport);

// GET /api/reports/filter-catalog — lightweight inventory list for filter dropdowns
router.get('/filter-catalog', async (req, res) => {
  if (!canAccessPage(req.user, 'dashboard') && !canAccessPage(req.user, 'reporting')) {
    return res.status(403).json({ error: 'You do not have permission to load filter options.' });
  }

  if (isMockClient()) {
    const { startDate, endDate } = dateRangeYMDInTZ(7);
    const base = mockDetailed({ startDate, endDate });
    const rows = scopeRowsToUser(dedupeCatalogRows(base.rows), req.user);
    const scoped = scopeCatalogOptionsForUser(
      { rows, ...buildCatalogFilterOptions(rows) },
      req.user
    );
    return res.json({ ...scoped, isMock: true });
  }

  // Always use the dedicated catalog (enriched with InventoryService site map).
  // Do NOT fall back to general report rows — those lack proper site/domain enrichment.
  try {
    const token = await getToken();
    const result = await getFilterCatalog(token, { allowStale: true });
    const rows = scopeRowsToUser(result.rows || [], req.user);
    const scoped = scopeCatalogOptionsForUser(
      {
        rows,
        adUnitsByHost: result.adUnitsByHost || {},
        ...buildCatalogFilterOptions(rows, result.rawHosts || {}),
      },
      req.user
    );
    res.json({
      ...scoped,
      appPackages: result.appPackages || [],
      startDate: result.startDate,
      endDate: result.endDate,
    });
  } catch (err) {
    logger.error('Filter catalog error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to load filter options' });
  }
});

// GET|POST /api/reports/detailed — full report with filters (date range, country, domain)
async function handleDetailedReport(req, res) {
  if (!canAccessPage(req.user, 'reporting')) {
    return res.status(403).json({ error: 'You do not have permission to access reporting.' });
  }
  const today = todayInTZ();
  const startDate = req.query.startDate || today;
  const endDate = req.query.endDate || today;
  const {
    country, domainId, domainName, domain, site,
    reportDimensions, reportMetrics,
    cursor, limit, sortColumn, sortDir,
  } = req.query;
  const filters = applyDateRestrictionToFilters({
    startDate, endDate, country, domainId, domainName, domain, site,
    reportDimensions, reportMetrics,
  }, req.user);
  const paginationOpts = parsePaginationQuery({ cursor, limit, sortColumn, sortDir });

  const wantAllRows = req.query.allRows === '1' || req.query.allRows === 'true';
  const MAX_REPORTING_CLIENT_ROWS = 5000;

  const buildScopedFromRows = (
    allRows,
    currency,
    isMock,
    reportWarning = null,
    reportWarningSkipped = [],
    reportWarningUsed = [],
    reportWarningUsedIds = [],
    reportWarningUsedMetricIds = [],
    precomputed = null,
  ) => {
    const isScopedChild = req.user?.role !== 'admin' && userHasAssignedInventory(req.user);
    // Cap before JS scope when rows came from a large dump — prefer SQL-capped bundles.
    const cappedSource = Array.isArray(allRows) && allRows.length > MAX_REPORTING_CLIENT_ROWS
      ? allRows.slice(0, MAX_REPORTING_CLIENT_ROWS)
      : (allRows || []);
    const rows = (isScopedChild && !hasInventoryFilters(filters))
      ? prepareScopedOverviewRows(cappedSource, req.user)
      : prepareScopedReportRows(cappedSource, filters, req.user);
    const trend = precomputed?.trend || trendFromRows(rows);
    const totalRevenue = precomputed?.summary?.totalRevenue != null
      ? precomputed.summary.totalRevenue
      : +rows.reduce((a, r) => {
        const fromMetric = Number(r.metrics?.total_line_item_level_cpm_and_cpc_revenue);
        const rev = Number.isFinite(fromMetric) && fromMetric > 0
          ? fromMetric
          : (Number(r.revenue) || 0);
        return a + rev;
      }, 0).toFixed(2);
    const offeredRecords = precomputed?.summary?.offeredRecords != null
      ? precomputed.summary.offeredRecords
      : rows.length;
    const totalDomains = precomputed?.summary?.totalDomains != null
      ? precomputed.summary.totalDomains
      : (new Set(rows.map((r) => r.site)).size + new Set(rows.map((r) => r.appId)).size);
    const summary = { totalRevenue, totalDomains, offeredRecords, currency };
    const warningFields = {
      reportWarning,
      reportWarningSkipped,
      reportWarningUsed,
      reportWarningUsedIds,
      reportWarningUsedMetricIds,
    };
    if (wantAllRows) {
      return applyVisibility({
        summary, rows, trend, isMock, ...warningFields,
        pagination: { totalRows: offeredRecords, allRows: true },
      }, req.user);
    }
    const { rows: pageRows, pagination } = paginateRows(rows, {
      ...paginationOpts,
      limit: Math.min(paginationOpts.limit || 50, MAX_REPORTING_CLIENT_ROWS),
    });
    return applyVisibility({
      summary,
      rows: pageRows,
      trend,
      isMock,
      ...warningFields,
      pagination: {
        ...pagination,
        totalRows: offeredRecords,
        truncated: offeredRecords > rows.length || (precomputed?.pagination?.truncated),
      },
    }, req.user);
  };

  if (isMockClient()) {
    logger.info('Mock mode: returning mock detailed report');
    const base = mockDetailed(filters);
    return res.json(buildScopedFromRows(base.rows, base.summary?.currency || 'USD', true));
  }

  const currency = process.env.GAM_CURRENCY || null;
  const dimIds = asArray(filters.reportDimensions);
  const metIds = asArray(filters.reportMetrics);
  const wantsCustomShape = Boolean(dimIds.length || metIds.length);

  // Compact response cache (final JSON) — warm clicks like Dashboard.
  const pageKey = wantAllRows
    ? 'all'
    : `${paginationOpts.cursor || 0}_${paginationOpts.limit || 50}_${paginationOpts.sortColumn || ''}_${paginationOpts.sortDir || ''}`;
  const detailedRespKey = `report_detailed_resp_v3_${req.user?.id || 'anon'}_${filterCacheKey({
    startDate: filters.startDate,
    endDate: filters.endDate,
    country: filters.country,
    domain: filters.domain,
    site: filters.site,
    domainName: filters.domainName,
    domainId: filters.domainId,
    reportDimensions: filters.reportDimensions,
    reportMetrics: filters.reportMetrics,
  })}_${pageKey}`;

  try {
    const hit = cache.get(detailedRespKey);
    if (hit?.summary && hit?.status !== 'building') {
      logger.info(`Reporting from memory response cache ${filters.startDate}..${filters.endDate}`);
      return res.json(hit);
    }
    const r = getRedis();
    if (r?.redisGet) {
      const rHit = await r.redisGet(detailedRespKey);
      if (rHit?.summary && rHit?.status !== 'building') {
        cache.set(detailedRespKey, rHit, REPORT_CACHE_TTL);
        logger.info(`Reporting from Redis response cache ${filters.startDate}..${filters.endDate}`);
        return res.json(rHit);
      }
    }
  } catch (_) { /* ignore */ }

  const cacheDetailedResponse = async (payload) => {
    if (!payload || payload.status === 'building') return payload;
    cache.set(detailedRespKey, payload, REPORT_CACHE_TTL);
    try {
      const r = getRedis();
      if (r?.redisSet) await r.redisSet(detailedRespKey, payload, r.TTL?.REPORT || REPORT_CACHE_TTL);
    } catch (_) { /* ignore */ }
    return payload;
  };

  const buildingPayload = (jobId = null) => applyVisibility({
    summary: {
      totalRevenue: 0,
      totalDomains: 0,
      offeredRecords: 0,
      currency: currency || 'USD',
    },
    rows: [],
    trend: [],
    isMock: false,
    status: 'building',
    jobId,
    reportWarning: null,
    reportWarningSkipped: [],
    reportWarningUsed: [],
    reportWarningUsedIds: [],
    reportWarningUsedMetricIds: [],
    pagination: { totalRows: 0, allRows: false },
  }, req.user);

  try {
    const svc = getSyncSvc();
    let domains = toFilterArray(filters.domain);
    let sites = toFilterArray(filters.site);
    let apps = toFilterArray(filters.domainId);
    let webInventoryOr = false;
    let skipAdUnitLike = false;
    const isScopedChild = req.user?.role !== 'admin' && userHasAssignedInventory(req.user);
    if (isScopedChild) {
      const scoped = resolveScopedSqlInventoryOpts(req.user, filters);
      domains = scoped.domains;
      sites = scoped.sites;
      apps = scoped.apps;
      webInventoryOr = !!scoped.webInventoryOr;
      skipAdUnitLike = !!scoped.skipAdUnitLike;
    }
    const invOpts = {
      domains,
      sites,
      adUnitNames: toFilterArray(filters.domainName),
      apps,
      countryNames: toFilterArray(filters.country).map((c) => String(c)),
      currency,
      tableLimit: 5000,
      selectedDomains: domains,
      webInventoryOr,
      skipAdUnitLike,
    };

    // ── Inventory-only: reuse Dashboard lean/rollup path ─────────────────────
    if (!wantsCustomShape && typeof svc?.fetchLeanDashboardBundleFromDB === 'function') {
      const t0 = Date.now();
      const compat = await fetchLeanDashboardBundleCompatible(
        svc,
        filters.startDate,
        filters.endDate,
        invOpts
      );
      if (compat?.bundle) {
        const bundle = compat.bundle;
        const rowFilters = bundle.source === 'compat-union'
          ? { ...filters, domain: [], site: [], domainName: [], domainId: [] }
          : {
            ...filters,
            domain: compat.usedOpts?.domains ?? filters.domain,
            site: compat.usedOpts?.sites ?? filters.site,
            domainName: compat.usedOpts?.adUnitNames ?? filters.domainName,
            domainId: compat.usedOpts?.apps ?? filters.domainId,
          };
        const scopedRows = prepareScopedReportRows(bundle.rows || [], rowFilters, req.user);
        const revenue = Number(bundle.summary?.revenue) || 0;
        const body = applyVisibility({
          summary: {
            totalRevenue: revenue,
            totalDomains: new Set(scopedRows.map((r) => r.site).filter(Boolean)).size
              + new Set(scopedRows.map((r) => r.appId).filter(Boolean)).size,
            offeredRecords: bundle.grainCount || scopedRows.length,
            currency: currency || bundle.summary?.currency || 'USD',
          },
          rows: wantAllRows
            ? scopedRows
            : paginateRows(scopedRows, {
              ...paginationOpts,
              limit: Math.min(paginationOpts.limit || 50, MAX_REPORTING_CLIENT_ROWS),
            }).rows,
          trend: bundle.trend || [],
          isMock: false,
          reportWarning: compat.skipped?.length ? 'partial' : null,
          reportWarningSkipped: compat.skipped || [],
          reportWarningUsed: [],
          reportWarningUsedIds: [],
          reportWarningUsedMetricIds: [],
          pagination: bundle.pagination || {
            totalRows: bundle.grainCount || scopedRows.length,
            truncated: Boolean(bundle.pagination?.truncated),
          },
        }, req.user);
        if (!wantAllRows && scopedRows.length) {
          const paged = paginateRows(scopedRows, {
            ...paginationOpts,
            limit: Math.min(paginationOpts.limit || 50, MAX_REPORTING_CLIENT_ROWS),
          });
          body.rows = paged.rows;
          body.pagination = {
            ...paged.pagination,
            totalRows: bundle.grainCount || scopedRows.length,
            truncated: Boolean(bundle.pagination?.truncated),
          };
        }
        logger.info(
          `Reporting lean/rollup bundle ${filters.startDate}..${filters.endDate}`
          + ` grain≈${bundle.grainCount || 0} in ${Date.now() - t0}ms`
        );
        return res.json(await cacheDetailedResponse(body));
      }
    }

    // ── Custom dims/metrics: report_full_* warehouse ─────────────────────────
    if (wantsCustomShape && typeof svc?.fetchFullReportBundleFromDB === 'function') {
      const t0 = Date.now();
      const dimensionApis = dimIds.map(catalogIdToGamEnum).filter(Boolean);
      const metricApis = metIds.map(catalogIdToGamEnum).filter(Boolean);
      const fullBundle = await svc.fetchFullReportBundleFromDB(
        filters.startDate,
        filters.endDate,
        {
          ...invOpts,
          dimensionApis,
          metricApis,
          dimensionIds: dimIds,
          metricIds: metIds,
        }
      );
      if (fullBundle?.rows?.length || (fullBundle?.grainCount > 0)) {
        // Light JS scope on already-capped SQL rows (filters applied in SQL).
        const scopedRows = isScopedChild
          ? prepareScopedReportRows(fullBundle.rows || [], {
            ...filters,
            // Inventory already applied in SQL — avoid double-AND wiping union rows.
            domain: [],
            site: [],
            domainName: [],
            domainId: [],
          }, req.user)
          : (fullBundle.rows || []);
        const body = applyVisibility({
          summary: {
            ...(fullBundle.summary || {}),
            currency: currency || fullBundle.summary?.currency || 'USD',
            offeredRecords: fullBundle.summary?.offeredRecords ?? fullBundle.grainCount ?? scopedRows.length,
          },
          rows: wantAllRows
            ? scopedRows
            : paginateRows(scopedRows, {
              ...paginationOpts,
              limit: Math.min(paginationOpts.limit || 50, MAX_REPORTING_CLIENT_ROWS),
            }).rows,
          trend: fullBundle.trend || [],
          isMock: false,
          reportWarning: fullBundle.reportWarning || null,
          reportWarningSkipped: fullBundle.reportWarningSkipped || [],
          reportWarningUsed: fullBundle.reportWarningUsed || [],
          reportWarningUsedIds: fullBundle.reportWarningUsedIds || [],
          reportWarningUsedMetricIds: fullBundle.reportWarningUsedMetricIds || [],
          pagination: fullBundle.pagination || {
            totalRows: fullBundle.grainCount || scopedRows.length,
            truncated: Boolean(fullBundle.pagination?.truncated),
          },
        }, req.user);
        if (!wantAllRows) {
          const paged = paginateRows(scopedRows, {
            ...paginationOpts,
            limit: Math.min(paginationOpts.limit || 50, MAX_REPORTING_CLIENT_ROWS),
          });
          body.rows = paged.rows;
          body.pagination = {
            ...paged.pagination,
            totalRows: fullBundle.grainCount || scopedRows.length,
            truncated: Boolean(fullBundle.pagination?.truncated),
          };
        }
        logger.info(
          `Reporting from report_full (${fullBundle.sliceKey}) ${filters.startDate}..${filters.endDate}`
          + ` grain≈${fullBundle.grainCount || 0} in ${Date.now() - t0}ms`
        );
        return res.json(await cacheDetailedResponse(body));
      }
    }

    // ── Miss: enqueue background job, never block HTTP on live GAM ───────────
    const token = await getToken().catch(() => null);
    const loaded = await loadReportRowsCacheAside(filters, token, {
      cachePrefix: wantsCustomShape ? 'report_detailed_custom_v1' : 'report_detailed_raw_v3',
      fastMode: true,
      useAdhocStore: wantsCustomShape,
      skipDb: false,
      persistOnGam: true,
      enqueueSyncOnMiss: true,
      asyncOnMiss: true,
      logLabel: wantsCustomShape ? 'Reporting' : 'Detailed',
    });

    if (loaded.status === 'building' || loaded.source === 'building') {
      if (wantsCustomShape) {
        await enqueueFullReportSync(filters.startDate, filters.endDate);
      }
      logger.info(
        `Reporting building ${filters.startDate}..${filters.endDate}`
        + (loaded.jobId ? ` job=${loaded.jobId}` : '')
      );
      return res.json(buildingPayload(loaded.jobId || null));
    }

    if (loaded.rows?.length) {
      const body = buildScopedFromRows(
        loaded.rows,
        currency,
        false,
        loaded.reportWarning,
        loaded.reportWarningSkipped,
        loaded.reportWarningUsed,
        loaded.reportWarningUsedIds,
        loaded.reportWarningUsedMetricIds,
      );
      return res.json(await cacheDetailedResponse(body));
    }

    // Empty after async path — still enqueue full fill for custom queries.
    if (wantsCustomShape) {
      const jobId = await enqueueFullReportSync(filters.startDate, filters.endDate);
      return res.json(buildingPayload(jobId));
    }
    await enqueueRangeSync(filters.startDate, filters.endDate);
    return res.json(buildingPayload(null));
  } catch (err) {
    logger.error('Detailed report error:', err.message);
    const empty = buildScopedFromRows([], currency, false);
    return res.json(empty);
  }
}
registerFilterReportRoute('/detailed', handleDetailedReport);


// GET|POST /api/reports/programmatic — programmatic channel totals (GAM report builder)
async function handleProgrammaticReport(req, res) {
  if (!canAccessPage(req.user, 'reporting')) {
    return res.status(403).json({ error: 'You do not have permission to access reporting.' });
  }
  const today = todayInTZ();
  const startDate = req.query.startDate || today;
  const endDate = req.query.endDate || today;
  const { country } = req.query;
  const filters = { startDate, endDate, country };

  if (isMockClient()) {
    const base = mockProgrammatic(filters);
    return res.json(applyProgrammaticVisibility({ ...base, currency: 'USD' }, req.user));
  }

  const cacheKey = `report_programmatic_resp_v1_${startDate}_${endDate}_${asArray(country).slice().sort().join('|') || 'all'}`;
  const currency = process.env.GAM_CURRENCY || null;
  const cached = cache.get(cacheKey);
  if (cached?.rows?.length || cached?.status === 'building') {
    return res.json(applyProgrammaticVisibility({ ...cached, currency }, req.user));
  }

  const r = getRedis();
  if (r?.redisGet) {
    const rData = await r.redisGet(cacheKey);
    if (rData?.rows?.length || rData?.status === 'building') {
      cache.set(cacheKey, rData, REPORT_CACHE_TTL);
      return res.json(applyProgrammaticVisibility({ ...rData, currency }, req.user));
    }
  }

  // Prefer channel slice from report_full_* when available (no live GAM on request).
  try {
    const svc = getSyncSvc();
    if (typeof svc?.fetchFullReportBundleFromDB === 'function') {
      const bundle = await svc.fetchFullReportBundleFromDB(startDate, endDate, {
        dimensionApis: ['DATE', 'PROGRAMMATIC_CHANNEL_NAME', 'DEMAND_CHANNEL_NAME', 'COUNTRY_NAME'],
        metricApis: [
          'TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS',
          'TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE',
        ],
        dimensionIds: ['date', 'programmatic_channel_name', 'demand_channel_name', 'country_name'],
        metricIds: [
          'total_line_item_level_impressions',
          'total_line_item_level_cpm_and_cpc_revenue',
        ],
        countryNames: toFilterArray(country).map((c) => String(c)),
        currency,
        tableLimit: 2500,
      });
      if (bundle?.rows?.length) {
        const payload = {
          rows: bundle.rows,
          startDate,
          endDate,
          isMock: false,
          summary: bundle.summary,
          trend: bundle.trend,
        };
        cache.set(cacheKey, payload, REPORT_CACHE_TTL);
        if (r?.redisSet) await r.redisSet(cacheKey, payload, r.TTL?.REPORT || REPORT_CACHE_TTL);
        logger.info(`Programmatic from report_full ${startDate}..${endDate} rows=${bundle.rows.length}`);
        return res.json(applyProgrammaticVisibility({ ...payload, currency }, req.user));
      }
    }
  } catch (e) {
    logger.warn(`Programmatic report_full read failed: ${e.message}`);
  }

  // Miss → enqueue background full sync + adhoc-style job; never block on GAM.
  const jobId = await enqueueFullReportSync(startDate, endDate);
  try {
    const { gamReportQueue } = require('../queues/gamSync');
    if (gamReportQueue) {
      const progJobId = `prog-${String(getClientId() || '').slice(0, 8)}-${startDate}-${endDate}`.slice(0, 120);
      const existing = await gamReportQueue.getJob(progJobId);
      if (!existing) {
        await gamReportQueue.add('programmatic-report', {
          startDate,
          endDate,
          country,
          cacheKey,
          clientId: getClientId(),
        }, {
          jobId: progJobId,
          attempts: 2,
          backoff: { type: 'fixed', delay: 15000 },
        });
      }
    }
  } catch (e) {
    logger.warn('Programmatic enqueue failed:', e.message);
  }

  const building = {
    rows: [],
    startDate,
    endDate,
    isMock: false,
    status: 'building',
    jobId: jobId || null,
    summary: { totalRevenue: 0, totalDomains: 0, offeredRecords: 0 },
  };
  cache.set(cacheKey, building, 60);
  return res.json(applyProgrammaticVisibility({ ...building, currency }, req.user));
}
registerFilterReportRoute('/programmatic', handleProgrammaticReport);

// GET /api/reports/countries — lightweight country list for the filter dropdown.
// Returns [{ id, name }] where id is the GAM COUNTRY_CRITERIA_ID used to filter.
router.get('/countries', async (req, res) => {
  if (isMockClient()) {
    const list = Array.from(new Set(MOCK_SITES.map(s => s.country))).sort().map(c => ({ id: c, name: c }));
    return res.json(list);
  }
  const cacheKey = 'report_countries';
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);
  try {
    const token = await getToken();
    const { startDate, endDate } = getDateRange(30);
    const reportQueryXML = `
      <dimensions>COUNTRY_NAME</dimensions>
      <dimensions>COUNTRY_CRITERIA_ID</dimensions>
      <columns>TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS</columns>
      <startDate><year>${startDate.year}</year><month>${startDate.month}</month><day>${startDate.day}</day></startDate>
      <endDate><year>${endDate.year}</year><month>${endDate.month}</month><day>${endDate.day}</day></endDate>
      <dateRangeType>CUSTOM_DATE</dateRangeType>`;
    const rows = await runReportAndDownload(reportQueryXML, token);
    const seen = new Set();
    const list = [];
    rows.forEach(r => {
      const id = r['Dimension.COUNTRY_CRITERIA_ID'];
      const name = r['Dimension.COUNTRY_NAME'];
      if (id && name && !seen.has(id)) { seen.add(id); list.push({ id, name }); }
    });
    list.sort((a, b) => a.name.localeCompare(b.name));
    cache.set(cacheKey, list, 86400); // country list barely changes — cache 24h
    res.json(list);
  } catch (err) {
    logger.error('Countries list error:', err.message);
    res.json([]);
  }
});

// GET /api/reports/summary
router.get('/summary', async (req, res) => {
  if (isMockClient()) {
    logger.info('Mock mode: returning mock summary');
    return res.json(mockSummary());
  }

  const days = req.query.days || 30;
  const cacheKey = `report_summary_${days}d`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const token = await getToken();
    const { startDate, endDate } = getDateRange(days);
    const reportQueryXML = `
      <dimensions>DATE</dimensions>
      <columns>TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS</columns>
      <columns>TOTAL_LINE_ITEM_LEVEL_CLICKS</columns>
      <columns>TOTAL_LINE_ITEM_LEVEL_CTR</columns>
      <columns>TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE</columns>
      <columns>TOTAL_INVENTORY_LEVEL_UNFILLED_IMPRESSIONS</columns>
      <startDate><year>${startDate.year}</year><month>${startDate.month}</month><day>${startDate.day}</day></startDate>
      <endDate><year>${endDate.year}</year><month>${endDate.month}</month><day>${endDate.day}</day></endDate>
      <dateRangeType>CUSTOM_DATE</dateRangeType>`;

    const rows = await runReportAndDownload(reportQueryXML, token);
    let totalRevMicros = 0, totalImps = 0, totalClicks = 0, totalUnfilled = 0;
    rows.forEach(r => {
      totalRevMicros += parseFloat(r['Column.TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE'] || 0);
      totalImps += parseInt(r['Column.TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS'] || 0);
      totalClicks += parseInt(r['Column.TOTAL_LINE_ITEM_LEVEL_CLICKS'] || 0);
      totalUnfilled += parseInt(r['Column.TOTAL_INVENTORY_LEVEL_UNFILLED_IMPRESSIONS'] || 0);
    });
    // GAM reports monetary columns in micros (1,000,000 micros = 1 currency unit)
    const totalRev = totalRevMicros / 1e6;
    const fillRate = totalImps > 0 ? ((totalImps / (totalImps + totalUnfilled)) * 100).toFixed(1) : 0;
    const ctr = totalImps > 0 ? ((totalClicks / totalImps) * 100).toFixed(4) : 0;
    const ecpm = totalImps > 0 ? ((totalRev / totalImps) * 1000).toFixed(2) : 0;

    const summary = {
      revenue: totalRev.toFixed(2), impressions: totalImps, clicks: totalClicks,
      ctr: parseFloat(ctr), fillRate: parseFloat(fillRate), ecpm: parseFloat(ecpm)
    };
    cache.set(cacheKey, summary, REPORT_CACHE_TTL);
    res.json(summary);
  } catch (err) {
    logger.error('Summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/trend
router.get('/trend', async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const metric = req.query.metric || 'revenue';

  if (isMockClient()) return res.json(mockTrend(days, metric));

  const cacheKey = `trend_${days}_${metric}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const token = await getToken();
    const { startDate, endDate } = getDateRange(days);
    const colMap = {
      revenue: 'TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE',
      impressions: 'TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS',
      ctr: 'TOTAL_LINE_ITEM_LEVEL_CTR'
    };
    const col = colMap[metric] || colMap.revenue;
    const reportQueryXML = `
      <dimensions>DATE</dimensions>
      <columns>${col}</columns>
      <startDate><year>${startDate.year}</year><month>${startDate.month}</month><day>${startDate.day}</day></startDate>
      <endDate><year>${endDate.year}</year><month>${endDate.month}</month><day>${endDate.day}</day></endDate>
      <dateRangeType>CUSTOM_DATE</dateRangeType>`;

    const rows = await runReportAndDownload(reportQueryXML, token);
    const divisor = metric === 'revenue' ? 1e6 : 1;
    const trend = rows.map(r => ({
      date: r['Dimension.DATE'],
      value: parseFloat(r[Object.keys(r).find(k => k !== 'Dimension.DATE')] || 0) / divisor
    }));
    cache.set(cacheKey, trend, REPORT_CACHE_TTL);
    res.json(trend);
  } catch (err) {
    logger.error('Trend error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/by-ad-type
router.get('/by-ad-type', async (req, res) => {
  if (isMockClient()) return res.json(mockAdTypes());

  const cacheKey = 'report_by_adtype';
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const token = await getToken();
    const { startDate, endDate } = getDateRange(30);
    const reportQueryXML = `
      <dimensions>AD_UNIT_NAME</dimensions>
      <adUnitView>FLAT</adUnitView>
      <columns>TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE</columns>
      <columns>TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS</columns>
      <startDate><year>${startDate.year}</year><month>${startDate.month}</month><day>${startDate.day}</day></startDate>
      <endDate><year>${endDate.year}</year><month>${endDate.month}</month><day>${endDate.day}</day></endDate>
      <dateRangeType>CUSTOM_DATE</dateRangeType>`;

    const rows = await runReportAndDownload(reportQueryXML, token);
    const data = rows.map(r => ({
      name: r['Dimension.AD_UNIT_NAME'],
      revenue: parseFloat(r['Column.TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE'] || 0) / 1e6,
      impressions: parseInt(r['Column.TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS'] || 0)
    })).sort((a, b) => b.revenue - a.revenue);
    cache.set(cacheKey, data, REPORT_CACHE_TTL);
    res.json(data);
  } catch (err) {
    logger.error('By ad type error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/top-advertisers
router.get('/top-advertisers', async (req, res) => {
  if (isMockClient()) return res.json(mockAdvertisers());

  const cacheKey = 'top_advertisers';
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const token = await getToken();
    const { startDate, endDate } = getDateRange(30);
    const reportQueryXML = `
      <dimensions>ADVERTISER_NAME</dimensions>
      <columns>TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE</columns>
      <columns>TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS</columns>
      <columns>TOTAL_LINE_ITEM_LEVEL_CLICKS</columns>
      <startDate><year>${startDate.year}</year><month>${startDate.month}</month><day>${startDate.day}</day></startDate>
      <endDate><year>${endDate.year}</year><month>${endDate.month}</month><day>${endDate.day}</day></endDate>
      <dateRangeType>CUSTOM_DATE</dateRangeType>`;

    const rows = await runReportAndDownload(reportQueryXML, token);
    const data = rows.map(r => ({
      name: r['Dimension.ADVERTISER_NAME'],
      revenue: parseFloat(r['Column.TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE'] || 0) / 1e6,
      impressions: parseInt(r['Column.TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS'] || 0),
      clicks: parseInt(r['Column.TOTAL_LINE_ITEM_LEVEL_CLICKS'] || 0)
    })).sort((a, b) => b.revenue - a.revenue).slice(0, 10);
    cache.set(cacheKey, data, REPORT_CACHE_TTL);
    res.json(data);
  } catch (err) {
    logger.error('Top advertisers error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Export GAM helpers for BullMQ worker reuse ──────────────────────────────
// The worker imports these instead of duplicating the SOAP/token/CSV logic.
function buildDateXML(startDate, endDate) {
  const [sy, sm, sd] = startDate.split('-');
  const [ey, em, ed] = endDate.split('-');
  return `<startDate><year>${sy}</year><month>${sm}</month><day>${sd}</day></startDate>
          <endDate><year>${ey}</year><month>${em}</month><day>${ed}</day></endDate>`;
}

router.__gamHelpers = { getToken, runReportAndDownload, buildDateXML, runDetailedReport, runProgrammaticReport };

module.exports = router;
