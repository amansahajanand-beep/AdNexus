/**
 * Full reporting sync catalog — multi-slice GAM pulls into report_full_*.
 *
 * Only use dimension/metric combos GAM accepts. Exotic screenshot metrics
 * are tried in small batches; each slice always falls back to SAFE_METRICS.
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
 * Extra metric batches (tried after SAFE_METRICS). May fail per-slice —
 * fetchFullFromGAM falls back to SAFE_METRICS automatically.
 */
const FULL_SYNC_METRIC_BATCHES = [
  {
    key: 'safe',
    metrics: SAFE_METRICS,
  },
  {
    key: 'ad_server',
    metrics: [
      'AD_SERVER_IMPRESSIONS',
      'AD_SERVER_CLICKS',
      'AD_SERVER_CTR',
      'AD_SERVER_CPM_AND_CPC_REVENUE',
      'AD_SERVER_ALL_REVENUE',
    ],
  },
  {
    key: 'ad_exchange',
    metrics: [
      'AD_EXCHANGE_LINE_ITEM_LEVEL_IMPRESSIONS',
      'AD_EXCHANGE_LINE_ITEM_LEVEL_CLICKS',
      'AD_EXCHANGE_LINE_ITEM_LEVEL_CTR',
      'AD_EXCHANGE_LINE_ITEM_LEVEL_REVENUE',
      'AD_EXCHANGE_LINE_ITEM_LEVEL_AVERAGE_ECPM',
    ],
  },
];

function allFullSyncMetrics() {
  const set = new Set(SAFE_METRICS);
  FULL_SYNC_METRIC_BATCHES.forEach((b) => b.metrics.forEach((m) => set.add(m)));
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
  FULL_SYNC_DIM_SLICES,
  FULL_SYNC_METRIC_BATCHES,
  allFullSyncMetrics,
  allFullSyncDimensions,
  pickBestFullSlice,
};
