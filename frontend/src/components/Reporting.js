import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useOutletContext } from 'react-router-dom';
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
  isPresetAllowedForRestriction,
  isFixedDateRestriction,
  isCustomRangeIncomplete,
} from '../utils/dateRestriction';
import AccessRestricted from './ui/AccessRestricted';
import MultiSelect from './ui/MultiSelect';
import FilterChips from './ui/FilterChips';
import ReportBuilderFilters, {
  DEFAULT_REPORT_DIMENSIONS,
  DEFAULT_REPORT_METRICS,
} from './ui/ReportBuilderFilters';
import ReportSettingsFilters, { DEFAULT_REPORT_SETTINGS } from './ui/ReportSettingsFilters';
import {
  dimensionsToChips,
  metricsToChips,
  reportSettingsToChips,
  dimensionLabel,
  metricLabel,
} from '../utils/gamReportCatalog';
import { buildFilterDropdownOptions } from '../utils/catalogOptions';
import { normalizeInventorySelections, slimFiltersForPersist, isAllSelection, ALL_SENTINEL } from '../utils/inventorySelection';
import { buildAppliedFilterChips, removeFilterChip } from '../utils/filterChips';
import { saveReportPage } from '../store/slices/reportSlice';
import { isReportCacheFresh } from '../hooks/useReportPageCache';
import { useMedia } from '../hooks/useMedia';
import DynamicReportTable from './ui/DynamicReportTable';
import ReportAutoCharts from './ui/ReportAutoCharts';
import GamReportControlBar from './ui/GamReportControlBar';
import {
  resolveReportTableConfig,
  buildReportColumns,
  formatCellValue,
  hasActiveReport,
} from '../utils/dynamicReportTable';
import { enrichReportRows, sortRowsByCompleteness } from '../utils/enrichReportRows';
import { resolveReportingQuery } from '../utils/reportSelection';
import { usePermissions } from '../hooks/usePermissions';
import { NO_VIEW_REPORTS_MSG, NO_VIEW_REPORTS_TITLE, getAssignedInventoryScope, hasAssignedInventory, isAdmin } from '../utils/permissions';
import {
  EMPTY_INVENTORY_FILTERS,
  draftHasInventorySelection,
  getAssignedFilterVisibility,
  initialInventoryDraft,
  shouldAutoLoadScopedInventory,
  buildAssignedInventoryFilters,
} from '../utils/assignedInventoryFilters';
import { getUserFacingMessage, logErrorForDebug } from '../utils/userFacingError';
import NoDomainsAssignedNote from './ui/NoDomainsAssignedNote';
import { getRecentFilters, saveRecentFilter, applyRecentFilter, clearRecentFilters, RECENT_FILTERS_CLEARED_EVENT } from '../utils/recentFilters';
import SavedFiltersBar from './ui/SavedFiltersBar';
import { SAVED_FILTERS_PAGES } from '../utils/savedFilters';

const PAGE_SIZE = 50;
const POLL_MS = 30 * 60 * 1000; // matches backend 30-min cache TTL

function normalizeCountry(v) {
  if (v == null || v === '') return [];
  return Array.isArray(v) ? v.filter(Boolean) : [v];
}

// Parent domain from an ad-unit name, e.g. "arenahubply.com_inter (233...)"
// → "arenahubply.com". Keep this in sync with the backend (reports.js).

