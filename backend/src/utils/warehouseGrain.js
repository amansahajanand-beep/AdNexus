/**
 * Unified warehouse grain for report_present + report_daily.
 * Dashboard and Reporting SQL-filter this set. Anything else is adhoc GAM.
 */
const { SAFE_METRICS } = require('./fullReportSyncCatalog');

const UNIFIED_GRAIN_DIMS = [
  'DATE',
  'COUNTRY_NAME',
  'DEVICE_CATEGORY_NAME',
  'AD_UNIT_NAME',
  'SITE_NAME',
  'DOMAIN',
  'MOBILE_APP_NAME',
  'MOBILE_APP_RESOLVED_ID',
  'PROGRAMMATIC_CHANNEL_NAME',
];

const UNIFIED_GRAIN_METRICS = [...SAFE_METRICS];

/**
 * Lean sync pulls these compatible slices separately, then upserts into
 * report_present / report_daily. Never drop COUNTRY + DEVICE — shrink metrics
 * or split inventory (web vs app) instead of falling back to AD_UNIT-only grain.
 */
/** Network-wide KPI — one row per day (GAM Totals only). ALL_REVENUE required. */
const NETWORK_KPI_METRICS = [
  'TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS',
  'TOTAL_LINE_ITEM_LEVEL_ALL_REVENUE',
  'TOTAL_LINE_ITEM_LEVEL_WITHOUT_CPD_AVERAGE_ECPM',
  'TOTAL_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE',
];

/** Slices that must include ALL_REVENUE — never fall back to CPM-only bundles. */
const REVENUE_STRICT_SLICES = new Set(['network_kpi', 'inventory_core', 'channel']);

const LEAN_SYNC_DIM_SLICES = [
  {
    key: 'network_kpi',
    dims: ['DATE'],
  },
  {
    key: 'inventory_core',
    dims: [
      'DATE', 'COUNTRY_NAME', 'DEVICE_CATEGORY_NAME',
      'AD_UNIT_NAME', 'SITE_NAME', 'MOBILE_APP_NAME',
    ],
  },
  // GAM Site × Domain (Historical). No AD_UNIT — DOMAIN+AD_UNIT often COLUMNS_NOT_SUPPORTED.
  {
    key: 'inventory_site_domain',
    dims: [
      'DATE', 'COUNTRY_NAME', 'DEVICE_CATEGORY_NAME',
      'SITE_NAME', 'DOMAIN',
    ],
  },
  // Domain-only fallback when Site×Domain is rejected.
  {
    key: 'inventory_domain',
    dims: [
      'DATE', 'COUNTRY_NAME', 'DEVICE_CATEGORY_NAME',
      'DOMAIN',
    ],
  },
  {
    key: 'app_id',
    dims: [
      'DATE', 'COUNTRY_NAME', 'DEVICE_CATEGORY_NAME',
      'AD_UNIT_NAME', 'MOBILE_APP_NAME', 'MOBILE_APP_RESOLVED_ID',
    ],
  },
  {
    key: 'channel',
    dims: [
      'DATE', 'COUNTRY_NAME', 'DEVICE_CATEGORY_NAME',
      'AD_UNIT_NAME', 'PROGRAMMATIC_CHANNEL_NAME',
    ],
  },
  {
    key: 'rich_core',
    dims: ['DATE', 'COUNTRY_NAME', 'DEVICE_CATEGORY_NAME', 'AD_UNIT_NAME'],
  },
];

/** Metric attempts per slice — revenue-strict slices never drop ALL_REVENUE. */
function getMetricAttemptsForSlice(sliceKey) {
  const sk = String(sliceKey || '').trim();
  if (sk === 'network_kpi') {
    return [NETWORK_KPI_METRICS];
  }
  if (REVENUE_STRICT_SLICES.has(sk)) {
    return [
      UNIFIED_GRAIN_METRICS,
      UNIFIED_GRAIN_METRICS.slice(0, 6),
      [
        'TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS',
        'TOTAL_LINE_ITEM_LEVEL_ALL_REVENUE',
        'TOTAL_LINE_ITEM_LEVEL_WITHOUT_CPD_AVERAGE_ECPM',
        'TOTAL_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE',
      ],
    ];
  }
  return LEAN_SYNC_METRIC_ATTEMPTS;
}

