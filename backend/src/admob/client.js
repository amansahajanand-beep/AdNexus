/**
 * AdMob Network Report API client (publisher earnings).
 */
const { google } = require('googleapis');
const {
  getPublisherOAuthClient,
  isPublisherOAuthConfigured,
  resolvePublisherOAuthApp,
  productRedirectUri,
  authClientFromRefresh,
} = require('../utils/publisherOAuth');
const logger = require('../utils/logger');

const ADMOB_SCOPE = 'https://www.googleapis.com/auth/admob.readonly';
const PRODUCT = 'admob';

const ADMOB_METRICS = [
  'ESTIMATED_EARNINGS',
  'IMPRESSIONS',
  'CLICKS',
  'AD_REQUESTS',
  'MATCHED_REQUESTS',
];

/**
 * Map API dimension → our dim_kind.
 * Mediation report uses FORMAT; Network report used AD_TYPE — accept both.
 */
const ADMOB_DIM_KINDS = {
  APP: 'app',
  AD_UNIT: 'ad_unit',
  AD_TYPE: 'format',
  FORMAT: 'format',
  COUNTRY: 'country',
  PLATFORM: 'platform',
  // Mediation-only dimensions (AdMob console waterfalls / partners)
  AD_SOURCE: 'ad_source',
  AD_SOURCE_INSTANCE: 'ad_source_instance',
  MEDIATION_GROUP: 'mediation_group',
};

/** Dimensions that only exist on mediationReport:generate. */
const ADMOB_MEDIATION_ONLY_DIMS = new Set([
  'AD_SOURCE',
  'AD_SOURCE_INSTANCE',
  'MEDIATION_GROUP',
]);

/** Prefer Mediation report so totals match the AdMob console (includes 3P networks). */
const ADMOB_REPORT_FLAVOR = String(process.env.ADMOB_REPORT_FLAVOR || 'mediation').toLowerCase() === 'network'
  ? 'network'
  : 'mediation';

function getAdMobOAuthClient(gamClient) {
  return getPublisherOAuthClient(PRODUCT, gamClient);
}

function isAdMobOAuthConfigured(gamClient) {
  return isPublisherOAuthConfigured(PRODUCT, gamClient);
}

function resolveAdMobOAuthApp(gamClient) {
  return resolvePublisherOAuthApp(PRODUCT, gamClient);
}

function admobRedirectUri() {
  return productRedirectUri(PRODUCT);
}

function admobApi(gamClient, refreshToken) {
  const auth = authClientFromRefresh(PRODUCT, gamClient, refreshToken);
  return google.admob({ version: 'v1', auth });
}

