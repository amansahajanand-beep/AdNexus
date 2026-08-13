/**
 * GAM realtime report table — columns = selected dimensions + metrics only.
 * No filters applied by default → empty table until Generate.
 */
import {
  DEFAULT_REPORT_SETTINGS,
  dimensionLabel,
  metricLabel,
} from './gamReportCatalog';
import { readDomainName, readSiteName } from './filters';
import { packageFromRow } from './appPackage';
import {
  readDimensionValue,
  readMetricValue,
  inferMetricFormat,
  inferMetricAggregate,
  pickRowRevenueDollars,
} from './reportMetrics';

export const PROGRAMMATIC_DIMENSION_IDS = new Set([
  'programmatic_channel_name',
  'demand_channel_name',
]);

export const DASHBOARD_DEFAULT_METRICS = [
  'total_line_item_level_all_revenue',
  'total_line_item_level_impressions',
  'total_line_item_level_without_cpd_average_ecpm',
  'total_active_view_viewable_impressions_rate',
];

/** Dashboard table — only columns matching applied inventory filters (+ date & KPI metrics). */
export function resolveDashboardTableConfig(applied = {}, filterApplied = false) {
  if (!filterApplied) {
    return { dimensions: [], metrics: [] };
  }
  const dimensions = ['date'];
  if (applied.domain?.length) dimensions.push('domain');
  if (applied.site?.length) dimensions.push('site_name');
  // Ad unit column only when user explicitly filters ad units (matches GAM Site vs Ad unit reports).
  if (applied.domainName?.length) dimensions.push('ad_unit_name');
  if (applied.domainId?.length) dimensions.push('mobile_app_resolved_id');
  return {
    dimensions,
    metrics: [...DASHBOARD_DEFAULT_METRICS],
  };
}

/** Fixed overview table on Dashboard (legacy full breakdown). */
export const DASHBOARD_OVERVIEW_DIMENSIONS = [
  'date', 'mobile_app_resolved_id', 'mobile_app_name', 'domain', 'site_name', 'ad_unit_name',
];
export const DASHBOARD_OVERVIEW_METRICS = [
  'total_line_item_level_cpm_and_cpc_revenue',
  'total_line_item_level_impressions',
  'total_line_item_level_without_cpd_average_ecpm',
  'total_active_view_viewable_impressions_rate',
  'total_line_item_level_ctr',
  'ad_exchange_match_rate',
  'total_fill_rate',
];

const DIMENSION_DEFS = {
  date: { getValue: (r) => r.date || readDimensionValue(r, 'date') || '—', cellClass: '' },
  mobile_app_resolved_id: {
    getValue: (r) => packageFromRow(r)
      || r.appId
      || readDimensionValue(r, 'mobile_app_resolved_id')
      || '—',
    cellClass: 'td-mono',
  },
  mobile_app_name: {
    getValue: (r) => {
      const name = (r.appName && r.appName !== '—') ? r.appName : '';
      return name
        || readDimensionValue(r, 'mobile_app_name')
        || '—';
    },
    cellClass: '',
  },
  domain: { getValue: (r) => readDomainName(r) || readDimensionValue(r, 'domain') || '—', cellClass: '' },
  site_name: {
    getValue: (r) => {
      const fromRow = readSiteName(r);
      if (fromRow && fromRow !== '—') return fromRow;
      const fromDim = readDimensionValue(r, 'site_name');
      // Ignore dimension values that are ad-unit slot hosts (d3.*, inter.*, …).
      return readSiteName({ siteName: fromDim, siteUrl: fromDim, gamSite: fromDim }) || '—';
    },
    cellClass: '',
  },
  ad_unit_name: { getValue: (r) => r.site || readDimensionValue(r, 'ad_unit_name') || '—', cellClass: '' },
  programmatic_channel_name: {
    getValue: (r) => r.channel || readDimensionValue(r, 'programmatic_channel_name'),
    cellClass: '',
  },
  demand_channel_name: { getValue: (r) => r.demandChannel || r.channel || '—', cellClass: '' },
  country_name: { getValue: (r) => readDimensionValue(r, 'country_name'), cellClass: '' },
  country_code: { getValue: (r) => r.countryCode || r.country || '—', cellClass: '' },
  ad_unit_id: { getValue: (r) => r.adUnitId || readDimensionValue(r, 'ad_unit_id'), cellClass: 'td-mono' },
  parent_ad_unit_id: { getValue: (r) => readDimensionValue(r, 'parent_ad_unit_id'), cellClass: 'td-mono' },
  parent_ad_unit_name: { getValue: (r) => readDimensionValue(r, 'parent_ad_unit_name'), cellClass: '' },
  placement_id: { getValue: (r) => readDimensionValue(r, 'placement_id'), cellClass: 'td-mono' },
  placement_name: { getValue: (r) => readDimensionValue(r, 'placement_name'), cellClass: '' },
  url_name: { getValue: (r) => readDimensionValue(r, 'url_name') || r.siteUrl || '—', cellClass: '' },
  mobile_device_name: { getValue: (r) => readDimensionValue(r, 'mobile_device_name'), cellClass: '' },
};

