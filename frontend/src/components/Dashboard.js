import React, { useState, useEffect, useCallback, useRef, useMemo, startTransition } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useOutletContext } from 'react-router-dom';
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
import AccessRestricted from './ui/AccessRestricted';
import MultiSelect from './ui/MultiSelect';
import FilterChips from './ui/FilterChips';
import GamOverviewCard from './ui/GamOverviewCard';
import { DATE_PRESETS } from '../utils/gamReportCatalog';
import { buildFilterDropdownOptions } from '../utils/catalogOptions';
import { buildAppliedFilterChips, removeFilterChip } from '../utils/filterChips';
import { normalizeInventorySelections, slimFiltersForPersist, isAllSelection, ALL_SENTINEL } from '../utils/inventorySelection';
import { saveReportPage } from '../store/slices/reportSlice';
import { isReportCacheFresh } from '../hooks/useReportPageCache';
import { useMedia } from '../hooks/useMedia';
import DynamicReportTable from './ui/DynamicReportTable';
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
import ScrollableChart from './ui/ScrollableChart';
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
import NoDomainsAssignedNote from './ui/NoDomainsAssignedNote';
import {
  getRecentFilters,
  saveRecentFilter,
  applyRecentFilter,
  removeRecentFilter,
  clearRecentFilters,
  RECENT_FILTERS_CLEARED_EVENT,
} from '../utils/recentFilters';
import SavedFiltersBar from './ui/SavedFiltersBar';
import { SAVED_FILTERS_PAGES } from '../utils/savedFilters';

const SHARE_COLORS = ['#1a73e8', '#34a853', '#f29900', '#ea4335', '#8e24aa', '#00acc1'];

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

/** True when a chart series has at least one positive value to plot. */
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
  site_name: ['siteName', 'site', 'gamSite', 'SITE_NAME'],
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