async function listAdMobAccounts(gamClient, refreshToken) {
  const api = admobApi(gamClient, refreshToken);
  const res = await api.accounts.list({ pageSize: 100 });
  const accounts = res.data?.account || [];
  return accounts.map((a) => ({
    accountId: String(a.name || '').replace(/^accounts\//, ''),
    name: a.name || '',
    descriptiveName: a.publisherId || a.name || '',
    currencyCode: a.currencyCode || 'USD',
    reportingTimeZone: a.reportingTimeZone || null,
  })).filter((a) => a.accountId);
}

function ymdParts(ymd) {
  const [y, m, d] = String(ymd).split('-').map((n) => parseInt(n, 10));
  return { year: y, month: m, day: d };
}

function parseYmd(dateVal) {
  if (!dateVal) return null;
  if (typeof dateVal === 'object') {
    const y = dateVal.year ?? dateVal.Year;
    const m = dateVal.month ?? dateVal.Month;
    const d = dateVal.day ?? dateVal.Day;
    if (y && m && d) {
      const mm = String(m).padStart(2, '0');
      const dd = String(d).padStart(2, '0');
      return `${y}-${mm}-${dd}`;
    }
    if (dateVal.value) return parseYmd(dateVal.value);
  }
  let ymd = String(dateVal);
  if (/^\d{8}$/.test(ymd)) {
    ymd = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? ymd : null;
}

/** ESTIMATED_EARNINGS is always in micros (see AdMob ReportRow MetricValue). */
function earningsFromMetric(earn = {}) {
  if (earn == null || typeof earn !== 'object') return 0;
  const micros = earn.microsValue ?? earn.micros_value;
  if (micros != null && micros !== '') {
    return Number(micros) / 1e6;
  }
  // Mediation stream examples use decimal_value as micros-as-string (e.g. "1324746").
  const decimal = earn.decimalValue ?? earn.decimal_value;
  if (decimal != null && decimal !== '') {
    const n = Number(decimal);
    if (!Number.isFinite(n)) return 0;
    // Heuristic: large values are micros; small floats are already currency units.
    if (Math.abs(n) >= 1000 || Number.isInteger(n)) return n / 1e6;
    return n;
  }
  if (earn.integerValue != null && earn.integerValue !== '') {
    const n = Number(earn.integerValue);
    return Math.abs(n) >= 1000 ? n / 1e6 : n;
  }
  if (earn.doubleValue != null && earn.doubleValue !== '') {
    return Number(earn.doubleValue);
  }
  return 0;
}

function parseAdMobMetrics(met = {}) {
  return {
    earnings: earningsFromMetric(met.ESTIMATED_EARNINGS),
    impressions: Number(met.IMPRESSIONS?.integerValue || 0),
    clicks: Number(met.CLICKS?.integerValue || 0),
    adRequests: Number(met.AD_REQUESTS?.integerValue || 0),
    matchedRequests: Number(met.MATCHED_REQUESTS?.integerValue || 0),
  };
}

function dimDate(dim = {}) {
  const dateObj = dim.DATE || dim.Date || dim.date;
  if (dateObj) return parseYmd(dateObj.value || dateObj.displayLabel || dateObj);
  for (const [k, v] of Object.entries(dim)) {
    if (!/date/i.test(k)) continue;
    const parsed = parseYmd(v?.value || v?.displayLabel || v);
    if (parsed) return parsed;
  }
  return null;
}

/** googleapis may return an array, a single chunk, NDJSON, or `{ row: object }`. */
function toChunkList(resData) {
  if (resData == null) return [];
  if (Array.isArray(resData)) return resData;
  if (Buffer.isBuffer(resData)) {
    try {
      return toChunkList(JSON.parse(resData.toString('utf8')));
    } catch {
      return parseConcatenatedJson(resData.toString('utf8'));
    }
  }
  if (typeof resData === 'string') {
    const trimmed = resData.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        return toChunkList(JSON.parse(trimmed));
      } catch {
        /* fall through */
      }
    }
    const concat = parseConcatenatedJson(trimmed);
    if (concat.length) return concat;
    const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length > 1) {
      const parsed = [];
      for (const line of lines) {
        try {
          parsed.push(JSON.parse(line));
        } catch {
          /* skip */
        }
      }
      if (parsed.length) return parsed;
    }
    try {
      return toChunkList(JSON.parse(trimmed));
    } catch {
      return [];
    }
  }
  if (Array.isArray(resData.responses)) return resData.responses;
  return [resData];
}

