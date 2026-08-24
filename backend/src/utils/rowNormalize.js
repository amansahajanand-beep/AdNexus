const { enrichReportRow } = require('./adUnit');
const { resolveAppFields } = require('./appIdentity');
const { gamMoneyToDollars, pickRowRevenueDollars } = require('./gamReportMetrics');

const REVENUE_KEYS = [
  'revenue',
  'TOTAL_LINE_ITEM_LEVEL_ALL_REVENUE',
  'total_line_item_level_all_revenue',
  'TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE',
  'total_line_item_level_cpm_and_cpc_revenue',
];

const IMPRESSION_KEYS = [
  'impression',
  'impressions',
  'total_line_item_level_impressions',
  'TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS',
];

const CLICK_KEYS = ['clicks', 'total_line_item_level_clicks', 'TOTAL_LINE_ITEM_LEVEL_CLICKS'];

function toDollars(v) {
  return gamMoneyToDollars(v);
}

function firstNumeric(row, keys) {
  for (const k of keys) {
    if (row[k] != null && row[k] !== '') {
      const n = Number(row[k]);
      if (Number.isFinite(n) && n !== 0) return n;
    }
  }
  return null;
}

function flattenRow(row = {}) {
  const r = { ...row };
  if (r.metrics && typeof r.metrics === 'object' && !Array.isArray(r.metrics)) {
    Object.assign(r, r.metrics);
  }
  if (r.dimensions && typeof r.dimensions === 'object' && !Array.isArray(r.dimensions)) {
    Object.assign(r, r.dimensions);
  }
  return r;
}

/** Map PG / GAM / legacy rows into the canonical report row shape. */
function normalizeReportRow(row = {}) {
  const flat = flattenRow(row);
  const r = { ...flat };

  r.date = r.date || r.DATE || r.report_date || '';

  const appFields = resolveAppFields(r);
  r.appPackage = appFields.appPackage;
  r.appName = appFields.appName;
  r.appId = appFields.appId;
  r.site = r.site || r.AD_UNIT_NAME || r.ad_unit_name || '—';
  r.domainName = r.domainName || r.DOMAIN || r.domain || '';
  if (!r.siteUrl) {
    r.siteUrl = r.URL_NAME || r.url_name || r.SITE_NAME || r.site_name || r.gamSite || null;
  }
  if (!r.gamSite && (r.SITE_NAME || r.site_name)) {
    r.gamSite = r.SITE_NAME || r.site_name;
  }
  if (!r.gamDomain && (r.DOMAIN || r.domainName || r.domain)) {
    r.gamDomain = r.DOMAIN || r.domainName || r.domain;
  }

  if (!r.revenue || r.revenue === 0) {
    r.revenue = pickRowRevenueDollars(r);
    if (!r.revenue) {
      const raw = firstNumeric(r, REVENUE_KEYS.filter((k) => k !== 'revenue'));
      if (raw != null) r.revenue = toDollars(raw);
    }
  } else if (r.revenueDollars) {
    r.revenue = +Number(r.revenue).toFixed(2);
  } else {
    r.revenue = toDollars(r.revenue);
  }

  if (!r.impression) {
    const imp = firstNumeric(r, IMPRESSION_KEYS.filter((k) => k !== 'impression'));
    if (imp != null) r.impression = Math.round(imp);
  }

  if (!r.clicks) {
    const clicks = firstNumeric(r, CLICK_KEYS.filter((k) => k !== 'clicks'));
    if (clicks != null) r.clicks = Math.round(clicks);
  }

  if (!r.ctr && r.impression > 0 && r.clicks > 0) {
    r.ctr = +((r.clicks / r.impression) * 100).toFixed(2);
  }

  if (!r.fillRate && r.impression > 0 && r.unfilled != null) {
    const unfilled = Number(r.unfilled) || Number(r.TOTAL_INVENTORY_LEVEL_UNFILLED_IMPRESSIONS) || 0;
    const denom = r.impression + unfilled;
    if (denom > 0) r.fillRate = +((r.impression / denom) * 100).toFixed(2);
  }

  if ((!r.ecpm || r.ecpm === 0) && r.impression > 0 && r.revenue > 0) {
    r.ecpm = +((r.revenue / r.impression) * 1000).toFixed(2);
  }

  if (r.viewableRate == null || r.viewableRate === '' || Number(r.viewableRate) === 0) {
    const rawView = firstNumeric(r, [
      'viewableRate',
      'total_active_view_viewable_impressions_rate',
      'TOTAL_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE',
    ]);
    if (rawView != null) {
      r.viewableRate = rawView > 0 && rawView <= 1 ? +(rawView * 100).toFixed(2) : +rawView.toFixed(2);
    }
  } else {
    const v = Number(r.viewableRate);
    if (Number.isFinite(v)) {
      r.viewableRate = v > 0 && v <= 1 ? +(v * 100).toFixed(2) : +v.toFixed(2);
    }
  }

  if (!r.country) {
    r.country = r.COUNTRY_NAME || r.country_name || r.countryName || '';
  }

  if (!r.device) {
    r.device = r.DEVICE_CATEGORY_NAME || r.device_category_name || r.deviceCategory || r.mobile_device_name || '';
  }

  return enrichReportRow(r);
}

function normalizeReportRows(rows = []) {
  return rows.map(normalizeReportRow);
}

function rowsHaveMetrics(rows = []) {
  if (!rows?.length) return false;
  for (const row of rows) {
    const rev = Number(row?.revenue);
    const imp = Number(row?.impression ?? row?.impressions);
    if ((Number.isFinite(rev) && rev > 0) || (Number.isFinite(imp) && imp > 0)) return true;
  }
  // Fallback for raw GAM / JSONB-shaped rows that still need normalize.
  let revenue = 0;
  let impressions = 0;
  for (const row of rows) {
    const n = normalizeReportRow(row);
    revenue += Number(n.revenue) || 0;
    impressions += Number(n.impression) || 0;
    if (revenue > 0 || impressions > 0) return true;
  }
  return false;
}

module.exports = {
  normalizeReportRow,
  normalizeReportRows,
  rowsHaveMetrics,
};
