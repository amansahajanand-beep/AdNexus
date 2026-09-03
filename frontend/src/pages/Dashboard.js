import React, { useState, useEffect, useCallback, useRef, useMemo, startTransition } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, BarChart, Bar,
  LineChart, Line, ComposedChart,
} from 'recharts';
import { reportsAPI } from '../utils/api';
import { nowTimeInTZ } from '../utils/datetime';
import {
  getDateRestriction,
  clampDateRange,
  clampPresetRange,
  clampDateValue,
  initialReportDatesForUser,
  defaultReportRangeForUser,
  formatDateRestrictionLabel,
  allowedDatePresets,
  isPresetAllowedForRestriction,
  isFixedDateRestriction,
  isCustomRangeIncomplete,
  committedReportDates,
} from '../utils/dateRestriction';
import AccessRestricted from '../components/ui/AccessRestricted';
import MultiSelect from '../components/ui/MultiSelect';
import FilterChips from '../components/ui/FilterChips';
import GamOverviewCard from '../components/ui/GamOverviewCard';
import InsightsStrip from '../components/ui/InsightsStrip';
import PageHeader from '../components/ui/PageHeader';
import ChartHeader from '../components/ui/ChartHeader';
import ChartExportButton from '../components/ui/ChartExportButton';
import OnboardingGuide from '../components/ui/OnboardingGuide';
import DataFreshness from '../components/ui/DataFreshness';
import ThresholdAlertBanner from '../components/ui/ThresholdAlertBanner';
import { useReportHotkeys } from '../hooks/useReportHotkeys';
import { showToast } from '../hooks/useToast';
import {
  previousPeriodRange,
  isPeriodAllowed,
  withPeriodDeltas,
  overlayPriorDaily,
  buildInsights,
  resolveCompareRange,
  compareLabelFor,
} from '../utils/periodCompare';
import { evaluateRevenueDropThreshold } from '../utils/thresholdAlerts';
import { getLastPageFilters, saveLastPageFilters, LAST_FILTER_PAGES } from '../utils/lastPageFilters';
import {
  DASH_CHARTS,
  loadHiddenDashCharts,
  saveHiddenDashCharts,
  loadComparePrefs,
  saveComparePrefs,
} from '../utils/dashCharts';
import CompareRangeBar from '../components/ui/CompareRangeBar';
import ChartVisibilityMenu from '../components/ui/ChartVisibilityMenu';
import { encodeReportShare, parseReportShare, copyReportLink } from '../utils/reportShare';
import { DATE_PRESETS } from '../utils/gamReportCatalog';
import { buildFilterDropdownOptions } from '../utils/catalogOptions';
import { buildAppliedFilterChips, removeFilterChip } from '../utils/filterChips';
import { normalizeInventorySelections, slimFiltersForPersist, isAllSelection, ALL_SENTINEL } from '../utils/inventorySelection';
import { saveReportPage } from '../store/slices/reportSlice';
import { isReportCacheFresh } from '../hooks/useReportPageCache';
import { useMedia } from '../hooks/useMedia';
import DynamicReportTable from '../components/ui/DynamicReportTable';
import {
  formatAxisMoney,
  formatAxisNumber,
  yAxisWidthForValues,
  dateAxisProps,
  chartMargins,
  truncateAxisLabel,
  categoryAxisWidth,
  categoryLabelMaxChars,
  scrollableChartMinWidth,
} from '../utils/chartAxis';
import ScrollableChart from '../components/ui/ScrollableChart';
import {
  resolveDashboardTableConfig,
  buildReportColumns,
  aggregateRowsByColumns,
  summarizeRowsForOverview,
} from '../utils/dynamicReportTable';
import { enrichReportRows } from '../utils/enrichReportRows';
import { usePermissions } from '../hooks/usePermissions';
import { NO_VIEW_REPORTS_MSG, NO_VIEW_REPORTS_TITLE, getAssignedInventoryScope, hasAssignedInventory, isAdmin } from '../utils/permissions';
import {
  EMPTY_INVENTORY_FILTERS,
  draftHasInventorySelection,
  getAssignedFilterVisibility,
  hasInventoryFilterSelection,
  initialInventoryDraft,
  shouldAutoLoadScopedInventory,
  buildScopedDashboardApplied,
} from '../utils/assignedInventoryFilters';
import { getUserFacingMessage, logErrorForDebug } from '../utils/userFacingError';
import NoDomainsAssignedNote from '../components/ui/NoDomainsAssignedNote';
import {
  getRecentFilters,
  saveRecentFilter,
  applyRecentFilter,
  removeRecentFilter,
  clearRecentFilters,
  RECENT_FILTERS_CLEARED_EVENT,
} from '../utils/recentFilters';
import SavedFiltersBar from '../components/ui/SavedFiltersBar';
import SavePresetButton from '../components/ui/SavePresetButton';
import { SAVED_FILTERS_PAGES, getSavedFilters } from '../utils/savedFilters';
import { PRESET_PAGES, filtersOnlySnapshot } from '../utils/reportPresets';
import {
  CHART_COLORS,
  CHART_SERIES,
  CHART_GRID,
  CHART_AXIS_TICK,
  CHART_TOOLTIP_STYLE,
} from '../utils/chartTheme';

const SHARE_COLORS = CHART_COLORS;

/** Legend below the SVG so long labels never overlap the donut. */
function SharePieLegend({ items = [], colors = SHARE_COLORS }) {
  if (!items.length) return null;
  return (
    <ul className="pie-legend pie-legend-grid" aria-label="Chart legend">
      {items.map((entry, idx) => (
        <li key={`${entry.name}-${idx}`} className="pie-legend-item" title={entry.name}>
          <span
            className="pie-legend-swatch"
            style={{ background: colors[idx % colors.length] }}
            aria-hidden
          />
          <span className="pie-legend-label">{entry.name}</span>
        </li>
      ))}
    </ul>
  );
}

const PAGE_SIZE = 50;
const POLL_MS = 30 * 60 * 1000; // matches backend 30-min cache TTL

