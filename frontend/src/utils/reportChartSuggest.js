/**
 * Suggest preferred Reporting charts from selected dimensions + metrics.
 * Pure helpers — no React.
 * Returns several varied charts (not a fixed pair) so Reporting always has options.
 */
import { dimensionLabel, metricLabel } from './gamReportCatalog';
import {
  readDimensionValue,
  readMetricValue,
  inferMetricFormat,
  inferMetricAggregate,
} from './reportMetrics';
import { readDomainName, readSiteName } from './filters';

const TIME_DIMS = new Set([
  'date', 'hour', 'day', 'week', 'month_and_year',
  'date_pt', 'week_pt', 'month_year_pt', 'day_of_week_pt',
]);

const CATEGORY_DIMS = new Set([
  'country_name', 'country_code', 'region_name', 'city_name', 'metro_name', 'postal_code',
  'device_category_name', 'browser_name', 'operating_system_name', 'mobile_device_name',
  'domain', 'site_name', 'url_name', 'ad_unit_name', 'ad_unit_id',
  'mobile_app_name', 'mobile_app_resolved_id',
  'programmatic_channel_name', 'demand_channel_name', 'channel_name',
  'advertiser_name', 'order_name', 'line_item_name', 'creative_name',
  'request_type', 'inventory_format', 'ad_type_name',
]);

const METRIC_PRIORITY = [
  'total_line_item_level_cpm_and_cpc_revenue',
  'total_line_item_level_all_revenue',
  'total_line_item_level_impressions',
  'total_line_item_level_clicks',
  'programmatic_revenue',
  'ad_exchange_line_item_level_revenue',
];

/** Max charts to show on Reporting (varied types). */
const MAX_CHARTS = 6;

function isTimeDim(id) {
  return TIME_DIMS.has(String(id || '').toLowerCase());
}

function isCategoryDim(id) {
  const key = String(id || '').toLowerCase();
  if (TIME_DIMS.has(key)) return false;
  if (CATEGORY_DIMS.has(key)) return true;
  return Boolean(key) && !isTimeDim(key);
}

function readDimLabel(row, dimId) {
  const id = String(dimId || '').toLowerCase();
  if (id === 'domain') {
    return readDomainName(row) || readDimensionValue(row, 'domain') || '—';
  }
  if (id === 'site_name' || id === 'url_name') {
    return readSiteName(row) || readDimensionValue(row, dimId) || '—';
  }
  const v = readDimensionValue(row, dimId);
  return v == null || v === '' ? '—' : String(v);
}

function metricAllowed(metricId, visibility = {}) {
  const fmt = inferMetricFormat(metricId);
  if (fmt === 'money' && visibility.revenue === false) return false;
  if ((String(metricId).includes('impression')) && visibility.impressions === false) return false;
  return true;
}

function chartKey(c) {
  return `${c.type}|${c.metricId}|${c.title}`;
}

function pushUnique(charts, chart) {
  if (!chart?.data?.length) return;
  if (charts.some((c) => chartKey(c) === chartKey(chart))) return;
  charts.push(chart);
}

/** Ordered list of chart-worthy metrics from selection. */
export function listChartMetrics(metrics = [], visibility = {}, limit = 4) {
  const list = (metrics || []).map(String).filter(Boolean);
  const allowed = list.filter((id) => metricAllowed(id, visibility));
  if (!allowed.length) return [];
  const ranked = [];
  for (const pref of METRIC_PRIORITY) {
    if (allowed.includes(pref)) ranked.push(pref);
  }
  allowed.forEach((id) => {
    if (!ranked.includes(id)) ranked.push(id);
  });
  // Prefer summable metrics first for bars/pies.
  ranked.sort((a, b) => {
    const aa = inferMetricAggregate(a) === 'sum' ? 0 : 1;
    const bb = inferMetricAggregate(b) === 'sum' ? 0 : 1;
    return aa - bb;
  });
  return ranked.slice(0, limit);
}

/** Pick best chart metric from selected list. */
export function pickChartMetric(metrics = [], visibility = {}) {
  return listChartMetrics(metrics, visibility, 1)[0] || null;
}

