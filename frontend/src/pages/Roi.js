import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import PageHeader from '../components/ui/PageHeader';
import RoiCountryTreeTable from '../components/roi/RoiCountryTreeTable';
import CompareRangeBar from '../components/ui/CompareRangeBar';
import SavePresetButton from '../components/ui/SavePresetButton';
import DataFreshness from '../components/ui/DataFreshness';
import ThresholdAlertBanner from '../components/ui/ThresholdAlertBanner';
import { adsAPI, roiAPI, usersAPI } from '../utils/api';
import MultiSelect from '../components/ui/MultiSelect';
import RoiFilterRow from '../components/roi/RoiFilterRow';
import RoiFilterSection from '../components/roi/RoiFilterSection';
import {
  ALL_SENTINEL,
  isAllSelection,
  toAllSelection,
  collapseFullSelection,
  optionValues,
} from '../utils/inventorySelection';
import { DATE_PRESETS } from '../utils/gamReportCatalog';
import {
  getDateRestriction,
  clampPresetRange,
  clampDateRange,
  defaultReportRangeForUser,
  allowedDatePresets,
  isCustomRangeIncomplete,
  isFixedDateRestriction,
  formatDateRestrictionLabel,
  clampDateValue,
} from '../utils/dateRestriction';
import { useAuth } from '../store/useAuth';
import { nowTimeInTZ } from '../utils/datetime';
import { getUserFacingMessage, logErrorForDebug } from '../utils/userFacingError';
import { useMedia } from '../hooks/useMedia';
import { showToast } from '../hooks/useToast';
import { parseReportShare, copyReportLink } from '../utils/reportShare';
import { PRESET_PAGES } from '../utils/reportPresets';
import { getLastPageFilters, saveLastPageFilters, LAST_FILTER_PAGES } from '../utils/lastPageFilters';
import { loadComparePrefs, saveComparePrefs } from '../utils/dashCharts';
import {
  resolveCompareRange,
  compareLabelFor,
  pctChange,
  previousPeriodRange,
  isPeriodAllowed,
} from '../utils/periodCompare';
import { evaluateRoiThresholds } from '../utils/thresholdAlerts';
import {
  buildRoiSummaryCards,
  buildCountryTree,
  formatRoiMoney,
  formatRoiPct,
  labelsForSelection,
  roiToneClass,
} from '../utils/report/roiView';

const ROI_TIP_KEY = 'adnexus.guide.roi.v1';

function money(n) {
  return formatRoiMoney(n);
}

function pct(n) {
  return formatRoiPct(n);
}

function roiTone(n) {
  return roiToneClass(n);
}

function emptyExpenseSlot() {
  return {
    amount: '',
    label: '',
    targetType: 'general',
    targetKey: '',
    notes: '',
  };
}

function DeltaLine({ change, compareLabel, loading }) {
  if (loading || change === undefined || change === null) return null;
  const n = Number(change);
  if (!Number.isFinite(n) || Math.abs(n) < 0.05) {
    return (
      <span className="gam-overview-delta is-flat">
        No change
        {compareLabel ? <span className="gam-overview-delta-vs"> {compareLabel}</span> : null}
      </span>
    );
  }
  const isDown = n < 0;
  return (
    <span className={`gam-overview-delta ${isDown ? 'down' : 'up'}`}>
      {isDown ? '▼' : '▲'} {Math.abs(n).toFixed(1)}%
      {compareLabel ? <span className="gam-overview-delta-vs"> {compareLabel}</span> : null}
    </span>
  );
}

