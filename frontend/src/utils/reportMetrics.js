import { packageFromRow } from './appPackage';

const LEGACY_DIMENSION_READ = {
  date: (r) => r.date,
  mobile_app_resolved_id: (r) => packageFromRow(r) || r.appId,
  mobile_app_name: (r) => (r.appName && r.appName !== '—' ? r.appName : ''),
  ad_unit_name: (r) => r.site,
  url_name: (r) => r.siteUrl || r.gamSite,
  country_name: (r) => r.country,
  programmatic_channel_name: (r) => r.channel,
};

/** Read a dimension value from row.dimensions bag or legacy fields. */
export function readDimensionValue(row, dimensionId) {
  if (!row || !dimensionId) return '—';
  if (row.dimensions?.[dimensionId]) return row.dimensions[dimensionId];
  const legacy = LEGACY_DIMENSION_READ[dimensionId];
  if (legacy) {
    const v = legacy(row);
    if (v != null && v !== '' && v !== '—') return String(v);
  }
  const direct = row[dimensionId];
  if (direct != null && direct !== '') return String(direct);
  return '—';
}

export function gamMoneyToDollars(raw) {
  const num = Number(raw);
  if (!Number.isFinite(num) || num === 0) return 0;
  if (Math.abs(num) >= 1000) return +(num / 1e6).toFixed(4);
  if (Math.abs(num) > 0 && Math.abs(num) < 1) return +num.toFixed(4);
  if (Math.abs(num) >= 1 && Math.abs(num) < 1000 && num === Math.floor(num)) {
    return +(num / 1e6).toFixed(4);
  }
  return +num.toFixed(4);
}

const REVENUE_METRIC_KEYS = [
  'total_line_item_level_all_revenue',
  'TOTAL_LINE_ITEM_LEVEL_ALL_REVENUE',
  'total_line_item_level_cpm_and_cpc_revenue',
  'TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE',
];

/** Best revenue dollars from a report row (GAM Total revenue preferred). */
export function pickRowRevenueDollars(row = {}) {
  if (!row) return 0;
  if (row.revenue != null && row.revenue !== '' && Number(row.revenue) !== 0) {
    return gamMoneyToDollars(row.revenue);
  }
  for (const k of REVENUE_METRIC_KEYS) {
    if (row[k] == null || row[k] === '') continue;
    const n = Number(row[k]);
    if (Number.isFinite(n) && n !== 0) return gamMoneyToDollars(n);
  }
  const m = row.metrics || {};
  for (const k of REVENUE_METRIC_KEYS) {
    if (m[k] == null || m[k] === '') continue;
    const n = Number(m[k]);
    if (Number.isFinite(n) && n !== 0) return gamMoneyToDollars(n);
  }
  return 0;
}

function isMoneyMetric(metricId) {
  const id = String(metricId).toLowerCase();
  return id.includes('revenue') || id.includes('ecpm') || id.includes('cpc') || id.includes('earnings');
}

const LEGACY_ALIASES = {
  ad_exchange_line_item_level_ctr: ['adxCtr', 'ctr'],
  ad_exchange_line_item_level_percent_impressions: ['adxMatchRate', 'fillRate'],
  ad_exchange_total_request_ctr: ['adxCtr', 'ctr'],
  ad_exchange_match_rate: ['adxMatchRate'],
  total_active_view_eligible_impressions: ['impression', 'impressions'],
  total_active_view_revenue: ['revenue'],
  total_active_view_viewable_impressions_rate: ['viewableRate'],
};

export function inferMetricFormat(metricId) {
  const id = String(metricId).toLowerCase();
  if (id.includes('revenue') || id.includes('ecpm') || id.includes('cpc') || id.includes('earnings')) {
    return 'money';
  }
  if (id.includes('ctr') || id.includes('rate') || id.includes('percent')) return 'percent';
  if (id.includes('impressions') || id.includes('clicks') || id.includes('requests')
    || id.includes('responses')) return 'num';
  return 'raw';
}

export function inferMetricAggregate(metricId) {
  const fmt = inferMetricFormat(metricId);
  if (fmt === 'num' || fmt === 'money') return 'sum';
  if (fmt === 'percent') return 'avg';
  return 'none';
}

export function readMetricValue(row, metricId, fallbackFn) {
  if (!row) return 0;
  const money = isMoneyMetric(metricId);

  if (row.metrics && Object.prototype.hasOwnProperty.call(row.metrics, metricId)) {
    const v = Number(row.metrics[metricId]);
    if (Number.isFinite(v) && v !== 0) return money ? gamMoneyToDollars(v) : v;
    if (v === 0 && money) {
      const legacy = pickRowRevenueDollars(row);
      if (legacy > 0) return legacy;
    }
    if (!money && Number.isFinite(v)) return v;
  }

  if (money && (metricId === 'total_line_item_level_all_revenue'
    || metricId === 'total_line_item_level_cpm_and_cpc_revenue')) {
    const rev = pickRowRevenueDollars(row);
    if (rev > 0) return rev;
  }

  if (typeof fallbackFn === 'function') {
    const v = Number(fallbackFn(row));
    if (Number.isFinite(v) && v !== 0) return money ? gamMoneyToDollars(v) : v;
  }
  const aliases = LEGACY_ALIASES[metricId] || [];
  for (const key of aliases) {
    if (row[key] != null && row[key] !== '') {
      const v = Number(row[key]);
      if (Number.isFinite(v) && v !== 0) return money ? gamMoneyToDollars(v) : v;
    }
  }
  if (metricId === 'total_line_item_level_cpm_and_cpc_revenue'
    || metricId === 'total_line_item_level_all_revenue') {
    return pickRowRevenueDollars(row);
  }
  if (metricId === 'total_line_item_level_impressions') {
    return Number(row.impression ?? row.impressions) || 0;
  }
  const direct = Number(row[metricId]);
  return Number.isFinite(direct) ? (money ? gamMoneyToDollars(direct) : direct) : 0;
}