const METRIC_DEFS = {
  total_line_item_level_cpm_and_cpc_revenue: {
    label: 'Revenue',
    getValue: (r) => readMetricValue(r, 'total_line_item_level_cpm_and_cpc_revenue', (row) => row.revenue),
    format: 'money',
    visKey: 'revenue',
    aggregate: 'sum',
  },
  total_line_item_level_all_revenue: {
    label: 'Revenue',
    getValue: (r) => readMetricValue(r, 'total_line_item_level_all_revenue', (row) => row.revenue),
    format: 'money',
    visKey: 'revenue',
    aggregate: 'sum',
  },
  total_line_item_level_impressions: {
    label: 'Impression',
    getValue: (r) => readMetricValue(r, 'total_line_item_level_impressions', (row) => row.impression ?? row.impressions),
    format: 'num',
    visKey: 'impressions',
    aggregate: 'sum',
  },
  total_line_item_level_ctr: {
    label: 'CTR',
    getValue: (r) => Number(r.ctr) || 0,
    format: 'percent',
    visKey: 'ctr',
    aggregate: 'avg',
  },
  total_fill_rate: {
    label: 'Total Fill Rate',
    getValue: (r) => Number(r.fillRate) || 0,
    format: 'percent',
    visKey: 'ecpm',
    aggregate: 'avg',
  },
  total_line_item_level_without_cpd_average_ecpm: {
    label: 'eCPM',
    getValue: (r) => {
      const imp = Number(readMetricValue(r, 'total_line_item_level_impressions', (row) => row.impression ?? row.impressions)) || 0;
      const rev = Number(readMetricValue(r, 'total_line_item_level_all_revenue', (row) => row.revenue)) || 0;
      if (imp > 0 && rev > 0) return +((rev / imp) * 1000).toFixed(2);
      const direct = Number(r.ecpm);
      return direct > 0 ? direct : 0;
    },
    format: 'money',
    visKey: 'ecpm',
    aggregate: 'weightedEcpm',
  },
  total_active_view_viewable_impressions_rate: {
    label: 'Viewability',
    getValue: (r) => readMetricValue(r, 'total_active_view_viewable_impressions_rate', (row) => row.viewableRate),
    format: 'percent',
    visKey: 'impressions',
    aggregate: 'avg',
  },
  total_line_item_level_clicks: {
    label: 'Total clicks',
    getValue: (r) => Number(r.clicks) || 0,
    format: 'num',
    visKey: 'ctr',
    aggregate: 'sum',
  },
  ad_exchange_line_item_level_ctr: {
    label: 'Ad Exchange CTR',
    getValue: (r) => readMetricValue(r, 'ad_exchange_line_item_level_ctr', (row) => row.ctr),
    format: 'percent',
    visKey: 'ctr',
    aggregate: 'avg',
  },
  ad_exchange_line_item_level_percent_impressions: {
    label: 'Ad Exchange impressions (%)',
    getValue: (r) => readMetricValue(r, 'ad_exchange_line_item_level_percent_impressions', (row) => row.adxMatchRate),
    format: 'percent',
    visKey: 'impressions',
    aggregate: 'avg',
  },
  ad_exchange_total_request_ctr: {
    label: 'Ad Exchange ad request CTR',
    getValue: (r) => readMetricValue(r, 'ad_exchange_total_request_ctr', (row) => row.adxCtr || row.ctr),
    format: 'percent',
    visKey: 'ctr',
    aggregate: 'avg',
  },
  ad_exchange_matched_request_ctr: {
    label: 'Ad Exchange matched request CTR',
    getValue: (r) => readMetricValue(r, 'ad_exchange_matched_request_ctr', (row) => row.adxCtr || row.ctr),
    format: 'percent',
    visKey: 'ctr',
    aggregate: 'avg',
  },
  ad_exchange_match_rate: {
    label: 'Ad Exchange match rate',
    getValue: (r) => readMetricValue(r, 'ad_exchange_match_rate', (row) => row.adxMatchRate),
    format: 'percent',
    visKey: 'ecpm',
    aggregate: 'avg',
  },
  ad_exchange_line_item_level_revenue: {
    label: 'Ad Exchange revenue',
    getValue: (r) => readMetricValue(r, 'ad_exchange_line_item_level_revenue', (row) => row.revenue),
    format: 'money',
    visKey: 'revenue',
    aggregate: 'sum',
  },
  ad_exchange_line_item_level_impressions: {
    label: 'Ad Exchange impressions',
    getValue: (r) => readMetricValue(r, 'ad_exchange_line_item_level_impressions', (row) => row.impression),
    format: 'num',
    visKey: 'impressions',
    aggregate: 'sum',
  },
  ad_exchange_line_item_level_average_ecpm: {
    label: 'Ad Exchange average eCPM',
    getValue: (r) => readMetricValue(r, 'ad_exchange_line_item_level_average_ecpm', (row) => row.ecpm),
    format: 'money',
    visKey: 'ecpm',
    aggregate: 'avg',
  },
  total_active_view_eligible_impressions: {
    label: 'Total Active View eligible impressions',
    getValue: (r) => readMetricValue(r, 'total_active_view_eligible_impressions', (row) => row.impression),
    format: 'num',
    visKey: 'impressions',
    aggregate: 'sum',
  },
  total_active_view_revenue: {
    label: 'Total Active View revenue',
    getValue: (r) => readMetricValue(r, 'total_active_view_revenue', (row) => row.revenue),
    format: 'money',
    visKey: 'revenue',
    aggregate: 'sum',
  },
  total_active_view_viewable_impressions: {
    label: 'Total Active View viewable impressions',
    getValue: (r) => readMetricValue(r, 'total_active_view_viewable_impressions', (row) => row.impression),
    format: 'num',
    visKey: 'impressions',
    aggregate: 'sum',
  },
};

