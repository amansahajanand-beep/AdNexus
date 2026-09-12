/**
 * Full / lean reporting sync catalog.
 *
 * SAFE_METRICS power Dashboard KPIs. EXTENDED families (Ad Exchange, Ad Server,
 * AdSense, …) are pulled in separate GAM batches and merged into report_grain.metrics
 * so Reporting can serve real AdX/AdServer columns at Country/Site/App grain.
 *
 * Not every GAM dimension×metric combo can be pre-stored (API rejects many mixes).
 * Compatible slices below cover the builder fields we can reliably warehouse.
 */

/** Metrics known to work with inventory / country / device dimensions. */
const SAFE_METRICS = [
  'TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS',
  'TOTAL_LINE_ITEM_LEVEL_CLICKS',
  'TOTAL_LINE_ITEM_LEVEL_CTR',
  'TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE',
  'TOTAL_LINE_ITEM_LEVEL_ALL_REVENUE',
  'TOTAL_LINE_ITEM_LEVEL_WITHOUT_CPD_AVERAGE_ECPM',
  'TOTAL_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS',
  'TOTAL_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE',
  'TOTAL_INVENTORY_LEVEL_UNFILLED_IMPRESSIONS',
];

/** Chunk large metric lists so GAM does not reject oversized column sets. */
function chunkMetrics(metrics, size = 6) {
  const out = [];
  const list = [...new Set((metrics || []).filter(Boolean))];
  for (let i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size));
  }
  return out.length ? out : [[]];
}

const AD_EXCHANGE_METRICS = [
  'AD_EXCHANGE_LINE_ITEM_LEVEL_IMPRESSIONS',
  'AD_EXCHANGE_LINE_ITEM_LEVEL_TARGETED_IMPRESSIONS',
  'AD_EXCHANGE_LINE_ITEM_LEVEL_CLICKS',
  'AD_EXCHANGE_LINE_ITEM_LEVEL_TARGETED_CLICKS',
  'AD_EXCHANGE_LINE_ITEM_LEVEL_CTR',
  'AD_EXCHANGE_LINE_ITEM_LEVEL_REVENUE',
  'AD_EXCHANGE_LINE_ITEM_LEVEL_AVERAGE_ECPM',
  'AD_EXCHANGE_LINE_ITEM_LEVEL_PERCENT_IMPRESSIONS',
  'AD_EXCHANGE_LINE_ITEM_LEVEL_PERCENT_CLICKS',
  'AD_EXCHANGE_LINE_ITEM_LEVEL_WITHOUT_CPD_PERCENT_REVENUE',
  'AD_EXCHANGE_LINE_ITEM_LEVEL_WITH_CPD_PERCENT_REVENUE',
  'AD_EXCHANGE_RESPONSES_SERVED',
  'AD_EXCHANGE_TOTAL_REQUESTS',
  'AD_EXCHANGE_MATCH_RATE',
  'AD_EXCHANGE_COST_PER_CLICK',
  'AD_EXCHANGE_TOTAL_REQUEST_CTR',
  'AD_EXCHANGE_MATCHED_REQUEST_CTR',
  'AD_EXCHANGE_TOTAL_REQUEST_ECPM',
  'AD_EXCHANGE_MATCHED_REQUEST_ECPM',
];

const AD_SERVER_METRICS = [
  'AD_SERVER_IMPRESSIONS',
  'AD_SERVER_BEGIN_TO_RENDER_IMPRESSIONS',
  'AD_SERVER_TARGETED_IMPRESSIONS',
  'AD_SERVER_CLICKS',
  'AD_SERVER_TARGETED_CLICKS',
  'AD_SERVER_CTR',
  'AD_SERVER_CPM_AND_CPC_REVENUE',
  'AD_SERVER_CPM_AND_CPC_REVENUE_GROSS',
  'AD_SERVER_CPD_REVENUE',
  'AD_SERVER_ALL_REVENUE',
  'AD_SERVER_ALL_REVENUE_GROSS',
  'AD_SERVER_WITHOUT_CPD_AVERAGE_ECPM',
  'AD_SERVER_WITH_CPD_AVERAGE_ECPM',
  'AD_SERVER_LINE_ITEM_LEVEL_PERCENT_IMPRESSIONS',
  'AD_SERVER_LINE_ITEM_LEVEL_PERCENT_CLICKS',
  'AD_SERVER_LINE_ITEM_LEVEL_WITHOUT_CPD_PERCENT_REVENUE',
  'AD_SERVER_LINE_ITEM_LEVEL_WITH_CPD_PERCENT_REVENUE',
  'AD_SERVER_UNFILTERED_IMPRESSIONS',
  'AD_SERVER_UNFILTERED_BEGIN_TO_RENDER_IMPRESSIONS',
  'AD_SERVER_UNFILTERED_CLICKS',
  'AD_SERVER_RESPONSES_SERVED',
];

