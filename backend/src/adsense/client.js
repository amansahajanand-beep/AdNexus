/**
 * AdSense Management API v2 client (publisher earnings).
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

const ADSENSE_SCOPE = 'https://www.googleapis.com/auth/adsense.readonly';
const PRODUCT = 'adsense';

const ADSENSE_METRICS = ['ESTIMATED_EARNINGS', 'PAGE_VIEWS', 'IMPRESSIONS', 'CLICKS'];

/** API dimension → our dim_kind */
const ADSENSE_DIM_KINDS = {
  DOMAIN_NAME: 'site',
  COUNTRY_CODE: 'country',
  PLATFORM_TYPE_CODE: 'platform',
  AD_UNIT_NAME: 'ad_unit',
};

function getAdSenseOAuthClient(gamClient) {
  return getPublisherOAuthClient(PRODUCT, gamClient);
}

function isAdSenseOAuthConfigured(gamClient) {
  return isPublisherOAuthConfigured(PRODUCT, gamClient);
}

function resolveAdSenseOAuthApp(gamClient) {
  return resolvePublisherOAuthApp(PRODUCT, gamClient);
}

function adsenseRedirectUri() {
  return productRedirectUri(PRODUCT);
}

function adsenseApi(gamClient, refreshToken) {
  const auth = authClientFromRefresh(PRODUCT, gamClient, refreshToken);
  return google.adsense({ version: 'v2', auth });
}

async function listAdSenseAccounts(gamClient, refreshToken) {
  const api = adsenseApi(gamClient, refreshToken);
  const res = await api.accounts.list({ pageSize: 100 });
  const accounts = res.data?.accounts || [];
  return accounts.map((a) => ({
    accountId: String(a.name || '').replace(/^accounts\//, ''),
    name: a.name || '',
    descriptiveName: a.displayName || a.name || '',
    currencyCode: 'USD',
    timeZone: a.timeZone?.id || null,
  })).filter((a) => a.accountId);
}

function dateParams(startDate, endDate) {
  return {
    'startDate.year': parseInt(startDate.slice(0, 4), 10),
    'startDate.month': parseInt(startDate.slice(5, 7), 10),
    'startDate.day': parseInt(startDate.slice(8, 10), 10),
    'endDate.year': parseInt(endDate.slice(0, 4), 10),
    'endDate.month': parseInt(endDate.slice(5, 7), 10),
    'endDate.day': parseInt(endDate.slice(8, 10), 10),
  };
}

function parseAdSenseRows(resData, extraDims = []) {
  const headers = (resData?.headers || []).map((h) => String(h.name || h).toUpperCase());
  const idx = (name) => headers.findIndex((h) => h === name || h.endsWith(name));
  const iDate = idx('DATE');
  const iEarn = idx('ESTIMATED_EARNINGS');
  const iPv = idx('PAGE_VIEWS');
  const iImp = idx('IMPRESSIONS');
  const iClk = idx('CLICKS');
  const dimIdx = {};
  for (const d of extraDims) dimIdx[d] = idx(d);

  const rows = [];
  for (const row of resData?.rows || []) {
    const cells = row.cells || row;
    const get = (i) => (i >= 0 ? (cells[i]?.value ?? cells[i]) : null);
    let dateVal = String(get(iDate) || '');
    if (/^\d{8}$/.test(dateVal)) {
      dateVal = `${dateVal.slice(0, 4)}-${dateVal.slice(4, 6)}-${dateVal.slice(6, 8)}`;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateVal)) continue;
    const out = {
      reportDate: dateVal,
      earnings: Number(get(iEarn) || 0),
      pageViews: Number(get(iPv) || 0),
      impressions: Number(get(iImp) || 0),
      clicks: Number(get(iClk) || 0),
    };
    for (const d of extraDims) {
      const kind = ADSENSE_DIM_KINDS[d] || d.toLowerCase();
      out[kind] = String(get(dimIdx[d]) || 'Unknown').trim() || 'Unknown';
    }
    rows.push(out);
  }
  return rows;
}

async function generateAdSenseReport(gamClient, {
  accountId,
  refreshToken,
  startDate,
  endDate,
  dimensions = ['DATE'],
}) {
  const api = adsenseApi(gamClient, refreshToken);
  const name = accountId.startsWith('accounts/') ? accountId : `accounts/${accountId}`;
  const res = await api.accounts.reports.generate({
    account: name,
    ...dateParams(startDate, endDate),
    dimensions,
    metrics: ADSENSE_METRICS,
    currencyCode: 'USD',
  });
  const extraDims = dimensions.filter((d) => d !== 'DATE');
  return parseAdSenseRows(res.data, extraDims);
}

async function fetchAdSenseReport(gamClient, opts) {
  const rows = await generateAdSenseReport(gamClient, { ...opts, dimensions: ['DATE'] });
  logger.info(`[adsense] report ${opts.accountId} ${opts.startDate}→${opts.endDate}: ${rows.length} day(s)`);
  return rows;
}

async function fetchAdSenseDimReport(gamClient, {
  accountId,
  refreshToken,
  startDate,
  endDate,
  dimension, // DOMAIN_NAME | COUNTRY_CODE | PLATFORM_TYPE_CODE | AD_UNIT_NAME
}) {
  const dim = String(dimension || '').toUpperCase();
  if (!ADSENSE_DIM_KINDS[dim]) throw new Error(`Unsupported AdSense dimension: ${dimension}`);
  const rows = await generateAdSenseReport(gamClient, {
    accountId,
    refreshToken,
    startDate,
    endDate,
    dimensions: ['DATE', dim],
  });
  const kind = ADSENSE_DIM_KINDS[dim];
  logger.info(`[adsense] dim=${dim} ${accountId} ${startDate}→${endDate}: ${rows.length} row(s)`);
  return rows.map((r) => ({
    reportDate: r.reportDate,
    dimKind: kind,
    dimValue: r[kind] || 'Unknown',
    earnings: r.earnings,
    pageViews: r.pageViews,
    impressions: r.impressions,
    clicks: r.clicks,
  }));
}

module.exports = {
  ADSENSE_SCOPE,
  ADSENSE_DIM_KINDS,
  getAdSenseOAuthClient,
  isAdSenseOAuthConfigured,
  resolveAdSenseOAuthApp,
  adsenseRedirectUri,
  listAdSenseAccounts,
  fetchAdSenseReport,
  fetchAdSenseDimReport,
};
