import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import PageHeader from '../../components/ui/PageHeader';
import CompareRangeBar from '../../components/ui/CompareRangeBar';
import MultiSelect from '../../components/ui/MultiSelect';
import RoiCountryTreeTable from '../../components/roi/RoiCountryTreeTable';
import RoiSummaryBoards from '../../components/roi/RoiSummaryBoards';
import RoiFilterRow from '../../components/roi/RoiFilterRow';
import RoiFilterSection from '../../components/roi/RoiFilterSection';
import SavePresetButton from '../../components/ui/SavePresetButton';
import { parseReportShare } from '../../utils/report/reportShare';
import { PRESET_PAGES } from '../../utils/reportPresets';
import AdsConnectChooser from '../../components/ads/AdsConnectChooser';
import { admobAPI, adsAPI } from '../../utils/api';
import { useAuth } from '../../store/useAuth';
import { useMedia } from '../../hooks/useMedia';
import { showToast } from '../../hooks/useToast';
import { getUserFacingMessage, logErrorForDebug } from '../../utils/userFacingError';
import { DATE_PRESETS } from '../../utils/gamReportCatalog';
import { clampPresetRange, isCustomRangeIncomplete } from '../../utils/dateRestriction';
import { ALL_SENTINEL, isAllSelection, toAllSelection } from '../../utils/inventorySelection';
import { loadComparePrefs, saveComparePrefs } from '../../utils/dashCharts';
import {
  compareLabelFor,
  pctChange,
  previousPeriodRange,
  resolveCompareRange,
} from '../../utils/periodCompare';
import { formatRoiDateRange, formatRoiMoney, formatRoiNum } from '../../utils/report/roiView';

const HIDDEN_TREE_COLUMNS = ['otherExpenses', 'profitExpense', 'roiExpensePercent'];
const DENSITY_KEY = 'adnexus.tableDensity:admob-roi';