/** At least one dimension or metric must be selected (GAM report builder). */
export function hasActiveReport(dimensions = [], metrics = []) {
  return dimensions.length > 0 || metrics.length > 0;
}

export function createEmptyApplied(reportSettings = DEFAULT_REPORT_SETTINGS) {
  return {
    startDate: '',
    endDate: '',
    country: '',
    domainName: [],
    domainId: [],
    domain: [],
    site: [],
    reportDimensions: [],
    reportMetrics: [],
    reportSettings,
  };
}

export function isProgrammaticReport(dimensions = []) {
  return dimensions.length > 0 && dimensions.every((d) => PROGRAMMATIC_DIMENSION_IDS.has(d));
}

const HIDDEN_DIMENSION_IDS = new Set([
  'programmatic_channel_name',
  'demand_channel_name',
]);

/** Exact selected dimensions + metrics — no fallbacks. */
export function resolveReportTableConfig(appliedDims = [], appliedMets = []) {
  const dimensions = (appliedDims || []).filter(d => !HIDDEN_DIMENSION_IDS.has(d));
  const metrics = [...(appliedMets || [])];

  if (!hasActiveReport(dimensions, metrics)) {
    return { mode: 'none', dimensions: [], metrics: [] };
  }
  if (isProgrammaticReport(dimensions)) {
    return { mode: 'programmatic', dimensions, metrics };
  }
  return {
    mode: 'inventory',
    dimensions,
    metrics,
  };
}