function money(v, currency = 'USD') {
  const sym = currency === 'INR' ? '\u20B9' : '$';
  const num = parseFloat(v || 0);
  return `${sym}${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function num(v) {
  return parseInt(v || 0).toLocaleString();
}

export default function Reporting() {
  const dispatch = useDispatch();
  const { has, visibility: clientVis, user } = usePermissions();
  const canGenerate = has('canGenerateReports');
  const inventoryScope = getAssignedInventoryScope(user);
  const inventoryAssigned = hasAssignedInventory(user);
  const filterVisibility = getAssignedFilterVisibility(user);
  const saved = useSelector((s) => s.reports?.reporting);
  const { networkInfo } = useOutletContext();
  const dateRestriction = useMemo(() => getDateRestriction(user), [user]);
  const dateFilterLocked = Boolean(isFixedDateRestriction(dateRestriction));
  const todayInit = useMemo(() => defaultReportRangeForUser(user), [user]);
  const initDates = useMemo(() => initialReportDatesForUser(user, saved), [user, saved]);
  const buildDefaultApplied = () => ({
    ...todayInit,
    country: [],
    ...EMPTY_INVENTORY_FILTERS,
    reportDimensions: [],
    // Total revenue (+ impressions) by default so cards load without Apply.
    reportMetrics: [...DEFAULT_REPORT_METRICS],
    reportSettings: DEFAULT_REPORT_SETTINGS,
  });
  const buildScopedApplied = (dates = todayInit) => ({
    ...buildDefaultApplied(),
    ...dates,
    ...buildAssignedInventoryFilters(user),
  });
  const cacheFresh = isReportCacheFresh(saved, POLL_MS)
    && Boolean(resolveReportingQuery(saved?.applied));

  const savedInv = saved ? {
    domain: saved.domain, site: saved.site, domainName: saved.domainName, domainId: saved.domainId,
  } : {};
  const invDraft = initialInventoryDraft(user, savedInv);
  const scopedAutoLoad = shouldAutoLoadScopedInventory(user);

  const [preset, setPreset] = useState(() => saved?.preset ?? 'today');
  const [startDate, setStartDate] = useState(() => initDates.startDate);
  const [endDate, setEndDate] = useState(() => initDates.endDate);
  const [country, setCountry] = useState(() => normalizeCountry(saved?.country));
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
  const [countryOptions, setCountryOptions] = useState([]);
  const [countryLoading, setCountryLoading] = useState(true);
  const countryMultiOptions = useMemo(
    () => countryOptions.map((c) => ({ value: String(c.id), label: c.name })),
    [countryOptions]
  );

  const [filtersOpen, setFiltersOpen] = useState(() => saved?.filtersOpen ?? !filterVisibility.isScopedUser);
  const [breakdownOpen, setBreakdownOpen] = useState(() => saved?.breakdownOpen ?? true);
  const [chipsExpanded, setChipsExpanded] = useState(() => saved?.chipsExpanded ?? false);
  // Restore saved builder state; default metrics = Total revenue (+ impressions).
  const [reportDimensions, setReportDimensions] = useState(() => saved?.reportDimensions ?? []);
  const [reportMetrics, setReportMetrics] = useState(
    () => (saved?.reportMetrics?.length ? saved.reportMetrics : [...DEFAULT_REPORT_METRICS])
  );
  const [reportSettings, setReportSettings] = useState(
    () => saved?.reportSettings ?? DEFAULT_REPORT_SETTINGS
  );
  const filterPanelRef = useRef(null);

  const [applied, setApplied] = useState(() => {
    const withCountry = (obj) => ({ ...obj, country: normalizeCountry(obj?.country) });
    const ensureDefaultMetrics = (obj) => {
      const o = withCountry(obj);
      if (o.reportMetrics?.length) return o;
      return { ...o, reportMetrics: [...DEFAULT_REPORT_METRICS] };
    };
    // Domain user: never restore auto-applied full inventory — dates + default metrics only.
    if (filterVisibility.isScopedUser) {
      return ensureDefaultMetrics({
        ...buildDefaultApplied(),
        startDate: saved?.applied?.startDate || saved?.startDate || todayInit.startDate,
        endDate: saved?.applied?.endDate || saved?.endDate || todayInit.endDate,
        ...EMPTY_INVENTORY_FILTERS,
      });
    }
    if (saved?.applied) return ensureDefaultMetrics(saved.applied);
    if (scopedAutoLoad) return ensureDefaultMetrics(buildScopedApplied());
    return ensureDefaultMetrics(buildDefaultApplied());
  });
  const [data, setData] = useState(() => (cacheFresh ? saved?.data : null) ?? null);
  // Nothing loads or shows until the user clicks Apply Filter. The only
  // exception is a fresh cache from a previous session, which we restore.
  const [hasApplied, setHasApplied] = useState(
    () => Boolean(cacheFresh && (saved?.data || saved?.progData))
  );
  const [loading, setLoading] = useState(false);
  const [slowLoad, setSlowLoad] = useState(false);
  const [recentFilters, setRecentFilters] = useState(() => getRecentFilters(user?.id));
  const slowTimerRef = useRef(null);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(() => saved?.page ?? 1);
  const [search, setSearch] = useState(() => saved?.search ?? '');
  const [lastUpdated, setLastUpdated] = useState(() => saved?.lastUpdated ?? null);
  const [fetchedAt, setFetchedAt] = useState(() => saved?.fetchedAt ?? null);
  const [progData, setProgData] = useState(() => (cacheFresh ? saved?.progData : null) ?? null);
  const pollRef = useRef(null);
  const skipInitialLoadRef = useRef(cacheFresh);
  const loadGenRef = useRef(0);
  const buildingPollRef = useRef(0);

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

  const currency = data?.summary?.currency || networkInfo?.currencyCode || 'USD';
  const isNarrow = useMedia('(max-width: 768px)');

  const persistRecentFilter = useCallback(() => {
    const snapshot = {
      preset,
      startDate,
      endDate,
      country,
      domain,
      site,
      domainName,
      domainId,
      reportDimensions,
      reportMetrics,
      reportSettings,
    };
    setRecentFilters(saveRecentFilter(slimFiltersForPersist(snapshot), user?.id));
  }, [preset, startDate, endDate, country, domain, site, domainName, domainId, reportDimensions, reportMetrics, reportSettings, user?.id]);

  const getSavedFilterSnapshot = useCallback(() => slimFiltersForPersist({
    country,
    domain,
    site,
    domainName,
    domainId,
    reportDimensions,
    reportMetrics,
    reportSettings,
  }), [country, domain, site, domainName, domainId, reportDimensions, reportMetrics, reportSettings]);

  const handleApplySavedFilter = useCallback((snapshot) => {
    const nextCountry = normalizeCountry(snapshot.country);
    const nextDomain = snapshot.domain || [];
    const nextSite = snapshot.site || [];
    const nextDomainName = snapshot.domainName || [];
    const nextDomainId = snapshot.domainId || [];
    const nextDims = snapshot.reportDimensions?.length
      ? snapshot.reportDimensions
      : DEFAULT_REPORT_DIMENSIONS;
    const nextMets = snapshot.reportMetrics?.length
      ? snapshot.reportMetrics
      : DEFAULT_REPORT_METRICS;
    const nextSettings = snapshot.reportSettings && Object.keys(snapshot.reportSettings).length
      ? snapshot.reportSettings
      : DEFAULT_REPORT_SETTINGS;

    setCountry(nextCountry);
    setDomain(nextDomain);
    setSite(nextSite);
    setDomainName(nextDomainName);
    setDomainId(nextDomainId);
    setReportDimensions(nextDims);
    setReportMetrics(nextMets);
    setReportSettings(nextSettings);
    setPage(1);
    setChipsExpanded(false);
    setFiltersOpen(true);
    setData(null);
    setProgData(null);
    // Keep the user's current date range — saved filters never restore dates.
    setApplied({
      startDate,
      endDate,
      country: nextCountry,
      domain: nextDomain,
      site: nextSite,
      domainName: nextDomainName,
      domainId: nextDomainId,
      reportDimensions: nextDims,
      reportMetrics: nextMets,
      reportSettings: nextSettings,
    });
    setHasApplied(true);
  }, [startDate, endDate]);

  const load = useCallback(async (silent = false) => {
    if (!canGenerate) return;
    const query = resolveReportingQuery(applied);
    if (!query) return;
    const { dims, mets } = query;
    const loadGen = ++loadGenRef.current;
    // Cancel any in-flight building poll from a prior load.
    buildingPollRef.current += 1;
    const buildingPollId = buildingPollRef.current;

    const hasRows = (payload) => {
      if (!payload) return false;
      if (Array.isArray(payload.rows) && payload.rows.length > 0) return true;
      const s = payload.summary || {};
      return (Number(s.totalRevenue) || 0) > 0
        || (Number(s.offeredRecords) || 0) > 0
        || (Number(s.impressions) || 0) > 0;
    };

    /** Never let a later empty "building" response wipe rows we already have. */
    const applyDetailed = (payload) => {
      if (loadGen !== loadGenRef.current) return;
      setData((prev) => {
        if (payload?.status === 'building' && !hasRows(payload) && hasRows(prev)) {
          return { ...prev, status: undefined };
        }
        return payload;
      });
    };
    const applyProg = (payload) => {
      if (loadGen !== loadGenRef.current) return;
      setProgData((prev) => {
        if (payload?.status === 'building' && !hasRows(payload) && hasRows(prev)) {
          return { ...prev, status: undefined };
        }
        return payload;
      });
    };

    if (!silent) {
      setLoading(true);
      setSlowLoad(false);
      clearTimeout(slowTimerRef.current);
      slowTimerRef.current = setTimeout(() => setSlowLoad(true), 8000);
    }
    setError(null);
    try {
      const cfg = resolveReportTableConfig(dims, mets);
      const dateFilters = {
        ...normalizeInventorySelections(applied || {}, {}),
        startDate: applied.startDate || todayInit.startDate,
        endDate: applied.endDate || todayInit.endDate,
        reportDimensions: dims,
        reportMetrics: mets,
        country: applied.country,
        reportSettings: applied.reportSettings,
      };
      // Return the full capped table (up to 2500 rows) so a 30-day report is not
      // chopped to a single 50-row page. The UI paginates those rows client-side.
      const reportFilters = { ...dateFilters, allRows: true };
      const [detailed, programmatic] = await Promise.all([
        cfg.mode === 'inventory' ? reportsAPI.getDetailed(reportFilters) : Promise.resolve(null),
        cfg.mode === 'programmatic' ? reportsAPI.getProgrammatic(reportFilters).catch(() => null) : Promise.resolve(null),
      ]);
      if (loadGen !== loadGenRef.current) return;
      applyDetailed(detailed);
      applyProg(programmatic);
      setLastUpdated(nowTimeInTZ());
      setFetchedAt(Date.now());
      // Only poll when we truly have no usable data yet (don't flash building over good rows).
      const needsPoll = (!silent)
        && (
          (detailed?.status === 'building' && !hasRows(detailed))
          || (programmatic?.status === 'building' && !hasRows(programmatic))
        );
      if (needsPoll) {
        let tries = 0;
        const poll = async () => {
          if (buildingPollId !== buildingPollRef.current) return;
          tries += 1;
          if (tries > 40) return;
          await new Promise((r) => setTimeout(r, 3000));
          if (buildingPollId !== buildingPollRef.current) return;
          try {
            const [againDetailed, againProg] = await Promise.all([
              cfg.mode === 'inventory' ? reportsAPI.getDetailed(reportFilters) : Promise.resolve(null),
              cfg.mode === 'programmatic'
                ? reportsAPI.getProgrammatic(reportFilters).catch(() => null)
                : Promise.resolve(null),
            ]);
            if (buildingPollId !== buildingPollRef.current) return;
            if (againDetailed) applyDetailed(againDetailed);
            if (againProg) applyProg(againProg);
            const stillBuilding = (
              (againDetailed?.status === 'building' && !hasRows(againDetailed))
              || (againProg?.status === 'building' && !hasRows(againProg))
            );
            if (stillBuilding) {
              poll();
              return;
            }
            setLastUpdated(nowTimeInTZ());
            setFetchedAt(Date.now());
            setSlowLoad(false);
          } catch (_) { /* keep last payload */ }
        };
        poll();
      }
    } catch (err) {
      if (loadGen !== loadGenRef.current) return;
      logErrorForDebug(err, 'Reporting load');
      const status = err?.status ?? err?.response?.status ?? null;
      // Auth/permission still surface as errors; GAM incompat / empty failures → no data found.
      if (status === 401 || status === 403) {
        setError(getUserFacingMessage(err, 'Could not load the report. Please try again or narrow your filters.'));
        setData(null);
        setProgData(null);
      } else {
        setError(null);
        setData({
          rows: [],
          summary: { totalRevenue: 0, totalDomains: 0, offeredRecords: 0 },
          trend: [],
          reportWarning: 'incompatible',
          reportWarningSkipped: [
            ...dims.map((id) => dimensionLabel(id)),
            ...mets.map((id) => metricLabel(id)),
          ],
        });
        setProgData(null);
        setLastUpdated(nowTimeInTZ());
        setFetchedAt(Date.now());
      }
    } finally {
      if (!silent && loadGen === loadGenRef.current) {
        setLoading(false);
        setSlowLoad(false);
        clearTimeout(slowTimerRef.current);
      }
    }
  }, [applied, todayInit.startDate, todayInit.endDate, canGenerate]);

  useEffect(() => {
    if (!canGenerate) return;
    // Don't load anything until the user has applied a filter at least once.
    if (!hasApplied) return;
    if (skipInitialLoadRef.current) {
      skipInitialLoadRef.current = false;
      return;
    }
    load();
    setPage(1);
  }, [load, canGenerate, applied, hasApplied]);

  useEffect(() => {
    if (!canGenerate) return;
    if (!data || !fetchedAt) return;
    // Persist overview + applied filters so refresh keeps card values.
    dispatch(saveReportPage({
      pageKey: 'reporting',
      payload: {
        applied, data, progData, catalog, fetchedAt, lastUpdated,
        preset, startDate, endDate, country, domain, site, domainName, domainId,
        search, page, filtersOpen, breakdownOpen, chipsExpanded,
        reportDimensions, reportMetrics, reportSettings,
      },
    }));
  }, [
    dispatch, applied, data, progData, catalog, fetchedAt, lastUpdated,
    preset, startDate, endDate, country, domain, site, domainName, domainId,
    search, page, filtersOpen, breakdownOpen, chipsExpanded,
    reportDimensions, reportMetrics, reportSettings,
  ]);

  // Capture the full row set as the option catalogue whenever an UNFILTERED
  // report loads (no inventory filter applied), so the dropdowns always have the
  // complete list to cascade from.
  useEffect(() => {
    if (!data?.rows) return;
    if (applied.domain?.length || applied.site?.length || applied.domainName?.length || applied.domainId?.length) return;
    setCatalog(data.rows);
  }, [data, applied.domain, applied.site, applied.domainName, applied.domainId]);

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
    if (!force && catalog.length) return;
    setCatalogLoading(true);
    try {
      const res = await reportsAPI.getFilterCatalog();
      applyCatalogResponse(res);
    } catch (err) {
      logErrorForDebug(err, 'Reporting filter catalog');
      setError(getUserFacingMessage(err, 'Could not load filter options. Please refresh the page.'));
    } finally { setCatalogLoading(false); }
  }, [catalog.length, applyCatalogResponse]);

  useEffect(() => {
    if (!canGenerate) return;
    let cancelled = false;
    setCatalogLoading(true);
    reportsAPI.getFilterCatalog()
      .then((res) => { if (!cancelled) applyCatalogResponse(res); })
      .catch((err) => {
        if (!cancelled) {
          logErrorForDebug(err, 'Reporting filter catalog (initial)');
          setError(getUserFacingMessage(err, 'Could not load filter options. Please refresh the page.'));
        }
      })
      .finally(() => { if (!cancelled) setCatalogLoading(false); });
    return () => { cancelled = true; };
  }, [applyCatalogResponse, canGenerate]);

  // Selections keyed by filter field; drives bidirectional cascading so picking
  // any filter instantly narrows the other three (no Generate needed).
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

  const showNoDomainsNote = !isAdmin(user) && (!inventoryAssigned || noDomainsAssigned);

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

  // Columns the table auto-shows for the current inventory (breakdown) filters.
  // App ID pulls in BOTH App ID + App names (matches real GAM's default app
  // report), so every app resolves + is counted and revenue totals stay correct.
  const autoInventoryDims = useMemo(() => {
    const dims = [];
    if (country?.length) dims.push('country_name');
    if (domain?.length) dims.push('domain');
    if (site?.length) dims.push('site_name');
    if (domainName?.length) dims.push('ad_unit_name');
    if (domainId?.length) {
      dims.push('mobile_app_resolved_id');
      dims.push('mobile_app_name');
    }
    if (dims.length) dims.unshift('date');
    return dims;
  }, [country, domain, site, domainName, domainId]);

  // Mirror those auto columns into the Report Builder dimension picker so they
  // show as already selected — the user never has to re-check them (and can't
  // accidentally break the report by selecting only part of the set). Manual
  // dimension choices are preserved.
  const autoDimsRef = useRef([]);
  useEffect(() => {
    setReportDimensions((prev) => {
      const prevAuto = autoDimsRef.current;
      const manual = (prev || []).filter(
        (d) => !prevAuto.includes(d) && !autoInventoryDims.includes(d)
      );
      return [...autoInventoryDims, ...manual];
    });
    autoDimsRef.current = autoInventoryDims;
  }, [autoInventoryDims]);

  // Load the (lightweight) country list once for the filter dropdown.
  useEffect(() => {
    if (!canGenerate) return;
    reportsAPI.getCountries()
      .then(setCountryOptions)
      .catch(() => setCountryOptions([]))
      .finally(() => setCountryLoading(false));
  }, [canGenerate]);

  // Realtime auto-refresh for overview cards + any applied report
  useEffect(() => {
    if (!canGenerate) return undefined;
    if (!hasApplied) return undefined;
    if (!resolveReportingQuery(applied)) return undefined;
    pollRef.current = setInterval(() => load(true), POLL_MS);
    return () => clearInterval(pollRef.current);
}, [load, applied, canGenerate, hasApplied]);

  // Default metrics always allow Apply; scoped users still need inventory when they clear defaults.
  const inventoryDraft = useMemo(
    () => ({ domain, site, domainName, domainId }),
    [domain, site, domainName, domainId]
  );
  const canRunReport = Boolean(resolveReportingQuery({
    reportDimensions, reportMetrics, domain, site, domainName, domainId, country,
  })) && (!filterVisibility.isScopedUser || draftHasInventorySelection(inventoryDraft)
    || reportDimensions.length || reportMetrics.length);
  const customDatesIncomplete = isCustomRangeIncomplete(preset, startDate, endDate);
  useEffect(() => {
    if (!canRunReport) {
      setFiltersOpen(true);
    }
  }, [canRunReport]);

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
    // Predefined range: immediately update applied → triggers load() automatically.
    const r = clampPresetRange(p, dateRestriction);
    setStartDate(r.startDate);
    setEndDate(r.endDate);
    setPage(1);
    setChipsExpanded(false);
    if (resolveReportingQuery({ ...applied, startDate: r.startDate, endDate: r.endDate })) {
      setData(null);
      setProgData(null);
    }
    if (scopedAutoLoad) {
      setApplied(buildScopedApplied(r));
    } else {
      setApplied((prev) => ({ ...prev, startDate: r.startDate, endDate: r.endDate }));
    }
  };

  const applyFilter = () => {
    if (!canRunReport) return;
    if (customDatesIncomplete) return;
    const dates = clampDateRange(startDate, endDate, dateRestriction);
    setStartDate(dates.startDate);
    setEndDate(dates.endDate);
    setPage(1);
    setData(null);
    setProgData(null);
    setHasApplied(true);
    // Keep Select-All sentinel in UI; API path normalizes to [].
    setApplied({
      ...dates,
      country,
      domainName,
      domainId,
      domain,
      site,
      reportDimensions,
      reportMetrics,
      reportSettings,
    });
    persistRecentFilter();
    setFiltersOpen(false);
    setChipsExpanded(false);
    loadCatalog(true);
  };

  const appliedChips = useMemo(
    () => buildAppliedFilterChips(applied, {
      countryOptions,
      domainOptions: domainRootOptions,
      siteOptions,
      adUnitOptions,
      appOptions,
    }),
    [applied, countryOptions, domainRootOptions, siteOptions, adUnitOptions, appOptions]
  );
  const allAppliedChips = useMemo(() => {
    // Only show dim/metric chips for non-default selections so reset clears all chips visually.
    const nonDefaultDims = (applied.reportDimensions || []).filter(d => !DEFAULT_REPORT_DIMENSIONS.includes(d));
    const nonDefaultMets = (applied.reportMetrics || []).filter(m => !DEFAULT_REPORT_METRICS.includes(m));
    return [
      ...appliedChips,
      ...dimensionsToChips(nonDefaultDims),
      ...metricsToChips(nonDefaultMets),
      ...reportSettingsToChips(applied.reportSettings || DEFAULT_REPORT_SETTINGS),
    ];
  }, [appliedChips, applied.reportDimensions, applied.reportMetrics, applied.reportSettings]);

  const toggleChipsExpanded = () => setChipsExpanded((v) => !v);

  const toggleFiltersPanel = () => {
    setFiltersOpen((open) => {
      const next = !open;
      if (!next) {
        setChipsExpanded(false);
        setBreakdownOpen(false);
      }
      return next;
    });
  };

  const scrollToReportBuilder = () => {
    setFiltersOpen(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        filterPanelRef.current
          ?.querySelector('.gam-report-builder-section')
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  };

  const handleAddFilter = () => {
    scrollToReportBuilder();
  };

  const reportingQuery = useMemo(() => resolveReportingQuery(applied), [applied]);
  const hasUserReport = Boolean(reportingQuery);
  const effectiveAppliedDims = reportingQuery?.tableDims ?? reportingQuery?.dims ?? [];
  const effectiveAppliedMets = reportingQuery?.mets ?? [];
  const reportReady = hasApplied && hasUserReport && hasActiveReport(effectiveAppliedDims, effectiveAppliedMets);

  const summary = data?.summary || progData?.summary || {};
  const summaryLoading = hasUserReport && (loading || (canGenerate && !data && !progData));
  const vis = {
    ...clientVis,
    ...(data?.visibility || progData?.visibility || {}),
  };
  const canDownload = vis.download !== false;
  const canFilter = vis.filters !== false;
  const canReportBuilder = vis.reportBuilder !== false;

  // When GAM returns a partial-query warning, keep only dims/metrics that actually ran.
  // Prefer catalog ids (reportWarningUsedIds / reportWarningUsedMetricIds).
  const effectiveDims = useMemo(() => {
    if (!data?.reportWarning) return effectiveAppliedDims;

    const usedIds = new Set(
      (data.reportWarningUsedIds || []).map((s) => String(s).toLowerCase())
    );
    if (usedIds.size) {
      const matched = effectiveAppliedDims.filter((id) => usedIds.has(String(id).toLowerCase()));
      // Prefer matched columns; if ids don't align (legacy payloads), keep applied dims
      // so compatible rows still render.
      if (matched.length) return matched;
      if (Array.isArray(data?.rows) && data.rows.length) return effectiveAppliedDims;
    }

    const LABEL_ALIASES = {
      'app id': ['app id', 'package name'],
      'app names': ['app names', 'app name'],
    };
    const usedLabels = new Set(
      (data.reportWarningUsed || []).map((s) => String(s).toLowerCase())
    );
    if (usedLabels.size) {
      const matched = effectiveAppliedDims.filter((id) => {
        const label = dimensionLabel(id).toLowerCase();
        if (usedLabels.has(label)) return true;
        const aliases = LABEL_ALIASES[label] || [];
        return aliases.some((a) => usedLabels.has(a));
      });
      if (matched.length) return matched;
      if (Array.isArray(data?.rows) && data.rows.length) return effectiveAppliedDims;
    }
    return effectiveAppliedDims;
  }, [effectiveAppliedDims, data]);

  const effectiveMets = useMemo(() => {
    if (!data?.reportWarning) return effectiveAppliedMets;
    const usedMetIds = new Set(
      (data.reportWarningUsedMetricIds || []).map((s) => String(s).toLowerCase())
    );
    if (usedMetIds.size) {
      const matched = effectiveAppliedMets.filter((id) => usedMetIds.has(String(id).toLowerCase()));
      if (matched.length) return matched;
      if (Array.isArray(data?.rows) && data.rows.length) return effectiveAppliedMets;
    }
    // Partial response without metric ids: drop metrics listed as skipped by label.
    const skipped = new Set(
      (data.reportWarningSkipped || []).map((s) => String(s).toLowerCase())
    );
    if (!skipped.size) return effectiveAppliedMets;
    const kept = effectiveAppliedMets.filter((id) => !skipped.has(String(metricLabel(id)).toLowerCase()));
    return kept.length ? kept : effectiveAppliedMets;
  }, [effectiveAppliedMets, data]);

  const tableConfig = useMemo(
    () => resolveReportTableConfig(effectiveDims, effectiveMets),
    [effectiveDims, effectiveMets]
  );
  const reportColumns = useMemo(
    () => buildReportColumns(tableConfig.dimensions, tableConfig.metrics, vis),
    [tableConfig, vis]
  );

  const tableRows = useMemo(() => {
    if (tableConfig.mode === 'none') return [];
    // When there's a warning, prefer partial result rows; otherwise use mode source.
    const raw = data?.reportWarning && Array.isArray(data?.rows) && data.rows.length
      ? data.rows
      : tableConfig.mode === 'programmatic'
        ? (progData?.rows || [])
        : (data?.rows || []);
    const enriched = enrichReportRows(raw, tableConfig.dimensions, tableConfig.metrics);
    if (tableConfig.mode === 'inventory') return enriched;
    return sortRowsByCompleteness(enriched, reportColumns);
  }, [tableConfig, progData, data, reportColumns]);

  const totalRecordCount = tableRows.length;

  // Only treat as "no data" when the report is empty. If GAM returned a partial
  // compatible subset, still show those rows and warn about what was skipped.
  const skippedChips = useMemo(() => {
    if (data?.reportWarningSkipped?.length) return data.reportWarningSkipped;
    return [];
  }, [data?.reportWarningSkipped]);

  const unavailableChips = useMemo(() => {
    if (skippedChips.length) return skippedChips;
    if (!loading && reportReady && totalRecordCount === 0 && data) {
      return [
        ...effectiveAppliedDims.map((id) => dimensionLabel(id)),
        ...effectiveAppliedMets.map((id) => metricLabel(id)),
      ];
    }
    return [];
  }, [
    skippedChips,
    data,
    loading,
    reportReady,
    totalRecordCount,
    effectiveAppliedDims,
    effectiveAppliedMets,
  ]);

  const showNoReportCard = Boolean(
    reportReady
    && !loading
    && totalRecordCount === 0
    && data?.status !== 'building'
    && progData?.status !== 'building'
  );

  const showPartialCompatWarning = Boolean(
    reportReady
    && !loading
    && totalRecordCount > 0
    && skippedChips.length > 0
  );

  // Summary cards only after apply, and only when the report returned rows.
  const hasReportData = !loading && totalRecordCount > 0;
  const showSummaryCards = canGenerate && hasApplied && (loading || hasReportData);
  // Only show the hourglass when we are waiting AND have nothing useful on screen yet.
  const showBuildingBanner = Boolean(
    (data?.status === 'building' || progData?.status === 'building')
    && !hasReportData
  );

  const handleRemoveChip = (chip) => {
    if (chip.field === 'date') {
      const r = defaultReportRangeForUser(user);
      setPreset('today');
      setStartDate(r.startDate);
      setEndDate(r.endDate);
      setData(null);
      setProgData(null);
      setApplied(prev => ({ ...prev, startDate: r.startDate, endDate: r.endDate }));
      return;
    }
    if (chip.field === 'dimension') {
      const nextDims = (applied.reportDimensions || []).filter((d) => d !== chip.value);
      setReportDimensions(nextDims);
      setApplied((prev) => ({ ...prev, reportDimensions: nextDims }));
      return;
    }
    if (chip.field === 'metric') {
      const nextMets = (applied.reportMetrics || []).filter((m) => m !== chip.value);
      setReportMetrics(nextMets);
      setApplied((prev) => ({ ...prev, reportMetrics: nextMets }));
      return;
    }
    if (chip.field === 'reportSetting' && chip.settingKey) {
      const nextSettings = {
        ...(applied.reportSettings || DEFAULT_REPORT_SETTINGS),
        [chip.settingKey]: DEFAULT_REPORT_SETTINGS[chip.settingKey],
      };
      setReportSettings(nextSettings);
      setApplied((prev) => ({ ...prev, reportSettings: nextSettings }));
      return;
    }
    const draft = { startDate, endDate, country, domain, site, domainName, domainId };
    const { nextApplied, nextDraft } = removeFilterChip(applied, draft, chip, {
      countryOptions,
      domainOptions: domainRootOptions,
      siteOptions,
      adUnitOptions,
      appOptions,
    });
    setCountry(nextDraft.country || []);
    setDomain(nextDraft.domain || []);
    setSite(nextDraft.site || []);
    setDomainName(nextDraft.domainName || []);
    setDomainId(nextDraft.domainId || []);
    setApplied(nextApplied);
  };

  const reset = () => {
    const r = defaultReportRangeForUser(user);
    setPreset('today');
    setStartDate(r.startDate);
    setEndDate(r.endDate);
    setCountry([]);
    setDomain([]);
    setSite([]);
    setDomainName([]);
    setDomainId([]);
    setReportDimensions([]);
    setReportMetrics([...DEFAULT_REPORT_METRICS]);
    setReportSettings(DEFAULT_REPORT_SETTINGS);
    setFiltersOpen(!filterVisibility.isScopedUser);
    setBreakdownOpen(true);
    setChipsExpanded(false);
    setSearch('');
    setPage(1);
    setData(null);
    setProgData(null);
    setFetchedAt(null);
    setHasApplied(false);
    setLoading(false);
    setError(null);
    clearRecentFilters(user?.id);
    setRecentFilters([]);
    dispatch(saveReportPage({ pageKey: 'reporting', payload: null }));
    setApplied({
      ...r,
      country: [],
      ...EMPTY_INVENTORY_FILTERS,
      reportDimensions: [],
      reportMetrics: [...DEFAULT_REPORT_METRICS],
      reportSettings: DEFAULT_REPORT_SETTINGS,
    });
  };

  const downloadCSV = () => {
    const csvCell = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const money = (v) => {
      const sym = currency === 'INR' ? '\u20B9' : '$';
      return `${sym}${parseFloat(v || 0).toFixed(2)}`;
    };
    const numFmt = (v) => String(parseInt(v || 0, 10));
    const headers = reportColumns.map((c) => c.label);
    const lines = tableRows.map((r) => reportColumns.map((col) => {
      const raw = col.getValue(r);
      const formatted = formatCellValue(raw, col.format, currency, money, numFmt);
      return csvCell(formatted);
    }).join(','));
    const csv = [headers.join(','), ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `report_${applied.startDate}_${applied.endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!canGenerate) {
    return (
      <div className="reporting-page">
        <div className="reporting-head">
          <h2 className="page-title">Reporting</h2>
          <p className="reporting-sub">Historical report builder — select dimensions &amp; metrics, then apply filter</p>
        </div>
        <AccessRestricted title={NO_VIEW_REPORTS_TITLE} message={NO_VIEW_REPORTS_MSG} />
      </div>
    );
  }

  return (
    <div className="reporting-page">
      <div className="reporting-head">
        <h2 className="page-title">Reporting</h2>
        <p className="reporting-sub">Historical report builder — select dimensions &amp; metrics, then apply filter</p>
        {dateRestriction && (
          <p className="form-note" style={{ marginTop: 4 }}>
            {dateFilterLocked
              ? `Data locked to: ${formatDateRestrictionLabel(dateRestriction)}`
              : `Allowed filter window: ${formatDateRestrictionLabel(dateRestriction)}`}
          </p>
        )}
      </div>

      <div className={`filter-card gam-report-shell ${filtersOpen ? 'filter-card-open' : ''}`} ref={filterPanelRef}>
        <div className="filter-card-head filter-card-head-sticky">
          <button
            type="button"
            className="filter-card-title filter-card-toggle"
            onClick={toggleFiltersPanel}
            aria-expanded={filtersOpen}
          >
            Historical report {filtersOpen ? '▾' : '▸'}
          </button>
          <div className="filter-actions">
            <button className="btn-generate" onClick={applyFilter} disabled={!canFilter || !canRunReport || customDatesIncomplete}
              title={customDatesIncomplete
                ? 'Select both start and end dates, then click Apply Filter'
                : (!canRunReport ? 'Select at least one dimension, metric, or inventory filter' : (canFilter ? '' : 'You do not have permission to apply filters'))}>✓ Apply Filter</button>
            <SavedFiltersBar
              page={SAVED_FILTERS_PAGES.reporting}
              userId={user?.id}
              getSnapshot={getSavedFilterSnapshot}
              onApply={handleApplySavedFilter}
              canSave={canFilter}
              disabled={!canFilter}
            />
            {canDownload && reportReady && (
              <button className="btn-csv" onClick={downloadCSV} disabled={!tableRows.length}>⬇ Download CSV</button>
            )}
            <button className="btn-reset" onClick={reset} disabled={!canFilter}>↺ Reset</button>
          </div>
        </div>

        <ReportSettingsFilters
          settings={reportSettings}
          onChange={setReportSettings}
          preset={preset}
          onPresetChange={applyPreset}
          startDate={startDate}
          endDate={endDate}
          onStartDateChange={(v) => { setStartDate(clampDateValue(v, dateRestriction)); setPreset('custom'); }}
          onEndDateChange={(v) => { setEndDate(clampDateValue(v, dateRestriction)); setPreset('custom'); }}
          disabled={!canFilter || dateFilterLocked}
          dateRestriction={dateRestriction}
        />
        {!dateFilterLocked && preset === 'custom' && (
          <div className="custom-range-hint">
            📅 Pick <strong>start</strong> and <strong>end</strong> dates, then click <strong>Apply Filter</strong> to load data.
          </div>
        )}

        {allAppliedChips.length > 0 && (
          <FilterChips
            chips={allAppliedChips}
            expanded={chipsExpanded}
            onToggleExpand={toggleChipsExpanded}
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
              <span className="filter-section-hint">Reuse one of your recent filter sets</span>
            </div>
            <div className="preset-pills dash-preset-row">
              {recentFilters.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="preset-pill"
                  onClick={() => {
                    const snapshot = applyRecentFilter(item.snapshot);
                    if (snapshot.startDate) setStartDate(snapshot.startDate);
                    if (snapshot.endDate) setEndDate(snapshot.endDate);
                    if (snapshot.preset) setPreset(snapshot.preset);
                    if (snapshot.country) setCountry(normalizeCountry(snapshot.country));
                    if (snapshot.domain) setDomain(snapshot.domain);
                    if (snapshot.site) setSite(snapshot.site);
                    if (snapshot.domainName) setDomainName(snapshot.domainName);
                    if (snapshot.domainId) setDomainId(snapshot.domainId);
                    if (snapshot.reportDimensions) setReportDimensions(snapshot.reportDimensions);
                    if (snapshot.reportMetrics) setReportMetrics(snapshot.reportMetrics);
                    if (snapshot.reportSettings) setReportSettings(snapshot.reportSettings);
                    setApplied({ ...applied, ...snapshot, startDate: snapshot.startDate || startDate, endDate: snapshot.endDate || endDate });
                    setHasApplied(true);
                  }}
                >{item.label}</button>
              ))}
            </div>
          </div>
        )}

        <GamReportControlBar
          showWarning={!canRunReport}
          onOpenBuilder={scrollToReportBuilder}
        />

        {filtersOpen && canReportBuilder && (
          <div className="gam-report-builder-section">
            <div className="filter-section-divider" />
            <ReportBuilderFilters
              dimensions={reportDimensions}
              metrics={reportMetrics}
              onDimensionsChange={setReportDimensions}
              onMetricsChange={setReportMetrics}
              disabled={!canFilter}
            />
          </div>
        )}

        {filtersOpen && breakdownOpen && (
          <div className="gam-report-breakdown-section">
            <div className="filter-section-divider" />
            {showNoDomainsNote ? (
              <NoDomainsAssignedNote />
            ) : (
            <>
            <div className="filter-section-head" style={{ marginBottom: 12 }}>
              <span className="filter-section-title">Breakdown filters</span>
              <span className="filter-section-hint">
                {filterVisibility.isScopedUser
                  ? 'Pick from your assigned list'
                  : 'Country, domain, site, ad unit & app filters'}
                {catalogLoading ? ' · Loading options…' : ''}
              </span>
            </div>
            <div className="filter-grid">
              {!filterVisibility.isScopedUser && (
              <div className="filter-field">
                <label>Country</label>
                <MultiSelect
                  options={countryMultiOptions}
                  value={country}
                  onChange={setCountry}
                  placeholder="Select countries"
                  disabled={!canFilter}
                  loading={countryLoading}
                  selectAllLabel="Select All Countries"
                />
              </div>
              )}
              {filterVisibility.showDomain && (
              <div className="filter-field">
                <label>Domain name</label>
                <MultiSelect options={domainRootOptions} value={domain} onChange={handleDomainChange}
                  placeholder="Select domain names" disabled={!canFilter} loading={catalogLoading} />
              </div>
              )}
              {filterVisibility.showSite && (
              <div className="filter-field">
                <label>Site (URL)</label>
                <MultiSelect options={siteOptions} value={site} onChange={handleSiteChange}
                  placeholder="Select sites" disabled={!canFilter} loading={catalogLoading} />
              </div>
              )}
              {filterVisibility.showAdUnit && (
              <div className="filter-field">
                <label>Ad Unit</label>
                <MultiSelect options={adUnitOptions} value={domainName} onChange={handleAdUnitChange}
                  placeholder="Select Ad Units" disabled={!canFilter} loading={catalogLoading} />
              </div>
              )}
              {filterVisibility.showApp && (
              <div className="filter-field">
                <label>App ID</label>
                <MultiSelect options={appOptions} value={domainId} onChange={handleAppChange}
                  placeholder="Select app IDs" disabled={!canFilter} loading={catalogLoading} />
              </div>
              )}
            </div>
            </>
            )}
          </div>
        )}
        {filtersOpen && canFilter && (
          <div className="filter-actions-foot">
            <button className="btn-generate" onClick={applyFilter} disabled={!canRunReport || customDatesIncomplete}
              title={customDatesIncomplete
                ? 'Select both start and end dates, then click Apply Filter'
                : (!canRunReport ? 'Select at least one dimension, metric, or inventory filter' : '')}>
              ✓ Apply Filter
            </button>
            <button className="btn-reset" onClick={reset}>↺ Reset</button>
          </div>
        )}
        {!canFilter && (
          <p className="filter-locked-note">🔒 Filters are disabled for your account.</p>
        )}
      </div>

      {((loading && slowLoad) || showBuildingBanner) && (
        <div className="gam-report-warning" role="status">
          <span className="gam-report-warning-icon" aria-hidden>⏳</span>
          {showBuildingBanner
            ? 'Report is being prepared in the background. Results will appear shortly…'
            : 'Reports are taking longer than usual to respond. Please wait…'}
        </div>
      )}

      {error && (
        <div className="error-box">⚠️ {error} <button onClick={() => load()} className="btn-retry">Retry</button></div>
      )}

      {showSummaryCards && (
      <div className={`report-summary-row${summaryLoading ? ' is-loading' : ''}`}>
        {vis.revenue && (
          <div className={`report-sum-card${summaryLoading ? ' is-loading' : ''}`}>
            <span className="rsc-icon blue">💳</span>
            <div>
              <div className="rsc-label">Total Revenue</div>
              <div className="rsc-value">{summaryLoading ? <span className="card-spinner card-spinner-lg" aria-label="Loading" /> : money(summary.totalRevenue, currency)}</div>
            </div>
          </div>
        )}
        <div className={`report-sum-card${summaryLoading ? ' is-loading' : ''}`}>
          <span className="rsc-icon green">🌐</span>
          <div>
            <div className="rsc-label">Total App &amp; Website Domain</div>
            <div className="rsc-value">{summaryLoading ? <span className="card-spinner card-spinner-lg" aria-label="Loading" /> : num(summary.totalDomains)}</div>
          </div>
        </div>
        <div className={`report-sum-card${summaryLoading ? ' is-loading' : ''}`}>
          <span className="rsc-icon amber">📄</span>
          <div>
            <div className="rsc-label">Offered Records</div>
            <div className="rsc-value">{summaryLoading ? <span className="card-spinner card-spinner-lg" aria-label="Loading" /> : num(summary.offeredRecords)}</div>
          </div>
        </div>
        <div className="report-live">
          <span className="dot-pulse" /> {data?.isMock ? 'Mock' : 'Live'}
          {lastUpdated && <span className="report-updated">Updated {lastUpdated} SGT</span>}
        </div>
      </div>
      )}

      {showPartialCompatWarning && (
        <div className="warn-card warn-card-partial" role="status">
          <div className="warn-card-main">
            <div className="warn-card-left">
              <div className="warn-card-icon-wrap">
                <span aria-hidden>i</span>
              </div>
              <div className="warn-card-body">
                <div className="warn-card-title">Showing compatible data</div>
                <div className="warn-card-desc">
                  Some selected dimensions or metrics can&apos;t be combined in one GAM report.
                  Results below use the compatible subset. Remove the unavailable items for a complete selection.
                </div>
              </div>
            </div>
            <div className="warn-card-right">
              <div className="warn-card-section-label">Skipped (incompatible)</div>
              <div className="warn-chip-row">
                {skippedChips.map((name) => (
                  <span key={name} className="warn-chip warn-chip-unavail">{name}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {showNoReportCard && (
        <div className="warn-card" role="status">
          <div className="warn-card-main">
            <div className="warn-card-left">
              <div className="warn-card-icon-wrap">
                <span aria-hidden>i</span>
              </div>
              <div className="warn-card-body">
                <div className="warn-card-title">No report data found</div>
                <div className="warn-card-desc">
                  The highlighted dimensions on the right could not return any data for your selected filters and date range.
                  These dimensions are not supported in the current combination — remove them or adjust your selection to view complete data.
                </div>
                <div className="warn-card-btns">
                  {canFilter && (
                    <>
                      <button type="button" className="warn-btn-primary" onClick={reset}>↺ Reset Filters</button>
                      {canReportBuilder && (
                        <button
                          type="button"
                          className="warn-btn-secondary"
                          onClick={handleAddFilter}
                        >
                          ＋ Add New Filter
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="warn-card-right">
              <div className="warn-card-section-label">Unavailable dimensions for current selection</div>
              <div className="warn-chip-row">
                {unavailableChips.map((name) => (
                  <span key={name} className="warn-chip warn-chip-unavail">{name}</span>
                ))}
              </div>
            </div>
          </div>

          <div className="warn-card-hint-bar">
            <span className="warn-card-hint-icon" aria-hidden>💡</span>
            <span>Some selected filters and metrics can&apos;t be combined in the same report. Remove incompatible filters to view complete data.</span>
          </div>
        </div>
      )}

      {reportReady && (loading || hasReportData) && (
      <DynamicReportTable
        title={tableConfig.mode === 'programmatic' ? '📊 Programmatic Channel Report' : '📊 Report Data'}
        rows={tableRows}
        dimensions={tableConfig.dimensions}
        metrics={tableConfig.metrics}
        visibility={vis}
        currency={currency}
        loading={loading}
        search={search}
        onSearchChange={setSearch}
        onPageReset={() => setPage(1)}
        searchPlaceholder={
          tableConfig.mode === 'programmatic'
            ? 'Search programmatic channel…'
            : 'Search date / domain / site / ad unit…'
        }
        page={page}
        pageSize={PAGE_SIZE}
        onPageChange={setPage}
        pagination={data?.pagination || progData?.pagination || null}
        showTotals={reportReady && tableRows.length > 0}
        className="reporting-table"
        headerExtra={applied.startDate && applied.endDate
          ? <span className="report-range">{applied.startDate} → {applied.endDate}</span>
          : null}
        noReportMessage="Select at least one metric to run a report"
        emptyMessage="No data available"
      />
      )}

      {/* Auto charts — preferred visualization(s) from selected dims/metrics */}
      {reportReady && hasReportData && (
        <ReportAutoCharts
          rows={tableRows}
          trend={data?.trend || progData?.trend || []}
          dimensions={tableConfig.dimensions}
          metrics={tableConfig.metrics}
          visibility={vis}
          currency={currency}
          startDate={applied.startDate}
          endDate={applied.endDate}
          mode={tableConfig.mode}
          isNarrow={isNarrow}
        />
      )}
    </div>
  );
}
