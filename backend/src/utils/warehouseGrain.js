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
  'PROGRAMMATIC_CHANNEL_NAME',
];

const UNIFIED_GRAIN_METRICS = [...SAFE_METRICS];

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
  MAX_CUSTOM_DIMS,
  MAX_CUSTOM_METS,
  isGrainDimension,
  isGrainMetric,
  classifyReportingQuery,
};
