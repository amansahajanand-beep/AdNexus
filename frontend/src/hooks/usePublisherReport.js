import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { presetRange } from '../utils/datetime';
import { getUserFacingMessage, logErrorForDebug } from '../utils/userFacingError';
import { isAllSelection } from '../utils/inventorySelection';
import { resolveCompareRange, compareLabelFor } from '../utils/periodCompare';
import { parseReportShare } from '../utils/report/reportShare';
import { filtersOnlySnapshot } from '../utils/reportPresets';
import { DATE_PRESETS } from '../utils/gamReportCatalog';

function defaultRange(timeZone) {
  // Match AdMob console: Last 7 days ends on yesterday (today is its own preset).
  return presetRange('last7', timeZone ? { timeZone } : {});
}

export const ADMOB_CORE_DIM_KEYS = ['apps', 'formats', 'countries', 'platforms'];
export const ADMOB_EXTRA_DIM_KEYS = [
  'adUnits',
  'adSources',
  'adSourceInstances',
  'mediationGroups',
];

export function publisherDimKeys(product, { includeExtra = true } = {}) {
  if (product === 'adsense') {
    return ['sites', 'countries', 'platforms'];
  }
  if (!includeExtra) return [...ADMOB_CORE_DIM_KEYS];
  return [...ADMOB_CORE_DIM_KEYS, ...ADMOB_EXTRA_DIM_KEYS];
}

const DIM_LABELS = {
  apps: 'apps',
  formats: 'formats',
  countries: 'countries',
  platforms: 'platforms',
  sites: 'sites',
  adUnits: 'ad units',
  adSources: 'ad sources',
  adSourceInstances: 'ad source instances',
  mediationGroups: 'mediation groups',
};

function toParamList(selected) {
  if (!selected?.length || isAllSelection(selected)) return undefined;
  return selected.join(',');
}

function mapFilterOptions(raw = {}) {
  const out = {};
  for (const [key, list] of Object.entries(raw || {})) {
    out[key] = (list || []).map((o) => ({
      value: o.id || o.value || o.label,
      label: o.label || o.id || o.value,
    }));
  }
  return out;
}

async function soft(promise, label) {
  try {
    return await promise;
  } catch (err) {
    logErrorForDebug(err, label);
    return null;
  }
}

function readShare() {
  if (typeof window === 'undefined') return null;
  try {
    return parseReportShare(new URLSearchParams(window.location.search));
  } catch {
    return null;
  }
}

function filtersFromShare(product, parsed) {
  if (!parsed) return {};
  const out = {};
  for (const key of publisherDimKeys(product)) {
    if (parsed[key]?.length) out[key] = parsed[key];
  }
  return out;
}

function inventoryBits(dimKeys, filters) {
  const bits = [];
  for (const key of dimKeys) {
    const vals = filters?.[key];
    if (vals?.length && !isAllSelection(vals)) {
      bits.push(`${vals.length} ${DIM_LABELS[key] || key}`);
    }
  }
  return bits;
}

/**
 * Shared AdMob / AdSense reporting state: overview, filters, breakdowns, table, freshness, compare.
 */