function formatCustomerId(id) {
  const d = String(id || '').replace(/\D/g, '');
  if (d.length !== 10) return id || '—';
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

function concreteSelection(sel, options) {
  if (isAllSelection(sel)) return options.map((o) => o.value);
  return (sel || []).filter((v) => v !== ALL_SENTINEL);
}

function sameIds(a = [], b = []) {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

function ctrOf(clicks, impressions) {
  return impressions > 0 ? (clicks / impressions) * 100 : null;
}

function ecpmOf(spend, impressions) {
  return impressions > 0 ? (spend / impressions) * 1000 : null;
}

function initialRange(searchParams) {
  // Own links use start/end; Presets "Open in" links use the shared from/to encoding.
  const qsStart = searchParams.get('start') || searchParams.get('from');
  const qsEnd = searchParams.get('end') || searchParams.get('to');
  const qsPreset = searchParams.get('preset');
  if (/^\d{4}-\d{2}-\d{2}$/.test(qsStart || '') && /^\d{4}-\d{2}-\d{2}$/.test(qsEnd || '')) {
    return { preset: qsPreset || 'custom', startDate: qsStart, endDate: qsEnd };
  }
  const r = clampPresetRange('last7', null);
  return { preset: 'last7', startDate: r.startDate, endDate: r.endDate };
}

export function buildAppTree(apps, { startDate, endDate, linkedOnly }) {
  const rangeLabel = formatRoiDateRange(startDate, endDate);
  return (apps || [])
    .filter((a) => !linkedOnly || a.linked)
    .map((a) => {
      const days = (a.days || []).map((d) => ({
        id: `day:${a.name}:${d.date}`,
        level: 'package',
        label: d.date,
        date: d.date,
        dateLabel: d.date,
        kindLabel: 'Day',
        hideIcon: true,
        days: [],
        adsSpend: d.adsSpend,
        earn: d.earnings,
        otherExpenses: 0,
        profitSpend: d.profit,
        profitExpense: 0,
        roiSpendPercent: d.roiPercent,
        impressions: d.adsImpressions,
        clicks: d.adsClicks,
        conversions: d.conversions,
        ctr: ctrOf(d.adsClicks, d.adsImpressions),
        ecpm: ecpmOf(d.adsSpend, d.adsImpressions),
      }));
      return {
        id: `app:${a.name}`,
        level: 'country',
        iconKind: 'app',
        exportLevel: 'App',
        label: a.name,
        subLabel: [a.storeId, a.platform].filter(Boolean).join(' · ') || null,
        dateLabel: rangeLabel,
        adsSpend: a.adsSpend,
        earn: a.earnings,
        otherExpenses: 0,
        profitSpend: a.profit,
        profitExpense: 0,
        roiSpendPercent: a.roiPercent,
        impressions: a.adsImpressions,
        clicks: a.adsClicks,
        conversions: a.conversions,
        ctr: ctrOf(a.adsClicks, a.adsImpressions),
        ecpm: ecpmOf(a.adsSpend, a.adsImpressions),
        flatMode: true,
        packages: days,
        accounts: [],
        childCount: days.length,
        childBadge: `${days.length} day${days.length === 1 ? '' : 's'}`,
      };
    });
}

export default function AdMobRoi() {
  const { user, isAdmin } = useAuth();
  const { viewAdmobAccountId } = useOutletContext() || {};
  const accountId = isAdmin ? (viewAdmobAccountId || null) : null;
  const [searchParams] = useSearchParams();
  const isNarrow = useMedia('(max-width: 768px)');

  const [init] = useState(() => initialRange(searchParams));
  const [initialShare] = useState(() => parseReportShare(searchParams));
  const [preset, setPreset] = useState(init.preset);
  const [startDate, setStartDate] = useState(init.startDate);
  const [endDate, setEndDate] = useState(init.endDate);
  const [applied, setApplied] = useState(() => ({
    startDate: init.startDate,
    endDate: init.endDate,
    adsAccountIds: initialShare?.accountIds?.length ? initialShare.accountIds : null,
    apps: initialShare?.apps?.length ? initialShare.apps : null,
  }));
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [filterAdsAccountIds, setFilterAdsAccountIds] = useState(() => initialShare?.accountIds || []);
  const [filterApps, setFilterApps] = useState(() => initialShare?.apps || []);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [priorSummary, setPriorSummary] = useState(null);
  const [adsData, setAdsData] = useState(null);
  const [adsLoading, setAdsLoading] = useState(false);
  const [appOptions, setAppOptions] = useState([]);
  const [adsSyncHealth, setAdsSyncHealth] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [savingLinks, setSavingLinks] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [picker, setPicker] = useState(null);
  const [pickingId, setPickingId] = useState(null);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [pendingSessionId, setPendingSessionId] = useState(null);
  const [selectAfterLoad, setSelectAfterLoad] = useState(null);

  function openPicker(res) {
    setPicker({
      sessionId: res.sessionId,
      options: [
        ...(res.managers || []).map((m) => ({ ...m, kind: 'mcc' })),
        ...(res.individuals || []).map((i) => ({ ...i, kind: 'client' })),
      ],
    });
  }

  const [compareMode, setCompareMode] = useState(() => loadComparePrefs(user?.id).mode);
  const [compareStart, setCompareStart] = useState(() => loadComparePrefs(user?.id).startDate);
  const [compareEnd, setCompareEnd] = useState(() => loadComparePrefs(user?.id).endDate);

  const [linkedOnly, setLinkedOnly] = useState(true);
  const [treeSearch, setTreeSearch] = useState('');
  const [treePage, setTreePage] = useState(1);
  const [tableDensity, setTableDensity] = useState(() => {
    try {
      return localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable';
    } catch {
      return 'comfortable';
    }
  });

  useEffect(() => {
    try { localStorage.setItem(DENSITY_KEY, tableDensity); } catch { /* ignore */ }
  }, [tableDensity]);

  useEffect(() => {
    saveComparePrefs(user?.id, { mode: compareMode, startDate: compareStart, endDate: compareEnd });
  }, [user?.id, compareMode, compareStart, compareEnd]);

  const presetOptions = DATE_PRESETS;
  const customDatesIncomplete = isCustomRangeIncomplete(preset, startDate, endDate);
  const presetLabel = useMemo(
    () => DATE_PRESETS.find((p) => p.id === preset)?.label || 'Custom',
    [preset]
  );

  const baseParams = useMemo(() => (accountId ? { accountId } : {}), [accountId]);

  const roiParams = useCallback((range) => {
    const p = { ...baseParams, startDate: range.startDate, endDate: range.endDate };
    if (applied.adsAccountIds?.length) p.adsAccountIds = applied.adsAccountIds.join(',');
    if (applied.apps?.length) p.apps = applied.apps.join(',');
    return p;
  }, [baseParams, applied.adsAccountIds, applied.apps]);

  // Google Ads accounts (shared pool) with spend + per-publisher link flags.
  useEffect(() => {
    if (!applied.startDate || !applied.endDate) return undefined;
    let cancelled = false;
    setAdsLoading(true);
    admobAPI.roiAdsAccounts({ ...baseParams, startDate: applied.startDate, endDate: applied.endDate })
      .then((res) => {
        if (cancelled) return;
        setAdsData(res);
        const linked = (res.accounts || []).filter((a) => a.linked).map((a) => a.id);
        setFilterAdsAccountIds((prev) => {
          const concrete = (prev || []).filter((v) => v !== ALL_SENTINEL);
          if (concrete.length || isAllSelection(prev)) return prev;
          return linked;
        });
      })
      .catch((err) => {
        if (!cancelled) logErrorForDebug(err, 'AdMob ROI ads accounts');
      })
      .finally(() => {
        if (!cancelled) setAdsLoading(false);
      });
    return () => { cancelled = true; };
  }, [baseParams, applied.startDate, applied.endDate, refreshKey]);

  const publisherClientId = adsData?.publisherClientId || null;

  useEffect(() => {
    if (!publisherClientId) return undefined;
    let cancelled = false;
    adsAPI.syncHealth(publisherClientId)
      .then((health) => { if (!cancelled) setAdsSyncHealth(health); })
      .catch(() => { if (!cancelled) setAdsSyncHealth(null); });
    return () => { cancelled = true; };
  }, [publisherClientId, refreshKey]);

  // After a connect, pre-select the new accounts once the Ads list reloads.
  useEffect(() => {
    if (!selectAfterLoad || !adsData) return;
    const ids = new Set(selectAfterLoad.ids || []);
    const matches = (adsData.accounts || [])
      .filter((a) => ids.has(a.id) || (selectAfterLoad.mccId && a.parentMccId === selectAfterLoad.mccId))
      .map((a) => a.id);
    setSelectAfterLoad(null);
    if (!matches.length) return;
    setFilterAdsAccountIds((prev) => [...new Set([...(prev || []).filter((v) => v !== ALL_SENTINEL), ...matches])]);
    setFiltersOpen(true);
    showToast({
      message: `Selected ${matches.length} Google Ads account(s) — Apply Filter to see ROI, or Save as publisher default.`,
      replaceKey: 'admob-roi-ads-select',
    });
  }, [selectAfterLoad, adsData]);

  useEffect(() => {
    if (!applied.startDate || !applied.endDate) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    admobAPI.roi(roiParams(applied))
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setFetchedAt(new Date().toISOString());
        setTreePage(1);
        if (!applied.apps?.length) {
          setAppOptions((res.apps || []).map((a) => ({
            value: a.name,
            label: a.storeId ? `${a.name} (${a.storeId})` : a.name,
          })));
        }
      })
      .catch((err) => {
        if (cancelled) return;
        logErrorForDebug(err, 'AdMob ROI');
        setError(getUserFacingMessage(err, 'Could not load AdMob ROI.'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [applied, roiParams, refreshKey]);

  const compareRange = useMemo(
    () => resolveCompareRange(compareMode, applied.startDate, applied.endDate, {
      startDate: compareStart,
      endDate: compareEnd,
    }),
    [compareMode, applied.startDate, applied.endDate, compareStart, compareEnd]
  );
  const compareLabel = compareLabelFor(compareMode, compareRange);

  useEffect(() => {
    setPriorSummary(null);
    if (!compareRange) return undefined;
    let cancelled = false;
    admobAPI.roi(roiParams(compareRange))
      .then((res) => { if (!cancelled) setPriorSummary(res?.summary || null); })
      .catch((err) => {
        logErrorForDebug(err, 'AdMob ROI compare');
      });
    return () => { cancelled = true; };
  }, [compareRange, roiParams, refreshKey]);

  // Return from Google Ads OAuth (Connect Google Ads account).
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    const status = qs.get('ads_oauth');
    if (!status) return;
    if (status === 'error') {
      setError(`Google Ads connection failed${qs.get('reason') ? `: ${qs.get('reason')}` : ''}`);
    } else if (status === 'connected' || status === 'connected_individual') {
      showToast({ message: 'Google Ads connected — pick it under Ads accounts and Save for this publisher.' });
    } else if (status === 'pick' && qs.get('session')) {
      setPendingSessionId(qs.get('session'));
    }
    ['ads_oauth', 'reason', 'session'].forEach((k) => qs.delete(k));
    const next = qs.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${next ? `?${next}` : ''}`);
  }, []);

  // The OAuth session lives on the publisher's network — wait until it is known.
  useEffect(() => {
    if (!pendingSessionId || !publisherClientId) return;
    setPendingSessionId(null);
    adsAPI.oauthPending(pendingSessionId, publisherClientId)
      .then((res) => openPicker(res))
      .catch((err) => setError(getUserFacingMessage(err, 'Could not load Google Ads accounts from Google.')));
  }, [pendingSessionId, publisherClientId]);

  const adsAccounts = useMemo(() => adsData?.accounts || [], [adsData]);
  const spendCurrency = data?.currency || adsData?.currency || 'USD';
  const account = data?.account || adsData?.account || null;
  const publisherLabel = account?.descriptiveName || account?.accountId || 'this publisher';
  const linkedIds = useMemo(() => adsAccounts.filter((a) => a.linked).map((a) => a.id), [adsAccounts]);

  const adsAccountOptions = useMemo(() => adsAccounts
    .filter((a) => a.appSpend > 0 || a.spend > 0 || a.linked)
    .map((a) => ({
      value: a.id,
      label: `${a.descriptiveName} · ${formatCustomerId(a.customerId)}${a.linked ? ' · saved' : ''}`,
    })), [adsAccounts]);

  const pickedAdsIds = useMemo(
    () => concreteSelection(filterAdsAccountIds, adsAccountOptions),
    [filterAdsAccountIds, adsAccountOptions]
  );
  const linksDirty = !sameIds(pickedAdsIds, linkedIds);

  const summary = useMemo(() => {
    const s = data?.summary || {};
    return {
      adsSpendCurrency: spendCurrency,
      adsSpend: s.adsSpend,
      impressions: s.adsImpressions,
      clicks: s.adsClicks,
      ctr: ctrOf(Number(s.adsClicks) || 0, Number(s.adsImpressions) || 0),
      ecpm: ecpmOf(Number(s.adsSpend) || 0, Number(s.adsImpressions) || 0),
      earn: s.linkedEarnings,
      profitSpend: s.profit,
      roiSpendPercent: s.roiPercent,
      otherExpenses: 0,
    };
  }, [data, spendCurrency]);

  const cardDeltas = useMemo(() => {
    if (!priorSummary) return {};
    return {
      adsSpend: pctChange(data?.summary?.adsSpend, priorSummary.adsSpend),
      earn: pctChange(data?.summary?.linkedEarnings, priorSummary.linkedEarnings),
      roiSpendPercent: pctChange(data?.summary?.roiPercent, priorSummary.roiPercent),
    };
  }, [data, priorSummary]);

  const tree = useMemo(
    () => buildAppTree(data?.apps, { ...applied, linkedOnly }),
    [data, applied, linkedOnly]
  );

  const filterSummary = useMemo(() => {
    const bits = [applied.startDate === applied.endDate
      ? applied.startDate
      : `${applied.startDate} → ${applied.endDate}`];
    if (applied.adsAccountIds?.length) bits.push(`${applied.adsAccountIds.length} Ads account(s)`);
    if (applied.apps?.length) bits.push(`${applied.apps.length} app(s)`);
    return bits.join(' · ');
  }, [applied]);

  const onPreset = (p) => {
    setPreset(p);
    if (p !== 'custom') {
      const r = clampPresetRange(p, null);
      if (r) {
        setStartDate(r.startDate);
        setEndDate(r.endDate);
      }
    }
  };

  const applyWith = (range) => {
    const ads = concreteSelection(filterAdsAccountIds, adsAccountOptions);
    const apps = concreteSelection(filterApps, appOptions);
    setApplied({
      startDate: range.startDate,
      endDate: range.endDate,
      adsAccountIds: ads.length ? ads : null,
      apps: isAllSelection(filterApps) || !apps.length ? null : apps,
    });
  };

  const applyFilter = () => {
    if (customDatesIncomplete) return;
    applyWith({ startDate, endDate });
    showToast({ message: 'Filters applied', replaceKey: 'admob-roi-apply' });
  };

  const applyPreset = (p) => {
    const r = clampPresetRange(p, null);
    if (!r) return;
    setPreset(p);
    setStartDate(r.startDate);
    setEndDate(r.endDate);
    applyWith(r);
  };

  const reset = () => {
    const r = clampPresetRange('last7', null);
    setPreset('last7');
    setStartDate(r.startDate);
    setEndDate(r.endDate);
    setFilterAdsAccountIds(linkedIds);
    setFilterApps([]);
    setApplied({ startDate: r.startDate, endDate: r.endDate, adsAccountIds: null, apps: null });
    showToast({ message: 'Filters reset', replaceKey: 'admob-roi-apply' });
  };

  const handleCompareMode = (mode) => {
    setCompareMode(mode);
    if (mode === 'custom' && (!compareStart || !compareEnd)) {
      const prior = previousPeriodRange(applied.startDate, applied.endDate);
      if (prior) {
        setCompareStart(prior.startDate);
        setCompareEnd(prior.endDate);
      }
    }
  };

  // Presets keep inventory + Google Ads account picks (dates are chosen on the Presets page).
  const getPresetSnapshot = () => ({
    accountIds: concreteSelection(filterAdsAccountIds, adsAccountOptions),
    apps: isAllSelection(filterApps) ? [] : concreteSelection(filterApps, appOptions),
  });

  const handleCopyLink = async () => {
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('preset', preset);
    url.searchParams.set('start', applied.startDate);
    url.searchParams.set('end', applied.endDate);
    try {
      await navigator.clipboard.writeText(url.toString());
      showToast({ message: 'Link copied — opens this AdMob ROI range' });
    } catch {
      showToast({ message: 'Could not copy link' });
    }
  };

  const saveLinks = async () => {
    setSavingLinks(true);
    try {
      await admobAPI.saveRoiAdsAccounts({ adsAccountIds: pickedAdsIds }, accountId ? { accountId } : undefined);
      showToast({
        message: pickedAdsIds.length
          ? `Saved ${pickedAdsIds.length} Google Ads account(s) as default for ${publisherLabel}.`
          : `Cleared — ${publisherLabel} now uses all connected Google Ads accounts.`,
        replaceKey: 'admob-roi-ads-save',
      });
      setApplied((prev) => ({ ...prev, adsAccountIds: null }));
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not save Google Ads accounts.'));
    } finally {
      setSavingLinks(false);
    }
  };

  const connectWithGoogle = async () => {
    setConnecting(true);
    try {
      const { url } = await adsAPI.mccOauthUrl({ returnTo: 'admob-roi' }, publisherClientId);
      window.location.href = url;
    } catch (err) {
      setConnecting(false);
      throw err;
    }
  };

  const onUsedExistingLogin = (res, login) => {
    setChooserOpen(false);
    if (res?.sessionId) {
      openPicker(res);
      return;
    }
    const ids = res?.accountIds || [];
    setSelectAfterLoad({ ids, mccId: login.accountType === 'mcc' ? login.id : null });
    setRefreshKey((k) => k + 1);
  };

  const pickOAuthAccount = async (customerId) => {
    if (!picker?.sessionId) return;
    setPickingId(customerId);
    try {
      const res = await adsAPI.oauthSelect(picker.sessionId, { customerId }, publisherClientId);
      setPicker(null);
      showToast({
        message: res.accountType === 'mcc'
          ? `Manager connected with ${res.childrenCount || 0} account(s). Run Sync spend to load their spend.`
          : 'Google Ads account connected. Run Sync spend to load its spend.',
      });
      if (res.account?.id) {
        setSelectAfterLoad(res.accountType === 'mcc'
          ? { ids: [], mccId: res.account.id }
          : { ids: [res.account.id], mccId: null });
      }
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not connect the selected account.'));
    } finally {
      setPickingId(null);
    }
  };

  const syncSpend = async () => {
    setSyncing(true);
    try {
      await adsAPI.syncAll(undefined, publisherClientId);
      showToast({ message: 'Google Ads spend sync started — ROI updates when it finishes.', replaceKey: 'admob-roi-ads-sync' });
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not start Google Ads sync.'));
    } finally {
      setSyncing(false);
    }
  };

  const s = data?.summary || {};
  const usingAllAccounts = data?.adsAccounts?.usingAllAccounts ?? adsData?.usingAllAccounts;

  return (
    <div className="dashboard-page reporting-page roi-page product-page--admob">
      <PageHeader
        title="AdMob ROI"
        subtitle="Google Ads spend vs AdMob earnings per app — choose which Google Ads accounts count for each AdMob publisher"
        summary={filterSummary}
      >
        <button type="button" className="btn-outline-action" onClick={syncSpend} disabled={syncing}>
          {syncing ? 'Starting…' : 'Sync spend'}
        </button>
        <button type="button" className="btn-outline-action" onClick={() => setChooserOpen(true)} disabled={connecting}>
          {connecting ? 'Opening Google…' : 'Add Google Ads account'}
        </button>
        <SavePresetButton page={PRESET_PAGES.admobRoi} userId={user?.id} getSnapshot={getPresetSnapshot} />
        <button type="button" className="btn-outline-action" onClick={handleCopyLink}>
          Copy link
        </button>
      </PageHeader>

      <CompareRangeBar
        mode={compareMode}
        onModeChange={handleCompareMode}
        customStart={compareStart}
        customEnd={compareEnd}
        onCustomStart={setCompareStart}
        onCustomEnd={setCompareEnd}
      />

      {account ? (
        <p className="form-note page-restriction-note">
          AdMob publisher: <strong>{publisherLabel}</strong>
          {account.accountId && account.descriptiveName ? ` (${account.accountId})` : ''}
          {' · '}
          {usingAllAccounts
            ? 'using spend from all connected Google Ads accounts'
            : `using ${linkedIds.length} saved Google Ads account(s)`}
        </p>
      ) : null}

      {picker ? (
        <div className="filter-card" style={{ marginTop: 12 }}>
          <div className="filter-card-head">
            <span className="filter-card-title">Choose the Google Ads account to connect</span>
            <div className="filter-actions">
              <button type="button" className="btn-reset" onClick={() => setPicker(null)} disabled={!!pickingId}>
                Cancel
              </button>
            </div>
          </div>
          <div className="table-wrap">
            <table className="data-table report-table report-table--comfortable">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Customer ID</th>
                  <th>Type</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {picker.options.map((o) => (
                  <tr key={o.customerId}>
                    <td>{o.descriptiveName || o.customerId}</td>
                    <td>{formatCustomerId(o.customerId)}</td>
                    <td>{o.kind === 'mcc' ? 'Manager (MCC)' : 'Client'}</td>
                    <td>
                      <button
                        type="button"
                        className="btn-generate"
                        onClick={() => pickOAuthAccount(o.customerId)}
                        disabled={!!pickingId}
                      >
                        {pickingId === o.customerId ? 'Connecting…' : 'Connect'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

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
            <RoiFilterSection title="Date range" subtitle="Same presets as Dashboard and Reporting">
              <RoiFilterRow icon="calendar" label="Period">
                <div className="roi-filter-date-toolbar">
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
                  <div className="preset-pills roi-filter-date-pills">
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
              </RoiFilterRow>
              {preset === 'custom' && (
                <div className="roi-filter-date-custom">
                  <div className="filter-field">
                    <label>Start date</label>
                    <input type="date" value={startDate || ''} onChange={(e) => setStartDate(e.target.value)} />
                  </div>
                  <div className="filter-field">
                    <label>End date</label>
                    <input type="date" value={endDate || ''} onChange={(e) => setEndDate(e.target.value)} />
                  </div>
                </div>
              )}
            </RoiFilterSection>

            <RoiFilterSection
              title="Google Ads & AdMob"
              subtitle="Google Ads accounts are shared with GAM ROI; the saved selection is per AdMob publisher."
            >
              <RoiFilterRow icon="accounts" label="Ads accounts">
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', width: '100%' }}>
                  <div style={{ flex: '1 1 320px', minWidth: 0 }}>
                    <MultiSelect
                      options={adsAccountOptions}
                      value={filterAdsAccountIds}
                      onChange={setFilterAdsAccountIds}
                      placeholder={
                        adsAccountOptions.length
                          ? 'Empty = saved default for this publisher (or all accounts)…'
                          : 'No Ads spend in this period — try another date or Sync spend'
                      }
                      loading={adsLoading}
                      searchable
                      showSelectAll
                      selectAllLabel="Select all accounts with spend"
                    />
                  </div>
                  <button
                    type="button"
                    className="btn-reset"
                    onClick={saveLinks}
                    disabled={!linksDirty || savingLinks || !account}
                    title="Save the picked accounts as the default for this AdMob publisher"
                  >
                    {savingLinks ? 'Saving…' : 'Save as publisher default'}
                  </button>
                </div>
              </RoiFilterRow>
              <RoiFilterRow icon="apps" label="AdMob apps">
                <MultiSelect
                  options={appOptions}
                  value={filterApps}
                  onChange={setFilterApps}
                  placeholder={appOptions.length ? 'All apps — pick to narrow…' : 'No AdMob app earnings in this period'}
                  disabled={!appOptions.length && !loading}
                  loading={loading && !appOptions.length}
                  searchable
                  showSelectAll
                  selectAllLabel="Select all apps"
                />
              </RoiFilterRow>
            </RoiFilterSection>

            <div className="roi-filter-notes">
              {!adsAccounts.length && !adsLoading ? (
                <p className="form-note">
                  No Google Ads accounts connected yet. Use <strong>Add Google Ads account</strong>, then <strong>Sync spend</strong>.
                </p>
              ) : null}
              {adsAccounts.length > 0 && !adsAccountOptions.length && !adsLoading ? (
                <p className="form-note page-restriction-note">
                  No Ads spend synced for <strong>{formatRoiDateRange(applied.startDate, applied.endDate)}</strong> yet.
                  Try <strong>Yesterday</strong> or run Sync spend.
                </p>
              ) : null}
              {data?.catalogError ? (
                <p className="form-note">
                  Could not load the AdMob app list ({data.catalogError}) — spend is matched by app name only.
                </p>
              ) : null}
            </div>
          </div>
        )}
      </div>

      {adsSyncHealth?.needsReconnect || (adsSyncHealth?.otherProblems || []).length > 0 ? (
        <div className="warn-card warn-card-partial" role="alert" style={{ marginTop: 12 }}>
          <div className="warn-card-main" style={{ gridTemplateColumns: '1fr' }}>
            <div className="warn-card-left" style={{ borderRight: 'none' }}>
              <div className="warn-card-icon-wrap"><span aria-hidden>!</span></div>
              <div className="warn-card-body">
                <div className="warn-card-title">
                  {adsSyncHealth.needsReconnect
                    ? 'Google Ads connection needs reconnect'
                    : 'Google Ads sync reported errors'}
                </div>
                <div className="warn-card-desc">
                  {adsSyncHealth.instruction || 'Open Google Ads accounts to review sync errors.'}
                  {(adsSyncHealth.authProblems || adsSyncHealth.otherProblems || []).slice(0, 3).map((p) => (
                    <div key={p.id} className="ads-sync-err" style={{ maxWidth: '100%', marginTop: 8 }} title={p.lastSyncError}>
                      {p.descriptiveName || p.customerId}: {p.lastSyncError || 'Needs reconnect'}
                    </div>
                  ))}
                </div>
                <div className="warn-card-btns">
                  <Link className="warn-btn-primary" to={adsSyncHealth.fixPath || '/admin?tab=ads'}>
                    {adsSyncHealth.needsReconnect ? 'Fix in Google Ads accounts' : 'Open Google Ads accounts'}
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {error && <div className="login-error" style={{ marginTop: 12 }}>{error}</div>}

      <RoiSummaryBoards
        summary={summary}
        deltas={cardDeltas}
        compareLabel={compareLabel}
        loading={loading && !data}
        fetchedAt={fetchedAt}
      />

      {data ? (
        <p className="form-note" style={{ marginTop: 8 }}>
          Total AdMob earnings (all apps): <strong>{formatRoiMoney(s.totalEarnings, spendCurrency)}</strong>
          {' · '}{s.linkedAppCount || 0} of {s.appCount || 0} apps have Ads spend
          {' · '}Conversions <strong>{formatRoiNum(s.conversions)}</strong>
          {s.costPerConversion != null ? (
            <> {' · '}Cost / conversion <strong>{formatRoiMoney(s.costPerConversion, spendCurrency)}</strong></>
          ) : null}
          {data.earningsCurrency && data.earningsCurrency !== spendCurrency
            ? ` · AdMob ${data.earningsCurrency} converted to ${spendCurrency}`
            : ''}
        </p>
      ) : null}

      {Number(s.unmatchedAppSpend) > 0 && (
        <div className="warn-card warn-card-partial" role="status" style={{ marginTop: 12 }}>
          <div className="warn-card-main">
            <div className="warn-card-left">
              <div className="warn-card-icon-wrap"><span aria-hidden>i</span></div>
              <div className="warn-card-body">
                <div className="warn-card-title">Ads spend on other apps</div>
                <div className="warn-card-desc">
                  {formatRoiMoney(s.unmatchedAppSpend, spendCurrency)} of App campaign spend in this range is for apps
                  that are not in this AdMob publisher, so it is excluded from ROI.
                  {usingAllAccounts ? ' Pick only this publisher\'s Google Ads accounts and Save as publisher default to hide it.' : ''}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {!loading && data && !(Number(s.adsSpend) > 0) && (
        <div className="warn-card" role="status" style={{ marginTop: 12 }}>
          <div className="warn-card-main">
            <div className="warn-card-left">
              <div className="warn-card-icon-wrap"><span aria-hidden>i</span></div>
              <div className="warn-card-body">
                <div className="warn-card-title">No Google Ads spend matched to AdMob apps</div>
                <div className="warn-card-desc">
                  Spend is matched when an App campaign promotes the same store app as this publisher,
                  or a campaign is mapped to the app in Admin → Google Ads accounts → Campaign mapping.
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <RoiCountryTreeTable
        title="ROI by app"
        tree={tree}
        loading={loading}
        search={treeSearch}
        onSearchChange={setTreeSearch}
        onPageReset={() => setTreePage(1)}
        page={treePage}
        pageSize={isNarrow ? 12 : 50}
        onPageChange={setTreePage}
        density={tableDensity}
        freezeFirst
        spendCurrency={spendCurrency}
        labelColumn="App / Day"
        hideColumns={HIDDEN_TREE_COLUMNS}
        topIconKind="app"
        searchPlaceholder="Search app / date…"
        exportName={`admob_roi_${applied.startDate}_${applied.endDate}`}
        className="reporting-table"
        emptyMessage={linkedOnly ? 'No AdMob apps with Google Ads spend for the selected filters' : 'No AdMob app earnings for the selected filters'}
        onReset={reset}
        emptyActions={(
          <>
            {linkedOnly ? (
              <button type="button" className="btn-generate" onClick={() => setLinkedOnly(false)}>Show all apps</button>
            ) : null}
            <button type="button" className="btn-reset" onClick={() => applyPreset('yesterday')}>Try yesterday</button>
            <button type="button" className="btn-reset" onClick={() => applyPreset('last7')}>Try last 7 days</button>
          </>
        )}
        headerExtra={(
          <>
            <div className="table-density-toggle" role="group" aria-label="Apps shown">
              <button
                type="button"
                className={`table-density-btn${linkedOnly ? ' active' : ''}`}
                onClick={() => { setLinkedOnly(true); setTreePage(1); }}
              >
                With Ads spend
              </button>
              <button
                type="button"
                className={`table-density-btn${!linkedOnly ? ' active' : ''}`}
                onClick={() => { setLinkedOnly(false); setTreePage(1); }}
              >
                All apps
              </button>
            </div>
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
            {applied.startDate && applied.endDate ? (
              <span className="report-range">{applied.startDate} → {applied.endDate}</span>
            ) : null}
          </>
        )}
      />

      <AdsConnectChooser
        open={chooserOpen}
        onClose={() => setChooserOpen(false)}
        clientId={publisherClientId}
        onConnectGoogle={connectWithGoogle}
        onUsed={onUsedExistingLogin}
        reconnectReturnTo="admob-roi"
        title={`Add Google Ads account for ${publisherLabel}`}
      />
    </div>
  );
}