function money(v, currency = 'USD') {
  const sym = currency === 'INR' ? '\u20B9' : '$';
  const num = parseFloat(v || 0);
  return `${sym}${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function num(v) {
  return parseInt(v || 0).toLocaleString();
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function inventoryQueryFromApplied(applied) {
  const n = normalizeInventorySelections(applied || {}, {});
  return {
    domain: n.domain || [],
    site: n.site || [],
    domainName: n.domainName || [],
    domainId: n.domainId || [],
  };
}

function priorQueryKey(startDate, endDate, applied, compareStart, compareEnd) {
  const inv = inventoryQueryFromApplied(applied);
  return [
    startDate || '',
    endDate || '',
    compareStart || '',
    compareEnd || '',
    (inv.domain || []).join(','),
    (inv.site || []).join(','),
    (inv.domainName || []).join(','),
    (inv.domainId || []).join(','),
  ].join('|');
}

/** True when a chart series has at least one positive value to plot. */
function buildEngagementSeries(rows = []) {
  const map = new Map();
  rows.forEach((row) => {
    const date = readValue(row, ['date', 'report_date', 'DATE', 'reportDate', 'period'], ['day']) || 'Unknown';
    if (!date) return;
    const entry = map.get(date) || { date, impressions: 0, clicks: 0, unfilled: 0 };
    entry.impressions += toNumber(readValue(row, ['impression', 'impressions', 'total_line_item_level_impressions'], ['impressionsTotal']));
    entry.clicks += toNumber(readValue(row, ['clicks', 'click', 'total_line_item_level_clicks'], ['clicksTotal']));
    entry.unfilled += toNumber(readValue(row, ['unfilled', 'unfilled_impressions', 'total_inventory_level_unfilled_impressions'], ['unfilledImpressions']));
    const ctrRaw = toNumber(readValue(row, ['ctr', 'total_line_item_level_ctr'], ['clickThroughRate']));
    const fillRaw = toNumber(readValue(row, ['fillRate', 'fill_rate', 'adxMatchRate'], ['fillRatePercent']));
    if (ctrRaw > 0) entry._ctrSum = (entry._ctrSum || 0) + (ctrRaw > 1 ? ctrRaw : ctrRaw * 100);
    if (fillRaw > 0) entry._fillSum = (entry._fillSum || 0) + (fillRaw > 1 ? fillRaw : fillRaw * 100);
    entry._count = (entry._count || 0) + 1;
    map.set(date, entry);
  });

  const series = Array.from(map.values())
    .map((entry) => {
      const impressions = entry.impressions;
      const clicks = entry.clicks;
      const unfilled = entry.unfilled;
      const ctr = impressions > 0
        ? +((clicks / impressions) * 100).toFixed(2)
        : (entry._count ? +((entry._ctrSum || 0) / entry._count).toFixed(2) : 0);
      const fillRate = (impressions + unfilled) > 0
        ? +((impressions / (impressions + unfilled)) * 100).toFixed(2)
        : (entry._count ? +((entry._fillSum || 0) / entry._count).toFixed(2) : 0);
      return {
        date: entry.date,
        impressions,
        clicks,
        unfilled,
        ctr,
        fillRate,
      };
    })
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const hasSignal = series.some((item) => item.clicks > 0 || item.ctr > 0 || item.fillRate > 0 || item.unfilled > 0);
  return hasSignal ? series : [];
}

function hasChartData(series = [], valueKeys = ['value', 'revenue', 'impressions', 'ecpm', 'score']) {
  if (!Array.isArray(series) || !series.length) return false;
  return series.some((row) => {
    if (row == null || typeof row !== 'object') return toNumber(row) > 0;
    return valueKeys.some((k) => toNumber(row[k]) > 0);
  });
}

function readValue(row, keys = [], fallbackKeys = []) {
  if (!row || typeof row !== 'object') return null;
  const candidates = [...new Set([...keys, ...fallbackKeys].flatMap((key) => {
    const base = String(key || '').trim();
    return base ? [base, base.toLowerCase(), base.toUpperCase(), base.replace(/_/g, ' ')] : [];
  }))];

  const sources = [row, row.dimensions, row.metrics];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of candidates) {
      const value = source[key];
      if (value != null && value !== '' && value !== '—') return value;
    }
  }
  return null;
}

function resolveLabel(row, keys = []) {
  const value = readValue(row, keys, ['label', 'name', 'title', 'id', 'site', 'siteUrl', 'gamSite', 'domain', 'domainName', 'siteName', 'adUnitName', 'appName', 'mobileAppName', 'campaignName', 'lineItemName', 'country', 'countryName', 'device', 'deviceName', 'channel', 'demandChannelName', 'programmaticChannelName']);
  if (value == null || value === '' || value === '—') return 'Uncategorized';
  const normalized = String(value).trim();
  if (!normalized || ['unknown', 'n/a', 'na', 'undefined', 'null', 'unavailable'].includes(normalized.toLowerCase())) return 'Uncategorized';
  return normalized;
}

function buildDailySeries(rows = [], trend = []) {
  const map = new Map();
  const hasRowMetrics = rows.some((row) => {
    const impressions = toNumber(readValue(row, ['impression', 'impressions', 'total_line_item_level_impressions'], ['impressionsTotal']));
    const revenue = toNumber(readValue(row, ['revenue', 'total_line_item_level_cpm_and_cpc_revenue'], ['earnings']));
    return impressions > 0 || revenue > 0;
  });

  // Only seed from network trend when filtered rows themselves have metrics.
  if (hasRowMetrics) {
    trend.forEach((item) => {
      const date = readValue(item, ['date', 'report_date', 'DATE', 'reportDate', 'period'], ['day']) || 'Unknown';
      if (!date) return;
      const entry = map.get(date) || { date, revenue: 0, impressions: 0 };
      entry.revenue += toNumber(item.earning ?? item.revenue ?? item.value ?? item.totalRevenue ?? item.amount);
      map.set(date, entry);
    });
  }

  rows.forEach((row) => {
    const date = readValue(row, ['date', 'report_date', 'DATE', 'reportDate', 'period'], ['day']) || 'Unknown';
    if (!date) return;
    const entry = map.get(date) || { date, revenue: 0, impressions: 0 };
    entry.impressions += toNumber(readValue(row, ['impression', 'impressions', 'total_line_item_level_impressions'], ['impressionsTotal']) ?? readValue(row, ['metrics.total_line_item_level_impressions'], []));
    if (entry.revenue === 0) {
      entry.revenue += toNumber(readValue(row, ['revenue', 'total_line_item_level_cpm_and_cpc_revenue'], ['earnings']));
    }
    map.set(date, entry);
  });

  const series = Array.from(map.values()).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const hasSignal = series.some((item) => item.revenue > 0 || item.impressions > 0);
  return hasSignal ? series : [];
}

const SHARE_LABEL_FALLBACKS = {
  domain: ['gamDomain', 'DOMAIN', 'inv_domain'],
  site_name: ['siteName', 'siteUrl', 'gamSite', 'site', 'SITE_NAME'],
  ad_unit_name: ['adUnitName', 'ad_unit_name', 'AD_UNIT_NAME', 'site'],
  mobile_app_name: ['appName', 'mobileAppName', 'mobile_app_name', 'appId'],
  country_name: ['countryName', 'country', 'COUNTRY_NAME', 'COUNTRY', 'country_code', 'countryCode'],
  country: ['country_name', 'countryName', 'COUNTRY_NAME', 'COUNTRY'],
  COUNTRY_NAME: ['country_name', 'countryName', 'country'],
  device_category_name: ['DEVICE_CATEGORY_NAME', 'device', 'deviceCategory', 'mobile_device_name', 'deviceName'],
  DEVICE_CATEGORY_NAME: ['device_category_name', 'device', 'deviceCategory'],
  mobile_device_name: ['device_category_name', 'DEVICE_CATEGORY_NAME', 'device', 'deviceCategory', 'mobileDeviceName', 'deviceName', 'deviceType'],
  device: ['device_category_name', 'DEVICE_CATEGORY_NAME', 'deviceCategory', 'mobile_device_name'],
  programmatic_channel_name: ['programmaticChannelName', 'channel', 'trafficType', 'demandChannelName'],
  demand_channel_name: ['demandChannelName', 'channel', 'trafficType', 'programmaticChannelName'],
};

/** Map GAM device categories to Laptop / Mobile / Tablet for Device share. */
function friendlyDeviceName(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (/tablet|ipad/.test(s)) return 'Tablet';
  if (/smart.?phone|mobile|phone|feature.?phone|android|ios/.test(s)) return 'Mobile';
  if (/desktop|laptop|computer|pc|macintosh|windows/.test(s)) return 'Laptop';
  if (/connected.?tv|smart.?tv|set.?top|tv/.test(s)) return 'TV';
  return String(raw).trim();
}

/** Resolve a share-chart label using only the intended dimension keys (no cross-field bleed). */
function resolveShareLabel(row, keys = [], { deviceFriendly = false } = {}) {
  const expanded = [];
  (keys.length ? keys : ['domain', 'site', 'adUnitName', 'appName']).forEach((key) => {
    expanded.push(key);
    const extras = SHARE_LABEL_FALLBACKS[key];
    if (extras) expanded.push(...extras);
  });
  const value = readValue(row, expanded, []);
  if (value == null || value === '' || value === '—') return 'Uncategorized';
  const normalized = String(value).trim();
  if (!normalized || ['unknown', 'n/a', 'na', 'undefined', 'null', 'unavailable'].includes(normalized.toLowerCase())) {
    return 'Uncategorized';
  }
  if (deviceFriendly) return friendlyDeviceName(normalized) || normalized;
  return normalized;
}

function buildShareSeries(rows = [], keys = [], metricKey = 'revenue', opts = {}) {
  const limit = Math.max(1, Number(opts.topN) || 6);
  const allowed = Array.isArray(opts.allowedNames) && opts.allowedNames.length
    ? new Set(opts.allowedNames.map((n) => String(n || '').trim().toLowerCase()).filter(Boolean))
    : null;
  const totals = new Map();
  rows.forEach((row) => {
    const label = resolveShareLabel(row, keys, opts);
    if (!label || label === 'Uncategorized') return;
    if (allowed && !allowed.has(label.toLowerCase())) return;
    let value = 0;
    if (metricKey === 'revenue') {
      value = toNumber(readValue(row, ['revenue', 'total_line_item_level_cpm_and_cpc_revenue', 'earning'], ['revenueTotal']));
    } else if (metricKey === 'impressions') {
      value = toNumber(readValue(row, ['impression', 'impressions', 'total_line_item_level_impressions'], ['impressionsTotal']));
    }
    if (value <= 0) return;
    totals.set(label, (totals.get(label) || 0) + value);
  });
  const ranked = Array.from(totals.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
  // Show all when under the limit; otherwise top N + "Others".
  if (ranked.length <= limit) return ranked;
  const top = ranked.slice(0, limit);
  const rest = ranked.slice(limit).reduce((sum, item) => sum + item.value, 0);
  return rest > 0 ? [...top, { name: 'Others', value: rest }] : top;
}

/**
 * Revenue share by domain:
 * - fewer than 10 domains selected → show every selected domain
 * - 10 or more selected → show only the top 10 by revenue (no "Others")
 * - none selected → top 10 domains from the data
 */
function buildRevenueDomainShare(rows = [], selectedDomains = []) {
  const selected = (Array.isArray(selectedDomains) ? selectedDomains : [])
    .map((d) => String(d || '').trim())
    .filter(Boolean);
  const totals = new Map(); // lowercase → { name, value }

  rows.forEach((row) => {
    const label = resolveShareLabel(row, ['domain', 'inv_domain', 'gamDomain', 'DOMAIN']);
    if (!label || label === 'Uncategorized') return;
    const value = toNumber(readValue(row, ['revenue', 'total_line_item_level_cpm_and_cpc_revenue', 'earning'], ['revenueTotal']));
    if (value <= 0) return;
    const key = label.toLowerCase();
    const prev = totals.get(key) || { name: label, value: 0 };
    prev.value += value;
    totals.set(key, prev);
  });

  if (selected.length > 0) {
    const bySelection = selected.map((sel) => {
      const hit = totals.get(sel.toLowerCase());
      return { name: hit?.name || sel, value: hit?.value || 0 };
    });
    if (selected.length < 10) {
      // Show all selected domains (keep selection order).
      return bySelection;
    }
    // 10+: only top 10 by revenue among the selection.
    return bySelection
      .slice()
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
  }

  return Array.from(totals.values())
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);
}

function withDailyEcpm(series = []) {
  return (Array.isArray(series) ? series : []).map((item) => {
    const revenue = toNumber(item.revenue);
    const impressions = toNumber(item.impressions);
    return {
      ...item,
      revenue,
      impressions,
      ecpm: impressions > 0 ? +((revenue / impressions) * 1000).toFixed(2) : 0,
    };
  });
}

function buildSiteRevenueShare(rows = [], limit = 10) {
  return buildShareSeries(rows, [
    'site_name', 'siteName', 'gamSite', 'siteUrl', 'inv_site', 'SITE_NAME',
  ], 'revenue', { topN: limit });
}

function formatMetricValue(key, value, currency = 'USD') {
  if (key === 'ctr' || key === 'viewability') {
    const percent = value > 1 ? value : value * 100;
    return `${percent.toFixed(2)}%`;
  }
  if (key === 'ecpm') return money(value, currency);
  return `${Number(value || 0).toLocaleString()}`;
}

export default function Dashboard() {
  const dispatch = useDispatch();
  const { has, visibility: clientVis, user } = usePermissions();
  const canGenerate = has('canGenerateReports');
  const inventoryScope = getAssignedInventoryScope(user);
  const inventoryAssigned = hasAssignedInventory(user);
  const filterVisibility = getAssignedFilterVisibility(user);
  const savedRaw = useSelector((s) => s.reports?.dashboard);
  const saved = savedRaw?.userId === user?.id ? savedRaw : null;
  const { networkInfo } = useOutletContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const dateRestriction = useMemo(() => getDateRestriction(user), [user]);
  const todayInit = useMemo(() => defaultReportRangeForUser(user), [user]);
  const initDates = useMemo(() => initialReportDatesForUser(user, saved), [user, saved]);
  const visiblePresets = useMemo(
    () => (isFixedDateRestriction(dateRestriction)
      ? []
      : allowedDatePresets(dateRestriction, DATE_PRESETS)),
    [dateRestriction]
  );
  const dateFilterLocked = Boolean(isFixedDateRestriction(dateRestriction));
  const savedInv = saved ? {
    domain: saved.domain, site: saved.site, domainName: saved.domainName, domainId: saved.domainId,
  } : {};
  const invDraft = initialInventoryDraft(user, savedInv);
  const scopedAutoLoad = shouldAutoLoadScopedInventory(user);
  const defaultApplied = { ...todayInit, ...EMPTY_INVENTORY_FILTERS };
  const cacheFresh = isReportCacheFresh(saved, POLL_MS) && saved?.filterApplied;

  const [preset, setPreset] = useState(() => saved?.preset ?? 'today');
  const [startDate, setStartDate] = useState(() => initDates.startDate);
  const [endDate, setEndDate] = useState(() => initDates.endDate);
  const [domainName, setDomainName] = useState(() => (
    filterVisibility.isScopedUser ? invDraft.domainName : (saved?.domainName ?? invDraft.domainName)
  ));
  const [domainId, setDomainId] = useState(() => (
    filterVisibility.isScopedUser ? invDraft.domainId : (saved?.domainId ?? invDraft.domainId)
  ));
  const [domain, setDomain] = useState(() => (
    filterVisibility.isScopedUser ? invDraft.domain : (saved?.domain ?? invDraft.domain)
  ));
  const [site, setSite] = useState(() => (
    filterVisibility.isScopedUser ? invDraft.site : (saved?.site ?? invDraft.site)
  ));
  const [catalog, setCatalog] = useState([]);
  const [catalogLists, setCatalogLists] = useState({ domainRoots: [], siteHosts: [], sitesByDomain: {}, adUnitsByHost: {}, appIds: [] });
  const [noDomainsAssigned, setNoDomainsAssigned] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [applied, setApplied] = useState(() => {
    // Domain user: dates only — never restore auto-applied full inventory assignment.
    if (filterVisibility.isScopedUser) {
      return {
        ...defaultApplied,
        startDate: saved?.applied?.startDate || saved?.startDate || todayInit.startDate,
        endDate: saved?.applied?.endDate || saved?.endDate || todayInit.endDate,
      };
    }
    if (saved?.applied) return saved.applied;
    if (scopedAutoLoad) return buildScopedDashboardApplied(user, todayInit);
    return defaultApplied;
  });
  const [filterApplied, setFilterApplied] = useState(() => {
    if (filterVisibility.isScopedUser) return false;
    if (saved?.filterApplied != null) return saved.filterApplied;
    return scopedAutoLoad;
  });

  const [overviewData, setOverviewData] = useState(() => (
    filterVisibility.isScopedUser ? null : (saved?.overviewData ?? null)
  ));
  const [detailData, setDetailData] = useState(() => (
    filterVisibility.isScopedUser ? null : ((cacheFresh ? saved?.detailData : null) ?? null)
  ));
  const [priorOverview, setPriorOverview] = useState(null);
  const [priorDetail, setPriorDetail] = useState(null);
  const [overviewLoading, setOverviewLoading] = useState(() => (
    filterVisibility.isScopedUser ? true : !saved?.overviewData
  ));
  const [detailLoading, setDetailLoading] = useState(() => {
    if (filterVisibility.isScopedUser) return false;
    if (cacheFresh && saved?.filterApplied) return true;
    return scopedAutoLoad && canGenerate;
  });
  const [error, setError] = useState(null);
  const [page, setPage] = useState(() => saved?.page ?? 1);
  const [search, setSearch] = useState(() => saved?.search ?? '');
  const [lastUpdated, setLastUpdated] = useState(() => saved?.lastUpdated ?? null);
  const [fetchedAt, setFetchedAt] = useState(() => saved?.fetchedAt ?? null);
  const [breakdownOpen, setBreakdownOpen] = useState(() => saved?.breakdownOpen ?? true);
  const [chipsExpanded, setChipsExpanded] = useState(false);
  const [slowDetail, setSlowDetail] = useState(false);
  const [tableDensity, setTableDensity] = useState(() => {
    try {
      return localStorage.getItem('adnexus.tableDensity:dashboard') === 'compact' ? 'compact' : 'comfortable';
    } catch {
      return 'comfortable';
    }
  });
  const [trendMetric, setTrendMetric] = useState('all');
  const [compareMode, setCompareMode] = useState(() => loadComparePrefs(user?.id).mode);
  const [compareStart, setCompareStart] = useState(() => loadComparePrefs(user?.id).startDate);
  const [compareEnd, setCompareEnd] = useState(() => loadComparePrefs(user?.id).endDate);
  const [hiddenChartIds, setHiddenChartIds] = useState(() => loadHiddenDashCharts(user?.id));
  const [recentFilters, setRecentFilters] = useState(() => getRecentFilters(user?.id));
  const isNarrow = useMedia('(max-width: 768px)');
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(true);
  const pollRef = useRef(null);
  const filterPanelRef = useRef(null);
  const skipDetailRef = useRef(cacheFresh && saved?.filterApplied);
  const slowTimerRef = useRef(null);
  const detailAbortRef = useRef(null);
  const overviewAbortRef = useRef(null);
  const shareHydratedRef = useRef(false);
  const undoSnapRef = useRef(null);
  const skipPrefsSaveRef = useRef(true);

  useEffect(() => {
    skipPrefsSaveRef.current = true;
    setRecentFilters(getRecentFilters(user?.id));
    const prefs = loadComparePrefs(user?.id);
    setCompareMode(prefs.mode);
    setCompareStart(prefs.startDate);
    setCompareEnd(prefs.endDate);
    setHiddenChartIds(loadHiddenDashCharts(user?.id));
  }, [user?.id]);

  useEffect(() => {
    if (skipPrefsSaveRef.current) {
      skipPrefsSaveRef.current = false;
      return;
    }
    saveComparePrefs(user?.id, { mode: compareMode, startDate: compareStart, endDate: compareEnd });
    saveHiddenDashCharts(user?.id, hiddenChartIds);
  }, [user?.id, compareMode, compareStart, compareEnd, hiddenChartIds]);

  useEffect(() => {
    try {
      localStorage.setItem('adnexus.tableDensity:dashboard', tableDensity);
    } catch {
      /* ignore */
    }
  }, [tableDensity]);

  useEffect(() => {
    setMobileFiltersOpen(!isNarrow);
  }, [isNarrow]);

  useEffect(() => {
    if (shareHydratedRef.current) return;
    shareHydratedRef.current = true;
    const viewId = searchParams.get('view');
    if (viewId) {
      const found = getSavedFilters(SAVED_FILTERS_PAGES.dashboard, user?.id).find((f) => f.id === viewId);
      if (found?.snapshot) {
        const snap = found.snapshot;
        if (snap.domain) setDomain(snap.domain);
        if (snap.site) setSite(snap.site);
        if (snap.domainName) setDomainName(snap.domainName);
        if (snap.domainId) setDomainId(snap.domainId);
      }
    }
    const shared = parseReportShare(searchParams);
    if (shared) {
      if (shared.preset && shared.preset !== 'custom') {
        const r = clampPresetRange(shared.preset, dateRestriction);
        setPreset(shared.preset);
        setStartDate(r.startDate);
        setEndDate(r.endDate);
        setApplied((prev) => ({
          ...prev,
          startDate: r.startDate,
          endDate: r.endDate,
          domain: shared.domain?.length ? shared.domain : prev.domain,
          site: shared.site?.length ? shared.site : prev.site,
          domainName: shared.domainName?.length ? shared.domainName : prev.domainName,
          domainId: shared.domainId?.length ? shared.domainId : prev.domainId,
        }));
        if (shared.domain?.length) setDomain(shared.domain);
        if (shared.site?.length) setSite(shared.site);
        if (shared.domainName?.length) setDomainName(shared.domainName);
        if (shared.domainId?.length) setDomainId(shared.domainId);
        setFilterApplied(true);
        return;
      }
      if (shared.startDate && shared.endDate) {
        const r = clampDateRange(shared.startDate, shared.endDate, dateRestriction);
        setPreset(shared.preset || 'custom');
        setStartDate(r.startDate);
        setEndDate(r.endDate);
        setApplied((prev) => ({
          ...prev,
          ...r,
          domain: shared.domain?.length ? shared.domain : prev.domain,
          site: shared.site?.length ? shared.site : prev.site,
          domainName: shared.domainName?.length ? shared.domainName : prev.domainName,
          domainId: shared.domainId?.length ? shared.domainId : prev.domainId,
        }));
        if (shared.domain?.length) setDomain(shared.domain);
        if (shared.site?.length) setSite(shared.site);
        if (shared.domainName?.length) setDomainName(shared.domainName);
        if (shared.domainId?.length) setDomainId(shared.domainId);
        setFilterApplied(true);
      }
      return;
    }
    if (viewId) return;
    const last = getLastPageFilters(LAST_FILTER_PAGES.dashboard, user?.id);
    if (!last?.startDate || !last?.endDate) return;
    const r = clampDateRange(last.startDate, last.endDate, dateRestriction);
    setPreset(last.preset || 'custom');
    setStartDate(r.startDate);
    setEndDate(r.endDate);
    if (last.domain?.length) setDomain(last.domain);
    if (last.site?.length) setSite(last.site);
    if (last.domainName?.length) setDomainName(last.domainName);
    if (last.domainId?.length) setDomainId(last.domainId);
    setApplied((prev) => ({
      ...prev,
      ...r,
      domain: last.domain?.length ? last.domain : prev.domain,
      site: last.site?.length ? last.site : prev.site,
      domainName: last.domainName?.length ? last.domainName : prev.domainName,
      domainId: last.domainId?.length ? last.domainId : prev.domainId,
    }));
  }, [searchParams, user?.id, dateRestriction]);

  useEffect(() => {
    const onCleared = () => setRecentFilters([]);
    window.addEventListener(RECENT_FILTERS_CLEARED_EVENT, onCleared);
    return () => window.removeEventListener(RECENT_FILTERS_CLEARED_EVENT, onCleared);
  }, []);

  useEffect(() => {
    if (!dateRestriction) return;
    if (dateFilterLocked) {
      setStartDate(dateRestriction.startDate);
      setEndDate(dateRestriction.endDate);
      return;
    }
    if (!isCustomRangeIncomplete(preset, startDate, endDate)) {
      const r = clampDateRange(startDate, endDate, dateRestriction);
      if (r.startDate !== startDate || r.endDate !== endDate) {
        setStartDate(r.startDate);
        setEndDate(r.endDate);
      }
    }
    if (!isPresetAllowedForRestriction(preset, dateRestriction) && preset !== 'custom') {
      setPreset('custom');
    }
  }, [dateRestriction, dateFilterLocked]);

  const inventoryDraft = useMemo(
    () => ({ domain, site, domainName, domainId }),
    [domain, site, domainName, domainId]
  );
  const canApplyInventory = !filterVisibility.isScopedUser
    || draftHasInventorySelection(inventoryDraft);
  const customDatesIncomplete = isCustomRangeIncomplete(preset, startDate, endDate);

  const buildOverviewFiltersForState = useCallback((appliedSnapshot, filterAppliedSnapshot) => {
    const dates = committedReportDates({
      preset,
      filterApplied: filterAppliedSnapshot,
      applied: appliedSnapshot,
      startDate: appliedSnapshot?.startDate ?? startDate,
      endDate: appliedSnapshot?.endDate ?? endDate,
      fallback: todayInit,
    });
    if (!filterAppliedSnapshot || !hasInventoryFilterSelection(appliedSnapshot)) {
      return dates;
    }
    const normalized = normalizeInventorySelections(appliedSnapshot || {}, {});
    const { domain, site, domainName, domainId } = normalized;
    if (!domain?.length && !site?.length && !domainName?.length && !domainId?.length) {
      return dates;
    }
    return { ...dates, domain, site, domainName, domainId };
  }, [preset, startDate, endDate, todayInit]);

  // Overview KPIs: full assigned scope by default; after Apply Filter, same inventory filters as chart/table.
  const overviewFilters = useMemo(
    () => buildOverviewFiltersForState(applied, filterApplied),
    [applied, filterApplied, buildOverviewFiltersForState]
  );

  const loadOverview = useCallback(async (filtersOverride, silent = false) => {
    const filters = filtersOverride ?? overviewFilters;
    if (overviewAbortRef.current) overviewAbortRef.current.abort();
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    overviewAbortRef.current = ac;
    if (!silent) setOverviewLoading(true);
    setError(null);
    try {
      const res = await reportsAPI.getDashboardOverview(filters, ac ? { signal: ac.signal } : {});
      if (ac?.signal?.aborted) return;
      setOverviewData(res);
      setLastUpdated(nowTimeInTZ());
    } catch (err) {
      if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError' || ac?.signal?.aborted) return;
      logErrorForDebug(err, 'Dashboard overview');
      setError(getUserFacingMessage(err, 'Could not load overview metrics. Please try again.'));
    } finally {
      if (!silent && overviewAbortRef.current === ac) setOverviewLoading(false);
    }
  }, [overviewFilters]);

  const currency = overviewData?.summary?.currency || overviewData?.currency
    || detailData?.summary?.currency || networkInfo?.currencyCode || 'USD';

  /** Network + filtered charts — load for current dates; inventory filters refine. */
  const loadDetail = useCallback(async (silent = false) => {
    if (detailAbortRef.current) detailAbortRef.current.abort();
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    detailAbortRef.current = ac;
    if (!silent) {
      setDetailLoading(true);
      setSlowDetail(false);
      clearTimeout(slowTimerRef.current);
      slowTimerRef.current = setTimeout(() => setSlowDetail(true), 4000);
    }
    setError(null);
    try {
      const dates = {
        startDate: applied?.startDate || startDate,
        endDate: applied?.endDate || endDate,
      };
      // Compact dashboard payload (SQL charts + capped table). Do NOT request allRows —
      // wide ranges were shipping 100k–700k grain rows and freezing the UI.
      const res = await reportsAPI.getDashboard({
        ...dates,
        ...normalizeInventorySelections(applied || {}, {}),
      }, ac ? { signal: ac.signal } : {});
      if (ac?.signal?.aborted) return;
      startTransition(() => {
        setDetailData(res);
        setLastUpdated(nowTimeInTZ());
        setFetchedAt(Date.now());
      });
    } catch (err) {
      if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError' || ac?.signal?.aborted) return;
      logErrorForDebug(err, 'Dashboard detail');
      const status = err?.status ?? err?.response?.status ?? null;
      // Auth/permission / timeout / server errors — show error. Only treat empty
      // filter combos (2xx with empty body is handled above) as warn card.
      if (
        status === 401
        || status === 403
        || status === 503
        || status === 502
        || status === 504
        || status === 500
        || err?.isTimeout
        || err?.code === 'ECONNABORTED'
        || err?.code === 'ERR_NETWORK'
      ) {
        setError(getUserFacingMessage(
          err,
          'Could not load the chart and breakdown table. Try Apply Filter again or use a shorter date range.'
        ));
        setDetailData(null);
      } else {
        setError(null);
        const skipped = [];
        if (applied?.domain?.length) skipped.push('Domain name');
        if (applied?.site?.length) skipped.push('Site');
        if (applied?.domainName?.length) skipped.push('Ad Unit');
        if (applied?.domainId?.length) skipped.push('App ID');
        startTransition(() => {
          setDetailData({
            rows: [],
            summary: { impressions: 0, revenue: 0, ecpm: 0, viewability: 0 },
            trend: [],
            charts: { revenue: [], device: [], country: [], performance: [] },
            reportWarning: 'incompatible',
            reportWarningSkipped: skipped,
          });
          setLastUpdated(nowTimeInTZ());
          setFetchedAt(Date.now());
        });
      }
    } finally {
      if (!silent && detailAbortRef.current === ac) {
        setDetailLoading(false);
        setSlowDetail(false);
        clearTimeout(slowTimerRef.current);
      }
    }
  }, [applied, startDate, endDate]);

  useEffect(() => () => {
    detailAbortRef.current?.abort();
    overviewAbortRef.current?.abort();
    clearTimeout(slowTimerRef.current);
  }, []);

  useEffect(() => {
    if (filterApplied && hasInventoryFilterSelection(applied)) return;
    loadOverview();
  }, [loadOverview, filterApplied, applied]);

  useEffect(() => {
    if (!canGenerate) return;
    if (isCustomRangeIncomplete(preset, startDate, endDate)) return;
    if (skipDetailRef.current) {
      skipDetailRef.current = false;
      return;
    }
    loadDetail();
    setPage(1);
  }, [filterApplied, applied, loadDetail, canGenerate, preset, startDate, endDate]);

  const compareRange = useMemo(
    () => resolveCompareRange(
      compareMode,
      applied?.startDate || startDate,
      applied?.endDate || endDate,
      { startDate: compareStart, endDate: compareEnd }
    ),
    [compareMode, applied?.startDate, applied?.endDate, startDate, endDate, compareStart, compareEnd]
  );
  const compareLabel = compareLabelFor(compareMode, compareRange);

  const compareKey = priorQueryKey(
    applied?.startDate || startDate,
    applied?.endDate || endDate,
    applied,
    compareRange?.startDate,
    compareRange?.endDate
  );

  useEffect(() => {
    if (!canGenerate) {
      setPriorOverview(null);
      setPriorDetail(null);
      return undefined;
    }
    const prior = compareRange;
    if (!prior || !isPeriodAllowed(prior, dateRestriction)) {
      setPriorOverview(null);
      setPriorDetail(null);
      return undefined;
    }
    setPriorOverview(null);
    setPriorDetail(null);
    let cancelled = false;
    (async () => {
      const inv = inventoryQueryFromApplied(applied);
      const priorFilters = {
        ...inv,
        startDate: prior.startDate,
        endDate: prior.endDate,
      };
      try {
        const ov = await reportsAPI.getDashboardOverview(priorFilters);
        if (!cancelled) setPriorOverview(ov);
      } catch {
        /* keep last successful compare if this retry fails */
      }
      try {
        const dash = await reportsAPI.getDashboard(priorFilters);
        if (!cancelled) {
          setPriorDetail(dash);
          if (dash?.summary) setPriorOverview((prev) => prev || { summary: dash.summary });
        }
      } catch {
        /* keep last successful compare */
      }
    })();
    return () => { cancelled = true; };
  }, [canGenerate, compareKey, dateRestriction, compareRange, applied]);

  useEffect(() => {
    if (!overviewData && !detailData) return;
    if (!canGenerate && !overviewData) return;
    const slimApplied = slimFiltersForPersist(applied || {});
    const slimDraft = slimFiltersForPersist({ domain, site, domainName, domainId });
    dispatch(saveReportPage({
      pageKey: 'dashboard',
      payload: {
        userId: user?.id,
        applied: slimApplied,
        filterApplied,
        // Do not persist huge row catalogs / detail payloads — they freeze sessionStorage.
        overviewData: overviewData
          ? { summary: overviewData.summary, visibility: overviewData.visibility, isMock: overviewData.isMock }
          : null,
        detailData: null,
        catalog: [],
        fetchedAt,
        lastUpdated,
        preset,
        startDate,
        endDate,
        ...slimDraft,
        search,
        page,
        breakdownOpen,
        chipsExpanded,
      },
    }));
  }, [
    dispatch, user?.id, applied, filterApplied, overviewData, detailData, catalog, fetchedAt, lastUpdated,
    preset, startDate, endDate, domain, site, domainName, domainId,
    search, page, breakdownOpen, chipsExpanded, canGenerate,
  ]);

  const applyCatalogResponse = useCallback((res) => {
    if (res?.rows?.length) setCatalog(res.rows);
    if (Array.isArray(res?.domainRoots) || Array.isArray(res?.siteHosts) || res?.sitesByDomain || res?.adUnitsByHost || res?.appPackages) {
      setCatalogLists({
        domainRoots: res.domainRoots || [],
        siteHosts: res.siteHosts || [],
        sitesByDomain: res.sitesByDomain || {},
        adUnitsByHost: res.adUnitsByHost || {},
        appIds: (res.appPackages || []).filter((id) => id && id !== '—'),
      });
    }
    if (typeof res?.noDomainsAssigned === 'boolean') setNoDomainsAssigned(res.noDomainsAssigned);
  }, []);

  const loadCatalog = useCallback(async (force = false) => {
    // Domain users: options come from assigned permissions already on the user — no network catalog wait.
    if (filterVisibility.isScopedUser) {
      setCatalogLoading(false);
      return;
    }
    if (!force && catalog.length) return;
    setCatalogLoading(true);
    try {
      const res = await reportsAPI.getFilterCatalog();
      applyCatalogResponse(res);
    } catch (_) { /* filter options optional until opened */ }
    finally { setCatalogLoading(false); }
  }, [catalog.length, applyCatalogResponse, filterVisibility.isScopedUser]);

  useEffect(() => {
    if (!canGenerate) return;
    if (filterVisibility.isScopedUser) {
      setCatalogLoading(false);
      return;
    }
    loadCatalog(true);
  }, [canGenerate, loadCatalog, filterVisibility.isScopedUser]);

  const selections = useMemo(
    () => ({
      domain: isAllSelection(domain) ? [] : (domain || []).filter((v) => v !== ALL_SENTINEL),
      site: isAllSelection(site) ? [] : (site || []).filter((v) => v !== ALL_SENTINEL),
      adUnit: isAllSelection(domainName) ? [] : (domainName || []).filter((v) => v !== ALL_SENTINEL),
      app: isAllSelection(domainId) ? [] : (domainId || []).filter((v) => v !== ALL_SENTINEL),
    }),
    [domain, site, domainName, domainId]
  );
  const { domainOptions: domainRootOptions, siteOptions, adUnitOptions, appOptions } = useMemo(
    () => buildFilterDropdownOptions({
      catalog,
      selections,
      domainRoots: catalogLists.domainRoots,
      siteHosts: catalogLists.siteHosts,
      sitesByDomain: catalogLists.sitesByDomain,
      adUnitsByHost: catalogLists.adUnitsByHost,
      selectedDomains: isAllSelection(domain) ? [] : domain,
      inventoryScope,
      independentAssignment: true,
      allowedDomains: inventoryScope?.allowedDomains ?? null,
      appIds: catalogLists.appIds,
    }),
    [catalog, selections, catalogLists, domain, inventoryScope, filterVisibility.isScopedUser]
  );
  // Domain users already have lists on the session — never show catalog "Loading…"
  const catalogBusy = !filterVisibility.isScopedUser && catalogLoading;

  const showNoDomainsNote = !isAdmin(user) && !inventoryAssigned;

  const handleDomainChange = useCallback((nextDomain) => {
    setDomain(nextDomain);
  }, []);

  const handleSiteChange = useCallback((nextSite) => {
    setSite(nextSite);
  }, []);

  const handleAdUnitChange = useCallback((nextAdUnit) => {
    setDomainName(nextAdUnit);
  }, []);

  const handleAppChange = useCallback((nextApp) => {
    setDomainId(nextApp);
  }, []);

  useEffect(() => {
    const overviewEmpty = !(
      (Number(overviewData?.summary?.impressions) || 0) > 0
      || (Number(overviewData?.summary?.revenue) || 0) > 0
    );
    const detailEmpty = !(
      (Number(detailData?.summary?.impressions) || 0) > 0
      || (Number(detailData?.summary?.revenue) || 0) > 0
    );
    const waitingOnSync = (
      (overviewData?.status === 'building' && overviewEmpty)
      || (detailData?.status === 'building' && detailEmpty)
    );
    const intervalMs = waitingOnSync ? 12_000 : POLL_MS;
    pollRef.current = setInterval(() => {
      if (!(filterApplied && hasInventoryFilterSelection(applied))) {
        loadOverview(undefined, true);
      }
      if (canGenerate && filterApplied) loadDetail(true);
    }, intervalMs);
    return () => clearInterval(pollRef.current);
  }, [
    loadOverview,
    loadDetail,
    filterApplied,
    applied,
    canGenerate,
    overviewData?.status,
    overviewData?.summary?.impressions,
    overviewData?.summary?.revenue,
    detailData?.status,
    detailData?.summary?.impressions,
    detailData?.summary?.revenue,
  ]);

  const applyPreset = (p) => {
    if (dateFilterLocked) return;
    if (dateRestriction && !isPresetAllowedForRestriction(p, dateRestriction)) return;
    setPreset(p);
    if (p === 'custom') {
      setStartDate('');
      setEndDate('');
      setBreakdownOpen(true);
      loadCatalog(true);
      return;
    }
    // Predefined range: update dates AND applied immediately → auto-triggers loadDetail + loadOverview.
    const r = clampPresetRange(p, dateRestriction);
    setStartDate(r.startDate);
    setEndDate(r.endDate);
    setPage(1);
    setChipsExpanded(false);
    setOverviewData(null);
    setDetailData(null);
    if (scopedAutoLoad) {
      setApplied(buildScopedDashboardApplied(user, r));
      setFilterApplied(true);
    } else {
      setApplied(prev => ({ ...prev, startDate: r.startDate, endDate: r.endDate }));
      if (!filterVisibility.isScopedUser) {
        setFilterApplied(true);
      } else if (filterApplied && draftHasInventorySelection(inventoryDraft)) {
        setFilterApplied(true);
      }
    }
  };

  const persistRecentFilter = useCallback(() => {
    const snapshot = slimFiltersForPersist({
      preset,
      startDate,
      endDate,
      domain,
      site,
      domainName,
      domainId,
      country: [],
    });
    setRecentFilters(saveRecentFilter(snapshot, user?.id));
  }, [preset, startDate, endDate, domain, site, domainName, domainId, user?.id]);

  const getSavedFilterSnapshot = useCallback(() => slimFiltersForPersist({
    domain,
    site,
    domainName,
    domainId,
  }), [domain, site, domainName, domainId]);

  const getPresetSnapshot = useCallback(() => filtersOnlySnapshot({
    domain: applied?.domain || domain,
    site: applied?.site || site,
    domainName: applied?.domainName || domainName,
    domainId: applied?.domainId || domainId,
  }), [
    applied, domain, site, domainName, domainId,
  ]);

  const handleApplySavedFilter = useCallback((snapshot) => {
    const nextDomain = snapshot.domain || [];
    const nextSite = snapshot.site || [];
    const nextDomainName = snapshot.domainName || [];
    const nextDomainId = snapshot.domainId || [];
    setDomain(nextDomain);
    setSite(nextSite);
    setDomainName(nextDomainName);
    setDomainId(nextDomainId);
    setPage(1);
    setChipsExpanded(false);
    setBreakdownOpen(true);
    setOverviewData(null);
    setDetailData(null);
    // Keep the user's current date range — saved filters never restore dates.
    setApplied((prev) => ({
      ...prev,
      startDate,
      endDate,
      domain: nextDomain,
      site: nextSite,
      domainName: nextDomainName,
      domainId: nextDomainId,
    }));
    setFilterApplied(true);
  }, [startDate, endDate]);

  const applyFilter = () => {
    if (!canApplyInventory) return;
    if (customDatesIncomplete) return;
    const dates = clampDateRange(startDate, endDate, dateRestriction);
    setStartDate(dates.startDate);
    setEndDate(dates.endDate);
    setPage(1);
    setDetailData(null);
    setOverviewData(null);
    // Keep Select-All sentinel in UI state; API calls normalize it to [] (no filter).
    const nextApplied = { ...dates, domainName, domainId, domain, site };
    setApplied(nextApplied);
    setFilterApplied(true);
    persistRecentFilter();
    saveLastPageFilters(LAST_FILTER_PAGES.dashboard, {
      preset,
      startDate: dates.startDate,
      endDate: dates.endDate,
      domain,
      site,
      domainName,
      domainId,
    }, user?.id);
    setBreakdownOpen(true);
    setChipsExpanded(false);
    loadCatalog(true);
    const apiFilters = normalizeInventorySelections(nextApplied, {
      domainOptions: domainRootOptions,
      siteOptions,
      adUnitOptions,
      appOptions,
    });
    if (!hasInventoryFilterSelection(apiFilters) && isAdmin(user)) {
      loadOverview(buildOverviewFiltersForState(apiFilters, true));
    }
    const qs = encodeReportShare({
      preset,
      startDate: dates.startDate,
      endDate: dates.endDate,
      domain,
      site,
      domainName,
      domainId,
    });
    setSearchParams(qs ? new URLSearchParams(qs) : {}, { replace: true });
    const rangeLabel = dates.startDate === dates.endDate
      ? dates.startDate
      : `${dates.startDate} → ${dates.endDate}`;
    showToast({ message: `Loaded ${rangeLabel}` });
  };

  const appliedChips = useMemo(
    () => (filterApplied ? buildAppliedFilterChips(applied, {
      domainOptions: domainRootOptions,
      siteOptions,
      adUnitOptions,
      appOptions,
    }) : []),
    [filterApplied, applied, domainRootOptions, siteOptions, adUnitOptions, appOptions]
  );

  const handleAddFilter = useCallback(() => {
    const needsReveal = !breakdownOpen || (isNarrow && !mobileFiltersOpen);
    setMobileFiltersOpen(true);
    setBreakdownOpen(true);
    loadCatalog(true);
    window.setTimeout(() => {
      const section = document.getElementById('dash-inventory-filters');
      if (!section) {
        filterPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      section.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const control = section.querySelector('.ms-control:not([disabled])');
      if (control && !section.querySelector('.ms-is-open')) {
        control.focus();
        control.click();
      }
    }, needsReveal ? 120 : 0);
  }, [breakdownOpen, isNarrow, mobileFiltersOpen, loadCatalog]);

  const handleRemoveChip = useCallback((chip) => {
    if (chip.field === 'date') {
      const r = defaultReportRangeForUser(user);
      setPreset('today');
      setStartDate(r.startDate);
      setEndDate(r.endDate);
      const nextApplied = { ...applied, startDate: r.startDate, endDate: r.endDate };
      setApplied(nextApplied);
      setOverviewData(null);
      loadOverview(buildOverviewFiltersForState(nextApplied, filterApplied));
      return;
    }
    const draft = { startDate, endDate, domain, site, domainName, domainId };
    const { nextApplied, nextDraft } = removeFilterChip(applied, draft, chip, {
      domainOptions: domainRootOptions,
      siteOptions,
      adUnitOptions,
      appOptions,
    });
    setDomain(nextDraft.domain || []);
    setSite(nextDraft.site || []);
    setDomainName(nextDraft.domainName || []);
    setDomainId(nextDraft.domainId || []);
    setApplied(nextApplied);
    setOverviewData(null);
    if (!hasInventoryFilterSelection(nextApplied)) {
      loadOverview(buildOverviewFiltersForState(nextApplied, filterApplied));
    }
  }, [
    startDate, endDate, domain, site, domainName, domainId, applied, user,
    filterApplied, buildOverviewFiltersForState, loadOverview,
    domainRootOptions, siteOptions, adUnitOptions, appOptions,
  ]);

  const reset = () => {
    undoSnapRef.current = {
      preset,
      startDate,
      endDate,
      domain,
      site,
      domainName,
      domainId,
      applied,
      filterApplied,
    };
    const r = defaultReportRangeForUser(user);
    setPreset('today');
    setStartDate(r.startDate);
    setEndDate(r.endDate);
    setDomainName([]);
    setDomainId([]);
    setDomain([]);
    setSite([]);
    setSearch('');
    setBreakdownOpen(filterVisibility.isScopedUser);
    setChipsExpanded(false);
    setFilterApplied(false);
    setDetailData(null);
    setOverviewData(null);
    setPriorOverview(null);
    setPriorDetail(null);
    setFetchedAt(null);
    clearRecentFilters(user?.id);
    setRecentFilters([]);
    dispatch(saveReportPage({ pageKey: 'dashboard', payload: null }));
    setApplied({ ...r, ...EMPTY_INVENTORY_FILTERS });
    setSearchParams({}, { replace: true });
    showToast({
      message: 'Filters cleared',
      actionLabel: 'Undo',
      onAction: () => {
        const snap = undoSnapRef.current;
        if (!snap) return;
        setPreset(snap.preset);
        setStartDate(snap.startDate);
        setEndDate(snap.endDate);
        setDomain(snap.domain || []);
        setSite(snap.site || []);
        setDomainName(snap.domainName || []);
        setDomainId(snap.domainId || []);
        setApplied(snap.applied);
        setFilterApplied(snap.filterApplied);
      },
    });
  };

  const handleCopyLink = async () => {
    await copyReportLink({
      preset,
      startDate: applied?.startDate || startDate,
      endDate: applied?.endDate || endDate,
      domain: applied?.domain || domain,
      site: applied?.site || site,
      domainName: applied?.domainName || domainName,
      domainId: applied?.domainId || domainId,
    });
    showToast({ message: 'Link copied — opens this exact report' });
  };

  const vis = {
    ...clientVis,
    ...(overviewData?.visibility || detailData?.visibility || {}),
  };
  const canFilter = vis.filters !== false;

  useReportHotkeys({
    enabled: canGenerate && canFilter,
    onApply: () => {
      if (customDatesIncomplete) return;
      if (!canApplyInventory) return;
      applyFilter();
    },
    onReset: reset,
  });

  const hasInventoryFilter = filterApplied && hasInventoryFilterSelection(applied);
  const isScopedDashboardUser = !isAdmin(user);

  const mapDetailSummary = useCallback((s) => {
    if (!s) return null;
    return {
      impressions: s.impressions ?? 0,
      revenue: s.revenue ?? s.selectRange ?? 0,
      ecpm: s.ecpm ?? 0,
      viewability: s.viewability ?? 0,
      impressionsChange: s.impressionsChange ?? 0,
      revenueChange: s.revenueChange ?? 0,
      ecpmChange: s.ecpmChange ?? 0,
      viewabilityChange: s.viewabilityChange ?? 0,
      currency: s.currency || currency,
    };
  }, [currency]);

  const tableConfig = useMemo(
    () => resolveDashboardTableConfig(applied, filterApplied),
    [applied, filterApplied]
  );

  const tableColumns = useMemo(
    () => buildReportColumns(tableConfig.dimensions, tableConfig.metrics, vis),
    [tableConfig, vis]
  );

  const tableRows = useMemo(() => {
    if (!detailData) return [];
    const raw = detailData?.rows || [];
    const enriched = enrichReportRows(raw, tableConfig.dimensions, tableConfig.metrics, { useProxy: false });
    return aggregateRowsByColumns(enriched, tableColumns);
  }, [detailData, tableConfig, tableColumns]);

  const tableSummaryTotals = useMemo(() => {
    const hasConcreteSite = applied?.site?.length && !isAllSelection(applied.site);
    const truncated = detailData?.pagination?.truncated;
    const fromRows = tableRows.length ? summarizeRowsForOverview(tableRows, currency) : null;
    const s = detailData?.summary;
    // Prefer summing table rows for site filters so Total matches the breakdown.
    // Only fall back to API summary when the table was capped (incomplete).
    if (hasConcreteSite && fromRows && truncated !== true) {
      return {
        total_line_item_level_all_revenue: fromRows.revenue,
        total_line_item_level_impressions: fromRows.impressions,
        total_line_item_level_without_cpd_average_ecpm: fromRows.ecpm,
        total_active_view_viewable_impressions_rate: fromRows.viewability,
      };
    }
    if (!s) {
      if (!fromRows) return null;
      return {
        total_line_item_level_all_revenue: fromRows.revenue,
        total_line_item_level_impressions: fromRows.impressions,
        total_line_item_level_without_cpd_average_ecpm: fromRows.ecpm,
        total_active_view_viewable_impressions_rate: fromRows.viewability,
      };
    }
    const apiRev = Number(s.revenue ?? s.selectRange ?? 0) || 0;
    const apiImp = Number(s.impressions ?? 0) || 0;
    const apiEcpm = Number(s.ecpm ?? 0) || 0;
    // Guard against bad long-range coercion ($4.50 revenue / $0 eCPM with huge imps).
    if (
      fromRows
      && apiImp > 0
      && fromRows.revenue > 0
      && apiRev > 0
      && apiRev < fromRows.revenue * 0.01
      && (apiEcpm <= 0 || apiRev < 100)
    ) {
      return {
        total_line_item_level_all_revenue: fromRows.revenue,
        total_line_item_level_impressions: fromRows.impressions,
        total_line_item_level_without_cpd_average_ecpm: fromRows.ecpm,
        total_active_view_viewable_impressions_rate: fromRows.viewability,
      };
    }
    return {
      total_line_item_level_all_revenue: apiRev,
      total_line_item_level_impressions: apiImp,
      total_line_item_level_without_cpd_average_ecpm: apiEcpm,
      total_active_view_viewable_impressions_rate: s.viewability ?? 0,
    };
  }, [
    detailData?.summary,
    detailData?.pagination?.truncated,
    applied?.site,
    tableRows,
    currency,
  ]);

  const overviewSummary = useMemo(() => {
    const fromDetail = mapDetailSummary(detailData?.summary);
    const fromRows = tableRows.length ? summarizeRowsForOverview(tableRows, currency) : null;
    let base = {};

    if (isScopedDashboardUser) {
      if (hasInventoryFilter) {
        if (fromDetail && !detailLoading) base = fromDetail;
        else if (fromDetail) base = fromDetail;
        else if (fromRows) base = fromRows;
        else base = {};
      } else {
        base = overviewData?.summary || {};
      }
    } else if (hasInventoryFilter && fromDetail && !detailLoading) {
      base = fromDetail;
    } else if (hasInventoryFilter && detailData) {
      base = fromDetail || fromRows || {};
    } else {
      base = overviewData?.summary || {};
    }

    // If API summary was mangled (tiny revenue / $0 eCPM) while table rows look sane, prefer rows.
    const apiRev = Number(base.revenue ?? base.selectRange ?? 0) || 0;
    const apiEcpm = Number(base.ecpm ?? 0) || 0;
    if (
      fromRows
      && fromRows.revenue > 0
      && apiRev > 0
      && apiRev < fromRows.revenue * 0.01
      && (apiEcpm <= 0 || apiRev < 100)
    ) {
      base = { ...base, ...fromRows };
    }

    const priorSum = priorDetail?.summary || priorOverview?.summary || null;
    return withPeriodDeltas(base, priorSum);
  }, [
    isScopedDashboardUser,
    filterApplied,
    hasInventoryFilter,
    detailLoading,
    detailData,
    tableRows,
    currency,
    overviewData,
    mapDetailSummary,
    priorOverview,
    priorDetail,
  ]);

  const overviewCardLoading = useMemo(() => {
    if (isScopedDashboardUser) {
      if (hasInventoryFilter) return detailLoading || !detailData;
      return overviewLoading || !overviewData?.summary;
    }
    if (hasInventoryFilter) return detailLoading || !detailData;
    return overviewLoading || !overviewData?.summary;
  }, [
    isScopedDashboardUser,
    filterApplied,
    hasInventoryFilter,
    detailLoading,
    detailData,
    overviewLoading,
    overviewData,
  ]);

  const enrichedRows = useMemo(() => {
    const rows = Array.isArray(detailData?.rows) ? detailData.rows : [];
    return enrichReportRows(rows, [
      'date',
      'domain',
      'site_name',
      'ad_unit_name',
      'mobile_app_name',
      'country_name',
      'device_category_name',
      'mobile_device_name',
      'programmatic_channel_name',
      'demand_channel_name',
    ], [
      'total_line_item_level_cpm_and_cpc_revenue',
      'total_line_item_level_impressions',
      'total_line_item_level_ctr',
      'total_line_item_level_clicks',
      'total_inventory_level_unfilled_impressions',
      'total_line_item_level_without_cpd_average_ecpm',
      'total_active_view_viewable_impressions_rate',
    ]);
  }, [detailData?.rows]);

  const dailySeries = useMemo(() => {
    const trend = detailData?.trend || [];
    // Prefer server trend (full-range SQL) — compact table rows are truncated.
    if (Array.isArray(trend) && trend.length) {
      const fromTrend = trend.map((item) => ({
        date: item.date,
        revenue: toNumber(item.earning ?? item.revenue),
        impressions: toNumber(item.impressions),
      })).filter((d) => d.date);
      if (fromTrend.some((d) => d.revenue > 0 || d.impressions > 0)) return fromTrend;
    }
    return buildDailySeries(enrichedRows, trend);
  }, [enrichedRows, detailData?.trend]);

  const engagementSeries = useMemo(() => {
    // Prefer full-range trend for daily impressions so truncated table rows don't hide early days.
    const trend = detailData?.trend || [];
    if (Array.isArray(trend) && trend.length) {
      const fromTrend = trend.map((item) => {
        const impressions = toNumber(item.impressions);
        const clicks = toNumber(item.clicks);
        return {
          date: item.date,
          impressions,
          clicks,
          unfilled: 0,
          ctr: impressions > 0 && clicks > 0 ? +((clicks / impressions) * 100).toFixed(2) : 0,
          fillRate: 0,
        };
      }).filter((d) => d.date);
      if (fromTrend.some((d) => d.impressions > 0)) return fromTrend;
    }
    return buildEngagementSeries(enrichedRows);
  }, [enrichedRows, detailData?.trend]);

  const shareSeries = useMemo(() => {
    const charts = detailData?.charts;
    if (charts?.revenue || charts?.device || charts?.country) {
      return {
        revenue: Array.isArray(charts.revenue) ? charts.revenue : [],
        device: Array.isArray(charts.device) ? charts.device : [],
        country: Array.isArray(charts.country) ? charts.country : [],
      };
    }
    return {
      revenue: buildRevenueDomainShare(
        enrichedRows,
        normalizeInventorySelections({ domain: applied?.domain || [] }, {}).domain || []
      ),
      device: buildShareSeries(enrichedRows, [
        'device_category_name', 'mobile_device_name', 'device', 'DEVICE_CATEGORY_NAME', 'device_name', 'deviceType',
      ], 'revenue', { deviceFriendly: true, topN: 6 }),
      country: buildShareSeries(enrichedRows, [
        'country_name', 'country', 'COUNTRY_NAME', 'countryName', 'countryCode',
      ], 'revenue', { topN: 10 }),
    };
  }, [enrichedRows, applied?.domain, detailData?.charts]);

  const dailyWithEcpm = useMemo(() => withDailyEcpm(dailySeries), [dailySeries]);

  const priorDailySeries = useMemo(() => {
    const trend = priorDetail?.trend || [];
    if (!Array.isArray(trend) || !trend.length) return [];
    return trend.map((item) => ({
      date: item.date,
      revenue: toNumber(item.earning ?? item.revenue),
      impressions: toNumber(item.impressions),
    }));
  }, [priorDetail?.trend]);

  const dailyCompareSeries = useMemo(
    () => withDailyEcpm(overlayPriorDaily(dailySeries, priorDailySeries)),
    [dailySeries, priorDailySeries]
  );

  const siteShareSeries = useMemo(
    () => buildSiteRevenueShare(enrichedRows, 10),
    [enrichedRows]
  );
  const priorSiteShareSeries = useMemo(
    () => buildSiteRevenueShare(priorDetail?.rows || [], 10),
    [priorDetail?.rows]
  );

  const insightItems = useMemo(() => {
    const currentShare = siteShareSeries;
    const currentCountry = Array.isArray(detailData?.charts?.country)
      ? detailData.charts.country
      : [];
    const priorShare = priorSiteShareSeries;
    const priorCountry = Array.isArray(priorDetail?.charts?.country) ? priorDetail.charts.country : [];
    if (
      !priorShare.length
      && !currentShare.length
      && !priorCountry.length
      && !priorDetail?.summary
      && !priorOverview?.summary
    ) {
      return [];
    }
    return buildInsights({
      currentSummary: overviewSummary,
      priorSummary: priorDetail?.summary || priorOverview?.summary || null,
      currentShare,
      priorShare,
      currentCountry,
      priorCountry,
      comparePhrase: compareLabel,
    });
  }, [
    overviewSummary,
    priorOverview,
    priorDetail,
    detailData?.charts?.country,
    compareLabel,
    siteShareSeries,
    priorSiteShareSeries,
  ]);

  const [thresholdBanners, setThresholdBanners] = useState([]);
  const [dismissedAlerts, setDismissedAlerts] = useState(() => new Set());

  useEffect(() => {
    const items = evaluateRevenueDropThreshold(
      overviewSummary?.revenueChange,
      compareLabel
    );
    setThresholdBanners(items);
  }, [overviewSummary?.revenueChange, compareLabel]);

  const visibleThresholdBanners = useMemo(
    () => thresholdBanners.filter((b) => !dismissedAlerts.has(b.id)),
    [thresholdBanners, dismissedAlerts]
  );

  const stickyKpis = useMemo(() => ([
    { key: 'imps', label: 'Imps', value: overviewSummary?.impressions, change: overviewSummary?.impressionsChange },
    { key: 'rev', label: 'Rev', value: overviewSummary?.revenue ?? overviewSummary?.selectRange, change: overviewSummary?.revenueChange, money: true },
    { key: 'ecpm', label: 'eCPM', value: overviewSummary?.ecpm, change: overviewSummary?.ecpmChange, money: true },
  ]), [overviewSummary]);

  const dailyDates = useMemo(
    () => dailySeries.map((d) => d.date).filter(Boolean),
    [dailySeries]
  );
  const dailyScrollable = Boolean(scrollableChartMinWidth(dailySeries.length, { isNarrow }));
  const dailyDateAxis = useMemo(
    () => dateAxisProps(dailySeries.length, {
      isNarrow,
      dates: dailyDates,
      scrollable: dailyScrollable,
    }),
    [dailySeries.length, isNarrow, dailyDates, dailyScrollable]
  );
  const dailyMoneyWidth = useMemo(
    () => yAxisWidthForValues(dailySeries.map((d) => d.revenue), 'money', { isNarrow }),
    [dailySeries, isNarrow]
  );
  const dailyImpWidth = useMemo(
    () => yAxisWidthForValues(dailySeries.map((d) => d.impressions), 'raw', { isNarrow }),
    [dailySeries, isNarrow]
  );
  const dailyEcpmWidth = useMemo(
    () => yAxisWidthForValues(
      (dailyWithEcpm || []).map((d) => d.ecpm),
      'money',
      { isNarrow }
    ),
    [dailyWithEcpm, isNarrow]
  );
  const engagementDates = useMemo(
    () => engagementSeries.map((d) => d.date).filter(Boolean),
    [engagementSeries]
  );
  const engagementScrollable = Boolean(scrollableChartMinWidth(engagementSeries.length, { isNarrow }));
  const engagementDateAxis = useMemo(
    () => dateAxisProps(engagementSeries.length, {
      isNarrow,
      dates: engagementDates,
      scrollable: engagementScrollable,
    }),
    [engagementSeries.length, isNarrow, engagementDates, engagementScrollable]
  );
  const engagementClicksWidth = useMemo(
    () => yAxisWidthForValues(engagementSeries.map((d) => d.clicks), 'raw', { isNarrow }),
    [engagementSeries, isNarrow]
  );
  const engagementPctWidth = useMemo(
    () => yAxisWidthForValues(
      engagementSeries.flatMap((d) => [d.ctr, d.fillRate]),
      'percent',
      { isNarrow }
    ),
    [engagementSeries, isNarrow]
  );
  const engagementMargins = useMemo(
    () => chartMargins({
      isNarrow,
      hasAngledX: Boolean(engagementDateAxis.angle),
      yWidth: Math.max(engagementClicksWidth, engagementPctWidth),
    }),
    [isNarrow, engagementDateAxis.angle, engagementClicksWidth, engagementPctWidth]
  );
  const dailyChartMargins = useMemo(
    () => chartMargins({
      isNarrow,
      hasAngledX: Boolean(dailyDateAxis.angle),
      yWidth: dailyMoneyWidth,
      rightWidth: dailyImpWidth,
    }),
    [isNarrow, dailyDateAxis.angle, dailyMoneyWidth, dailyImpWidth]
  );
  const dailyEcpmMargins = useMemo(
    () => chartMargins({
      isNarrow,
      hasAngledX: Boolean(dailyDateAxis.angle),
      yWidth: dailyMoneyWidth,
      rightWidth: dailyEcpmWidth,
    }),
    [isNarrow, dailyDateAxis.angle, dailyMoneyWidth, dailyEcpmWidth]
  );
  const catAxisW = categoryAxisWidth({ isNarrow });
  const catLabelMax = categoryLabelMaxChars({ isNarrow });
  const hBarMargins = useMemo(
    () => ({ top: 8, right: 16, left: isNarrow ? 4 : 8, bottom: 8 }),
    [isNarrow]
  );
  const yieldSeries = useMemo(() => {
    if (!dailyWithEcpm.length || !engagementSeries.length) return [];
    const ctrByDate = new Map(engagementSeries.map((d) => [d.date, toNumber(d.ctr)]));
    const merged = dailyWithEcpm.map((d) => ({
      date: d.date,
      ecpm: toNumber(d.ecpm),
      ctr: ctrByDate.get(d.date) || 0,
    }));
    return merged.some((d) => d.ecpm > 0 && d.ctr > 0) ? merged : [];
  }, [dailyWithEcpm, engagementSeries]);
  const impressionCountryShare = useMemo(
    () => buildShareSeries(enrichedRows, [
      'country_name', 'country', 'COUNTRY_NAME', 'countryName', 'countryCode',
    ], 'impressions', { topN: 10 }),
    [enrichedRows]
  );
  const yieldMargins = useMemo(
    () => chartMargins({
      isNarrow,
      hasAngledX: Boolean(dailyDateAxis.angle),
      yWidth: dailyEcpmWidth,
      rightWidth: engagementPctWidth,
    }),
    [isNarrow, dailyDateAxis.angle, dailyEcpmWidth, engagementPctWidth]
  );
  const showRevenueCharts = vis.revenue !== false;
  const showImpressionCharts = vis.impressions !== false;
  const showEcpmCharts = showRevenueCharts && showImpressionCharts;
  const activeTrend = (
    (trendMetric === 'ecpm' && !showEcpmCharts)
    || (trendMetric === 'revenue' && !showRevenueCharts)
    || (trendMetric === 'impressions' && !showImpressionCharts)
  ) ? 'all' : trendMetric;
  const dataStillBuilding = detailData?.status === 'building';

  const hasChartReportData = useMemo(() => {
    if (detailData?.summary && (
      (Number(detailData.summary.impressions) || 0) > 0
      || (Number(detailData.summary.revenue) || 0) > 0
    )) {
      return true;
    }
    if (hasChartData(dailySeries, ['revenue', 'impressions'])) return true;
    if (hasChartData(shareSeries.revenue) || hasChartData(shareSeries.device) || hasChartData(shareSeries.country)) {
      return true;
    }
    return enrichedRows.some((row) => {
      const impressions = toNumber(readValue(row, ['impression', 'impressions', 'total_line_item_level_impressions'], ['impressionsTotal']));
      const revenue = toNumber(readValue(row, ['revenue', 'total_line_item_level_cpm_and_cpc_revenue'], ['earnings']));
      return impressions > 0 || revenue > 0;
    });
  }, [enrichedRows, detailData?.summary, dailySeries, shareSeries]);

  const hasFilteredReportData = useMemo(() => {
    if (!hasInventoryFilter) return hasChartReportData;
    return hasChartReportData;
  }, [hasInventoryFilter, hasChartReportData]);

  const skippedFilterChips = useMemo(() => {
    if (detailData?.reportWarningSkipped?.length) return detailData.reportWarningSkipped;
    return [];
  }, [detailData?.reportWarningSkipped]);

  const unavailableFilterChips = useMemo(() => {
    if (skippedFilterChips.length) return skippedFilterChips;
    if (hasInventoryFilter && !detailLoading && !hasFilteredReportData && detailData) {
      const chips = [];
      if (applied?.domain?.length) chips.push('Domain name');
      if (applied?.site?.length) chips.push('Site');
      if (applied?.domainName?.length) chips.push('Ad Unit');
      if (applied?.domainId?.length) chips.push('App ID');
      return chips;
    }
    return [];
  }, [
    skippedFilterChips,
    hasInventoryFilter,
    detailLoading,
    hasFilteredReportData,
    detailData,
    applied,
  ]);

  const showPartialCompatWarning = Boolean(
    hasInventoryFilter
    && !detailLoading
    && hasFilteredReportData
    && skippedFilterChips.length > 0
  );

  const showNoReportCard = Boolean(
    hasInventoryFilter
    && !detailLoading
    && !hasFilteredReportData
    && detailData
    && detailData?.status !== 'building'
  );

  const clearIncompatibleFilters = () => {
    const names = new Set(unavailableFilterChips);
    const next = { ...applied };
    if (names.has('Domain name')) { setDomain([]); next.domain = []; }
    if (names.has('Site')) { setSite([]); next.site = []; }
    if (names.has('Ad Unit')) { setDomainName([]); next.domainName = []; }
    if (names.has('App ID')) { setDomainId([]); next.domainId = []; }
    setApplied(next);
    setFilterApplied(true);
    showToast({ message: 'Removed incompatible filters' });
  };

  const presetLabel = DATE_PRESETS.find(p => p.id === preset)?.label || 'Custom';
  const isMock = overviewData?.isMock || detailData?.isMock;

  const filterSummary = useMemo(() => {
    const parts = [];
    if (customDatesIncomplete) {
      parts.push('Custom range incomplete');
    } else if (startDate && endDate) {
      parts.push(startDate === endDate ? startDate : `${startDate} → ${endDate}`);
    } else {
      parts.push(presetLabel);
    }
    if (hasInventoryFilter) {
      const bits = [];
      if (applied?.domain?.length && !isAllSelection(applied.domain)) bits.push(`${applied.domain.length} domains`);
      if (applied?.site?.length && !isAllSelection(applied.site)) bits.push(`${applied.site.length} sites`);
      if (applied?.domainName?.length && !isAllSelection(applied.domainName)) bits.push(`${applied.domainName.length} ad units`);
      if (applied?.domainId?.length && !isAllSelection(applied.domainId)) bits.push(`${applied.domainId.length} apps`);
      parts.push(bits.length ? bits.join(', ') : 'Filtered inventory');
    } else {
      parts.push('All inventory');
    }
    return parts.join(' · ');
  }, [
    customDatesIncomplete, startDate, endDate, presetLabel, hasInventoryFilter, applied,
  ]);

  const chartOn = (id) => !hiddenChartIds.includes(id);
  const hideChart = (id) => {
    setHiddenChartIds((prev) => {
      const next = prev.includes(id) ? prev : [...prev, id];
      return next.length >= DASH_CHARTS.length ? prev : next;
    });
  };
  const toggleChart = (id) => {
    setHiddenChartIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      const next = [...prev, id];
      return next.length >= DASH_CHARTS.length ? prev : next;
    });
  };
  const handleCompareMode = (mode) => {
    setCompareMode(mode);
    if (mode === 'custom' && (!compareStart || !compareEnd)) {
      const prior = previousPeriodRange(applied?.startDate || startDate, applied?.endDate || endDate);
      if (prior) {
        setCompareStart(prior.startDate);
        setCompareEnd(prior.endDate);
      }
    }
  };

  return (
    <div className="dashboard-page">
      <PageHeader
        title="Dashboard"
        subtitle="Network performance overview — charts load for the selected dates; inventory filters refine them"
        summary={filterSummary}
      >
        {canFilter && (
          <>
            <button type="button" className="btn-reset btn-copy-link" onClick={handleCopyLink}>
              Copy link
            </button>
            <SavePresetButton
              page={PRESET_PAGES.dashboard}
              userId={user?.id}
              getSnapshot={getPresetSnapshot}
              disabled={!canFilter}
            />
          </>
        )}
      </PageHeader>
      <DataFreshness
        coverage={overviewData?.coverage}
        networkInfo={networkInfo}
        status={overviewData?.status}
        className="dash-freshness"
      />
      {canGenerate && (
        <CompareRangeBar
          mode={compareMode}
          onModeChange={handleCompareMode}
          customStart={compareStart}
          customEnd={compareEnd}
          onCustomStart={(v) => setCompareStart(clampDateValue(v, dateRestriction))}
          onCustomEnd={(v) => setCompareEnd(clampDateValue(v, dateRestriction))}
          minDate={dateRestriction?.startDate}
          maxDate={dateRestriction?.endDate}
          disabled={!canFilter}
        />
      )}
      {canGenerate && (
        <OnboardingGuide
          visible
          onPickDates={() => {
            setBreakdownOpen(true);
            setMobileFiltersOpen(true);
            filterPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
          onApply={() => {
            if (!customDatesIncomplete && canApplyInventory) applyFilter();
          }}
        />
      )}
      {dateRestriction && (
        <p className="form-note page-restriction-note">
          {dateFilterLocked
            ? `Data locked to: ${formatDateRestrictionLabel(dateRestriction)}`
            : `Allowed filter window: ${formatDateRestrictionLabel(dateRestriction)}`}
        </p>
      )}

      {canGenerate && (
      <div className="filter-card dash-overview-shell" ref={filterPanelRef}>
        <div className="dash-date-toolbar filter-card-head-sticky">
          <div className="dash-date-display">
            <span className="dash-date-label">{presetLabel}</span>
            <span className="dash-date-range">
              {customDatesIncomplete
                ? 'Select start & end dates'
                : (startDate && endDate
                  ? (startDate !== endDate ? `${startDate} → ${endDate}` : startDate)
                  : '…')}
            </span>
          </div>
          <div className="filter-actions filter-actions--desktop">
            <button className="btn-generate" onClick={applyFilter}
              disabled={!canFilter || !canApplyInventory || customDatesIncomplete}
              title={customDatesIncomplete
                ? 'Select both start and end dates, then click Apply Filter'
                : (!canApplyInventory ? 'Select at least one domain, site, or app ID from your assigned list' : '')}>✓ Apply Filter</button>
            <SavedFiltersBar
              page={SAVED_FILTERS_PAGES.dashboard}
              userId={user?.id}
              getSnapshot={getSavedFilterSnapshot}
              onApply={handleApplySavedFilter}
              canSave={canFilter}
              disabled={!canFilter}
            />
            <button className="btn-reset" onClick={reset} disabled={!canFilter}>↺ Reset</button>
          </div>
        </div>

        {isNarrow && (
          <div className="filter-mobile-toggle-row">
            <button
              type="button"
              className="filter-mobile-toggle"
              aria-expanded={mobileFiltersOpen}
              onClick={() => setMobileFiltersOpen((v) => !v)}
            >
              Filters{appliedChips.length ? ` (${appliedChips.length})` : ''} {mobileFiltersOpen ? '▴' : '▾'}
            </button>
            <button type="button" className="btn-reset btn-copy-link" onClick={handleCopyLink}>Copy link</button>
            <SavePresetButton
              page={PRESET_PAGES.dashboard}
              userId={user?.id}
              getSnapshot={getPresetSnapshot}
              disabled={!canFilter}
            />
          </div>
        )}

        <div className={`filter-panel-body${!mobileFiltersOpen && isNarrow ? ' is-collapsed' : ''}`}>
        {!dateFilterLocked && visiblePresets.length > 0 && (
        <div className="preset-pills dash-preset-row">
          {visiblePresets.map(p => {
            const presetDisabled = !canFilter
              || (dateRestriction && !isPresetAllowedForRestriction(p.id, dateRestriction));
            return (
            <button
              key={p.id}
              type="button"
              className={`preset-pill ${preset === p.id ? 'active' : ''}`}
              onClick={() => applyPreset(p.id)}
              disabled={presetDisabled}
              title={presetDisabled && dateRestriction
                ? `Outside your allowed range (${formatDateRestrictionLabel(dateRestriction)})`
                : ''}
            >{p.label}</button>
            );
          })}
        </div>
        )}

        {!dateFilterLocked && preset === 'custom' && (
          <>
            <div className="filter-grid dash-custom-dates">
              <div className="filter-field">
                <label>Start Date</label>
                <input type="date" value={startDate}
                  min={dateRestriction?.startDate}
                  max={dateRestriction?.endDate && endDate
                    ? (endDate < dateRestriction.endDate ? endDate : dateRestriction.endDate)
                    : (endDate || dateRestriction?.endDate)}
                  disabled={!canFilter || dateFilterLocked}
                  onChange={e => {
                    const v = clampDateValue(e.target.value, dateRestriction);
                    setStartDate(v);
                    setPreset('custom');
                  }} />
              </div>
              <div className="filter-field">
                <label>End Date</label>
                <input type="date" value={endDate}
                  min={dateRestriction?.startDate && startDate
                    ? (startDate > dateRestriction.startDate ? startDate : dateRestriction.startDate)
                    : (startDate || dateRestriction?.startDate)}
                  max={dateRestriction?.endDate}
                  disabled={!canFilter || dateFilterLocked}
                  onChange={e => {
                    const v = clampDateValue(e.target.value, dateRestriction);
                    setEndDate(v);
                    setPreset('custom');
                  }} />
              </div>
            </div>
            <div className="custom-range-hint">
              Pick <strong>start</strong> and <strong>end</strong> dates, then click <strong>Apply Filter</strong> to load data.
            </div>
          </>
        )}

        {filterApplied && appliedChips.length > 0 && (
          <FilterChips
            chips={appliedChips}
            expanded={chipsExpanded}
            onToggleExpand={() => setChipsExpanded((v) => !v)}
            onAddFilter={canFilter ? handleAddFilter : undefined}
            onRemove={canFilter ? handleRemoveChip : undefined}
            title="Applied filters"
          />
        )}

        {recentFilters.length > 0 && (
          <div className="dash-breakdown-section gam-report-breakdown-section" style={{ marginTop: 8 }}>
            <div className="filter-section-divider" />
            <div className="filter-section-head" style={{ marginBottom: 8 }}>
              <span className="filter-section-title">Recently used filters</span>
              <span className="filter-section-hint">Tap a saved set to reuse it</span>
            </div>
            <div className="preset-pills dash-preset-row">
             {recentFilters.map((item) => (
  <button
    key={item.id}
    type="button"
    className="preset-pill recent-filter-pill"
    onClick={() => {
      const snapshot = applyRecentFilter(item.snapshot);

      if (snapshot.startDate) setStartDate(snapshot.startDate);
      if (snapshot.endDate) setEndDate(snapshot.endDate);
      if (snapshot.preset) setPreset(snapshot.preset);
      if (snapshot.domain) setDomain(snapshot.domain);
      if (snapshot.site) setSite(snapshot.site);
      if (snapshot.domainName) setDomainName(snapshot.domainName);
      if (snapshot.domainId) setDomainId(snapshot.domainId);

      setApplied({
        ...applied,
        ...snapshot,
        startDate: snapshot.startDate || startDate,
        endDate: snapshot.endDate || endDate,
      });

      setFilterApplied(true);
    }}
  >
    <span className="recent-filter-label">{item.label}</span>

    <span
      className="recent-filter-close"
      title="Remove filter"
      onClick={(e) => {
        e.stopPropagation();          // Don't apply the filter
        setRecentFilters(removeRecentFilter(item.id, user?.id));
      }}
    >
      ×
    </span>
  </button>
))}
            </div>
          </div>
        )}

        {isNarrow && (
          <div className="filter-actions filter-actions--mobile-inline" style={{ marginTop: 10 }}>
            <SavedFiltersBar
              page={SAVED_FILTERS_PAGES.dashboard}
              userId={user?.id}
              getSnapshot={getSavedFilterSnapshot}
              onApply={handleApplySavedFilter}
              canSave={canFilter}
              disabled={!canFilter}
            />
          </div>
        )}

        {breakdownOpen && (
          <div id="dash-inventory-filters" className="dash-breakdown-section gam-report-breakdown-section">
            <div className="filter-section-divider" />
            {showNoDomainsNote ? (
              <NoDomainsAssignedNote />
            ) : (
            <>
            <div className="filter-section-head" style={{ marginBottom: 12 }}>
              <span className="filter-section-title">Inventory filters</span>
              <span className="filter-section-hint">
                {filterVisibility.isScopedUser
                  ? 'Pick from your assigned list — overview KPIs update when you apply filters'
                  : 'Domain, site, ad unit, app & custom dates'}
                {catalogBusy ? ' · Loading options…' : ''}
              </span>
            </div>
            <div className="filter-grid">
              {filterVisibility.showDomain && (
              <div className="filter-field">
                <label>Domain name</label>
                <MultiSelect options={domainRootOptions} value={domain} onChange={handleDomainChange}
                  placeholder="Select domain names" disabled={!canFilter} loading={catalogBusy} />
              </div>
              )}
              {filterVisibility.showSite && (
              <div className="filter-field">
                <label>Site (URL)</label>
                <MultiSelect options={siteOptions} value={site} onChange={handleSiteChange}
                  placeholder="Select sites" disabled={!canFilter} loading={catalogBusy} />
              </div>
              )}
              {filterVisibility.showAdUnit && (
              <div className="filter-field">
                <label>Ad Unit</label>
                <MultiSelect options={adUnitOptions} value={domainName} onChange={handleAdUnitChange}
                  placeholder="Select Ad Units" disabled={!canFilter} loading={catalogBusy} />
              </div>
              )}
              {filterVisibility.showApp && (
              <div className="filter-field">
                <label>App ID</label>
                <MultiSelect options={appOptions} value={domainId} onChange={handleAppChange}
                  placeholder="Select app IDs" disabled={!canFilter} loading={catalogBusy} />
              </div>
              )}
            </div>
            </>
            )}
          </div>
        )}
        </div>
        {breakdownOpen && canFilter && (
          <div className="filter-actions-foot">
            <button className="btn-generate" onClick={applyFilter}
              disabled={!canApplyInventory || customDatesIncomplete}>✓ Apply Filter</button>
            <button className="btn-reset" onClick={reset}>↺ Reset</button>
          </div>
        )}
        {!canFilter && (
          <p className="filter-locked-note">Filters are disabled for your account.</p>
        )}
      </div>
      )}

      {error && (
        <div className="error-box dash-error-box" role="alert">
          <div className="dash-error-copy">
            <strong>Couldn’t load live metrics</strong>
            <span>{error}</span>
          </div>
          <button type="button" onClick={() => { loadOverview(); if (canGenerate) loadDetail(); }} className="btn-retry">Retry</button>
        </div>
      )}

      {!(hasInventoryFilter && !detailLoading && !hasFilteredReportData) && (
        <>
          {isNarrow && !overviewCardLoading && (overviewSummary?.impressions != null || overviewSummary?.revenue != null) && (
            <div className="kpi-sticky-strip" aria-label="Key metrics">
              {stickyKpis.map((k) => {
                const change = k.change;
                const down = change != null && change < 0;
                const val = k.money
                  ? money(k.value, currency)
                  : Number(k.value || 0).toLocaleString();
                return (
                  <div key={k.key} className="kpi-sticky-item">
                    <span className="kpi-sticky-label">{k.label}</span>
                    <span className="kpi-sticky-value">{val}</span>
                    {change != null && (
                      <span className={`kpi-sticky-delta ${down ? 'down' : 'up'}`}>
                        {down ? '▼' : '▲'}{Math.abs(change).toFixed(0)}%
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <div className="dash-overview-row">
            <GamOverviewCard
              summary={overviewSummary}
              currency={currency}
              loading={overviewCardLoading}
              sparkSeries={dailyWithEcpm}
              compareLabel={compareLabel}
            />
          </div>
          {!overviewCardLoading && insightItems.length > 0 && (
            <InsightsStrip items={insightItems} compareLabel={compareLabel} />
          )}
          {visibleThresholdBanners.length > 0 && (
            <ThresholdAlertBanner
              items={visibleThresholdBanners}
              onDismiss={(id) => setDismissedAlerts((prev) => new Set([...prev, id]))}
            />
          )}
        </>
      )}

      {!canGenerate ? (
        <AccessRestricted title={NO_VIEW_REPORTS_TITLE} message={NO_VIEW_REPORTS_MSG} />
      ) : (
        <>
      {detailLoading && (
        <div className="dash-skeleton-grid" aria-busy="true" aria-label="Loading charts">
          <div className="chart-card wide dash-skeleton-card">
            <div className="skeleton dash-skeleton-title" />
            <div className="skeleton dash-skeleton-chart" />
          </div>
          <div className="charts-grid">
            <div className="chart-card dash-skeleton-card">
              <div className="skeleton dash-skeleton-title" />
              <div className="skeleton dash-skeleton-chart sm" />
            </div>
            <div className="chart-card dash-skeleton-card">
              <div className="skeleton dash-skeleton-title" />
              <div className="skeleton dash-skeleton-chart sm" />
            </div>
          </div>
        </div>
      )}

      {detailLoading && slowDetail && (
        <div className="gam-report-warning" role="status">
          <span className="gam-report-warning-icon" aria-hidden>…</span>
          Reports are taking longer than usual to respond. Please wait…
        </div>
      )}

      {!detailLoading && dataStillBuilding && (
        <div className="chart-annotation" role="status">
          {hasChartReportData
            ? 'Data is still filling in for this range. Totals may change when the sync finishes.'
            : 'Fetching live metrics for this account. This can take a minute on first login…'}
        </div>
      )}

      {showPartialCompatWarning && (
        <div className="warn-card warn-card-partial" role="status" style={{ marginTop: 16 }}>
          <div className="warn-card-main">
            <div className="warn-card-left">
              <div className="warn-card-icon-wrap">
                <span aria-hidden>i</span>
              </div>
              <div className="warn-card-body">
                <div className="warn-card-title">Showing compatible data</div>
                <div className="warn-card-desc">
                  Some selected filters can&apos;t be combined in one result set.
                  Results below use the compatible subset. Remove the unavailable items for a complete selection.
                </div>
                {canFilter && skippedFilterChips.length > 0 && (
                  <div className="warn-card-btns">
                    <button type="button" className="warn-btn-primary" onClick={clearIncompatibleFilters}>
                      Remove these and apply
                    </button>
                  </div>
                )}
              </div>
            </div>
            <div className="warn-card-right">
              <div className="warn-card-section-label">Skipped (incompatible)</div>
              <div className="warn-chip-row">
                {skippedFilterChips.map((name) => (
                  <span key={name} className="warn-chip warn-chip-unavail">{name}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {showNoReportCard && (
        <div className="warn-card" role="status" style={{ marginTop: 16 }}>
          <div className="warn-card-main">
            <div className="warn-card-left">
              <div className="warn-card-icon-wrap">
                <span aria-hidden>i</span>
              </div>
              <div className="warn-card-body">
                <div className="warn-card-title">No report data found</div>
                <div className="warn-card-desc">
                  The highlighted filters on the right could not return any data for your selected combination and date range.
                  These filters are not supported together — remove them or adjust your selection to view complete data.
                </div>
                <div className="warn-card-btns">
                  {canFilter && (
                    <>
                      <button type="button" className="warn-btn-primary" onClick={clearIncompatibleFilters}>
                        Remove these and apply
                      </button>
                      <button type="button" className="warn-btn-secondary" onClick={reset}>↺ Reset Filters</button>
                    </>
                  )}
                </div>
              </div>
            </div>
            <div className="warn-card-right">
              <div className="warn-card-section-label">Unavailable filters for current selection</div>
              <div className="warn-chip-row">
                {unavailableFilterChips.map((name) => (
                  <span key={name} className="warn-chip warn-chip-unavail">{name}</span>
                ))}
              </div>
            </div>
          </div>
          <div className="warn-card-hint-bar">
            <span className="warn-card-hint-icon" aria-hidden>i</span>
            <span>Some selected filters can&apos;t be combined in the same report. Remove incompatible filters to view complete data.</span>
          </div>
        </div>
      )}

      {!detailLoading && hasChartReportData && (
        <>
          <div className="dash-chart-toolbar">
            <ChartVisibilityMenu
              hiddenIds={hiddenChartIds}
              onToggle={toggleChart}
              onShowAll={() => setHiddenChartIds([])}
            />
          </div>
          {chartOn('trend') && hasChartData(dailySeries, ['revenue', 'impressions']) && (
          <div className="chart-card wide">
            <div className="chart-header">
              <div className="chart-header-text">
                <h3 className="chart-title">
                  {activeTrend === 'revenue' ? 'Revenue'
                    : activeTrend === 'impressions' ? 'Impressions'
                      : activeTrend === 'ecpm' ? 'eCPM'
                        : 'Revenue growth & impressions'}
                </h3>
                {priorDailySeries.length > 0 && activeTrend !== 'impressions' && activeTrend !== 'ecpm' && (
                  <p className="chart-hint">Solid = this period · Dashed = {compareLabel} revenue</p>
                )}
              </div>
              <div className="chart-header-actions">
                <div className="chart-metric-toggle" role="group" aria-label="Trend metric">
                  <button type="button" className={`chart-metric-toggle-btn${activeTrend === 'all' ? ' active' : ''}`} onClick={() => setTrendMetric('all')}>All</button>
                  {showRevenueCharts && (
                    <button type="button" className={`chart-metric-toggle-btn${activeTrend === 'revenue' ? ' active' : ''}`} onClick={() => setTrendMetric('revenue')}>Revenue</button>
                  )}
                  {showImpressionCharts && (
                    <button type="button" className={`chart-metric-toggle-btn${activeTrend === 'impressions' ? ' active' : ''}`} onClick={() => setTrendMetric('impressions')}>Impressions</button>
                  )}
                  {showEcpmCharts && (
                    <button type="button" className={`chart-metric-toggle-btn${activeTrend === 'ecpm' ? ' active' : ''}`} onClick={() => setTrendMetric('ecpm')}>eCPM</button>
                  )}
                </div>
                {filterApplied && (
                  <div className="report-live">
                    <span className="dot-pulse" /> {isMock ? 'Mock' : 'Live'}
                    <DataFreshness
                      networkInfo={networkInfo}
                      fetchedAt={lastUpdated}
                      className="report-updated"
                    />
                  </div>
                )}
                <ChartExportButton filename="revenue-impressions" />
                <button type="button" className="chart-hide-btn" onClick={() => hideChart('trend')} title="Hide this chart">Hide</button>
              </div>
            </div>
              <ScrollableChart pointCount={dailyCompareSeries.length} isNarrow={isNarrow} height={isNarrow ? 320 : 310}>
                <ComposedChart data={dailyCompareSeries} margin={dailyChartMargins}>
                  <defs>
                    <linearGradient id="dashEarnGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={CHART_SERIES.primary} stopOpacity={0.22} />
                      <stop offset="95%" stopColor={CHART_SERIES.primary} stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="dashImpsGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={CHART_SERIES.secondary} stopOpacity={0.18} />
                      <stop offset="95%" stopColor={CHART_SERIES.secondary} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray={CHART_GRID.strokeDasharray} stroke={CHART_GRID.stroke} />
                  <XAxis dataKey="date" {...dailyDateAxis} />
                  {(activeTrend === 'all' || activeTrend === 'revenue' || activeTrend === 'ecpm') && (
                  <YAxis
                    yAxisId="left"
                    tick={{ ...CHART_AXIS_TICK, fontSize: isNarrow ? 10 : 11 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => formatAxisMoney(v, currency)}
                    width={activeTrend === 'ecpm' ? dailyEcpmWidth : dailyMoneyWidth}
                  />
                  )}
                  {(activeTrend === 'all' || activeTrend === 'impressions') && (
                  <YAxis
                    yAxisId={activeTrend === 'impressions' ? 'left' : 'right'}
                    orientation={activeTrend === 'impressions' ? 'left' : 'right'}
                    tick={{ ...CHART_AXIS_TICK, fontSize: isNarrow ? 10 : 11 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => formatAxisNumber(v)}
                    width={dailyImpWidth}
                  />
                  )}
                  <Tooltip contentStyle={CHART_TOOLTIP_STYLE}
                    labelFormatter={(label) => String(label || '')}
                    formatter={(v, name) => {
                      if (name === 'Prior revenue') return [money(v, currency), compareLabel.replace(/^vs /, '')];
                      if (name === 'eCPM') return [money(v, currency), 'eCPM'];
                      return name === 'Revenue' ? [money(v, currency), 'Revenue'] : [num(v), 'Impressions'];
                    }} />
                  {(activeTrend === 'all' || activeTrend === 'revenue') && (
                  <Area yAxisId="left" type="monotone" dataKey="revenue" stroke={CHART_SERIES.primary} strokeWidth={2}
                    fill="url(#dashEarnGrad)" fillOpacity={1} dot={false} activeDot={{ r: 4 }} name="Revenue" isAnimationActive={false} />
                  )}
                  {priorDailySeries.length > 0 && (activeTrend === 'all' || activeTrend === 'revenue') && (
                    <Line
                      yAxisId="left"
                      type="monotone"
                      dataKey="priorRevenue"
                      stroke={CHART_SERIES.muted}
                      strokeWidth={2}
                      strokeDasharray="5 5"
                      dot={false}
                      name="Prior revenue"
                      isAnimationActive={false}
                    />
                  )}
                  {(activeTrend === 'all' || activeTrend === 'impressions') && (
                  <Area yAxisId={activeTrend === 'impressions' ? 'left' : 'right'} type="monotone" dataKey="impressions" stroke={CHART_SERIES.secondary} strokeWidth={2}
                    fill="url(#dashImpsGrad)" fillOpacity={1} dot={false} activeDot={{ r: 4 }} name="Impressions" isAnimationActive={false} />
                  )}
                  {activeTrend === 'ecpm' && (
                    <Line
                      yAxisId="left"
                      type="monotone"
                      dataKey="ecpm"
                      stroke={CHART_SERIES.accent}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                      name="eCPM"
                      isAnimationActive={false}
                    />
                  )}
                </ComposedChart>
              </ScrollableChart>
          </div>
          )}

          {((chartOn('ctr') && hasChartData(engagementSeries, ['ctr']))
            || (chartOn('clicks') && hasChartData(engagementSeries, ['clicks']))
            || (chartOn('fill') && hasChartData(engagementSeries, ['fillRate']))
            || (chartOn('unfilled') && hasChartData(engagementSeries, ['unfilled']))
            || (chartOn('yield') && showEcpmCharts && hasChartData(yieldSeries, ['ecpm', 'ctr']))
            || (chartOn('revenueShare') && hasChartData(shareSeries.revenue))
            || (chartOn('deviceShare') && hasChartData(shareSeries.device))
            || (chartOn('countryShare') && hasChartData(shareSeries.country))
            || (chartOn('dailyEcpm') && showEcpmCharts && hasChartData(dailyWithEcpm, ['ecpm']))
            || (showImpressionCharts && chartOn('impsCountry') && hasChartData(impressionCountryShare))) && (
          <div className="charts-grid" style={{ marginTop: 16 }}>
            {chartOn('ctr') && hasChartData(engagementSeries, ['ctr']) && (
            <div className="chart-card">
              <ChartHeader title="CTR over time" hint="Clicks / impressions" onHide={() => hideChart('ctr')} />
              <ScrollableChart pointCount={engagementSeries.length} isNarrow={isNarrow} height={isNarrow ? 260 : 250}>
                <AreaChart data={engagementSeries} margin={engagementMargins}>
                  <defs>
                    <linearGradient id="dashCtrGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={CHART_SERIES.primary} stopOpacity={0.2} />
                      <stop offset="95%" stopColor={CHART_SERIES.primary} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray={CHART_GRID.strokeDasharray} stroke={CHART_GRID.stroke} />
                  <XAxis dataKey="date" {...engagementDateAxis} />
                  <YAxis
                    tick={{ ...CHART_AXIS_TICK, fontSize: isNarrow ? 10 : 11 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `${Number(v || 0).toFixed(1)}%`}
                    width={engagementPctWidth}
                  />
                  <Tooltip contentStyle={CHART_TOOLTIP_STYLE}
                    labelFormatter={(label) => String(label || '')}
                    formatter={(v) => [`${Number(v || 0).toFixed(2)}%`, 'CTR']} />
                  <Area type="monotone" dataKey="ctr" name="CTR" stroke={CHART_SERIES.primary} strokeWidth={2}
                    fill="url(#dashCtrGrad)" fillOpacity={1} dot={false} isAnimationActive={false} />
                </AreaChart>
              </ScrollableChart>
            </div>
            )}
            {chartOn('clicks') && hasChartData(engagementSeries, ['clicks']) && (
            <div className="chart-card">
              <ChartHeader title="Clicks trend" hint="Daily clicks" onHide={() => hideChart('clicks')} />
              <ScrollableChart pointCount={engagementSeries.length} isNarrow={isNarrow} height={isNarrow ? 260 : 250}>
                <AreaChart data={engagementSeries} margin={engagementMargins}>
                  <defs>
                    <linearGradient id="dashClicksGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={CHART_SERIES.accent} stopOpacity={0.22} />
                      <stop offset="95%" stopColor={CHART_SERIES.accent} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray={CHART_GRID.strokeDasharray} stroke={CHART_GRID.stroke} />
                  <XAxis dataKey="date" {...engagementDateAxis} />
                  <YAxis
                    tick={{ ...CHART_AXIS_TICK, fontSize: isNarrow ? 10 : 11 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => formatAxisNumber(v)}
                    width={engagementClicksWidth}
                  />
                  <Tooltip contentStyle={CHART_TOOLTIP_STYLE}
                    labelFormatter={(label) => String(label || '')}
                    formatter={(v) => [num(v), 'Clicks']} />
                  <Area type="monotone" dataKey="clicks" name="Clicks" stroke={CHART_SERIES.accent} strokeWidth={2}
                    fill="url(#dashClicksGrad)" fillOpacity={1} dot={false} isAnimationActive={false} />
                </AreaChart>
              </ScrollableChart>
            </div>
            )}
            {chartOn('fill') && hasChartData(engagementSeries, ['fillRate']) && (
            <div className="chart-card">
              <ChartHeader title="Fill rate over time" hint="Impressions / (impressions + unfilled)" onHide={() => hideChart('fill')} />
              <ScrollableChart pointCount={engagementSeries.length} isNarrow={isNarrow} height={isNarrow ? 260 : 250}>
                <AreaChart data={engagementSeries} margin={engagementMargins}>
                  <defs>
                    <linearGradient id="dashFillGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={CHART_SERIES.secondary} stopOpacity={0.2} />
                      <stop offset="95%" stopColor={CHART_SERIES.secondary} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray={CHART_GRID.strokeDasharray} stroke={CHART_GRID.stroke} />
                  <XAxis dataKey="date" {...engagementDateAxis} />
                  <YAxis
                    tick={{ ...CHART_AXIS_TICK, fontSize: isNarrow ? 10 : 11 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `${Number(v || 0).toFixed(0)}%`}
                    width={engagementPctWidth}
                    domain={[0, 100]}
                  />
                  <Tooltip contentStyle={CHART_TOOLTIP_STYLE}
                    labelFormatter={(label) => String(label || '')}
                    formatter={(v) => [`${Number(v || 0).toFixed(1)}%`, 'Fill rate']} />
                  <Area type="monotone" dataKey="fillRate" name="Fill rate" stroke={CHART_SERIES.secondary} strokeWidth={2}
                    fill="url(#dashFillGrad)" fillOpacity={1} dot={false} isAnimationActive={false} />
                </AreaChart>
              </ScrollableChart>
            </div>
            )}
            {chartOn('unfilled') && hasChartData(engagementSeries, ['unfilled']) && (
            <div className="chart-card">
              <ChartHeader title="Unfilled impressions" hint="Demand that did not fill" onHide={() => hideChart('unfilled')} />
              <ScrollableChart pointCount={engagementSeries.length} isNarrow={isNarrow} height={isNarrow ? 260 : 250}>
                <AreaChart data={engagementSeries} margin={engagementMargins}>
                  <defs>
                    <linearGradient id="dashUnfilledGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={CHART_SERIES.danger} stopOpacity={0.2} />
                      <stop offset="95%" stopColor={CHART_SERIES.danger} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray={CHART_GRID.strokeDasharray} stroke={CHART_GRID.stroke} />
                  <XAxis dataKey="date" {...engagementDateAxis} />
                  <YAxis
                    tick={{ ...CHART_AXIS_TICK, fontSize: isNarrow ? 10 : 11 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => formatAxisNumber(v)}
                    width={engagementClicksWidth}
                  />
                  <Tooltip contentStyle={CHART_TOOLTIP_STYLE}
                    labelFormatter={(label) => String(label || '')}
                    formatter={(v) => [num(v), 'Unfilled']} />
                  <Area type="monotone" dataKey="unfilled" name="Unfilled" stroke={CHART_SERIES.danger} strokeWidth={2}
                    fill="url(#dashUnfilledGrad)" fillOpacity={1} dot={false} isAnimationActive={false} />
                </AreaChart>
              </ScrollableChart>
            </div>
            )}
            {chartOn('yield') && showEcpmCharts && hasChartData(yieldSeries, ['ecpm', 'ctr']) && (
            <div className="chart-card">
              <ChartHeader title="Yield quality" hint="eCPM vs CTR" onHide={() => hideChart('yield')} />
              <ScrollableChart pointCount={yieldSeries.length} isNarrow={isNarrow} height={isNarrow ? 260 : 250}>
                <ComposedChart data={yieldSeries} margin={yieldMargins}>
                  <CartesianGrid strokeDasharray={CHART_GRID.strokeDasharray} stroke={CHART_GRID.stroke} />
                  <XAxis dataKey="date" {...dailyDateAxis} />
                  <YAxis
                    yAxisId="left"
                    tick={{ ...CHART_AXIS_TICK, fontSize: isNarrow ? 10 : 11 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => formatAxisMoney(v, currency)}
                    width={dailyEcpmWidth}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ ...CHART_AXIS_TICK, fontSize: isNarrow ? 10 : 11 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `${Number(v || 0).toFixed(1)}%`}
                    width={engagementPctWidth}
                  />
                  <Tooltip contentStyle={CHART_TOOLTIP_STYLE}
                    labelFormatter={(label) => String(label || '')}
                    formatter={(v, name) => (
                      name === 'CTR'
                        ? [`${Number(v || 0).toFixed(2)}%`, 'CTR']
                        : [money(v, currency), 'eCPM']
                    )} />
                  <Legend />
                  <Bar yAxisId="left" dataKey="ecpm" name="eCPM" fill={CHART_SERIES.primary} radius={[4, 4, 0, 0]} maxBarSize={isNarrow ? 14 : 28} />
                  <Line yAxisId="right" type="monotone" dataKey="ctr" name="CTR" stroke={CHART_SERIES.accent} strokeWidth={2} dot={false} />
                </ComposedChart>
              </ScrollableChart>
            </div>
            )}
            {chartOn('revenueShare') && hasChartData(shareSeries.revenue) && (
            <div className="chart-card">
              <div className="chart-header">
                <div className="chart-header-text">
                  <h3 className="chart-title">Revenue share</h3>
                  <span className="filter-section-hint">
                    {isAllSelection(applied?.domain)
                      ? 'Top 10 domains'
                      : (applied?.domain?.length || 0) >= 10
                        ? 'Top 10 domains'
                        : (applied?.domain?.length || 0) > 0
                          ? `All ${applied.domain.length} selected`
                          : 'Top 10 domains'}
                  </span>
                </div>
                <div className="chart-header-actions">
                  <ChartExportButton filename="revenue-share" />
                  <button type="button" className="chart-hide-btn" onClick={() => hideChart('revenueShare')} title="Hide this chart">Hide</button>
                </div>
              </div>
              <div className="pie-chart-block">
                <ResponsiveContainer width="100%" height={isNarrow ? 168 : 180}>
                  <PieChart className="chart-pie-no-focus" margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                    <Pie
                      data={shareSeries.revenue}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={isNarrow ? 42 : 50}
                      outerRadius={isNarrow ? 68 : 76}
                      paddingAngle={2}
                      isAnimationActive={false}
                      stroke="none"
                    >
                      {shareSeries.revenue.map((entry, idx) => (
                        <Cell
                          key={`${entry.name}-${idx}`}
                          fill={SHARE_COLORS[idx % SHARE_COLORS.length]}
                          stroke="none"
                          style={{ outline: 'none' }}
                        />
                      ))}
                    </Pie>
                    <Tooltip formatter={(value) => [money(value, currency), 'Revenue']} />
                  </PieChart>
                </ResponsiveContainer>
                <SharePieLegend items={shareSeries.revenue} />
              </div>
            </div>
            )}
            {chartOn('deviceShare') && hasChartData(shareSeries.device) && (
            <div className="chart-card">
              <ChartHeader title="Device share" hint="Laptop · Mobile · Tablet" onHide={() => hideChart('deviceShare')} />
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={shareSeries.device} layout="vertical" margin={hBarMargins}>
                  <CartesianGrid strokeDasharray={CHART_GRID.strokeDasharray} stroke={CHART_GRID.stroke} />
                  <XAxis type="number" tick={false} axisLine={false} />
                  <YAxis dataKey="name" type="category" width={catAxisW} tick={{ fontSize: isNarrow ? 10 : 11 }} axisLine={false} tickLine={false}
                    tickFormatter={(v) => truncateAxisLabel(v, catLabelMax)} />
                  <Tooltip formatter={(value, _n, item) => [money(value, currency), item?.payload?.name || 'Device']} />
                  <Bar dataKey="value" radius={[0, 6, 6, 0]}>
                    {shareSeries.device.map((entry, idx) => (
                      <Cell key={`${entry.name}-${idx}`} fill={SHARE_COLORS[idx % SHARE_COLORS.length]} />
                    ))}
                  </Bar>
                  <Legend
                    layout="horizontal"
                    verticalAlign="bottom"
                    align="center"
                    payload={shareSeries.device.map((entry, idx) => ({
                      value: entry.name,
                      type: 'square',
                      color: SHARE_COLORS[idx % SHARE_COLORS.length],
                    }))}
                    formatter={(value) => <span style={{ color: '#333', fontSize: 11 }}>{value}</span>}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
            )}
            {chartOn('countryShare') && hasChartData(shareSeries.country) && (
            <div className="chart-card">
              <ChartHeader title="Country share" hint="Top 10 countries" onHide={() => hideChart('countryShare')} />
              <div className="pie-chart-block">
                <ResponsiveContainer width="100%" height={isNarrow ? 168 : 180}>
                  <PieChart className="chart-pie-no-focus" margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                    <Pie
                      data={shareSeries.country}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={isNarrow ? 42 : 50}
                      outerRadius={isNarrow ? 68 : 76}
                      paddingAngle={2}
                      isAnimationActive={false}
                      stroke="none"
                    >
                      {shareSeries.country.map((entry, idx) => (
                        <Cell
                          key={`${entry.name}-${idx}`}
                          fill={SHARE_COLORS[idx % SHARE_COLORS.length]}
                          stroke="none"
                          style={{ outline: 'none' }}
                        />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value, name) => [money(value, currency), name || 'Country']}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <SharePieLegend items={shareSeries.country} />
              </div>
            </div>
            )}
            {chartOn('dailyEcpm') && showEcpmCharts && hasChartData(dailyWithEcpm, ['ecpm']) && (
              <div className="chart-card">
                <ChartHeader title="Daily eCPM" hint="Revenue / impressions × 1000" onHide={() => hideChart('dailyEcpm')} />
                <ScrollableChart pointCount={dailyWithEcpm.length} isNarrow={isNarrow} height={isNarrow ? 320 : 310}>
                  <LineChart data={dailyWithEcpm} margin={dailyEcpmMargins}>
                    <CartesianGrid strokeDasharray={CHART_GRID.strokeDasharray} stroke={CHART_GRID.stroke} />
                    <XAxis dataKey="date" {...dailyDateAxis} />
                    <YAxis
                      tick={{ ...CHART_AXIS_TICK, fontSize: isNarrow ? 10 : 11 }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v) => formatAxisMoney(v, currency)}
                      width={dailyMoneyWidth}
                    />
                    <Tooltip contentStyle={CHART_TOOLTIP_STYLE}
                      labelFormatter={(label) => String(label || '')}
                      formatter={(v) => [money(v, currency), 'eCPM']} />
                    <Line type="monotone" dataKey="ecpm" name="eCPM" stroke={CHART_COLORS[4]} strokeWidth={2} dot={dailyWithEcpm.length <= 31} />
                  </LineChart>
                </ScrollableChart>
              </div>
            )}
            {showImpressionCharts && chartOn('impsCountry') && hasChartData(impressionCountryShare) && (
            <div className="chart-card">
              <ChartHeader title="Impressions by country" hint="Top 10 countries" onHide={() => hideChart('impsCountry')} />
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={impressionCountryShare} layout="vertical" margin={hBarMargins}>
                  <CartesianGrid strokeDasharray={CHART_GRID.strokeDasharray} stroke={CHART_GRID.stroke} />
                  <XAxis type="number" tick={false} axisLine={false} />
                  <YAxis dataKey="name" type="category" width={catAxisW} tick={{ fontSize: isNarrow ? 10 : 11 }} axisLine={false} tickLine={false}
                    tickFormatter={(v) => truncateAxisLabel(v, catLabelMax)} />
                  <Tooltip formatter={(value, _n, item) => [num(value), item?.payload?.name || 'Country']} />
                  <Bar dataKey="value" radius={[0, 6, 6, 0]}>
                    {impressionCountryShare.map((entry, idx) => (
                      <Cell key={`${entry.name}-${idx}`} fill={SHARE_COLORS[idx % SHARE_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            )}
          </div>
          )}

          {chartOn('revenueEcpm') && showEcpmCharts && hasChartData(dailyWithEcpm, ['revenue', 'ecpm']) && (
            <div className="chart-card wide" style={{ marginTop: 16 }}>
              <ChartHeader title="Revenue vs eCPM" hint="Daily revenue bars with eCPM overlay" onHide={() => hideChart('revenueEcpm')} />
              <ScrollableChart pointCount={dailyWithEcpm.length} isNarrow={isNarrow} height={isNarrow ? 320 : 310}>
                <ComposedChart data={dailyWithEcpm} margin={dailyEcpmMargins}>
                  <CartesianGrid strokeDasharray={CHART_GRID.strokeDasharray} stroke={CHART_GRID.stroke} />
                  <XAxis dataKey="date" {...dailyDateAxis} />
                  <YAxis
                    yAxisId="left"
                    tick={{ ...CHART_AXIS_TICK, fontSize: isNarrow ? 10 : 11 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => formatAxisMoney(v, currency)}
                    width={dailyMoneyWidth}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ ...CHART_AXIS_TICK, fontSize: isNarrow ? 10 : 11 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => formatAxisMoney(v, currency)}
                    width={dailyEcpmWidth}
                  />
                  <Tooltip contentStyle={CHART_TOOLTIP_STYLE}
                    labelFormatter={(label) => String(label || '')}
                    formatter={(v, name) => [money(v, currency), name]} />
                  <Legend />
                  <Bar yAxisId="left" dataKey="revenue" name="Revenue" fill={CHART_SERIES.primary} radius={[4, 4, 0, 0]} maxBarSize={isNarrow ? 14 : 28} />
                  <Line yAxisId="right" type="monotone" dataKey="ecpm" name="eCPM" stroke={CHART_SERIES.accent} strokeWidth={2} dot={false} />
                </ComposedChart>
              </ScrollableChart>
            </div>
          )}
        </>
      )}

      {!detailLoading && !hasChartReportData && detailData && (
        <div className="dash-empty-state" role="status">
          <h3 className="dash-empty-title">No data for this range</h3>
          <p className="dash-empty-desc">
            Nothing matched this range. Try yesterday, last 7 days, or reset filters.
          </p>
          <div className="dash-empty-actions">
            {canFilter && (
              <button type="button" className="btn-generate" onClick={() => applyPreset('yesterday')}>Try yesterday</button>
            )}
            {canFilter && (
              <button type="button" className="btn-reset" onClick={() => applyPreset('last7')}>Try last 7 days</button>
            )}
            {canFilter && (
              <button type="button" className="btn-reset" onClick={reset}>Reset filters</button>
            )}
          </div>
        </div>
      )}

      {!detailLoading && hasChartReportData && <DynamicReportTable
        title="Inventory Breakdown"
        rows={tableRows}
        dimensions={tableConfig.dimensions}
        metrics={tableConfig.metrics}
        visibility={vis}
        currency={currency}
        loading={detailLoading}
        search={search}
        onSearchChange={setSearch}
        onPageReset={() => setPage(1)}
        searchPlaceholder="Search domain / site / date…"
        page={page}
        pageSize={isNarrow ? 12 : PAGE_SIZE}
        onPageChange={setPage}
        showTotals={tableRows.length > 0}
        summaryTotals={tableSummaryTotals}
        density={tableDensity}
        freezeFirst
        headerExtra={(
          <div className="table-density-toggle" role="group" aria-label="Table density">
            <button
              type="button"
              className={`table-density-btn${tableDensity === 'compact' ? ' active' : ''}`}
              onClick={() => setTableDensity('compact')}
            >
              Compact
            </button>
            <button
              type="button"
              className={`table-density-btn${tableDensity === 'comfortable' ? ' active' : ''}`}
              onClick={() => setTableDensity('comfortable')}
            >
              Comfortable
            </button>
          </div>
        )}
        noReportMessage="No data available for this period"
        emptyMessage="No data available"
        onReset={canFilter ? reset : undefined}
        emptyActions={canFilter ? (
          <>
            <button type="button" className="btn-generate" onClick={() => applyPreset('yesterday')}>Try yesterday</button>
            <button type="button" className="btn-reset" onClick={() => applyPreset('last7')}>Try last 7 days</button>
          </>
        ) : null}
        columnStorageKey="dashboard-inventory"
        canDownload={vis.download !== false}
        exportName={`dashboard_${applied?.startDate || startDate}_${applied?.endDate || endDate}`}
      />}
        </>
      )}
      {canFilter && (
        <>
          <button type="button" className="filter-add-fab" onClick={handleAddFilter} aria-label="Add filter">
            <span className="filter-add-icon" aria-hidden>+</span>
            Add filter
          </button>
          <div className="filter-actions-foot filter-actions-foot--mobile">
            <button
              className="btn-generate"
              onClick={applyFilter}
              disabled={!canApplyInventory || customDatesIncomplete}
            >✓ Apply Filter</button>
            <button type="button" className="btn-reset-link" onClick={reset}>Reset</button>
          </div>
        </>
      )}
    </div>
  );
}
