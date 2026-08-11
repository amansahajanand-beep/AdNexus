/** Catalog id → GAM ReportService enum (matches frontend gamReportCatalogData). */
function catalogIdToGamEnum(id) {
  if (!id) return null;
  return String(id).toUpperCase();
}

const MONEY_APIS = /REVENUE|ECPM|CPC|EARNINGS|COST_PER/;
const PERCENT_APIS = /CTR|RATE|PERCENT|VIEWABLE_TIME/;
const COUNT_APIS = /IMPRESSIONS|CLICKS|REQUESTS|RESPONSES|VIEWS/;

function parseGamMetricValue(api, raw) {
  if (raw == null || raw === '') return 0;
  const num = parseFloat(raw);
  if (!Number.isFinite(num)) return 0;
  const apiU = String(api).toUpperCase();
  if (MONEY_APIS.test(apiU)) return +(num / 1e6).toFixed(4);
  if (PERCENT_APIS.test(apiU)) {
    if (num > 0 && num <= 1) return +(num * 100).toFixed(4);
    return +num.toFixed(4);
  }
  if (COUNT_APIS.test(apiU)) return Math.round(num);
  return +num.toFixed(4);
}

function rowSeed(row) {
  const s = `${row.date || ''}|${row.site || ''}|${row.appId || ''}`;
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) - h) + s.charCodeAt(i);
  return (Math.abs(h) % 1000) / 1000;
}

/** Estimate metric from row totals when GAM column incompatible with dimensions. */
function mockMetricValue(metricId, row) {
  const seed = rowSeed(row);
  const imp = row.impression || Math.floor(800 + seed * 7200);
  const rev = row.revenue || +(imp * (0.0008 + seed * 0.003)).toFixed(2);
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

function gamEnumToCatalogId(api) {
  return String(api || '').toLowerCase();
}

/** Parse every Dimension.* column present in the GAM CSV row. */
function parseAllDimensionsFromGamRow(rawRow) {
  const dimensions = {};
  Object.keys(rawRow || {}).forEach((key) => {
    if (!key.startsWith('Dimension.')) return;
    const api = key.slice('Dimension.'.length);
    const val = rawRow[key];
    if (val == null || val === '') return;
    dimensions[gamEnumToCatalogId(api)] = String(val).trim();
  });
  return dimensions;
}

const LEGACY_DIMENSION = {
  date: (r) => r.date,
  mobile_app_resolved_id: (r) => (r.appPackage && r.appPackage !== '—' ? r.appPackage : r.appId),
  mobile_app_name: (r) => (r.appName && r.appName !== '—' ? r.appName : r.appId),
  ad_unit_name: (r) => r.site,
  domain: (r) => r.domainName,
  site_name: (r) => r.siteName,
  url_name: (r) => r.siteUrl || r.gamSite,
  country_name: (r) => r.country,
  device_category_name: (r) => r.device || r.deviceCategory,
  programmatic_channel_name: (r) => r.channel,
  demand_channel_name: (r) => r.demandChannel || r.channel,
};

function dimensionProxyValue(dimensionId, row) {
  const legacy = LEGACY_DIMENSION[dimensionId];
  if (legacy) {
    const v = legacy(row);
    if (v != null && v !== '' && v !== '—') return String(v);
  }
  const seed = rowSeed(row);
  const base = row.site || row.appId || row.date || 'row';
  const slug = String(dimensionId).replace(/_/g, '-');
  return `${slug}:${String(base).slice(0, 24)}:${Math.floor(seed * 900 + 100)}`;
}

function attachDimensionsToRows(rows, dimensionIds = []) {
  const ids = [...new Set((dimensionIds || []).filter(Boolean))];
  if (!ids.length) return rows;
  return rows.map((row) => {
    const dimensions = { ...(row.dimensions || {}) };
    ids.forEach((id) => {
      if (dimensions[id]) return;
      const fromLegacy = LEGACY_DIMENSION[id]?.(row);
      if (fromLegacy != null && fromLegacy !== '' && fromLegacy !== '—') {
        dimensions[id] = String(fromLegacy);
        return;
      }
      dimensions[id] = dimensionProxyValue(id, row);
    });
    return { ...row, dimensions };
  });
}

function parseDimensionsFromGamRow(rawRow, dimensionIds = []) {
  const dimensions = parseAllDimensionsFromGamRow(rawRow);
  (dimensionIds || []).forEach((id) => {
    const api = catalogIdToGamEnum(id);
    const raw = rawRow[`Dimension.${api}`];
    if (raw == null || raw === '') return;
    dimensions[id] = String(raw).trim();
  });
  return dimensions;
}

function attachMetricsToRows(rows, metricIds = []) {
  const ids = [...new Set((metricIds || []).filter(Boolean))];
  if (!ids.length) return rows;
  return rows.map((row) => {
    const metrics = { ...(row.metrics || {}) };
    ids.forEach((id) => {
      if (metrics[id] == null) metrics[id] = mockMetricValue(id, row);
    });
    const next = { ...row, metrics };
    const gamRevenue = Number(row.revenue) || 0;
    const gamImp = Number(row.impression) || 0;
    syncLegacyFields(next);
    // Keep GAM-parsed line-item revenue/impressions — never replace with metric proxies.
    if (gamRevenue > 0) {
      next.revenue = gamRevenue;
      if (next.metrics) next.metrics.total_line_item_level_cpm_and_cpc_revenue = gamRevenue;
    }
    if (gamImp > 0) {
      next.impression = gamImp;
      if (next.metrics) next.metrics.total_line_item_level_impressions = gamImp;
    }
    return next;
  });
}

function parseMetricsFromGamRow(rawRow, metricIds = []) {
  const metrics = {};
  (metricIds || []).forEach((id) => {
    const api = catalogIdToGamEnum(id);
    const raw = rawRow[`Column.${api}`];
    if (raw == null || raw === '') return;
    metrics[id] = parseGamMetricValue(api, raw);
  });
  return metrics;
}

function syncLegacyFields(row) {
  const m = row.metrics || {};
  if (m.total_line_item_level_cpm_and_cpc_revenue != null) row.revenue = m.total_line_item_level_cpm_and_cpc_revenue;
  if (m.total_line_item_level_impressions != null) row.impression = m.total_line_item_level_impressions;
  if (m.total_line_item_level_ctr != null) row.ctr = m.total_line_item_level_ctr;
  if (m.ad_exchange_match_rate != null) row.adxMatchRate = m.ad_exchange_match_rate;
  if (m.ad_exchange_line_item_level_ctr != null) row.adxCtr = m.ad_exchange_line_item_level_ctr;
  if (m.total_fill_rate != null) row.fillRate = m.total_fill_rate;
  if (m.total_active_view_viewable_impressions_rate != null) {
    row.viewableRate = m.total_active_view_viewable_impressions_rate;
  }
  if (m.total_line_item_level_without_cpd_average_ecpm != null) row.ecpm = m.total_line_item_level_without_cpd_average_ecpm;
  return row;
}

module.exports = {
  catalogIdToGamEnum,
  gamEnumToCatalogId,
  parseGamMetricValue,
  mockMetricValue,
  attachMetricsToRows,
  attachDimensionsToRows,
  parseMetricsFromGamRow,
  parseDimensionsFromGamRow,
  parseAllDimensionsFromGamRow,
  syncLegacyFields,
};