function metricVisible(visKey, vis) {
  if (!visKey) return true;
  // Selected report metrics always render; permissions redact values server-side.
  return true;
}

/** Build columns — one per selected dimension/metric (GAM realtime). */
export function buildReportColumns(dimensions, metrics, vis = {}) {
  const cols = [];

  (dimensions || []).forEach((id) => {
    const def = DIMENSION_DEFS[id];
    cols.push({
      id,
      type: 'dimension',
      label: dimensionLabel(id),
      cellClass: def?.cellClass || '',
      getValue: def?.getValue || ((r) => readDimensionValue(r, id)),
      aggregate: 'label',
    });
  });

  (metrics || []).forEach((id) => {
    const def = METRIC_DEFS[id];
    if (!def) {
      cols.push({
        id,
        type: 'metric',
        label: metricLabel(id),
        cellClass: '',
        getValue: (r) => readMetricValue(r, id),
        format: inferMetricFormat(id),
        aggregate: inferMetricAggregate(id),
      });
      return;
    }
    if (!metricVisible(def.visKey, vis)) return;
    cols.push({
      id,
      type: 'metric',
      label: def.label || metricLabel(id),
      cellClass: '',
      getValue: def.getValue,
      format: def.format,
      aggregate: def.aggregate,
    });
  });

  return cols;
}

/** Roll raw line-item rows up to the table's dimension grain (e.g. one row per date × site). */
export function aggregateRowsByColumns(rows = [], columns = []) {
  const dimCols = (columns || []).filter((c) => c.type === 'dimension');
  if (!dimCols.length || rows.length <= 1) return rows;

  const map = new Map();
  rows.forEach((row) => {
    const key = dimCols.map((c) => String(c.getValue(row) ?? '—')).join('\0');
    let bucket = map.get(key);
    if (!bucket) {
      bucket = {
        ...row,
        revenue: 0,
        impression: 0,
        impressions: 0,
        clicks: 0,
        _viewWeighted: 0,
        _fillWeighted: 0,
        _ctrWeighted: 0,
        _weight: 0,
      };
      dimCols.forEach((c) => {
        bucket[`_dim_${c.id}`] = c.getValue(row);
      });
      map.set(key, bucket);
    }
    const imp = Number(row.impression ?? row.impressions) || 0;
    const rev = pickRowRevenueDollars(row);
    const ctr = Number(row.ctr) || 0;
    const view = Number(row.viewableRate) || 0;
    const fill = Number(row.fillRate) || 0;
    bucket.revenue += rev;
    bucket.impression += imp;
    bucket.impressions += imp;
    bucket.clicks += Number(row.clicks) || 0;
    bucket._viewWeighted += view * imp;
    bucket._fillWeighted += fill * imp;
    bucket._ctrWeighted += ctr * imp;
    bucket._weight += imp;
  });

  return [...map.values()].map((b) => {
    const out = { ...b };
    out.revenue = +out.revenue.toFixed(2);
    const imp = out.impression;
    out.viewableRate = imp > 0 ? +(out._viewWeighted / imp).toFixed(2) : 0;
    out.fillRate = imp > 0 ? +(out._fillWeighted / imp).toFixed(2) : 0;
    out.ctr = imp > 0 ? +(out._ctrWeighted / imp).toFixed(2) : 0;
    out.ecpm = imp > 0 ? +((out.revenue / imp) * 1000).toFixed(2) : 0;
    out.metrics = {
      ...(out.metrics || {}),
      total_line_item_level_all_revenue: out.revenue,
      total_line_item_level_cpm_and_cpc_revenue: out.revenue,
      total_line_item_level_impressions: imp,
      total_line_item_level_without_cpd_average_ecpm: out.ecpm,
      total_active_view_viewable_impressions_rate: out.viewableRate,
      total_line_item_level_ctr: out.ctr,
    };
    dimCols.forEach((c) => {
      const v = b[`_dim_${c.id}`];
      if (c.id === 'date') out.date = v;
      if (c.id === 'site_name') {
        out.siteName = v;
        out.siteUrl = v;
        out.gamSite = v;
      }
      if (c.id === 'domain') {
        out.domainName = v;
        out.gamDomain = v;
      }
      if (c.id === 'ad_unit_name') out.site = v;
      if (c.id === 'mobile_app_resolved_id') out.appId = v;
      delete out[`_dim_${c.id}`];
    });
    delete out._viewWeighted;
    delete out._fillWeighted;
    delete out._ctrWeighted;
    delete out._weight;
    return out;
  });
}

