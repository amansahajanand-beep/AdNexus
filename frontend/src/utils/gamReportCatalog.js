/**
 * GAM Report Builder — re-exports full catalog from API docs + UI helpers.
 * Source: gamReportCatalogData.js (180 dimensions, 364 metrics).
 */
import {
  GAM_DIMENSION_CATEGORIES as ALL_DIMENSION_CATEGORIES,
  GAM_METRIC_CATEGORIES as ALL_METRIC_CATEGORIES,
  GAM_CATALOG_STATS as FULL_CATALOG_STATS,
} from './gamReportCatalogData';

/** Dimension groups hidden from the filter UI (too advanced / not needed). */
const HIDDEN_DIMENSION_GROUPS = new Set([
  'video', 'delivery', 'programmatic', 'audience', 'content', 'partners',
  'customTargeting', 'mediation', 'pricingBidding', 'other',
]);

/** Metric groups hidden from the filter UI. */
const HIDDEN_METRIC_GROUPS = new Set([
  'video', 'programmatic', 'adsense', 'reachForecast', 'sdkMediation', 'other',
]);

/** Keep screenshot defaults available after hiding the programmatic group. */
const CORE_DIMENSION_GROUP = {
  id: 'core',
  label: 'Programmatic',
  items: [
    { id: 'programmatic_channel_name', label: 'Programmatic channel', api: 'PROGRAMMATIC_CHANNEL_NAME' },
    { id: 'demand_channel_name', label: 'Demand channel', api: 'DEMAND_CHANNEL_NAME' },
  ],
};

export const GAM_DIMENSION_CATEGORIES = [
  CORE_DIMENSION_GROUP,
  ...ALL_DIMENSION_CATEGORIES.filter(c => !HIDDEN_DIMENSION_GROUPS.has(c.id)),
];

export const GAM_METRIC_CATEGORIES = ALL_METRIC_CATEGORIES.filter(
  c => !HIDDEN_METRIC_GROUPS.has(c.id)
);

export const GAM_CATALOG_STATS = {
  dimensions: GAM_DIMENSION_CATEGORIES.reduce((n, c) => n + c.items.length, 0),
  metrics: GAM_METRIC_CATEGORIES.reduce((n, c) => n + c.items.length, 0),
  full: FULL_CATALOG_STATS,
};

/**
 * Defaults used when user hasn't selected any dims/metrics.
 * Empty dims → resolveReportTableConfig picks 'inventory' mode → getDetailed() runs
 * → summary cards (revenue, totalDomains, offeredRecords) get real values from backend.
 */
export const DEFAULT_REPORT_DIMENSIONS = [];
export const DEFAULT_REPORT_METRICS = [
  'total_line_item_level_cpm_and_cpc_revenue',
  'total_line_item_level_impressions',
];

export const REPORT_SETTINGS_OPTIONS = {
  runTypes: [
    { id: 'totals', label: 'Totals only' },
    { id: 'breakdown', label: 'Breakdown by date' },
  ],
  currencies: [
    { id: 'USD', label: 'USD — US Dollar' },
    { id: 'INR', label: 'INR — Indian Rupee' },
    { id: 'EUR', label: 'EUR — Euro' },
    { id: 'GBP', label: 'GBP — British Pound' },
    { id: 'SGD', label: 'SGD — Singapore Dollar' },
  ],
  timezones: [
    { id: 'Asia/Singapore', label: 'Asia/Singapore' },
    { id: 'America/New_York', label: 'America/New_York' },
    { id: 'Europe/London', label: 'Europe/London' },
    { id: 'Asia/Kolkata', label: 'Asia/Kolkata' },
  ],
  adUnitViews: [
    { id: 'FLAT', label: 'Flat' },
    { id: 'HIERARCHICAL', label: 'Hierarchical' },
  ],
};

export const DEFAULT_REPORT_SETTINGS = {
  runType: 'totals',
  currency: 'USD',
  timezone: 'Asia/Singapore',
  adUnitView: 'FLAT',
};

export const DATE_PRESETS = [
  { id: 'today',     label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'last7',     label: 'Last 7 days' },
  { id: 'last30',    label: 'Last 30 days' },
  { id: 'thisMonth', label: 'This month' },
  { id: 'lastMonth', label: 'Last month' },
  { id: 'custom',    label: 'Custom range' },
];

function findInCategories(categories, id) {
  for (const cat of categories) {
    const hit = cat.items.find(i => i.id === id);
    if (hit) return hit;
  }
  return null;
}

function findDimension(id) {
  return findInCategories(GAM_DIMENSION_CATEGORIES, id)
    || findInCategories(ALL_DIMENSION_CATEGORIES, id);
}

function findMetric(id) {
  return findInCategories(GAM_METRIC_CATEGORIES, id)
    || findInCategories(ALL_METRIC_CATEGORIES, id);
}

export function dimensionLabel(id) {
  return findDimension(id)?.label || id;
}

export function metricLabel(id) {
  return findMetric(id)?.label || id;
}

export function dimensionApi(id) {
  return findDimension(id)?.api || null;
}

export function metricApi(id) {
  return findMetric(id)?.api || null;
}

export function dimensionsToChips(ids) {
  return (ids || []).map(id => ({
    id: `dim-${id}`,
    field: 'dimension',
    value: id,
    category: 'Dimension',
    label: dimensionLabel(id),
  }));
}

export function metricsToChips(ids) {
  return (ids || []).map(id => ({
    id: `met-${id}`,
    field: 'metric',
    value: id,
    category: 'Metric',
    label: metricLabel(id),
  }));
}

export function reportSettingsToChips(settings = DEFAULT_REPORT_SETTINGS) {
  const chips = [];
  const run = REPORT_SETTINGS_OPTIONS.runTypes.find(r => r.id === settings.runType);
  const cur = REPORT_SETTINGS_OPTIONS.currencies.find(c => c.id === settings.currency);
  const tz = REPORT_SETTINGS_OPTIONS.timezones.find(t => t.id === settings.timezone);
  const view = REPORT_SETTINGS_OPTIONS.adUnitViews.find(v => v.id === settings.adUnitView);
  // Only show chip when the value differs from the default so clicking × actually makes it disappear
  if (run && settings.runType !== DEFAULT_REPORT_SETTINGS.runType)
    chips.push({ id: 'set-run', field: 'reportSetting', settingKey: 'runType', category: 'Run', label: run.label });
  if (cur && settings.currency !== DEFAULT_REPORT_SETTINGS.currency)
    chips.push({ id: 'set-currency', field: 'reportSetting', settingKey: 'currency', category: 'Currency', label: cur.id });
  if (tz && settings.timezone !== DEFAULT_REPORT_SETTINGS.timezone)
    chips.push({ id: 'set-tz', field: 'reportSetting', settingKey: 'timezone', category: 'Timezone', label: tz.label });
  if (view && settings.adUnitView !== DEFAULT_REPORT_SETTINGS.adUnitView)
    chips.push({ id: 'set-view', field: 'reportSetting', settingKey: 'adUnitView', category: 'Ad unit view', label: view.label });
  return chips;
}