/** Active View family — Total + Ad Server / AdSense / Ad Exchange Active View cores. */
const ACTIVE_VIEW_METRICS = [
  'TOTAL_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS',
  'TOTAL_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS',
  'TOTAL_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE',
  'TOTAL_ACTIVE_VIEW_ELIGIBLE_IMPRESSIONS',
  'TOTAL_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS_RATE',
  'TOTAL_ACTIVE_VIEW_AVERAGE_VIEWABLE_TIME',
  'TOTAL_ACTIVE_VIEW_REVENUE',
  'ACTIVE_VIEW_PERCENT_AUDIBLE_START_IMPRESSIONS',
  'ACTIVE_VIEW_PERCENT_EVER_AUDIBLE_IMPRESSIONS',
  'AD_SERVER_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS',
  'AD_SERVER_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS',
  'AD_SERVER_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE',
  'AD_SERVER_ACTIVE_VIEW_ELIGIBLE_IMPRESSIONS',
  'AD_SERVER_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS_RATE',
  'AD_SERVER_ACTIVE_VIEW_REVENUE',
  'AD_SERVER_ACTIVE_VIEW_AVERAGE_VIEWABLE_TIME',
  'ADSENSE_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS',
  'ADSENSE_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS',
  'ADSENSE_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE',
  'ADSENSE_ACTIVE_VIEW_ELIGIBLE_IMPRESSIONS',
  'ADSENSE_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS_RATE',
  'ADSENSE_ACTIVE_VIEW_AVERAGE_VIEWABLE_TIME',
  'AD_EXCHANGE_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS',
  'AD_EXCHANGE_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS',
  'AD_EXCHANGE_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE',
  'AD_EXCHANGE_ACTIVE_VIEW_ELIGIBLE_IMPRESSIONS',
  'AD_EXCHANGE_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS_RATE',
  'AD_EXCHANGE_ACTIVE_VIEW_AVERAGE_VIEWABLE_TIME',
];

/** All extended metric enums stored in report_grain.metrics when GAM allows. */
const EXTENDED_GRAIN_METRICS = [
  ...AD_EXCHANGE_METRICS,
  ...AD_SERVER_METRICS,
  ...ACTIVE_VIEW_METRICS,
];

/**
 * Batches for sync-extended (every ~90m). Merged into report_grain.metrics.
 * Hourly lean sync stays SAFE Totals only so Dashboard stays fast.
 */
const EXTENDED_METRIC_BATCHES = [
  ...chunkMetrics(AD_EXCHANGE_METRICS, 6).map((metrics, i) => ({
    key: `ad_exchange_${i + 1}`,
    metrics,
  })),
  ...chunkMetrics(AD_SERVER_METRICS, 6).map((metrics, i) => ({
    key: `ad_server_${i + 1}`,
    metrics,
  })),
  ...chunkMetrics(ACTIVE_VIEW_METRICS, 6).map((metrics, i) => ({
    key: `active_view_${i + 1}`,
    metrics,
  })),
];

/** @deprecated alias — same as EXTENDED_METRIC_BATCHES */
const LEAN_SUPPLEMENTAL_METRIC_BATCHES = EXTENDED_METRIC_BATCHES;

/** Compatible dimension groups (proven + common Reporting builder fields). */
const FULL_SYNC_DIM_SLICES = [
  {
    key: 'inventory_core',
    dims: [
      'DATE', 'COUNTRY_NAME', 'DEVICE_CATEGORY_NAME',
      'AD_UNIT_NAME', 'SITE_NAME', 'MOBILE_APP_NAME',
    ],
  },
  {
    key: 'inventory_site_domain',
    dims: [
      'DATE', 'COUNTRY_NAME', 'DEVICE_CATEGORY_NAME',
      'SITE_NAME', 'DOMAIN',
    ],
  },
  {
    key: 'inventory_domain',
    dims: [
      'DATE', 'COUNTRY_NAME', 'DEVICE_CATEGORY_NAME',
      'AD_UNIT_NAME', 'DOMAIN',
    ],
  },
  {
    key: 'geo',
    dims: ['DATE', 'COUNTRY_NAME', 'COUNTRY_CODE', 'REGION_NAME', 'CITY_NAME'],
  },
  {
    key: 'geo_country',
    dims: ['DATE', 'COUNTRY_NAME', 'COUNTRY_CODE'],
  },
  {
    key: 'channel',
    dims: ['DATE', 'PROGRAMMATIC_CHANNEL_NAME', 'DEMAND_CHANNEL_NAME', 'COUNTRY_NAME'],
  },
  {
    key: 'device_browser',
    dims: ['DATE', 'DEVICE_CATEGORY_NAME', 'BROWSER_NAME', 'OPERATING_SYSTEM_NAME'],
  },
  {
    key: 'time_hour',
    dims: ['DATE', 'HOUR', 'AD_UNIT_NAME', 'COUNTRY_NAME'],
  },
  {
    key: 'app_id',
    dims: ['DATE', 'MOBILE_APP_RESOLVED_ID', 'MOBILE_APP_NAME', 'COUNTRY_NAME', 'DEVICE_CATEGORY_NAME'],
  },
];