export default function usePublisherReport(api, {
  product = 'admob',
  enabled = true,
  canUseFilters = true,
  defaultBreakdownDim,
  defaultTableDim,
  compareMode = 'prior',
  compareStart = '',
  compareEnd = '',
  /** AdMob only: include ad unit / ad source / mediation group filters (Reporting). */
  includeExtraFilters = false,
  /** Publisher account store UUID (AdMob / AdSense). */
  accountId = null,
} = {}) {
  const dimKeys = useMemo(
    () => publisherDimKeys(product, { includeExtra: includeExtraFilters }),
    [product, includeExtraFilters]
  );
  const accountParam = accountId || undefined;
  const share = useMemo(() => readShare(), []);
  const [datePreset, setDatePreset] = useState(
    () => share?.preset || (share?.startDate && share?.endDate ? 'custom' : 'last7')
  );
  const [range, setRange] = useState(() => (
    share?.startDate && share?.endDate
      ? { startDate: share.startDate, endDate: share.endDate }
      : defaultRange()
  ));
  const [reportingTimeZone, setReportingTimeZone] = useState(null);
  const [filters, setFilters] = useState(() => {
    const fromShare = filtersFromShare(product, share);
    if (includeExtraFilters) return fromShare;
    const core = {};
    for (const key of publisherDimKeys(product, { includeExtra: false })) {
      if (fromShare[key]) core[key] = fromShare[key];
    }
    return core;
  });
  const [filterOptions, setFilterOptions] = useState({});
  const [overview, setOverview] = useState(null);
  const [breakdown, setBreakdown] = useState({ rows: [], dim: defaultBreakdownDim });
  const [secondaryBreakdown, setSecondaryBreakdown] = useState({ rows: [], dim: null });
  const [table, setTable] = useState({ rows: [], dim: defaultTableDim, visibility: null });
  const [freshness, setFreshness] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const compareRange = useMemo(
    () => resolveCompareRange(
      compareMode,
      range.startDate,
      range.endDate,
      { startDate: compareStart, endDate: compareEnd }
    ),
    [compareMode, range.startDate, range.endDate, compareStart, compareEnd]
  );
  const compareLabel = compareLabelFor(compareMode, compareRange);

  const filterParams = useMemo(() => {
    const params = {
      startDate: range.startDate,
      endDate: range.endDate,
    };
    if (accountParam) params.accountId = accountParam;
    for (const key of dimKeys) {
      const list = toParamList(filters[key]);
      if (list) params[key] = list;
    }
    return params;
  }, [range, filters, dimKeys, accountParam]);

  const overviewParams = useMemo(() => {
    const params = {
      startDate: range.startDate,
      endDate: range.endDate,
    };
    if (accountParam) params.accountId = accountParam;
    if (compareRange?.startDate && compareRange?.endDate) {
      params.compareStartDate = compareRange.startDate;
      params.compareEndDate = compareRange.endDate;
    }
    for (const key of dimKeys) {
      const list = toParamList(filters[key]);
      if (list) params[key] = list;
    }
    return params;
  }, [range.startDate, range.endDate, compareRange, filters, dimKeys, accountParam]);

  const load = useCallback(async () => {
    if (!enabled || !api) return;
    if (!range.startDate || !range.endDate) return;
    setLoading(true);
    setError(null);
    const secondaryDim = product === 'admob' ? 'format' : 'country';
    try {
      const ov = await api.overview(overviewParams);
      setOverview(ov);
      const tz = ov?.account?.reportingTimeZone || null;
      if (tz) setReportingTimeZone(tz);

      const [fresh, br, tbl, br2, filt] = await Promise.all([
        soft(
          api.freshness?.(accountParam ? { accountId: accountParam } : undefined)
            || Promise.resolve(null),
          `${product} freshness`
        ),
        soft(api.breakdowns({ ...filterParams, dim: defaultBreakdownDim, limit: 12 }), `${product} breakdown`),
        soft(api.table({ ...filterParams, dim: defaultTableDim, limit: 100 }), `${product} table`),
        soft(api.breakdowns({ ...filterParams, dim: secondaryDim, limit: 12 }), `${product} breakdown2`),
        canUseFilters && api.filters
          ? soft(api.filters({
            startDate: range.startDate,
            endDate: range.endDate,
            ...(accountParam ? { accountId: accountParam } : {}),
          }), `${product} filters`)
          : Promise.resolve(null),
      ]);

      let tablePayload = tbl;
      if (!(tablePayload?.rows || []).length && product === 'admob' && defaultTableDim !== 'app') {
        tablePayload = await soft(
          api.table({ ...filterParams, dim: 'app', limit: 100 }),
          `${product} table-app`
        ) || tablePayload;
      }

      let secondary = br2;
      if (!(secondary?.rows || []).length && product === 'admob' && secondaryDim !== 'country') {
        secondary = await soft(
          api.breakdowns({ ...filterParams, dim: 'country', limit: 12 }),
          `${product} breakdown-country`
        ) || secondary;
      }

      setFreshness(fresh);
      setBreakdown({
        rows: br?.rows || [],
        dim: br?.dim || defaultBreakdownDim,
        isSample: !!br?.isSample,
      });
      setSecondaryBreakdown({
        rows: secondary?.rows || [],
        dim: secondary?.dim || secondaryDim,
        isSample: !!secondary?.isSample,
      });
      setTable({
        rows: tablePayload?.rows || [],
        dim: tablePayload?.dim || defaultTableDim,
        isSample: !!tablePayload?.isSample,
        visibility: tablePayload?.visibility || ov?.visibility || null,
      });
      if (filt?.options) setFilterOptions(mapFilterOptions(filt.options));
    } catch (err) {
      logErrorForDebug(err, `${product} report`);
      setError(getUserFacingMessage(err, `Could not load ${product} data.`));
    } finally {
      setLoading(false);
    }
  }, [
    api, enabled, canUseFilters, product, range.startDate, range.endDate,
    filterParams, overviewParams, defaultBreakdownDim, defaultTableDim, accountParam,
  ]);

  useEffect(() => {
    load();
  }, [load]);

  // Switching AdMob/AdSense account clears inventory filters (options differ per account).
  const prevAccountRef = useRef(accountParam);
  useEffect(() => {
    if (prevAccountRef.current && accountParam && prevAccountRef.current !== accountParam) {
      setFilters({});
    }
    prevAccountRef.current = accountParam;
  }, [accountParam]);

  // Once we know the AdMob account TZ, realign named presets to that calendar.
  useEffect(() => {
    if (!reportingTimeZone || datePreset === 'custom') return;
    if (share?.startDate && share?.endDate) return;
    const next = presetRange(datePreset, { timeZone: reportingTimeZone });
    setRange((prev) => (
      prev.startDate === next.startDate && prev.endDate === next.endDate
        ? prev
        : next
    ));
  }, [reportingTimeZone, datePreset, share?.startDate, share?.endDate]);

  const setFilter = useCallback((key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }, []);

  const applyDimensionFilters = useCallback((next) => {
    setFilters(next && typeof next === 'object' ? { ...next } : {});
  }, []);

  const clearFilters = useCallback(() => setFilters({}), []);

  const getSavedFilterSnapshot = useCallback(() => {
    const snap = {};
    for (const key of dimKeys) {
      snap[key] = filters[key] || [];
    }
    return snap;
  }, [dimKeys, filters]);

  const getPresetSnapshot = useCallback(
    () => filtersOnlySnapshot(getSavedFilterSnapshot()),
    [getSavedFilterSnapshot]
  );

  const getSharePayload = useCallback(() => ({
    preset: datePreset,
    startDate: range.startDate,
    endDate: range.endDate,
    ...getSavedFilterSnapshot(),
  }), [datePreset, range.startDate, range.endDate, getSavedFilterSnapshot]);

  const applySavedSnapshot = useCallback((snapshot = {}) => {
    const next = {};
    for (const key of dimKeys) {
      next[key] = Array.isArray(snapshot[key]) ? snapshot[key] : [];
    }
    setFilters(next);
  }, [dimKeys]);

  const applyRecentSnapshot = useCallback((snapshot = {}) => {
    if (snapshot.startDate && snapshot.endDate) {
      setRange({ startDate: snapshot.startDate, endDate: snapshot.endDate });
    }
    if (snapshot.preset) setDatePreset(snapshot.preset);
    else if (snapshot.startDate && snapshot.endDate) setDatePreset('custom');
    applySavedSnapshot(snapshot);
  }, [applySavedSnapshot]);

  const filterSummary = useMemo(() => {
    const parts = [];
    const presetLabel = DATE_PRESETS.find((p) => p.id === datePreset)?.label || 'Custom';
    if (range.startDate && range.endDate) {
      parts.push(range.startDate === range.endDate ? range.startDate : `${range.startDate} → ${range.endDate}`);
    } else {
      parts.push(presetLabel);
    }
    const bits = inventoryBits(dimKeys, filters);
    parts.push(bits.length ? bits.join(', ') : 'All inventory');
    return parts.join(' · ');
  }, [datePreset, range.startDate, range.endDate, dimKeys, filters]);

  return {
    datePreset,
    setDatePreset,
    range,
    setRange,
    reportingTimeZone,
    filters,
    setFilter,
    applyDimensionFilters,
    applySavedSnapshot,
    applyRecentSnapshot,
    clearFilters,
    getSavedFilterSnapshot,
    getPresetSnapshot,
    getSharePayload,
    filterSummary,
    filterOptions,
    includeExtraFilters,
    overview,
    breakdown,
    secondaryBreakdown,
    table,
    freshness,
    loading,
    error,
    reload: load,
    compareRange,
    compareLabel,
    isSample: !overview || overview.isSample,
    visibility: overview?.visibility || table?.visibility || {
      revenue: true, impressions: true, ctr: true, ecpm: true,
    },
  };
}