function parseConcatenatedJson(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  const wrapped = `[${s.replace(/}\s*{/g, '},{')}]`;
  try {
    const parsed = JSON.parse(wrapped);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/** AdMob often sends one `row` object, not an array. */
function toRowList(chunk) {
  if (chunk == null) return [];
  if (Array.isArray(chunk)) {
    return chunk.flatMap((c) => toRowList(c));
  }
  if (typeof chunk !== 'object') return [];
  if (chunk.dimensionValues || chunk.metricValues) return [chunk];
  const raw = chunk.row ?? chunk.rows;
  if (raw == null) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function parseAdMobReportRows(resData, extraDims = []) {
  const chunks = toChunkList(resData);
  const rows = [];
  for (const chunk of chunks) {
    const list = toRowList(chunk);
    for (let i = 0; i < list.length; i += 1) {
      const row = list[i];
      if (!row || typeof row !== 'object') continue;
      const dim = row.dimensionValues || {};
      const met = row.metricValues || {};
      const ymd = dimDate(dim);
      if (!ymd) continue;
      const metrics = parseAdMobMetrics(met);
      const out = { reportDate: ymd, ...metrics };
      for (const d of extraDims) {
        const rawVal = dim[d]?.displayLabel || dim[d]?.value || '';
        out[ADMOB_DIM_KINDS[d] || d.toLowerCase()] = String(rawVal || 'Unknown').trim() || 'Unknown';
      }
      rows.push(out);
    }
  }
  return rows;
}

async function generateAdMobReport(gamClient, {
  accountId,
  refreshToken,
  startDate,
  endDate,
  currencyCode = 'USD',
  dimensions = ['DATE'],
  flavor = ADMOB_REPORT_FLAVOR,
}) {
  const auth = authClientFromRefresh(PRODUCT, gamClient, refreshToken);
  const parent = accountId.startsWith('accounts/') ? accountId : `accounts/${accountId}`;
  // Mediation FORMAT ↔ Network AD_TYPE
  const dims = (dimensions || []).map((d) => {
    const up = String(d).toUpperCase();
    if (flavor === 'mediation' && up === 'AD_TYPE') return 'FORMAT';
    if (flavor === 'network' && up === 'FORMAT') return 'AD_TYPE';
    return up;
  });
  const reportSpec = {
    dateRange: { startDate: ymdParts(startDate), endDate: ymdParts(endDate) },
    dimensions: dims,
    metrics: ADMOB_METRICS,
    localizationSettings: { currencyCode: currencyCode || 'USD' },
  };

  const endpoint = flavor === 'network' ? 'networkReport:generate' : 'mediationReport:generate';
  let body;
  try {
    const res = await auth.request({
      url: `https://admob.googleapis.com/v1/${parent}/${endpoint}`,
      method: 'POST',
      data: { reportSpec },
      responseType: 'text',
    });
    body = res?.data;
  } catch (err) {
    // If mediation fails (rare), fall back once to network so sync is not stuck —
    // but never for mediation-only dimensions (AD_SOURCE, etc.).
    const needsMediation = dims.some((d) => ADMOB_MEDIATION_ONLY_DIMS.has(d));
    if (flavor === 'mediation' && !needsMediation) {
      logger.warn(`[admob] mediation report failed, falling back to network: ${err.message}`);
      return generateAdMobReport(gamClient, {
        accountId,
        refreshToken,
        startDate,
        endDate,
        currencyCode,
        dimensions,
        flavor: 'network',
      });
    }
    const apiMsg = err?.response?.data
      ? (typeof err.response.data === 'string'
        ? err.response.data
        : JSON.stringify(err.response.data))
      : err.message;
    throw new Error(String(apiMsg).slice(0, 400));
  }

  const extraDims = dims.filter((d) => d !== 'DATE');
  const rows = parseAdMobReportRows(body, extraDims);
  if (!rows.length) {
    const preview = typeof body === 'string'
      ? body.slice(0, 240)
      : JSON.stringify(body || {}).slice(0, 240);
    logger.info(`[admob] ${flavor} generate parsed 0 rows parent=${parent} preview=${preview}`);
  }
  return rows;
}

async function fetchAdMobNetworkReport(gamClient, opts) {
  const rows = await generateAdMobReport(gamClient, { ...opts, dimensions: ['DATE'] });
  logger.info(
    `[admob] ${ADMOB_REPORT_FLAVOR} report ${opts.accountId} ${opts.startDate}→${opts.endDate}: ${rows.length} day(s)`
  );
  return rows;
}

/**
 * Fetch DATE + one dimension (app / format / country / platform / ad_unit / mediation dims).
 * Returns rows with reportDate + dim field + metrics.
 */
async function fetchAdMobDimReport(gamClient, {
  accountId,
  refreshToken,
  startDate,
  endDate,
  currencyCode = 'USD',
  dimension, // APP | AD_UNIT | FORMAT | COUNTRY | PLATFORM | AD_SOURCE | …
}) {
  const dim = String(dimension || '').toUpperCase();
  if (!ADMOB_DIM_KINDS[dim]) throw new Error(`Unsupported AdMob dimension: ${dimension}`);
  // Force mediation flavor for mediation-only dims so we never fallback to network.
  const flavor = ADMOB_MEDIATION_ONLY_DIMS.has(dim) ? 'mediation' : ADMOB_REPORT_FLAVOR;
  const rows = await generateAdMobReport(gamClient, {
    accountId,
    refreshToken,
    startDate,
    endDate,
    currencyCode,
    dimensions: ['DATE', dim],
    flavor,
  });
  const kind = ADMOB_DIM_KINDS[dim];
  logger.info(`[admob] dim=${dim} ${accountId} ${startDate}→${endDate}: ${rows.length} row(s)`);
  return rows.map((r) => ({
    reportDate: r.reportDate,
    dimKind: kind,
    dimValue: r[kind] || 'Unknown',
    earnings: r.earnings,
    impressions: r.impressions,
    clicks: r.clicks,
    adRequests: r.adRequests,
    matchedRequests: r.matchedRequests,
  }));
}

module.exports = {
  ADMOB_SCOPE,
  ADMOB_DIM_KINDS,
  getAdMobOAuthClient,
  isAdMobOAuthConfigured,
  resolveAdMobOAuthApp,
  admobRedirectUri,
  listAdMobAccounts,
  generateAdMobReport,
  fetchAdMobNetworkReport,
  fetchAdMobDimReport,
};