/** Overview KPIs from the same aggregated rows shown in the dashboard table. */
export function summarizeRowsForOverview(rows = [], currency = 'USD') {
  const impressions = rows.reduce(
    (a, r) => a + (Number(r.impression ?? r.impressions) || 0),
    0
  );
  const revenue = +rows.reduce((a, r) => a + pickRowRevenueDollars(r), 0).toFixed(2);
  const ecpm = impressions > 0 ? +((revenue / impressions) * 1000).toFixed(2) : 0;
  const viewability = impressions > 0
    ? +(rows.reduce(
      (a, r) => a + (Number(r.viewableRate) || 0) * (Number(r.impression ?? r.impressions) || 0),
      0
    ) / impressions).toFixed(1)
    : 0;
  return {
    impressions,
    revenue,
    ecpm,
    viewability,
    impressionsChange: 0,
    revenueChange: 0,
    ecpmChange: 0,
    viewabilityChange: 0,
    currency,
  };
}

export function formatCellValue(value, format, currency = 'USD', moneyFn, numFn) {
  if (value == null || value === '' || value === '—') return '—';
  const n = Number(value);
  switch (format) {
    case 'money':
      return moneyFn ? moneyFn(value, currency) : value;
    case 'num':
      return numFn ? numFn(value) : value;
    case 'percent':
      return Number.isFinite(n) ? `${n.toFixed(2)}%` : '—';
    default:
      return String(value);
  }
}

export function aggregateColumn(rows, col) {
  if (!rows.length || col.type === 'dimension') {
    if (col.aggregate === 'label') return col.id === 'date' ? 'Total' : '—';
    return '—';
  }
  const nums = rows.map((r) => col.getValue(r)).filter((v) => Number.isFinite(Number(v)));
  if (!nums.length) return '—';
  if (col.aggregate === 'sum') {
    return nums.reduce((a, v) => a + Number(v), 0);
  }
  if (col.aggregate === 'avg') {
    return nums.reduce((a, v) => a + Number(v), 0) / nums.length;
  }
  if (col.aggregate === 'weightedEcpm') {
    let rev = 0;
    let imp = 0;
    rows.forEach((r) => {
      const rowRev = Number(readMetricValue(r, 'total_line_item_level_all_revenue', (row) => row.revenue)) || 0;
      const rowImp = Number(readMetricValue(r, 'total_line_item_level_impressions', (row) => row.impression ?? row.impressions)) || 0;
      rev += rowRev;
      imp += rowImp;
    });
    return imp > 0 ? (rev / imp) * 1000 : 0;
  }
  return '—';
}

export function rowSearchText(row, columns) {
  return columns.map((c) => c.getValue(row)).join(' ');
}
