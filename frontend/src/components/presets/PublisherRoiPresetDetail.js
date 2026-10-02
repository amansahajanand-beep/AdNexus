import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { EmptyIcon } from '../ui/Icon';
import PresetDateToolbar from './PresetDateToolbar';
import PresetAiAnalysis from './PresetAiAnalysis';
import PresetDetailHead from './PresetDetailHead';
import RoiSummaryBoards from '../roi/RoiSummaryBoards';
import RoiCountryTreeTable from '../roi/RoiCountryTreeTable';
import { useAuth } from '../../store/useAuth';
import { usePresetDateRange } from '../../hooks/usePresetDateRange';
import { admobAPI, adsenseAPI } from '../../utils/api';
import { buildAppTree } from '../../pages/admob/AdMobRoi';
import { buildSiteTree } from '../../pages/adsense/AdSenseRoi';
import { hrefForPreset, mergePresetWithDates, PRESET_PAGES } from '../../utils/reportPresets';
import { getUserFacingMessage, logErrorForDebug } from '../../utils/userFacingError';

const HIDDEN_TREE_COLUMNS = ['otherExpenses', 'profitExpense', 'roiExpensePercent'];

const PRODUCTS = {
  admob: {
    api: admobAPI,
    label: 'AdMob',
    entity: 'apps',
    entityLabel: 'App',
    page: PRESET_PAGES.admobRoi,
    buildTree: buildAppTree,
  },
  adsense: {
    api: adsenseAPI,
    label: 'AdSense',
    entity: 'sites',
    entityLabel: 'Site',
    page: PRESET_PAGES.adsenseRoi,
    buildTree: buildSiteTree,
  },
};

const concrete = (list) => (list || []).filter((v) => v && v !== '__ALL__');
const ctrOf = (clicks, impressions) => (impressions > 0 ? (clicks / impressions) * 100 : null);
const ecpmOf = (spend, impressions) => (impressions > 0 ? (spend / impressions) * 1000 : null);

/** Preview pane for AdMob / AdSense ROI presets: Google Ads spend vs earnings for the saved filters. */
export default function PublisherRoiPresetDetail({
  product,
  presetItem,
  onPin,
  onRename,
  onDelete,
  onDuplicate,
}) {
  const cfg = PRODUCTS[product];
  const navigate = useNavigate();
  const { user } = useAuth();
  const dates = usePresetDateRange(user, presetItem?.id);
  const { startDate, endDate } = dates.applied;

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const snapshot = presetItem?.snapshot;
  const accountIds = useMemo(() => concrete(snapshot?.accountIds), [snapshot]);
  const entityValues = useMemo(() => concrete(snapshot?.[cfg.entity]), [snapshot, cfg.entity]);

  useEffect(() => {
    setSearch('');
    setPage(1);
  }, [presetItem?.id]);

  useEffect(() => {
    if (!presetItem || !startDate || !endDate) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = { startDate, endDate };
    if (accountIds.length) params.adsAccountIds = accountIds.join(',');
    if (entityValues.length) params[cfg.entity] = entityValues.join(',');
    cfg.api.roi(params)
      .then((res) => { if (!cancelled) setData(res); })
      .catch((err) => {
        if (cancelled) return;
        logErrorForDebug(err, `${cfg.label} ROI preset`);
        setData(null);
        setError(getUserFacingMessage(err, `Could not load ${cfg.label} ROI for this preset.`));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [presetItem, startDate, endDate, accountIds, entityValues, cfg]);

  const currency = data?.currency || 'USD';
  const summary = useMemo(() => {
    const s = data?.summary || {};
    return {
      adsSpendCurrency: currency,
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
  }, [data, currency]);

  const tree = useMemo(
    () => cfg.buildTree(data?.[cfg.entity], { startDate, endDate, linkedOnly: true }),
    [cfg, data, startDate, endDate]
  );

  if (!presetItem) {
    return (
      <div className="presets-detail-empty" role="status">
        <div className="presets-detail-empty-icon" aria-hidden><EmptyIcon size={36} /></div>
        <div className="warn-card-title">Select a {cfg.label} ROI preset</div>
        <p className="form-note" style={{ margin: '8px 0 0' }}>
          Choose a saved {cfg.label} ROI combo on the left to preview spend, earnings and ROI.
        </p>
      </div>
    );
  }

  const openSnapshot = mergePresetWithDates(presetItem.snapshot, {
    startDate,
    endDate,
    preset: dates.preset,
  });

  return (
    <div className="presets-roi-detail">
      <PresetDetailHead
        presetItem={presetItem}
        openLabel={`Open in ${cfg.label} ROI`}
        onOpen={() => navigate(hrefForPreset(cfg.page, openSnapshot))}
        onPin={onPin}
        onRename={onRename}
        onDelete={onDelete}
        onDuplicate={onDuplicate}
      />

      <PresetDateToolbar
        preset={dates.preset}
        startDate={dates.startDate}
        endDate={dates.endDate}
        presetLabel={dates.presetLabel}
        presetOptions={dates.presetOptions}
        customDatesIncomplete={dates.customDatesIncomplete}
        dateFilterLocked={dates.dateFilterLocked}
        dateRestriction={dates.dateRestriction}
        onPreset={dates.onPreset}
        onStartDateChange={dates.setStartDate}
        onEndDateChange={dates.setEndDate}
        onApply={dates.applyDates}
      />

      <PresetAiAnalysis
        product={product}
        kind="roi"
        filters={presetItem.snapshot}
        startDate={dates.applied.startDate}
        endDate={dates.applied.endDate}
      />

      {error ? <div className="login-error" style={{ marginTop: 12 }}>{error}</div> : null}

      <RoiSummaryBoards summary={summary} loading={loading && !data} />

      <div style={{ marginTop: 16 }}>
        <RoiCountryTreeTable
          title={`ROI by ${cfg.entityLabel.toLowerCase()}`}
          tree={tree}
          loading={loading}
          search={search}
          onSearchChange={setSearch}
          onPageReset={() => setPage(1)}
          page={page}
          pageSize={50}
          onPageChange={setPage}
          density="comfortable"
          freezeFirst
          spendCurrency={currency}
          labelColumn={`${cfg.entityLabel} / Day`}
          hideColumns={HIDDEN_TREE_COLUMNS}
          topIconKind={cfg.entityLabel.toLowerCase()}
          searchPlaceholder={`Search ${cfg.entityLabel.toLowerCase()} / date…`}
          exportName={`${product}_roi_preset_${startDate || 'x'}_${endDate || 'y'}`}
          emptyMessage={`No ${cfg.label} ${cfg.entity} with Google Ads spend for this preset`}
        />
      </div>
    </div>
  );
}