function buildPerformanceSeries(rows = []) {
  const totals = new Map();
  rows.forEach((row) => {
    const label = resolveLabel(row, ['ad_unit_name', 'site_name', 'domain', 'mobile_app_name', 'line_item_name', 'campaign_name', 'adUnitName', 'siteName', 'domainName', 'appName', 'mobileAppName', 'campaignName']);
    if (!label || label === 'Uncategorized') return;
    const entry = totals.get(label) || {
      name: label,
      revenue: 0,
      impressions: 0,
      ctr: 0,
      ecpm: 0,
      viewability: 0,
      count: 0,
    };
    entry.revenue += toNumber(readValue(row, ['revenue', 'total_line_item_level_cpm_and_cpc_revenue'], ['earnings']));
    entry.impressions += toNumber(readValue(row, ['impression', 'impressions', 'total_line_item_level_impressions'], ['impressionsTotal']));
    entry.ctr += toNumber(readValue(row, ['ctr', 'total_line_item_level_ctr'], ['clickThroughRate']));
    entry.ecpm += toNumber(readValue(row, ['ecpm', 'total_line_item_level_without_cpd_average_ecpm'], ['averageEcpM']));
    entry.viewability += toNumber(readValue(row, ['viewability', 'viewableRate', 'total_active_view_viewable_impressions_rate'], ['viewableRatePercent']));
    entry.count += 1;
    totals.set(label, entry);
  });
  return Array.from(totals.values())
    .map((entry) => ({
      ...entry,
      ctr: entry.count ? entry.ctr / entry.count : 0,
      ecpm: entry.count ? entry.ecpm / entry.count : 0,
      viewability: entry.count ? entry.viewability / entry.count : 0,
      score: Math.max(0, (entry.ctr || 0) * 400 + (entry.ecpm || 0) * 3 + (entry.viewability || 0) * 200),
    }))
    .filter((entry) => entry.revenue > 0 || entry.impressions > 0)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 6);
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
  const [chipsExpanded, setChipsExpanded] = useState(() => saved?.chipsExpanded ?? false);
  const [slowDetail, setSlowDetail] = useState(false);
  const [recentFilters, setRecentFilters] = useState(() => getRecentFilters(user?.id));
  const pollRef = useRef(null);
  const filterPanelRef = useRef(null);
  const skipDetailRef = useRef(cacheFresh && saved?.filterApplied);
  const slowTimerRef = useRef(null);

  useEffect(() => {
    setRecentFilters(getRecentFilters(user?.id));
  }, [user?.id]);

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
    if (!silent) setOverviewLoading(true);
    setError(null);
    try {
      const res = await reportsAPI.getDashboardOverview(filters);
      setOverviewData(res);
      setLastUpdated(nowTimeInTZ());
    } catch (err) {
      logErrorForDebug(err, 'Dashboard overview');
      setError(getUserFacingMessage(err, 'Could not load overview metrics. Please try again.'));
    } finally {
      if (!silent) setOverviewLoading(false);
    }
  }, [overviewFilters]);

  const currency = overviewData?.summary?.currency || overviewData?.currency
    || detailData?.summary?.currency || networkInfo?.currencyCode || 'USD';
  const isNarrow = useMedia('(max-width: 768px)');

  /** Full breakdown — after Apply Filter. */
  const loadDetail = useCallback(async (silent = false) => {
    if (!silent) {
      setDetailLoading(true);
      setSlowDetail(false);
      clearTimeout(slowTimerRef.current);
      slowTimerRef.current = setTimeout(() => setSlowDetail(true), 8000);
    }
    setError(null);
    try {
      // Compact dashboard payload (SQL charts + capped table). Do NOT request allRows —
      // wide ranges were shipping 100k–700k grain rows and freezing the UI.
      const res = await reportsAPI.getDashboard({
        ...normalizeInventorySelections(applied || {}, {}),
      });
      startTransition(() => {
        setDetailData(res);
        setLastUpdated(nowTimeInTZ());
        setFetchedAt(Date.now());
      });
    } catch (err) {
      logErrorForDebug(err, 'Dashboard detail');
      const status = err?.status ?? err?.response?.status ?? null;
      // Auth/permission still surface as errors; filter incompat / empty → warn card like Reporting.
      if (status === 401 || status === 403) {
        setError(getUserFacingMessage(err, 'Could not load the chart and breakdown table. Try Apply Filter again or use a shorter date range.'));
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
      if (!silent) {
        setDetailLoading(false);
        setSlowDetail(false);
        clearTimeout(slowTimerRef.current);
      }
    }
  }, [applied]);

  useEffect(() => {
    if (filterApplied && hasInventoryFilterSelection(applied)) return;
    loadOverview();
  }, [loadOverview, filterApplied, applied]);

  useEffect(() => {
    if (!canGenerate) return;
    if (!filterApplied) return;
    if (skipDetailRef.current) {
      skipDetailRef.current = false;
      return;
    }
    loadDetail();
    setPage(1);
  }, [filterApplied, applied, loadDetail, canGenerate]);

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
    pollRef.current = setInterval(() => {
      if (!(filterApplied && hasInventoryFilterSelection(applied))) {
        loadOverview(undefined, true);
      }
      if (canGenerate && filterApplied) loadDetail(true);
    }, POLL_MS);
    return () => clearInterval(pollRef.current);
  }, [loadOverview, loadDetail, filterApplied, applied, canGenerate]);

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

  const handleAddFilter = () => {
    setBreakdownOpen(true);
    loadCatalog(true);
    requestAnimationFrame(() => {
      filterPanelRef.current?.querySelector('.dash-breakdown-section')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

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
    setFetchedAt(null);
    clearRecentFilters(user?.id);
    setRecentFilters([]);
    dispatch(saveReportPage({ pageKey: 'dashboard', payload: null }));
    setApplied({ ...r, ...EMPTY_INVENTORY_FILTERS });
  };

  const vis = {
    ...clientVis,
    ...(overviewData?.visibility || detailData?.visibility || {}),
  };
  const canFilter = vis.filters !== false;
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

  const tableSummaryTotals = useMemo(() => {
    const s = detailData?.summary;
    if (!s) return null;
    return {
      total_line_item_level_all_revenue: s.revenue ?? s.selectRange ?? 0,
      total_line_item_level_impressions: s.impressions ?? 0,
      total_line_item_level_without_cpd_average_ecpm: s.ecpm ?? 0,
      total_active_view_viewable_impressions_rate: s.viewability ?? 0,
    };
  }, [detailData?.summary]);

  const tableRows = useMemo(() => {
    if (!filterApplied) return [];
    const raw = detailData?.rows || [];
    const enriched = enrichReportRows(raw, tableConfig.dimensions, tableConfig.metrics, { useProxy: false });
    return aggregateRowsByColumns(enriched, tableColumns);
  }, [filterApplied, detailData, tableConfig, tableColumns]);

  const overviewSummary = useMemo(() => {
    const fromDetail = mapDetailSummary(detailData?.summary);

    if (isScopedDashboardUser) {
      if (hasInventoryFilter) {
        if (fromDetail && !detailLoading) return fromDetail;
        if (fromDetail) return fromDetail;
        if (detailData && tableRows.length) return summarizeRowsForOverview(tableRows, currency);
        return {};
      }
      return overviewData?.summary || {};
    }

    if (hasInventoryFilter && fromDetail && !detailLoading) return fromDetail;
    if (hasInventoryFilter && detailData) {
      return fromDetail || summarizeRowsForOverview(tableRows, currency);
    }
    return overviewData?.summary || {};
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
      'total_line_item_level_without_cpd_average_ecpm',
      'total_active_view_viewable_impressions_rate',
    ]);
  }, [detailData?.rows]);

  const dailySeries = useMemo(() => {
    if (!filterApplied) return [];
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
  }, [filterApplied, enrichedRows, detailData?.trend]);

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

  const performanceSeries = useMemo(() => {
    if (Array.isArray(detailData?.charts?.performance) && detailData.charts.performance.length) {
      return detailData.charts.performance;
    }
    return buildPerformanceSeries(enrichedRows);
  }, [enrichedRows, detailData?.charts?.performance]);

  const dailyWithEcpm = useMemo(() => withDailyEcpm(dailySeries), [dailySeries]);

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
  const siteShareSeries = useMemo(
    () => buildSiteRevenueShare(enrichedRows, 10),
    [enrichedRows]
  );
  const adUnitMixSeries = useMemo(
    () => (performanceSeries || []).map((row) => ({
      name: row.name,
      revenue: toNumber(row.revenue),
      impressions: toNumber(row.impressions),
    })).filter((row) => row.revenue > 0 || row.impressions > 0),
    [performanceSeries]
  );
  const showRevenueCharts = vis.revenue !== false;
  const showImpressionCharts = vis.impressions !== false;
  const showEcpmCharts = showRevenueCharts && showImpressionCharts;

  const hasFilteredReportData = useMemo(() => {
    if (!hasInventoryFilter) return false;
    if (detailData?.summary && (
      (Number(detailData.summary.impressions) || 0) > 0
      || (Number(detailData.summary.revenue) || 0) > 0
    )) {
      return true;
    }
    return enrichedRows.some((row) => {
      const impressions = toNumber(readValue(row, ['impression', 'impressions', 'total_line_item_level_impressions'], ['impressionsTotal']));
      const revenue = toNumber(readValue(row, ['revenue', 'total_line_item_level_cpm_and_cpc_revenue'], ['earnings']));
      return impressions > 0 || revenue > 0;
    });
  }, [hasInventoryFilter, enrichedRows, detailData?.summary]);

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

  const presetLabel = DATE_PRESETS.find(p => p.id === preset)?.label || 'Custom';
  const isMock = overviewData?.isMock || detailData?.isMock;


  return (
    <div className="dashboard-page">
      <div className="reporting-head">
        <h2 className="page-title">Dashboard</h2>
        <p className="reporting-sub">Overview shows your full assigned revenue; apply filters to narrow KPIs, chart &amp; table</p>
        {dateRestriction && (
          <p className="form-note" style={{ marginTop: 4 }}>
            {dateFilterLocked
              ? `Data locked to: ${formatDateRestrictionLabel(dateRestriction)}`
              : `Allowed filter window: ${formatDateRestrictionLabel(dateRestriction)}`}
          </p>
        )}
      </div>

      {canGenerate && (
      <div className="filter-card dash-overview-shell" ref={filterPanelRef}>
        <div className="dash-date-toolbar filter-card-head-sticky">
          <div className="dash-date-display">
            <span className="dash-date-label">📅 {presetLabel}</span>
            <span className="dash-date-range">
              {customDatesIncomplete
                ? 'Select start & end dates'
                : (startDate && endDate
                  ? (startDate !== endDate ? `${startDate} → ${endDate}` : startDate)
                  : '…')}
            </span>
          </div>
          <div className="filter-actions">
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
              📅 Pick <strong>start</strong> and <strong>end</strong> dates, then click <strong>Apply Filter</strong> to load data.
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

        {breakdownOpen && (
          <div className="dash-breakdown-section gam-report-breakdown-section">
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
        {(breakdownOpen || filterApplied) && canFilter && (
          <div className="filter-actions-foot">
            <button className="btn-generate" onClick={applyFilter}
              disabled={!canApplyInventory || customDatesIncomplete}>✓ Apply Filter</button>
            <button className="btn-reset" onClick={reset}>↺ Reset</button>
          </div>
        )}
        {!canFilter && (
          <p className="filter-locked-note">🔒 Filters are disabled for your account.</p>
        )}
      </div>
      )}

      {error && (
        <div className="error-box">⚠️ {error}
          <button onClick={() => { loadOverview(); if (canGenerate && filterApplied) loadDetail(); }} className="btn-retry">Retry</button>
        </div>
      )}

      {!(hasInventoryFilter && !detailLoading && !hasFilteredReportData) && (
        <div className="dash-overview-row">
          <GamOverviewCard
            summary={overviewSummary}
            currency={currency}
            loading={overviewCardLoading}
          />
        </div>
      )}

      {!canGenerate ? (
        <AccessRestricted title={NO_VIEW_REPORTS_TITLE} message={NO_VIEW_REPORTS_MSG} />
      ) : (
        <>
      {detailLoading && slowDetail && (
        <div className="gam-report-warning" role="status">
          <span className="gam-report-warning-icon" aria-hidden>⏳</span>
          Reports are taking longer than usual to respond. Please wait…
        </div>
      )}

      {hasInventoryFilter && detailLoading && (
        <div className="spinner-wrap"><div className="spinner" /></div>
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
                      <button type="button" className="warn-btn-primary" onClick={reset}>↺ Reset Filters</button>
                      <button type="button" className="warn-btn-secondary" onClick={handleAddFilter}>
                        ＋ Add New Filter
                      </button>
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
            <span className="warn-card-hint-icon" aria-hidden>💡</span>
            <span>Some selected filters can&apos;t be combined in the same report. Remove incompatible filters to view complete data.</span>
          </div>
        </div>
      )}

      {hasInventoryFilter && !detailLoading && hasFilteredReportData && (
        <>
          {hasChartData(dailySeries, ['revenue', 'impressions']) && (
          <div className="chart-card wide">
            <div className="chart-header">
              <h3 className="chart-title">Revenue growth &amp; impressions</h3>
              {filterApplied && (
                <div className="report-live">
                  <span className="dot-pulse" /> {isMock ? 'Mock' : 'Live'}
                  {lastUpdated && <span className="report-updated">Updated {lastUpdated} SGT</span>}
                </div>
              )}
            </div>
              <ScrollableChart pointCount={dailySeries.length} isNarrow={isNarrow} height={isNarrow ? 320 : 310}>
                <AreaChart data={dailySeries} margin={dailyChartMargins}>
                  <defs>
                    <linearGradient id="dashEarnGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#1a73e8" stopOpacity={0.28} />
                      <stop offset="95%" stopColor="#1a73e8" stopOpacity={0.04} />
                    </linearGradient>
                    <linearGradient id="dashImpsGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#34a853" stopOpacity={0.22} />
                      <stop offset="95%" stopColor="#34a853" stopOpacity={0.04} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="date" {...dailyDateAxis} />
                  <YAxis
                    yAxisId="left"
                    tick={{ fontSize: isNarrow ? 10 : 11, fill: '#5f6368' }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => formatAxisMoney(v, currency)}
                    width={dailyMoneyWidth}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ fontSize: isNarrow ? 10 : 11, fill: '#5f6368' }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => formatAxisNumber(v)}
                    width={dailyImpWidth}
                  />
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '0.5px solid #e0e0e0' }}
                    labelFormatter={(label) => String(label || '')}
                    formatter={(v, name) => (name === 'Revenue' ? [money(v, currency), 'Revenue'] : [num(v), 'Impressions'])} />
                  <Area yAxisId="left" type="monotone" dataKey="revenue" stroke="#1a73e8" strokeWidth={2}
                    fill="url(#dashEarnGrad)" fillOpacity={1} dot={false} activeDot={{ r: 4 }} name="Revenue" isAnimationActive={false} />
                  <Area yAxisId="right" type="monotone" dataKey="impressions" stroke="#34a853" strokeWidth={2}
                    fill="url(#dashImpsGrad)" fillOpacity={1} dot={false} activeDot={{ r: 4 }} name="Impressions" isAnimationActive={false} />
                </AreaChart>
              </ScrollableChart>
          </div>
          )}

          {(hasChartData(shareSeries.revenue) || hasChartData(shareSeries.device) || hasChartData(shareSeries.country)
            || (showEcpmCharts && hasChartData(dailyWithEcpm, ['ecpm']))
            || (showRevenueCharts && !showEcpmCharts && hasChartData(siteShareSeries))) && (
          <div className="charts-grid">
            {hasChartData(shareSeries.revenue) && (
            <div className="chart-card">
              <div className="chart-header">
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
              <ResponsiveContainer width="100%" height={220}>
                <PieChart className="chart-pie-no-focus">
                  <Pie
                    data={shareSeries.revenue}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={48}
                    outerRadius={78}
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
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </div>
            )}

            {hasChartData(shareSeries.device) && (
            <div className="chart-card">
              <div className="chart-header">
                <h3 className="chart-title">Device share</h3>
                <span className="filter-section-hint">Laptop · Mobile · Tablet</span>
              </div>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={shareSeries.device} layout="vertical" margin={hBarMargins}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
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

            {hasChartData(shareSeries.country) && (
            <div className="chart-card">
              <div className="chart-header">
                <h3 className="chart-title">Country share</h3>
                <span className="filter-section-hint">Top 10 countries</span>
              </div>
              <ResponsiveContainer width="100%" height={260}>
                <PieChart className="chart-pie-no-focus">
                  <Pie
                    data={shareSeries.country}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={48}
                    outerRadius={78}
                    paddingAngle={2}
                    isAnimationActive={false}
                    stroke="none"
                    label={isNarrow
                      ? false
                      : ({ name, percent }) => `${name} (${(percent * 100).toFixed(0)}%)`}
                    labelLine={isNarrow ? false : { stroke: '#9aa0a6', strokeWidth: 1 }}
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
                  <Legend
                    layout="horizontal"
                    verticalAlign="bottom"
                    align="center"
                    formatter={(value) => <span style={{ color: '#333', fontSize: 11 }}>{value}</span>}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            )}

            {showEcpmCharts && hasChartData(dailyWithEcpm, ['ecpm']) ? (
              <div className="chart-card">
                <div className="chart-header">
                  <h3 className="chart-title">Daily eCPM</h3>
                  <span className="filter-section-hint">Revenue / impressions × 1000</span>
                </div>
                <ScrollableChart pointCount={dailyWithEcpm.length} isNarrow={isNarrow} height={isNarrow ? 320 : 310}>
                  <LineChart data={dailyWithEcpm} margin={dailyEcpmMargins}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis dataKey="date" {...dailyDateAxis} />
                    <YAxis
                      tick={{ fontSize: isNarrow ? 10 : 11, fill: '#5f6368' }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v) => formatAxisMoney(v, currency)}
                      width={dailyMoneyWidth}
                    />
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '0.5px solid #e0e0e0' }}
                      labelFormatter={(label) => String(label || '')}
                      formatter={(v) => [money(v, currency), 'eCPM']} />
                    <Line type="monotone" dataKey="ecpm" name="eCPM" stroke="#8e24aa" strokeWidth={2} dot={dailyWithEcpm.length <= 31} />
                  </LineChart>
                </ScrollableChart>
              </div>
            ) : (showRevenueCharts && hasChartData(siteShareSeries)) ? (
              <div className="chart-card">
                <div className="chart-header">
                  <h3 className="chart-title">Top sites</h3>
                  <span className="filter-section-hint">Top 10 by revenue</span>
                </div>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={siteShareSeries} layout="vertical" margin={hBarMargins}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis type="number" tick={false} axisLine={false} />
                    <YAxis dataKey="name" type="category" width={catAxisW} tick={{ fontSize: isNarrow ? 10 : 11 }} axisLine={false} tickLine={false}
                    tickFormatter={(v) => truncateAxisLabel(v, catLabelMax)} />
                    <Tooltip formatter={(value, _n, item) => [money(value, currency), item?.payload?.name || 'Site']} />
                    <Bar dataKey="value" radius={[0, 6, 6, 0]}>
                      {siteShareSeries.map((entry, idx) => (
                        <Cell key={`${entry.name}-${idx}`} fill={SHARE_COLORS[idx % SHARE_COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : null}
          </div>
          )}

          {hasChartData(performanceSeries, ['score', 'value']) && (
          <div className="chart-card wide">
            <div className="chart-header">
              <h3 className="chart-title">Ad performance</h3>
              <span className="filter-section-hint">Compact score by ad unit</span>
            </div>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={performanceSeries} layout="vertical" margin={hBarMargins}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis type="number" tick={false} axisLine={false} />
                <YAxis dataKey="name" type="category" width={catAxisW} tick={{ fontSize: isNarrow ? 10 : 11 }} axisLine={false} tickLine={false}
                    tickFormatter={(v) => truncateAxisLabel(v, catLabelMax)} />
                <Tooltip formatter={(value) => [Number(value).toFixed(0), 'Performance score']} />
                <Bar dataKey="score" radius={[0, 6, 6, 0]} fill="#b91c1c" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          )}

          {showEcpmCharts && hasChartData(dailyWithEcpm, ['revenue', 'ecpm']) && (
            <div className="chart-card wide">
              <div className="chart-header">
                <h3 className="chart-title">Revenue vs eCPM</h3>
                <span className="filter-section-hint">Daily revenue bars with eCPM overlay</span>
              </div>
              <ScrollableChart pointCount={dailyWithEcpm.length} isNarrow={isNarrow} height={isNarrow ? 320 : 310}>
                <ComposedChart data={dailyWithEcpm} margin={dailyEcpmMargins}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="date" {...dailyDateAxis} />
                  <YAxis
                    yAxisId="left"
                    tick={{ fontSize: isNarrow ? 10 : 11, fill: '#5f6368' }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => formatAxisMoney(v, currency)}
                    width={dailyMoneyWidth}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ fontSize: isNarrow ? 10 : 11, fill: '#5f6368' }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => formatAxisMoney(v, currency)}
                    width={dailyEcpmWidth}
                  />
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '0.5px solid #e0e0e0' }}
                    labelFormatter={(label) => String(label || '')}
                    formatter={(v, name) => [money(v, currency), name]} />
                  <Legend />
                  <Bar yAxisId="left" dataKey="revenue" name="Revenue" fill="#1a73e8" radius={[4, 4, 0, 0]} maxBarSize={isNarrow ? 14 : 28} />
                  <Line yAxisId="right" type="monotone" dataKey="ecpm" name="eCPM" stroke="#f29900" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ScrollableChart>
            </div>
          )}

          {((showRevenueCharts && showEcpmCharts && hasChartData(siteShareSeries))
            || ((showRevenueCharts || showImpressionCharts) && hasChartData(adUnitMixSeries, ['revenue', 'impressions']))) && (
          <div className="charts-grid">
            {showRevenueCharts && showEcpmCharts && hasChartData(siteShareSeries) && (
              <div className="chart-card">
                <div className="chart-header">
                  <h3 className="chart-title">Top sites</h3>
                  <span className="filter-section-hint">Top 10 by revenue</span>
                </div>
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={siteShareSeries} layout="vertical" margin={hBarMargins}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis type="number" tick={false} axisLine={false} />
                    <YAxis dataKey="name" type="category" width={catAxisW} tick={{ fontSize: isNarrow ? 10 : 11 }} axisLine={false} tickLine={false}
                    tickFormatter={(v) => truncateAxisLabel(v, catLabelMax)} />
                    <Tooltip formatter={(value, _n, item) => [money(value, currency), item?.payload?.name || 'Site']} />
                    <Bar dataKey="value" radius={[0, 6, 6, 0]}>
                      {siteShareSeries.map((entry, idx) => (
                        <Cell key={`${entry.name}-${idx}`} fill={SHARE_COLORS[idx % SHARE_COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {(showRevenueCharts || showImpressionCharts) && hasChartData(adUnitMixSeries, ['revenue', 'impressions']) && (
              <div className="chart-card">
                <div className="chart-header">
                  <h3 className="chart-title">Ad unit mix</h3>
                  <span className="filter-section-hint">Revenue and impressions by ad unit</span>
                </div>
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={adUnitMixSeries} layout="vertical" margin={hBarMargins}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis type="number" tick={false} axisLine={false} />
                    <YAxis dataKey="name" type="category" width={catAxisW} tick={{ fontSize: isNarrow ? 10 : 11 }} axisLine={false} tickLine={false}
                    tickFormatter={(v) => truncateAxisLabel(v, catLabelMax)} />
                    <Tooltip formatter={(value, name) => (
                      name === 'Revenue' ? [money(value, currency), name] : [num(value), name]
                    )} />
                    <Legend />
                    {showRevenueCharts && (
                      <Bar dataKey="revenue" name="Revenue" fill="#1a73e8" radius={[0, 6, 6, 0]} />
                    )}
                    {showImpressionCharts && (
                      <Bar dataKey="impressions" name="Impressions" fill="#34a853" radius={[0, 6, 6, 0]} />
                    )}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
          )}
        </>
      )}

      {!hasInventoryFilter && (
        <div className="no-filter-hint">
          <span className="no-filter-hint-icon">📂</span>
          <p className="no-filter-hint-title">Select an inventory filter to view chart &amp; table</p>
          <p className="no-filter-hint-sub">
            {filterVisibility.isScopedUser
              ? 'Pick from your assigned list above and click Apply Filter.'
              : <>Choose a domain, site, ad unit, or app above and click <strong>Apply Filter</strong>.</>}
          </p>
        </div>
      )}

      {hasInventoryFilter && !detailLoading && hasFilteredReportData && <DynamicReportTable
        title="📄 Inventory Breakdown"
        rows={tableRows}
        dimensions={tableConfig.dimensions}
        metrics={tableConfig.metrics}
        visibility={vis}
        currency={currency}
        loading={filterApplied && detailLoading}
        search={search}
        onSearchChange={setSearch}
        onPageReset={() => setPage(1)}
        searchPlaceholder="Search domain / site / date…"
        page={page}
        pageSize={PAGE_SIZE}
        onPageChange={setPage}
        showTotals={filterApplied && tableRows.length > 0}
        summaryTotals={tableSummaryTotals}
        noReportMessage="No data available for this period"
        emptyMessage="No data available"
      />}
        </>
      )}
    </div>
  );
}