/** Prefer full SAFE metrics; shrink columns before dims if GAM rejects the combo. */
const LEAN_SYNC_METRIC_ATTEMPTS = [
  UNIFIED_GRAIN_METRICS,
  UNIFIED_GRAIN_METRICS.slice(0, 6),
  UNIFIED_GRAIN_METRICS.slice(0, 4),
  [
    'TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS',
    'TOTAL_LINE_ITEM_LEVEL_CLICKS',
    'TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE',
    'TOTAL_LINE_ITEM_LEVEL_WITHOUT_CPD_AVERAGE_ECPM',
  ],
];

const GRAIN_DIM_SET = new Set(UNIFIED_GRAIN_DIMS);
const GRAIN_MET_SET = new Set(UNIFIED_GRAIN_METRICS);

/** Max dims (including DATE) and metrics for a custom GAM / adhoc report. */
const MAX_CUSTOM_DIMS = Math.max(2, parseInt(process.env.MAX_CUSTOM_REPORT_DIMS || '8', 10) || 8);
const MAX_CUSTOM_METS = Math.max(1, parseInt(process.env.MAX_CUSTOM_REPORT_METRICS || '10', 10) || 10);

function toApi(v) {
  return String(v || '').trim().toUpperCase();
}

function isGrainDimension(api) {
  return GRAIN_DIM_SET.has(toApi(api));
}

function isGrainMetric(api) {
  return GRAIN_MET_SET.has(toApi(api));
}

/**
 * Classify a Reporting builder selection.
 *   grain  — SQL on report_present / report_daily
 *   adhoc  — GAM once, then report_adhoc cache
 */
function classifyReportingQuery(dimensionApis = [], metricApis = []) {
  const dims = [...new Set((dimensionApis || []).map(toApi).filter(Boolean))];
  const mets = [...new Set((metricApis || []).map(toApi).filter(Boolean))];
  const nonDateDims = dims.filter((d) => d !== 'DATE');
  const overCap = nonDateDims.length > (MAX_CUSTOM_DIMS - 1) || mets.length > MAX_CUSTOM_METS;

  if (overCap) {
    const skippedDims = nonDateDims.filter((d) => !isGrainDimension(d));
    const skippedMets = mets.filter((m) => !isGrainMetric(m));
    return {
      mode: 'grain',
      selectAll: true,
      skippedDims,
      skippedMets,
      usedDims: UNIFIED_GRAIN_DIMS,
      usedMetrics: UNIFIED_GRAIN_METRICS,
    };
  }

  const missingDims = nonDateDims.filter((d) => !isGrainDimension(d));
  const missingMets = mets.filter((m) => !isGrainMetric(m));
  if (!missingDims.length && !missingMets.length) {
    return {
      mode: 'grain',
      selectAll: false,
      skippedDims: [],
      skippedMets: [],
      usedDims: dims.length ? dims : UNIFIED_GRAIN_DIMS,
      usedMetrics: mets.length ? mets : UNIFIED_GRAIN_METRICS,
    };
  }

  const cappedDims = ['DATE', ...nonDateDims.filter((d) => d !== 'DATE')].slice(0, MAX_CUSTOM_DIMS);
  const uniqueCapped = [...new Set(cappedDims)];
  const cappedMets = mets.slice(0, MAX_CUSTOM_METS);
  return {
    mode: 'adhoc',
    selectAll: false,
    skippedDims: [
      ...nonDateDims.filter((d) => !uniqueCapped.includes(d)),
    ],
    skippedMets: mets.filter((m) => !cappedMets.includes(m)),
    usedDims: uniqueCapped,
    usedMetrics: cappedMets.length ? cappedMets : UNIFIED_GRAIN_METRICS.slice(0, 4),
  };
}

module.exports = {
  UNIFIED_GRAIN_DIMS,
  UNIFIED_GRAIN_METRICS,
  NETWORK_KPI_METRICS,
  REVENUE_STRICT_SLICES,
  LEAN_SYNC_DIM_SLICES,
  LEAN_SYNC_METRIC_ATTEMPTS,
  getMetricAttemptsForSlice,
  MAX_CUSTOM_DIMS,
  MAX_CUSTOM_METS,
  isGrainDimension,
  isGrainMetric,
  classifyReportingQuery,
};