export function buildTimeSeries(rows = [], timeDim, metricId) {
  if (!timeDim || !metricId) return [];
  const map = new Map();
  rows.forEach((row) => {
    const key = readDimLabel(row, timeDim);
    if (!key || key === '—') return;
    const value = readMetricValue(row, metricId);
    if (!Number.isFinite(value)) return;
    const prev = map.get(key) || { date: key, value: 0, count: 0 };
    prev.value += value;
    prev.count += 1;
    map.set(key, prev);
  });
  return Array.from(map.values())
    .map((entry) => ({
      date: entry.date,
      value: inferMetricAggregate(metricId) === 'avg' && entry.count
        ? entry.value / entry.count
        : entry.value,
    }))
    .filter((e) => e.value !== 0 || e.date)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/**
 * Full-range daily series from server SQL `trend` (not truncated table rows).
 * Table rows are often capped + sorted newest-first → charts collapse to one day.
 */
export function buildTimeSeriesFromTrend(trend = [], metricId) {
  if (!Array.isArray(trend) || !trend.length || !metricId) return [];
  const id = String(metricId || '').toLowerCase();
  const preferImpressions = id.includes('impression') && !id.includes('revenue');
  const series = trend
    .map((t) => {
      const date = String(t?.date || t?.report_date || '').slice(0, 10);
      if (!date || date === '—') return null;
      let value = 0;
      if (preferImpressions) {
        value = Number(t.impressions ?? t.value ?? 0) || 0;
      } else {
        value = Number(t.earning ?? t.revenue ?? t.value ?? 0) || 0;
      }
      return { date, value };
    })
    .filter(Boolean)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  // Drop all-zero series (wrong metric mapped onto trend).
  if (!series.some((e) => e.value > 0)) return [];
  return series;
}

/** Prefer SQL trend when it covers more dates than capped grain rows. */
export function preferTimeSeries(fromTrend = [], fromRows = []) {
  if (!fromTrend.length) return fromRows;
  if (!fromRows.length) return fromTrend;
  if (fromTrend.length > fromRows.length) return fromTrend;
  // Cap often leaves a single latest day in rows while trend has the full range.
  if (fromRows.length <= 2 && fromTrend.length > fromRows.length) return fromTrend;
  return fromRows;
}

export function buildCategorySeries(rows = [], catDim, metricId, { topN = 10 } = {}) {
  if (!catDim || !metricId) return [];
  const map = new Map();
  const agg = inferMetricAggregate(metricId);
  rows.forEach((row) => {
    const name = readDimLabel(row, catDim);
    if (!name || name === '—' || name === 'Uncategorized') return;
    const value = readMetricValue(row, metricId);
    if (!Number.isFinite(value) || value === 0) return;
    const prev = map.get(name) || { name, value: 0, count: 0 };
    prev.value += value;
    prev.count += 1;
    map.set(name, prev);
  });
  const ranked = Array.from(map.values())
    .map((entry) => ({
      name: entry.name,
      value: agg === 'avg' && entry.count ? entry.value / entry.count : entry.value,
    }))
    .filter((e) => e.value > 0)
    .sort((a, b) => b.value - a.value);

  if (ranked.length <= topN) return ranked;
  const top = ranked.slice(0, topN);
  const rest = ranked.slice(topN).reduce((sum, item) => sum + item.value, 0);
  return rest > 0 ? [...top, { name: 'Others', value: rest }] : top;
}

export function buildMetricTotals(rows = [], metrics = [], visibility = {}) {
  return (metrics || [])
    .filter((id) => metricAllowed(id, visibility))
    .map((metricId) => {
      const agg = inferMetricAggregate(metricId);
      let sum = 0;
      let count = 0;
      rows.forEach((row) => {
        const v = readMetricValue(row, metricId);
        if (!Number.isFinite(v)) return;
        sum += v;
        count += 1;
      });
      const value = agg === 'avg' && count ? sum / count : sum;
      return {
        name: metricLabel(metricId),
        value,
        metricId,
      };
    })
    .filter((e) => e.value > 0)
    .slice(0, 8);
}

/**
 * @returns {Array<{ type: 'area'|'bar'|'column'|'radar', title: string, hint: string, data: Array, metricId: string, format: string }>}
 */
export function suggestReportCharts({
  dimensions = [],
  metrics = [],
  rows = [],
  trend = [],
  visibility = {},
  mode = 'inventory',
} = {}) {
  if (!rows?.length && !trend?.length) return [];

  const dims = (dimensions || []).map(String).filter(Boolean);
  const mets = (metrics || []).map(String).filter(Boolean);
  const chartMetrics = listChartMetrics(mets, visibility, 4);
  const charts = [];

  if (mode === 'programmatic') {
    const channelDim = dims.find((d) => d.includes('channel')) || 'programmatic_channel_name';
    const progMets = chartMetrics.length
      ? chartMetrics
      : listChartMetrics([
        'total_line_item_level_cpm_and_cpc_revenue',
        'total_line_item_level_impressions',
      ], visibility, 3);
    progMets.forEach((m, idx) => {
      const data = buildCategorySeries(rows, channelDim, m, { topN: 10 });
      // Prefer column / horizontal bar — avoid pie for most cases
      const type = idx === 0 ? 'column' : (idx === 1 ? 'bar' : 'column');
      pushUnique(charts, {
        type,
        title: `${metricLabel(m)} by ${dimensionLabel(channelDim)}`,
        hint: `${type === 'column' ? 'Column' : 'Bar'} · by ${dimensionLabel(channelDim)} · ${metricLabel(m)}`,
        data,
        metricId: m,
        format: inferMetricFormat(m),
        layout: type === 'bar' ? 'vertical' : 'horizontal',
      });
    });
    return charts.slice(0, MAX_CHARTS);
  }

  const timeDim = dims.find(isTimeDim) || null;
  const catDims = dims.filter((d) => isCategoryDim(d) && !isTimeDim(d)).slice(0, 3);
  const primary = chartMetrics[0] || null;

  // 1) Time series — prefer SQL trend (full range) over capped table rows
  if (timeDim && chartMetrics.length) {
    chartMetrics.slice(0, 2).forEach((m, idx) => {
      const series = preferTimeSeries(
        buildTimeSeriesFromTrend(trend, m),
        buildTimeSeries(rows, timeDim, m)
      );
      const data = series.map((d) => ({ name: d.date, value: d.value, date: d.date }));
      if (idx === 0) {
        pushUnique(charts, {
          type: 'column',
          title: `${metricLabel(m)} by ${dimensionLabel(timeDim)}`,
          hint: `Column · by ${dimensionLabel(timeDim)} · ${metricLabel(m)}`,
          data,
          metricId: m,
          format: inferMetricFormat(m),
          layout: 'horizontal',
          wide: true,
        });
      } else {
        pushUnique(charts, {
          type: 'area',
          title: `${metricLabel(m)} trend`,
          hint: `Area · by ${dimensionLabel(timeDim)} · ${metricLabel(m)}`,
          data: series,
          metricId: m,
          format: inferMetricFormat(m),
          layout: 'horizontal',
        });
      }
    });
  }

  // When Date is selected but only one chart metric, still add an area trend twin
  // from the same series so "by Date" + "trend" both appear for revenue reports.
  if (timeDim && chartMetrics.length === 1) {
    const m = chartMetrics[0];
    const series = preferTimeSeries(
      buildTimeSeriesFromTrend(trend, m),
      buildTimeSeries(rows, timeDim, m)
    );
    if (series.length > 1) {
      pushUnique(charts, {
        type: 'area',
        title: `${metricLabel(m)} trend`,
        hint: `Area · by ${dimensionLabel(timeDim)} · ${metricLabel(m)}`,
        data: series,
        metricId: m,
        format: inferMetricFormat(m),
        layout: 'horizontal',
      });
    }
  }

  // 2) Category charts — mix column + horizontal bar (no pie by default)
  catDims.forEach((catDim, catIdx) => {
    if (!primary) return;
    const data = buildCategorySeries(rows, catDim, primary, { topN: 10 });
    const type = catIdx % 2 === 0 ? 'column' : 'bar';
    pushUnique(charts, {
      type,
      title: `${metricLabel(primary)} by ${dimensionLabel(catDim)}`,
      hint: `${type === 'column' ? 'Column' : 'Bar'} · by ${dimensionLabel(catDim)} · ${metricLabel(primary)}`,
      data,
      metricId: primary,
      format: inferMetricFormat(primary),
      layout: type === 'bar' ? 'vertical' : 'horizontal',
    });
  });

  // 3) Second metric — different chart type than primary on same category
  if (catDims[0] && chartMetrics[1]) {
    const m = chartMetrics[1];
    const data = buildCategorySeries(rows, catDims[0], m, { topN: 10 });
    pushUnique(charts, {
      type: 'bar',
      title: `${metricLabel(m)} by ${dimensionLabel(catDims[0])}`,
      hint: `Bar · by ${dimensionLabel(catDims[0])} · ${metricLabel(m)}`,
      data,
      metricId: m,
      format: inferMetricFormat(m),
      layout: 'vertical',
    });
  }

  // 4) Third metric as column if available
  if (catDims[0] && chartMetrics[2]) {
    const m = chartMetrics[2];
    const data = buildCategorySeries(rows, catDims[0], m, { topN: 8 });
    pushUnique(charts, {
      type: 'column',
      title: `${metricLabel(m)} by ${dimensionLabel(catDims[0])}`,
      hint: `Column · by ${dimensionLabel(catDims[0])} · ${metricLabel(m)}`,
      data,
      metricId: m,
      format: inferMetricFormat(m),
      layout: 'horizontal',
    });
  }

  // 5) Multi-metric radar when 3+ metrics (different kind of graph)
  if (mets.length >= 3) {
    const totals = buildMetricTotals(rows, mets, visibility).slice(0, 6);
    if (totals.length >= 3) {
      pushUnique(charts, {
        type: 'radar',
        title: 'Metrics comparison',
        hint: 'Radar · selected metrics',
        data: totals,
        metricId: totals[0].metricId,
        format: 'raw',
        layout: 'horizontal',
      });
    }
  }

  // 6) Metric totals as columns when 2+ metrics
  if (mets.length >= 2) {
    const totals = buildMetricTotals(rows, mets, visibility);
    pushUnique(charts, {
      type: 'column',
      title: 'Metric totals',
      hint: 'Column · selected metrics',
      data: totals,
      metricId: totals[0]?.metricId || primary,
      format: inferMetricFormat(totals[0]?.metricId || primary),
      layout: 'horizontal',
    });
  }

  // Fallback
  if (!charts.length) {
    const totals = buildMetricTotals(rows, mets.length ? mets : chartMetrics, visibility);
    pushUnique(charts, {
      type: 'column',
      title: 'Metric totals',
      hint: 'Column · selected metrics',
      data: totals,
      metricId: totals[0]?.metricId,
      format: inferMetricFormat(totals[0]?.metricId),
      layout: 'horizontal',
    });
  }

  return charts.slice(0, MAX_CHARTS);
}
