import { readDomainName, readSiteName } from './filters';
import { packageFromRow } from './appPackage';

const LEGACY_DIMENSION = {
  date: (r) => r.date,
  mobile_app_resolved_id: (r) => packageFromRow(r) || r.appId,
  mobile_app_name: (r) => (r.appName && r.appName !== '—' ? r.appName : ''),
  ad_unit_name: (r) => r.site,
  domain: (r) => readDomainName(r),
  site_name: (r) => readSiteName(r),
  url_name: (r) => r.siteUrl || r.gamSite,
  country_name: (r) => r.country || r.countryName || r.COUNTRY_NAME || r.country_name,
  country_code: (r) => r.countryCode || r.country_code || r.country,
  device_category_name: (r) => r.device || r.deviceCategory || r.device_category_name || r.DEVICE_CATEGORY_NAME,
  mobile_device_name: (r) => r.device || r.deviceCategory || r.mobile_device_name || r.device_category_name,
  programmatic_channel_name: (r) => r.channel,
  demand_channel_name: (r) => r.demandChannel || r.channel,
  ad_unit_id: (r) => r.adUnitId,
};

function rowSeed(row) {
  const s = `${row.date || ''}|${row.site || ''}|${row.appId || ''}`;
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) - h) + s.charCodeAt(i);
  return (Math.abs(h) % 1000) / 1000;
}

export function computeMetricProxy(metricId, row) {
  const seed = rowSeed(row);
  const imp = Number(row.impression ?? row.impressions) || Math.floor(800 + seed * 7200);
  const rev = Number(row.revenue) || +(imp * (0.0008 + seed * 0.003)).toFixed(2);
  const id = String(metricId).toLowerCase();

  if (id.includes('eligible_impressions')
    || (id.includes('viewable_impressions') && !id.includes('rate'))
    || (id.includes('measurable_impressions') && !id.includes('rate'))) {
    return Math.floor(imp * (0.65 + seed * 0.3));
  }
  if (id.includes('revenue') && !id.includes('percent')) {
    return +(rev * (0.25 + seed * 0.55)).toFixed(2);
  }
  if (id.includes('percent') || id.includes('_rate') || id.includes('ctr')) {
    return +(0.15 + seed * 2.5).toFixed(2);
  }
  if (id.includes('impressions')) return Math.floor(imp * (0.35 + seed * 0.55));
  if (id.includes('ecpm')) return imp > 0 ? +((rev / imp) * 1000).toFixed(2) : +(0.4 + seed * 5).toFixed(2);
  if (id.includes('clicks')) return Math.floor(imp * 0.015 * (0.2 + seed));
  if (id.includes('requests') || id.includes('responses')) {
    return Math.floor(imp * (1.1 + seed * 0.4));
  }
  return +(10 + seed * 500).toFixed(2);
}

function fillDimensions(row, dimensionIds = []) {
  const dimensions = { ...(row.dimensions || {}) };
  dimensionIds.forEach((id) => {
    if (dimensions[id]) return;
    const legacy = LEGACY_DIMENSION[id];
    const val = legacy ? legacy(row) : null;
    if (val != null && val !== '' && val !== '—') dimensions[id] = String(val);
  });
  return dimensions;
}

function fillMetrics(row, metricIds = [], useProxy = false) {
  const metrics = { ...(row.metrics || {}) };
  metricIds.forEach((id) => {
    if (metrics[id] != null && metrics[id] !== '') return;
    if (id === 'total_line_item_level_cpm_and_cpc_revenue') {
      if (row.revenue != null && row.revenue !== '' && Number.isFinite(Number(row.revenue))) {
        metrics[id] = Number(row.revenue);
        return;
      }
    }
    if (id === 'total_line_item_level_impressions') {
      const imp = row.impression ?? row.impressions;
      if (imp != null && imp !== '' && Number.isFinite(Number(imp))) {
        metrics[id] = Number(imp);
        return;
      }
    }
    if (id === 'total_line_item_level_ctr' && row.ctr != null && row.ctr !== '') {
      metrics[id] = Number(row.ctr);
      return;
    }
    if (id === 'ad_exchange_match_rate' && row.adxMatchRate != null && row.adxMatchRate !== '') {
      metrics[id] = Number(row.adxMatchRate);
      return;
    }
    if (id === 'total_fill_rate' && row.fillRate != null && row.fillRate !== '') {
      metrics[id] = Number(row.fillRate);
      return;
    }
    if (id === 'total_line_item_level_without_cpd_average_ecpm' && row.ecpm != null && row.ecpm !== '') {
      metrics[id] = Number(row.ecpm);
      return;
    }
    if (id === 'total_active_view_viewable_impressions_rate') {
      const view = row.viewableRate;
      if (view != null && view !== '' && Number.isFinite(Number(view))) {
        metrics[id] = Number(view);
        return;
      }
    }
    if (!useProxy) return;
    metrics[id] = computeMetricProxy(id, row);
  });
  return metrics;
}

/** Fill missing dimension/metric cells from legacy row fields. */
export function enrichReportRows(rows = [], dimensions = [], metrics = [], opts = {}) {
  const { useProxy = false } = opts;
  const dims = dimensions || [];
  const mets = metrics || [];
  if (!dims.length && !mets.length) return rows;
  return rows.map((row) => ({
    ...row,
    dimensions: fillDimensions(row, dims),
    metrics: fillMetrics(row, mets, useProxy),
  }));
}

export function isCellFilled(value, format) {
  if (value == null || value === '' || value === '—') return false;
  if (format === 'raw') return String(value).trim().length > 0;
  return true;
}

function parseSortableNumber(value) {
  if (value == null || value === '' || value === '—') return NaN;
  if (typeof value === 'number') return value;
  const cleaned = String(value).replace(/[^0-9.-]/g, '');
  if (!cleaned) return NaN;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

function compareSortValues(a, b) {
  const emptyA = a == null || a === '' || a === '—';
  const emptyB = b == null || b === '' || b === '—';
  if (emptyA && emptyB) return 0;
  if (emptyA) return 1;
  if (emptyB) return -1;

  const na = parseSortableNumber(a);
  const nb = parseSortableNumber(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;

  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** Sort rows by a selected column (asc / desc). */
export function sortRowsByColumn(rows = [], columns = [], columnId, direction = 'asc') {
  if (!columnId || !columns.length || rows.length < 2) return rows;
  const col = columns.find((c) => c.id === columnId);
  if (!col) return rows;
  const dir = direction === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = col.getValue(a);
    const bv = col.getValue(b);
    return compareSortValues(av, bv) * dir;
  });
}

/** Rows with most filled columns first (complete records on top). */
export function sortRowsByCompleteness(rows = [], columns = []) {
  if (!columns.length || rows.length < 2) return rows;
  const score = (row) => {
    let n = 0;
    columns.forEach((col) => {
      const raw = col.getValue(row);
      if (isCellFilled(raw, col.format)) n += 1;
    });
    return n;
  };
  return [...rows].sort((a, b) => score(b) - score(a));
}