export default function Roi() {
  const { user } = useAuth();
  const outlet = useOutletContext() || {};
  const networkInfo = outlet.networkInfo;
  const [searchParams] = useSearchParams();
  const dateRestriction = useMemo(() => getDateRestriction(user), [user]);
  const dateFilterLocked = isFixedDateRestriction(dateRestriction);
  const presetOptions = useMemo(
    () => (dateFilterLocked ? [] : allowedDatePresets(dateRestriction, DATE_PRESETS)),
    [dateRestriction, dateFilterLocked]
  );
  const todayInit = useMemo(() => defaultReportRangeForUser(user), [user]);

  const [preset, setPreset] = useState('today');
  const [startDate, setStartDate] = useState(() => {
    const r = clampPresetRange('today', getDateRestriction(user));
    return r?.startDate || todayInit.startDate;
  });
  const [endDate, setEndDate] = useState(() => {
    const r = clampPresetRange('today', getDateRestriction(user));
    return r?.endDate || todayInit.endDate;
  });
  const [applied, setApplied] = useState(() => {
    const r = clampPresetRange('today', getDateRestriction(user));
    return {
      startDate: r?.startDate || todayInit.startDate,
      endDate: r?.endDate || todayInit.endDate,
      targetType: 'all',
      accountIds: null,
      campaignIds: null,
      appKeys: null,
      siteKeys: null,
      countryCodes: null,
    };
  });
  const [filterAccountIds, setFilterAccountIds] = useState(() => toAllSelection());
  const [filterCampaignIds, setFilterCampaignIds] = useState(() => toAllSelection());
  const [filterAppKeys, setFilterAppKeys] = useState(() => toAllSelection());
  const [filterSiteKeys, setFilterSiteKeys] = useState([]);
  const [filterCountryCodes, setFilterCountryCodes] = useState(() => toAllSelection());
  const [roiAccountOptions, setRoiAccountOptions] = useState([]);
  const [roiCampaignOptions, setRoiCampaignOptions] = useState([]);
  const [roiAppOptions, setRoiAppOptions] = useState([]);
  const [roiCountryOptions, setRoiCountryOptions] = useState([]);
  const [roiCampaignsLoading, setRoiCampaignsLoading] = useState(false);
  const [roiCampaignsFallback, setRoiCampaignsFallback] = useState(false);
  const [roiAppsLoading, setRoiAppsLoading] = useState(false);
  const [roiCountriesLoading, setRoiCountriesLoading] = useState(false);
  const [roiCountriesFallback, setRoiCountriesFallback] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [filtersOpen, setFiltersOpen] = useState(true);

  const [compareMode, setCompareMode] = useState(() => loadComparePrefs(user?.id).mode);
  const [compareStart, setCompareStart] = useState(() => loadComparePrefs(user?.id).startDate);
  const [compareEnd, setCompareEnd] = useState(() => loadComparePrefs(user?.id).endDate);
  const [priorSummary, setPriorSummary] = useState(null);
  const [thresholdBanners, setThresholdBanners] = useState([]);
  const [showRoiTip, setShowRoiTip] = useState(() => {
    try {
      return localStorage.getItem(ROI_TIP_KEY) !== 'done';
    } catch {
      return true;
    }
  });

  const [showExpense, setShowExpense] = useState(false);
  const [expenseSharedDate, setExpenseSharedDate] = useState(() => endDate);
  const [expense1, setExpense1] = useState(emptyExpenseSlot);
  const [expense2, setExpense2] = useState(emptyExpenseSlot);
  const [expenseBusy, setExpenseBusy] = useState(false);
  const [siteHosts, setSiteHosts] = useState([]);
  const [appIds, setAppIds] = useState([]);
  const [inventoryLoading, setInventoryLoading] = useState(false);

  const [countryPage, setCountryPage] = useState(1);
  const [countrySearch, setCountrySearch] = useState('');
  const [tableDensity, setTableDensity] = useState(() => {
    try {
      return localStorage.getItem('adnexus.tableDensity:roi') === 'compact' ? 'compact' : 'comfortable';
    } catch {
      return 'comfortable';
    }
  });
  const isNarrow = useMedia('(max-width: 768px)');
  const shareHydratedRef = useRef(false);
  const pendingShareFiltersRef = useRef(null);
  const skipPrefsSaveRef = useRef(true);

  useEffect(() => {
    try {
      localStorage.setItem('adnexus.tableDensity:roi', tableDensity);
    } catch {
      /* ignore */
    }
  }, [tableDensity]);

  useEffect(() => {
    skipPrefsSaveRef.current = true;
    const prefs = loadComparePrefs(user?.id);
    setCompareMode(prefs.mode);
    setCompareStart(prefs.startDate);
    setCompareEnd(prefs.endDate);
  }, [user?.id]);

  useEffect(() => {
    if (skipPrefsSaveRef.current) {
      skipPrefsSaveRef.current = false;
      return;
    }
    saveComparePrefs(user?.id, { mode: compareMode, startDate: compareStart, endDate: compareEnd });
  }, [user?.id, compareMode, compareStart, compareEnd]);

  useEffect(() => {
    if (shareHydratedRef.current) return;
    shareHydratedRef.current = true;

    const applyRange = (nextPreset, range, nextTarget, adsFilters = null) => {
      const tt = ['site', 'app', 'all'].includes(nextTarget) ? nextTarget : 'all';
      setPreset(nextPreset);
      setStartDate(range.startDate);
      setEndDate(range.endDate);
      setCountryPage(1);
      setApplied({
        startDate: range.startDate,
        endDate: range.endDate,
        targetType: tt,
        accountIds: adsFilters?.accountIds?.length ? adsFilters.accountIds : null,
        campaignIds: adsFilters?.campaignIds?.length ? adsFilters.campaignIds : null,
        appKeys: adsFilters?.appKeys?.length ? adsFilters.appKeys : null,
        siteKeys: adsFilters?.siteKeys?.length ? adsFilters.siteKeys : null,
        countryCodes: adsFilters?.countryCodes?.length ? adsFilters.countryCodes : null,
      });
    };

    const shared = parseReportShare(searchParams);
    if (shared) {
      const adsFilters = {
        accountIds: shared.accountIds || [],
        campaignIds: shared.campaignIds || [],
        appKeys: shared.appKeys || [],
        siteKeys: shared.siteKeys || [],
        countryCodes: shared.countryCodes || [],
      };
      if (
        adsFilters.accountIds.length
        || adsFilters.campaignIds.length
        || adsFilters.appKeys.length
        || adsFilters.siteKeys.length
        || adsFilters.countryCodes.length
      ) {
        pendingShareFiltersRef.current = adsFilters;
      }
      if (shared.preset && shared.preset !== 'custom') {
        const r = clampPresetRange(shared.preset, dateRestriction);
        if (r) applyRange(shared.preset, r, shared.targetType || 'all', adsFilters);
        return;
      }
      if (shared.startDate && shared.endDate) {
        const r = clampDateRange(shared.startDate, shared.endDate, dateRestriction);
        applyRange(shared.preset || 'custom', r, shared.targetType || 'all', adsFilters);
        return;
      }
      if (shared.targetType) {
        setApplied((prev) => ({ ...prev, targetType: shared.targetType }));
      }
      return;
    }

    const last = getLastPageFilters(LAST_FILTER_PAGES.roi, user?.id);
    if (last?.startDate && last?.endDate) {
      if (last.preset && last.preset !== 'custom') {
        const r = clampPresetRange(last.preset, dateRestriction);
        if (r) {
          applyRange(last.preset, r, last.targetType || 'all');
          return;
        }
      }
      const r = clampDateRange(last.startDate, last.endDate, dateRestriction);
      applyRange(last.preset || 'custom', r, last.targetType || 'all');
    }
  }, [searchParams, user?.id, dateRestriction]);

  const customDatesIncomplete = isCustomRangeIncomplete(preset, startDate, endDate);
  const presetLabel = useMemo(
    () => DATE_PRESETS.find((p) => p.id === preset)?.label || 'Custom',
    [preset]
  );

  const siteOptions = useMemo(
    () => (siteHosts || []).map((h) => ({ value: String(h).toLowerCase(), label: String(h) })),
    [siteHosts]
  );

  const roiAccountsWithSpendInRange = useMemo(
    () => roiAccountOptions.filter((o) => Number(o.spend) > 0).length,
    [roiAccountOptions]
  );

  const filterSummary = useMemo(() => {
    if (!applied?.startDate) return null;
    const range = applied.startDate === applied.endDate
      ? applied.startDate
      : `${applied.startDate} → ${applied.endDate}`;
    const bits = [range];
    if (applied.accountIds?.length) bits.push(`${applied.accountIds.length} account(s)`);
    if (applied.campaignIds?.length) bits.push(`${applied.campaignIds.length} campaign(s)`);
    if (applied.appKeys?.length) bits.push(`${applied.appKeys.length} app(s)`);
    if (applied.siteKeys?.length) bits.push(`${applied.siteKeys.length} site(s)`);
    if (applied.countryCodes?.length) bits.push(`${applied.countryCodes.length} countr${applied.countryCodes.length === 1 ? 'y' : 'ies'}`);
    return bits.join(' · ');
  }, [applied]);

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

  const persistLastFilters = useCallback((snap) => {
    saveLastPageFilters(LAST_FILTER_PAGES.roi, {
      preset: snap.preset,
      startDate: snap.startDate,
      endDate: snap.endDate,
      targetType: snap.targetType || 'all',
    }, user?.id);
  }, [user?.id]);

  const resolveFilterIds = useCallback((
    accountSel,
    campaignSel,
    appSel,
    siteSel,
    countrySel,
    accountOpts,
    campaignOpts,
    appOpts,
    siteOpts,
    countryOpts
  ) => {
    const accountIds = collapseFullSelection(accountSel, accountOpts);
    const campaignIds = collapseFullSelection(campaignSel, campaignOpts);
    const countryCodes = collapseFullSelection(countrySel, countryOpts);
    // Apps: expand "all" to concrete related IDs so site-only maps stay out when sites aren't picked.
    const appKeys = isAllSelection(appSel)
      ? optionValues(appOpts)
      : (Array.isArray(appSel) ? appSel.filter((v) => v && v !== ALL_SENTINEL) : []);
    const siteKeys = isAllSelection(siteSel)
      ? optionValues(siteOpts)
      : (Array.isArray(siteSel) ? siteSel.filter((v) => v && v !== ALL_SENTINEL) : []);
    let targetType = 'all';
    if (appKeys.length && siteKeys.length) targetType = 'all';
    else if (appKeys.length) targetType = 'app';
    else if (siteKeys.length) targetType = 'site';
    return {
      accountIds: accountIds.length ? accountIds : null,
      campaignIds: campaignIds.length ? campaignIds : null,
      appKeys: appKeys.length ? appKeys : null,
      siteKeys: siteKeys.length ? siteKeys : null,
      countryCodes: countryCodes.length ? countryCodes : null,
      targetType,
    };
  }, []);

  const load = useCallback(async (range = applied) => {
    if (!range?.startDate || !range?.endDate) return;
    setLoading(true);
    setError(null);
    try {
      const params = {
        start: range.startDate,
        end: range.endDate,
        targetType: range.targetType || 'all',
      };
      if (range.accountIds?.length) params.accountIds = range.accountIds.join(',');
      if (range.campaignIds?.length) params.campaignIds = range.campaignIds.join(',');
      if (range.appKeys?.length) params.appKeys = range.appKeys.join(',');
      if (range.siteKeys?.length) params.siteKeys = range.siteKeys.join(',');
      if (range.countryCodes?.length) params.countryCodes = range.countryCodes.join(',');
      const summary = await roiAPI.summary(params);
      setData(summary);
      setLastUpdated(nowTimeInTZ());
      setThresholdBanners(evaluateRoiThresholds(summary?.summary || summary || {}));
    } catch (err) {
      logErrorForDebug(err, 'ROI summary');
      setError(getUserFacingMessage(err, 'Could not load ROI summary.'));
      setData(null);
      setThresholdBanners([]);
    } finally {
      setLoading(false);
    }
  }, [applied]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    setCountryPage(1);
    setCountrySearch('');
  }, [
    applied?.startDate,
    applied?.endDate,
    applied?.accountIds,
    applied?.campaignIds,
    applied?.appKeys,
    applied?.siteKeys,
    applied?.countryCodes,
  ]);

  // Load Ads accounts for filter (by current date selection)
  useEffect(() => {
    const start = startDate || applied?.startDate;
    const end = endDate || applied?.endDate;
    if (!start || !end) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const res = await adsAPI.listRoiAccounts({ start, end });
        if (cancelled) return;
        const opts = (res.accounts || []).map((a) => ({
          value: a.id,
          label: a.descriptiveName || a.customerId || a.id,
          spend: Number(a.spend) || 0,
        }));
        setRoiAccountOptions(opts);
        setFilterAccountIds((prev) => {
          const pending = pendingShareFiltersRef.current;
          if (pending?.accountIds?.length) {
            const allowed = new Set(opts.map((o) => o.value));
            const kept = pending.accountIds.filter((id) => allowed.has(id));
            pendingShareFiltersRef.current = { ...pending, accountIds: [] };
            if (kept.length) return kept;
          }
          if (isAllSelection(prev) || !prev?.length) return toAllSelection();
          const allowed = new Set(opts.map((o) => o.value));
          const kept = prev.filter((id) => id !== ALL_SENTINEL && allowed.has(id));
          return kept.length ? kept : toAllSelection();
        });
      } catch (err) {
        logErrorForDebug(err, 'ROI accounts filter');
        if (!cancelled) setRoiAccountOptions([]);
      }
    })();
    return () => { cancelled = true; };
  }, [startDate, endDate, applied?.startDate, applied?.endDate]);

  // Load campaigns for selected accounts
  useEffect(() => {
    const start = startDate || applied?.startDate;
    const end = endDate || applied?.endDate;
    if (!start || !end) return undefined;
    let cancelled = false;
    (async () => {
      setRoiCampaignsLoading(true);
      try {
        const accountIds = collapseFullSelection(filterAccountIds, roiAccountOptions);
        const params = { start, end };
        if (accountIds.length) params.accountIds = accountIds.join(',');
        const res = await adsAPI.listRoiCampaigns(params);
        if (cancelled) return;
        const opts = (res.campaigns || []).map((c) => ({
          value: c.campaignId,
          label: c.campaignName
            ? `${c.campaignName}${c.accountName ? ` · ${c.accountName}` : ''}`
            : c.campaignId,
          campaignName: c.campaignName,
          adsAccountId: c.adsAccountId,
        }));
        setRoiCampaignOptions(opts);
        setRoiCampaignsFallback(Boolean(res.fallbackUsed));
        // Honor shared/preset campaign list once; otherwise select all for current accounts.
        setFilterCampaignIds(() => {
          const pending = pendingShareFiltersRef.current;
          if (pending?.campaignIds?.length) {
            const allowed = new Set(opts.map((o) => o.value));
            const kept = pending.campaignIds.filter((id) => allowed.has(id));
            pendingShareFiltersRef.current = { ...pending, campaignIds: [] };
            if (kept.length) return kept;
          }
          return opts.length ? toAllSelection() : [];
        });
      } catch (err) {
        logErrorForDebug(err, 'ROI campaigns filter');
        if (!cancelled) {
          setRoiCampaignOptions([]);
          setFilterCampaignIds([]);
          setRoiCampaignsFallback(false);
        }
      } finally {
        if (!cancelled) setRoiCampaignsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [startDate, endDate, applied?.startDate, applied?.endDate, filterAccountIds, roiAccountOptions]);

  // App IDs from Google Ads for the selected accounts/campaigns (App Campaign settings).
  useEffect(() => {
    const start = startDate || applied?.startDate;
    const end = endDate || applied?.endDate;
    if (!start || !end) return undefined;
    // Wait until campaigns for the current accounts have loaded so we do not
    // request apps with a stale campaign filter from a previous selection.
    if (roiCampaignsLoading) return undefined;
    let cancelled = false;
    (async () => {
      setRoiAppsLoading(true);
      try {
        const accountIds = collapseFullSelection(filterAccountIds, roiAccountOptions);
        const campaignIds = collapseFullSelection(filterCampaignIds, roiCampaignOptions);
        const params = { start, end };
        if (accountIds.length) params.accountIds = accountIds.join(',');
        // Only narrow by campaigns when the user unselected some; "all" → accounts only.
        if (campaignIds.length) params.campaignIds = campaignIds.join(',');
        const res = await adsAPI.listRoiRelatedTargets(params);
        if (cancelled) return;
        const opts = (res.apps || []).map((a) => ({
          value: a.id,
          label: a.label || a.id,
        }));
        setRoiAppOptions(opts);
        setFilterAppKeys(() => {
          const pending = pendingShareFiltersRef.current;
          if (pending?.appKeys?.length) {
            const allowed = new Set(opts.map((o) => o.value));
            const kept = pending.appKeys
              .map((k) => String(k).toLowerCase())
              .filter((id) => allowed.has(id));
            pendingShareFiltersRef.current = { ...pending, appKeys: [] };
            if (kept.length) return kept;
          }
          return opts.length ? toAllSelection() : [];
        });
      } catch (err) {
        logErrorForDebug(err, 'ROI related apps');
        if (!cancelled) {
          setRoiAppOptions([]);
          setFilterAppKeys([]);
        }
      } finally {
        if (!cancelled) setRoiAppsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [
    startDate,
    endDate,
    applied?.startDate,
    applied?.endDate,
    filterAccountIds,
    filterCampaignIds,
    roiAccountOptions,
    roiCampaignOptions,
    roiCampaignsLoading,
  ]);

  // Countries with Ads spend for selected accounts/campaigns.
  useEffect(() => {
    const start = startDate || applied?.startDate;
    const end = endDate || applied?.endDate;
    if (!start || !end) return undefined;
    if (roiCampaignsLoading) return undefined;
    let cancelled = false;
    (async () => {
      setRoiCountriesLoading(true);
      try {
        const accountIds = collapseFullSelection(filterAccountIds, roiAccountOptions);
        const campaignIds = collapseFullSelection(filterCampaignIds, roiCampaignOptions);
        const params = { start, end };
        if (accountIds.length) params.accountIds = accountIds.join(',');
        if (campaignIds.length) params.campaignIds = campaignIds.join(',');
        const res = await adsAPI.listRoiCountries(params);
        if (cancelled) return;
        const opts = (res.countries || []).map((c) => ({
          value: String(c.code || '').toUpperCase(),
          label: c.name ? `${c.name} (${c.code})` : String(c.code),
          spend: Number(c.spend) || 0,
        })).filter((o) => o.value);
        setRoiCountryOptions(opts);
        setRoiCountriesFallback(Boolean(res.fallbackUsed));
        setFilterCountryCodes(() => {
          const pending = pendingShareFiltersRef.current;
          if (pending?.countryCodes?.length) {
            const allowed = new Set(opts.map((o) => o.value));
            const kept = pending.countryCodes
              .map((k) => String(k).toUpperCase())
              .filter((id) => allowed.has(id));
            pendingShareFiltersRef.current = { ...pending, countryCodes: [] };
            if (kept.length) return kept;
          }
          return opts.length ? toAllSelection() : [];
        });
      } catch (err) {
        logErrorForDebug(err, 'ROI countries filter');
        if (!cancelled) {
          setRoiCountryOptions([]);
          setFilterCountryCodes([]);
          setRoiCountriesFallback(false);
        }
      } finally {
        if (!cancelled) setRoiCountriesLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [
    startDate,
    endDate,
    applied?.startDate,
    applied?.endDate,
    filterAccountIds,
    filterCampaignIds,
    roiAccountOptions,
    roiCampaignOptions,
    roiCampaignsLoading,
  ]);

  useEffect(() => {
    const prior = compareRange;
    if (!prior || !isPeriodAllowed(prior, dateRestriction)) {
      setPriorSummary(null);
      return undefined;
    }
    let cancelled = false;
    setPriorSummary(null);
    (async () => {
      try {
        const params = {
          start: prior.startDate,
          end: prior.endDate,
          targetType: applied?.targetType || 'all',
        };
        if (applied?.accountIds?.length) params.accountIds = applied.accountIds.join(',');
        if (applied?.campaignIds?.length) params.campaignIds = applied.campaignIds.join(',');
        if (applied?.appKeys?.length) params.appKeys = applied.appKeys.join(',');
        if (applied?.siteKeys?.length) params.siteKeys = applied.siteKeys.join(',');
        if (applied?.countryCodes?.length) params.countryCodes = applied.countryCodes.join(',');
        const res = await roiAPI.summary(params);
        if (!cancelled) setPriorSummary(res?.summary || null);
      } catch (err) {
        logErrorForDebug(err, 'ROI compare summary');
        if (!cancelled) setPriorSummary(null);
      }
    })();
    return () => { cancelled = true; };
  }, [
    compareRange?.startDate,
    compareRange?.endDate,
    applied?.targetType,
    applied?.startDate,
    applied?.endDate,
    applied?.accountIds,
    applied?.campaignIds,
    applied?.appKeys,
    applied?.siteKeys,
    dateRestriction,
  ]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setInventoryLoading(true);
      try {
        const picker = await usersAPI.getInventoryPicker();
        if (cancelled) return;
        setSiteHosts(Array.isArray(picker?.siteHosts) ? picker.siteHosts : []);
        setAppIds(Array.isArray(picker?.appIds) ? picker.appIds : []);
        const pending = pendingShareFiltersRef.current;
        if (pending?.siteKeys?.length) {
          const hosts = Array.isArray(picker?.siteHosts) ? picker.siteHosts : [];
          const allowed = new Set(hosts.map((h) => String(h).toLowerCase()));
          const kept = pending.siteKeys
            .map((k) => String(k).toLowerCase())
            .filter((id) => allowed.has(id));
          pendingShareFiltersRef.current = { ...pending, siteKeys: [] };
          if (kept.length) setFilterSiteKeys(kept);
        }
      } catch (err) {
        logErrorForDebug(err, 'ROI inventory picker');
        if (!cancelled) {
          setSiteHosts([]);
          setAppIds([]);
        }
      } finally {
        if (!cancelled) setInventoryLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const getPresetSnapshot = useCallback(() => {
    const accountSel = filterAccountIds?.length ? filterAccountIds : toAllSelection();
    const campaignSel = filterCampaignIds?.length ? filterCampaignIds : toAllSelection();
    const appSel = filterAppKeys?.length ? filterAppKeys : [];
    const siteSel = filterSiteKeys?.length ? filterSiteKeys : [];
    const countrySel = filterCountryCodes?.length ? filterCountryCodes : toAllSelection();
    return {
      preset,
      startDate: applied?.startDate || startDate,
      endDate: applied?.endDate || endDate,
      targetType: applied?.targetType || 'all',
      accountIds: accountSel,
      campaignIds: campaignSel,
      appKeys: appSel,
      siteKeys: siteSel,
      countryCodes: countrySel,
      accountLabels: labelsForSelection(accountSel, roiAccountOptions),
      campaignLabels: labelsForSelection(campaignSel, roiCampaignOptions),
      appLabels: labelsForSelection(appSel, roiAppOptions),
      siteLabels: labelsForSelection(siteSel, siteOptions),
      countryLabels: labelsForSelection(countrySel, roiCountryOptions),
    };
  }, [
    preset,
    applied,
    startDate,
    endDate,
    filterAccountIds,
    filterCampaignIds,
    filterAppKeys,
    filterSiteKeys,
    filterCountryCodes,
    roiAccountOptions,
    roiCampaignOptions,
    roiAppOptions,
    siteOptions,
    roiCountryOptions,
  ]);

  const handleCopyLink = async () => {
    const snap = getPresetSnapshot();
    await copyReportLink(snap);
    showToast({ message: 'Link copied — opens this exact ROI view' });
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

  const dismissRoiTip = () => {
    try {
      localStorage.setItem(ROI_TIP_KEY, 'done');
    } catch {
      /* ignore */
    }
    setShowRoiTip(false);
  };

  const onPreset = (p) => {
    if (dateFilterLocked) return;
    setPreset(p);
    if (p !== 'custom') {
      const r = clampPresetRange(p, dateRestriction);
      if (r) {
        setStartDate(r.startDate);
        setEndDate(r.endDate);
      }
    }
  };

  const applyPreset = (p) => {
    if (dateFilterLocked) return;
    const r = clampPresetRange(p, dateRestriction);
    if (!r) return;
    setPreset(p);
    setStartDate(r.startDate);
    setEndDate(r.endDate);
    setCountryPage(1);
    const ids = resolveFilterIds(
      filterAccountIds,
      filterCampaignIds,
      filterAppKeys,
      filterSiteKeys,
      filterCountryCodes,
      roiAccountOptions,
      roiCampaignOptions,
      roiAppOptions,
      siteOptions,
      roiCountryOptions
    );
    const next = { startDate: r.startDate, endDate: r.endDate, ...ids };
    setApplied(next);
    persistLastFilters({
      preset: p,
      startDate: r.startDate,
      endDate: r.endDate,
      targetType: ids.targetType,
    });
    load(next);
  };

  const applyFilter = () => {
    if (customDatesIncomplete) return;
    const ids = resolveFilterIds(
      filterAccountIds,
      filterCampaignIds,
      filterAppKeys,
      filterSiteKeys,
      filterCountryCodes,
      roiAccountOptions,
      roiCampaignOptions,
      roiAppOptions,
      siteOptions,
      roiCountryOptions
    );
    const next = {
      startDate,
      endDate,
      ...ids,
    };
    setCountryPage(1);
    setApplied(next);
    persistLastFilters({ preset, startDate, endDate, targetType: ids.targetType });
    load(next);
  };

  const reset = () => {
    const r = clampPresetRange('today', dateRestriction) || todayInit;
    setPreset('today');
    setStartDate(r.startDate);
    setEndDate(r.endDate);
    setFilterAccountIds(toAllSelection());
    setFilterCampaignIds(toAllSelection());
    setFilterAppKeys(toAllSelection());
    setFilterSiteKeys([]);
    setFilterCountryCodes(toAllSelection());
    setCountryPage(1);
    setCountrySearch('');
    const next = {
      startDate: r.startDate,
      endDate: r.endDate,
      targetType: 'all',
      accountIds: null,
      campaignIds: null,
      appKeys: null,
      siteKeys: null,
      countryCodes: null,
    };
    setApplied(next);
    persistLastFilters({
      preset: 'today',
      startDate: r.startDate,
      endDate: r.endDate,
      targetType: 'all',
    });
    load(next);
  };

  const openExpenseForm = () => {
    setExpenseSharedDate(applied?.endDate || endDate);
    setExpense1(emptyExpenseSlot());
    setExpense2(emptyExpenseSlot());
    setShowExpense(true);
  };

  const updateExpenseSlot = (setSlot, patch) => {
    setSlot((f) => {
      const next = { ...f, ...patch };
      if (patch.targetType && patch.targetType !== f.targetType) {
        next.targetKey = '';
      }
      return next;
    });
  };

  const targetOptionsFor = (type) => {
    const seen = new Set();
    const options = [];
    const add = (raw) => {
      const label = String(raw || '').trim();
      if (!label) return;
      const id = label.toLowerCase();
      if (seen.has(id)) return;
      seen.add(id);
      options.push({ id, label });
    };
    if (type === 'site') {
      (siteHosts || []).forEach(add);
      (data?.rows || []).forEach((r) => {
        if (r.targetType === 'site') add(r.targetKey);
      });
    } else if (type === 'app') {
      (appIds || []).forEach(add);
      (data?.rows || []).forEach((r) => {
        if (r.targetType === 'app') add(r.targetKey);
      });
    }
    options.sort((a, b) => a.label.localeCompare(b.label));
    return options;
  };

  const saveExpenses = async (e) => {
    e.preventDefault();
    const slots = [expense1, expense2]
      .map((slot) => ({
        ...slot,
        expenseDate: expenseSharedDate || applied?.endDate || endDate,
        amount: Number(slot.amount),
        targetKey: String(slot.targetKey || '').trim().toLowerCase(),
      }))
      .filter((slot) => Number.isFinite(slot.amount) && slot.amount > 0);

    if (!slots.length) {
      setError('Enter an amount for at least one expense.');
      return;
    }

    setExpenseBusy(true);
    setError(null);
    try {
      for (const slot of slots) {
        if (slot.targetType !== 'general' && !slot.targetKey) {
          throw new Error(
            slot.targetType === 'site'
              ? 'Select a site host for site expenses.'
              : 'Select an app ID / package for app expenses.'
          );
        }
        await adsAPI.createExpense(slot);
      }
      setShowExpense(false);
      setExpense1(emptyExpenseSlot());
      setExpense2(emptyExpenseSlot());
      await load();
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not save expenses.'));
    } finally {
      setExpenseBusy(false);
    }
  };

  const deleteExpense = async (id) => {
    try {
      await adsAPI.deleteExpense(id);
      await load();
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not delete expense.'));
    }
  };

  const renderExpenseFields = (slot, setSlot, title) => {
    const options = targetOptionsFor(slot.targetType);
    return (
      <div className="filter-field">
        <div className="filter-section-head" style={{ marginBottom: 8 }}>
          <span className="filter-section-title">{title}</span>
        </div>
        <label className="ui-field">
          <span className="ui-field-label">Amount</span>
          <input
            className="ui-field-input"
            type="number"
            min="0"
            step="0.01"
            value={slot.amount}
            onChange={(e) => updateExpenseSlot(setSlot, { amount: e.target.value })}
            placeholder="0.00"
          />
        </label>
        <label className="ui-field">
          <span className="ui-field-label">Label</span>
          <input
            className="ui-field-input"
            type="text"
            value={slot.label}
            onChange={(e) => updateExpenseSlot(setSlot, { label: e.target.value })}
            placeholder="Creative, tools, salary…"
          />
        </label>
        <label className="ui-field">
          <span className="ui-field-label">Attach to</span>
          <select
            className="ui-field-input"
            value={slot.targetType}
            onChange={(e) => updateExpenseSlot(setSlot, { targetType: e.target.value })}
          >
            <option value="general">General (all inventory)</option>
            <option value="site">Site</option>
            <option value="app">App ID</option>
          </select>
        </label>
        {slot.targetType !== 'general' && (
          <label className="ui-field">
            <span className="ui-field-label">
              {slot.targetType === 'site' ? 'Site host' : 'App ID / package'}
            </span>
            {options.length > 0 ? (
              <select
                className="ui-field-input"
                value={slot.targetKey}
                onChange={(e) => updateExpenseSlot(setSlot, { targetKey: e.target.value })}
                required={Number(slot.amount) > 0}
              >
                <option value="">
                  {inventoryLoading ? 'Loading…' : 'Select…'}
                </option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>
            ) : (
              <input
                className="ui-field-input"
                type="text"
                value={slot.targetKey}
                onChange={(e) => updateExpenseSlot(setSlot, { targetKey: e.target.value })}
                placeholder={slot.targetType === 'site' ? 'example.com' : 'com.example.app'}
                required={Number(slot.amount) > 0}
              />
            )}
          </label>
        )}
      </div>
    );
  };

  const accounts = data?.accounts || [];
  const summary = data?.summary || {};

  const cardDeltas = useMemo(() => {
    if (!priorSummary) return {};
    return {
      adsSpend: pctChange(summary.adsSpend, priorSummary.adsSpend),
      earn: pctChange(summary.earn, priorSummary.earn),
      roiSpendPercent: pctChange(summary.roiSpendPercent, priorSummary.roiSpendPercent),
    };
  }, [summary, priorSummary]);

  const countryTargetBreakdown = data?.countryTargetBreakdown || [];
  const countryBreakdown = data?.countryBreakdown || [];
  const countryTargetDailyBreakdown = data?.countryTargetDailyBreakdown || [];
  const countryTree = useMemo(
    () => buildCountryTree(
      countryBreakdown,
      countryTargetBreakdown,
      countryTargetDailyBreakdown,
      { startDate: applied?.startDate || startDate, endDate: applied?.endDate || endDate },
    ),
    [
      countryBreakdown,
      countryTargetBreakdown,
      countryTargetDailyBreakdown,
      applied?.startDate,
      applied?.endDate,
      startDate,
      endDate,
    ]
  );

  const summaryCards = useMemo(() => {
    const base = buildRoiSummaryCards(summary);
    return base.map((card) => {
      if (card.key === 'spend') return { ...card, delta: cardDeltas.adsSpend };
      if (card.key === 'earn') return { ...card, delta: cardDeltas.earn };
      if (card.key === 'roiSpend') return { ...card, delta: cardDeltas.roiSpendPercent };
      return card;
    });
  }, [summary, cardDeltas]);

  return (
    <div className="dashboard-page reporting-page roi-page">
      <PageHeader
        title="ROI"
        subtitle="Ads spend and other expenses vs GAM earn — separate ROI% for spend and expenses"
        summary={filterSummary}
      >
        <button type="button" className="btn-outline-action" onClick={openExpenseForm}>
          Add expenses
        </button>
        <button type="button" className="btn-outline-action" onClick={handleCopyLink}>
          Copy link
        </button>
        <SavePresetButton
          page={PRESET_PAGES.roi}
          userId={user?.id}
          getSnapshot={getPresetSnapshot}
          variant="primary"
          hint="Saves accounts, campaigns, app IDs, sites, countries, and date range."
        />
      </PageHeader>

      <CompareRangeBar
        mode={compareMode}
        onModeChange={handleCompareMode}
        customStart={compareStart}
        customEnd={compareEnd}
        onCustomStart={(v) => setCompareStart(clampDateValue(v, dateRestriction))}
        onCustomEnd={(v) => setCompareEnd(clampDateValue(v, dateRestriction))}
        minDate={dateRestriction?.startDate}
        maxDate={dateRestriction?.endDate}
      />

      {showRoiTip && (
        <p className="form-note page-restriction-note" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span>
            Tip: Pick a date range, Apply Filter, then use Compare to see earn / spend deltas. Copy link or Save preset to reuse this view.
          </span>
          <button type="button" className="btn-reset" onClick={dismissRoiTip} aria-label="Dismiss tip">
            Dismiss
          </button>
        </p>
      )}

      {dateRestriction && (
        <p className="form-note page-restriction-note">
          {dateFilterLocked
            ? `Data locked to: ${formatDateRestrictionLabel(dateRestriction)}`
            : `Allowed filter window: ${formatDateRestrictionLabel(dateRestriction)}`}
        </p>
      )}

      <ThresholdAlertBanner
        items={thresholdBanners}
        onDismiss={(id) => setThresholdBanners((prev) => prev.filter((b) => b.id !== id))}
      />

      <div className={`filter-card gam-report-shell ${filtersOpen ? 'filter-card-open' : ''}`}>
        <div className="filter-card-head filter-card-head-sticky">
          <button
            type="button"
            className="filter-card-title filter-card-toggle"
            onClick={() => setFiltersOpen((v) => !v)}
            aria-expanded={filtersOpen}
          >
            ROI filters {filtersOpen ? '▾' : '▸'}
          </button>
          <div className="filter-actions filter-actions--desktop">
            <button
              type="button"
              className="btn-generate"
              onClick={applyFilter}
              disabled={customDatesIncomplete}
              title={customDatesIncomplete ? 'Select both start and end dates' : ''}
            >
              ✓ Apply Filter
            </button>
            <button type="button" className="btn-reset" onClick={reset}>↺ Reset</button>
          </div>
        </div>

        {filtersOpen && (
          <div className="gam-report-settings">
            <RoiFilterSection
              title="Date range"
              subtitle="Same presets as Dashboard and Reporting"
            >
              <RoiFilterRow icon="calendar" label="Period">
                <div className="dash-date-display" style={{ padding: '4px 0' }}>
                  <span className="dash-date-label">{presetLabel}</span>
                  <span className="dash-date-range">
                    {customDatesIncomplete
                      ? 'Select start & end dates'
                      : (startDate && endDate
                        ? (startDate !== endDate ? `${startDate} → ${endDate}` : startDate)
                        : '…')}
                  </span>
                </div>
              </RoiFilterRow>
              {!dateFilterLocked && presetOptions.length > 0 && (
                <div className="roi-filter-date-pills">
                  <div className="preset-pills dash-preset-row">
                    {presetOptions.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className={`preset-pill ${preset === p.id ? 'active' : ''}`}
                        onClick={() => onPreset(p.id)}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {!dateFilterLocked && preset === 'custom' && (
                <div className="roi-filter-date-custom">
                  <div className="filter-field">
                    <label>Start date</label>
                    <input
                      type="date"
                      value={startDate || ''}
                      min={dateRestriction?.startDate || undefined}
                      max={dateRestriction?.endDate || undefined}
                      onChange={(e) => setStartDate(clampDateValue(e.target.value, dateRestriction))}
                    />
                  </div>
                  <div className="filter-field">
                    <label>End date</label>
                    <input
                      type="date"
                      value={endDate || ''}
                      min={dateRestriction?.startDate || undefined}
                      max={dateRestriction?.endDate || undefined}
                      onChange={(e) => setEndDate(clampDateValue(e.target.value, dateRestriction))}
                    />
                  </div>
                </div>
              )}
            </RoiFilterSection>

            <RoiFilterSection
              title="Ads and inventory"
              subtitle="Choose the accounts, campaigns, apps, and sites to include in your ROI."
            >
              <RoiFilterRow icon="accounts" label="Ads accounts">
                <MultiSelect
                  options={roiAccountOptions}
                  value={filterAccountIds}
                  onChange={setFilterAccountIds}
                  placeholder="Select ads accounts…"
                  searchable
                  showSelectAll
                  selectAllLabel="Select all accounts"
                />
              </RoiFilterRow>
              <RoiFilterRow icon="campaigns" label="Campaigns">
                <MultiSelect
                  options={roiCampaignOptions}
                  value={filterCampaignIds}
                  onChange={setFilterCampaignIds}
                  placeholder="Paste campaign names, Enter to select…"
                  disabled={!roiCampaignOptions.length && !roiCampaignsLoading}
                  loading={roiCampaignsLoading}
                  searchable
                  showSelectAll
                  selectAllLabel="Select all campaigns"
                />
              </RoiFilterRow>
              <RoiFilterRow icon="apps" label="App IDs">
                <MultiSelect
                  options={roiAppOptions}
                  value={filterAppKeys}
                  onChange={setFilterAppKeys}
                  placeholder={
                    roiAppsLoading
                      ? 'Loading apps from Ads…'
                      : (roiAppOptions.length
                        ? 'Apps from selected accounts/campaigns…'
                        : 'No App Campaign package IDs found…')
                  }
                  disabled={!roiAppOptions.length && !roiAppsLoading}
                  loading={roiAppsLoading}
                  searchable
                  showSelectAll
                  selectAllLabel="Select all related apps"
                />
              </RoiFilterRow>
              <RoiFilterRow icon="sites" label="Sites">
                <MultiSelect
                  options={siteOptions}
                  value={filterSiteKeys}
                  onChange={setFilterSiteKeys}
                  placeholder="Select sites…"
                  disabled={!siteOptions.length && !inventoryLoading}
                  loading={inventoryLoading}
                  searchable
                  showSelectAll
                  selectAllLabel="Select all sites"
                />
              </RoiFilterRow>
              <RoiFilterRow icon="countries" label="Countries">
                <MultiSelect
                  options={roiCountryOptions}
                  value={filterCountryCodes}
                  onChange={setFilterCountryCodes}
                  placeholder={
                    roiCountriesLoading
                      ? 'Loading countries from Ads…'
                      : (roiCountryOptions.length
                        ? 'Filter by user country (Ads spend)…'
                        : 'No country spend synced yet — run Ads sync')
                  }
                  disabled={!roiCountryOptions.length && !roiCountriesLoading}
                  loading={roiCountriesLoading}
                  searchable
                  showSelectAll
                  selectAllLabel="Select all countries"
                />
              </RoiFilterRow>
            </RoiFilterSection>

            <div className="roi-filter-notes">
              {!roiAccountOptions.length ? (
                <p className="form-note">
                  No Google Ads accounts found. Connect accounts in <strong>Admin → Google Ads accounts</strong>,
                  then run <strong>Sync</strong> so spend and campaigns are available.
                </p>
              ) : null}
              {roiAccountOptions.length > 0 && roiAccountsWithSpendInRange === 0 ? (
                <p className="form-note page-restriction-note">
                  No Ads spend synced for <strong>{startDate === endDate ? startDate : `${startDate} → ${endDate}`}</strong> yet.
                  Accounts still appear so you can filter — try <strong>Yesterday</strong> or sync Ads in Admin.
                </p>
              ) : null}
              {roiCampaignsFallback ? (
                <p className="form-note">
                  No campaigns with spend on the selected date — showing campaigns from the last 30 days for picking.
                </p>
              ) : null}
              {roiCountriesFallback ? (
                <p className="form-note">
                  No country spend on the selected date — showing countries from the last 30 days for picking.
                </p>
              ) : null}
            </div>
          </div>
        )}
      </div>

      {error && <div className="login-error" style={{ marginTop: 12 }}>{error}</div>}

      {showExpense && (
        <form className="filter-card" style={{ marginTop: 16 }} onSubmit={saveExpenses}>
          <div className="filter-card-head">
            <span className="filter-card-title">Add expenses (general, site, or app)</span>
            <div className="filter-actions">
              <button type="submit" className="btn-generate" disabled={expenseBusy}>
                {expenseBusy ? 'Saving…' : '✓ Save expenses'}
              </button>
              <button type="button" className="btn-reset" onClick={() => setShowExpense(false)}>Cancel</button>
            </div>
          </div>
          <div className="filter-field" style={{ marginBottom: 12, maxWidth: 220 }}>
            <label>Date (shared)</label>
            <input
              type="date"
              value={expenseSharedDate || ''}
              onChange={(e) => setExpenseSharedDate(e.target.value)}
              required
            />
          </div>
          <div className="roi-expense-pair">
            {renderExpenseFields(expense1, setExpense1, 'Expense 1')}
            {renderExpenseFields(expense2, setExpense2, 'Expense 2')}
          </div>
          <p className="form-note" style={{ marginTop: 10 }}>
            Leave amount blank to skip one slot. Site/app expenses apply only to that inventory row; general expenses apply to overall ROI.
          </p>
        </form>
      )}

      <div className={`report-summary-row roi-summary-grid${loading ? ' is-loading' : ''}`}>
        {summaryCards.map((card) => (
          <div key={card.key} className={`report-sum-card${loading ? ' is-loading' : ''}`}>
            <span className={`rsc-icon ${card.tone}`}>{card.icon}</span>
            <div>
              <div className="rsc-label">{card.label}</div>
              <div className="rsc-value">
                {loading ? <span className="card-spinner card-spinner-lg" aria-label="Loading" /> : card.value}
              </div>
              {'delta' in card ? (
                <DeltaLine change={card.delta} compareLabel={compareLabel} loading={loading} />
              ) : null}
            </div>
          </div>
        ))}
        <div className="report-live">
          <span className="dot-pulse" /> Live
          <DataFreshness networkInfo={networkInfo} fetchedAt={lastUpdated} compact />
        </div>
      </div>

      {summary.unmappedSpend > 0 && (
        <div className="warn-card warn-card-partial" role="status" style={{ marginTop: 12 }}>
          <div className="warn-card-main">
            <div className="warn-card-left">
              <div className="warn-card-icon-wrap"><span aria-hidden>i</span></div>
              <div className="warn-card-body">
                <div className="warn-card-title">Unmapped Ads spend</div>
                <div className="warn-card-desc">
                  {money(summary.unmappedSpend)} in this range is not mapped to a site/app
                  {summary.mappedSpend != null
                    ? ` (${money(summary.mappedSpend)} is in the table)`
                    : ''}.
                  {' '}Unmapped spend is hidden from the table and from Ads spend / ROI cards.
                  Map campaigns in Admin → Campaign mapping to include them.
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {!accounts.length && !loading && (
        <div className="warn-card" role="status" style={{ marginTop: 12 }}>
          <div className="warn-card-main">
            <div className="warn-card-left">
              <div className="warn-card-icon-wrap"><span aria-hidden>i</span></div>
              <div className="warn-card-body">
                <div className="warn-card-title">No Google Ads accounts in ROI</div>
                <div className="warn-card-desc">
                  Connect MCC / individual accounts in Admin → Google Ads accounts and enable Include in ROI.
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <RoiCountryTreeTable
        tree={countryTree}
        loading={loading}
        search={countrySearch}
        onSearchChange={setCountrySearch}
        onPageReset={() => setCountryPage(1)}
        page={countryPage}
        pageSize={isNarrow ? 12 : 50}
        onPageChange={setCountryPage}
        density={tableDensity}
        freezeFirst
        exportName={`roi_countries_${applied?.startDate || startDate}_${applied?.endDate || endDate}`}
        className="reporting-table"
        emptyMessage="No country spend for the selected filters"
        onReset={reset}
        emptyActions={(
          <>
            <button type="button" className="btn-generate" onClick={() => applyPreset('yesterday')}>Try yesterday</button>
            <button type="button" className="btn-reset" onClick={() => applyPreset('last7')}>Try last 7 days</button>
          </>
        )}
        headerExtra={(
          <>
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
            {applied?.startDate && applied?.endDate ? (
              <span className="report-range">{applied.startDate} → {applied.endDate}</span>
            ) : null}
          </>
        )}
      />

      {!!(data?.expenses?.length || data?.generalExpenses?.length) && (
        <div className="filter-card" style={{ marginTop: 16 }}>
          <div className="filter-section-head">
            <span className="filter-section-title">Other expenses</span>
            <span className="filter-section-hint">General, site, and app — included in ROI on expenses</span>
          </div>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table className="data-table report-table report-table--comfortable">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Site / App</th>
                  <th>Label</th>
                  <th>Amount</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(data.expenses || data.generalExpenses || []).map((e) => (
                  <tr key={e.id}>
                    <td>{e.expenseDate}</td>
                    <td>
                      {e.targetType === 'site'
                        ? 'Site'
                        : e.targetType === 'app'
                          ? 'App'
                          : 'General'}
                    </td>
                    <td>{e.targetType === 'general' ? '—' : (e.targetKey || '—')}</td>
                    <td>{e.label || 'Expense'}</td>
                    <td>{money(e.amount)}</td>
                    <td>
                      <button type="button" className="btn-reset" onClick={() => deleteExpense(e.id)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
