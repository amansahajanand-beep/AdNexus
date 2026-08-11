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

/** Read a metric value from a report row (dynamic GAM metrics bag + legacy fields). */

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
  if (row.metrics && Object.prototype.hasOwnProperty.call(row.metrics, metricId)) {
    const v = Number(row.metrics[metricId]);
    return Number.isFinite(v) ? v : 0;
  }
  if (typeof fallbackFn === 'function') {
    const v = Number(fallbackFn(row));
    if (Number.isFinite(v)) return v;
  }
  const aliases = LEGACY_ALIASES[metricId] || [];
  for (const key of aliases) {
    if (row[key] != null && row[key] !== '') {
      const v = Number(row[key]);
      if (Number.isFinite(v)) return v;
    }
  }
  if (metricId === 'total_line_item_level_cpm_and_cpc_revenue' && row.revenue != null) {
    return Number(row.revenue) || 0;
  }
  if (metricId === 'total_line_item_level_impressions') {
    return Number(row.impression ?? row.impressions) || 0;
  }
  const direct = Number(row[metricId]);
  return Number.isFinite(direct) ? direct : 0;
}