/**
 * Metric batches for full-sync enrichment. SAFE first; then extended families.
 * May fail per-slice — fetchFullFromGAM falls back to SAFE_METRICS automatically.
 */
const FULL_SYNC_METRIC_BATCHES = [
  {
    key: 'safe',
    metrics: SAFE_METRICS,
  },
  ...LEAN_SUPPLEMENTAL_METRIC_BATCHES,
];

function allFullSyncMetrics() {
  const set = new Set(SAFE_METRICS);
  FULL_SYNC_METRIC_BATCHES.forEach((b) => b.metrics.forEach((m) => set.add(m)));
  EXTENDED_GRAIN_METRICS.forEach((m) => set.add(m));
  return [...set];
}

function allFullSyncDimensions() {
  const set = new Set();
  FULL_SYNC_DIM_SLICES.forEach((s) => s.dims.forEach((d) => set.add(d)));
  return [...set];
}

/**
 * Pick the best pre-synced slice for a Reporting query.
 * Prefers full dim coverage, then fewest extra dims; then best metric batch.
 */
function pickBestFullSlice(requestedDimApis = [], requestedMetricApis = []) {
  const neededDims = [...new Set(
    (requestedDimApis || [])
      .map((d) => String(d || '').toUpperCase())
      .filter((d) => d && d !== 'DATE')
  )];
  const neededMets = [...new Set(
    (requestedMetricApis || [])
      .map((m) => String(m || '').toUpperCase())
      .filter(Boolean)
  )];

  let bestSlice = null;
  let bestScore = -Infinity;
  for (const slice of FULL_SYNC_DIM_SLICES) {
    const set = new Set(slice.dims);
    const covered = neededDims.filter((d) => set.has(d));
    const missing = neededDims.filter((d) => !set.has(d));
    const score = (covered.length * 100)
      - (missing.length * 80)
      - Math.max(0, slice.dims.length - covered.length - 1);
    if (score > bestScore || (score === bestScore && slice.dims.length < (bestSlice?.dims.length || 999))) {
      bestScore = score;
      const usedDims = slice.dims.filter((d) => d === 'DATE' || covered.includes(d));
      bestSlice = {
        key: slice.key,
        dims: slice.dims,
        coveredDims: covered,
        missingDims: missing,
        usedDims: usedDims.length ? usedDims : (set.has('DATE') ? ['DATE'] : slice.dims.slice(0, 1)),
      };
    }
  }
  if (!bestSlice) return null;

  let bestBatch = FULL_SYNC_METRIC_BATCHES.find((b) => b.key === 'safe') || FULL_SYNC_METRIC_BATCHES[0];
  let bestMetScore = -1;
  for (const batch of FULL_SYNC_METRIC_BATCHES) {
    const set = new Set(batch.metrics);
    const covered = neededMets.filter((m) => set.has(m));
    if (covered.length > bestMetScore) {
      bestMetScore = covered.length;
      bestBatch = batch;
    }
  }
  const metSet = new Set(bestBatch.metrics);
  const usedMets = neededMets.length
    ? neededMets.filter((m) => metSet.has(m))
    : [...SAFE_METRICS];
  const missingMets = neededMets.filter((m) => !metSet.has(m));

  return {
    sliceKey: `${bestSlice.key}__${bestBatch.key}`,
    sliceBase: bestSlice.key,
    batchKey: bestBatch.key,
    dims: bestSlice.dims,
    metrics: bestBatch.metrics,
    usedDims: bestSlice.usedDims,
    missingDims: bestSlice.missingDims || [],
    usedMetrics: usedMets.length ? usedMets : bestBatch.metrics,
    missingMetrics: missingMets,
  };
}

module.exports = {
  SAFE_METRICS,
  AD_EXCHANGE_METRICS,
  AD_SERVER_METRICS,
  ACTIVE_VIEW_METRICS,
  EXTENDED_GRAIN_METRICS,
  EXTENDED_METRIC_BATCHES,
  LEAN_SUPPLEMENTAL_METRIC_BATCHES,
  FULL_SYNC_DIM_SLICES,
  FULL_SYNC_METRIC_BATCHES,
  allFullSyncMetrics,
  allFullSyncDimensions,
  pickBestFullSlice,
  chunkMetrics,
};
