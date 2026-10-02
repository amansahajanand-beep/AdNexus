import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { EmptyIcon } from '../ui/Icon';
import PresetDateToolbar from './PresetDateToolbar';
import PresetAiAnalysis from './PresetAiAnalysis';
import PresetDetailHead from './PresetDetailHead';
import ProductKpiStrip from '../ui/ProductKpiStrip';
import ProductDetailTable from '../ui/ProductDetailTable';
import { useAuth } from '../../store/useAuth';
import { usePresetDateRange } from '../../hooks/usePresetDateRange';
import usePublisherReport from '../../hooks/usePublisherReport';
import { admobAPI, adsenseAPI } from '../../utils/api';
import { hrefForPreset, mergePresetWithDates, PRESET_PAGES } from '../../utils/reportPresets';

const PRODUCTS = {
  admob: {
    api: admobAPI,
    label: 'AdMob',
    breakdownDim: 'app',
    pages: { dashboard: PRESET_PAGES.admob, reporting: PRESET_PAGES.admobReporting },
    accent: '#EA4335',
  },
  adsense: {
    api: adsenseAPI,
    label: 'AdSense',
    breakdownDim: 'site',
    pages: { dashboard: PRESET_PAGES.adsense, reporting: PRESET_PAGES.adsenseReporting },
    accent: '#D97706',
  },
};

/** Preview pane for AdMob / AdSense Dashboard and Reporting presets (kind = 'dashboard' | 'reporting'). */
export default function PublisherPresetDetail({
  product,
  kind,
  presetItem,
  onPin,
  onRename,
  onDelete,
  onDuplicate,
}) {
  const cfg = PRODUCTS[product];
  const navigate = useNavigate();
  const { user } = useAuth();
  const kindLabel = kind === 'reporting' ? 'Reporting' : 'Dashboard';
  const dates = usePresetDateRange(user, presetItem?.id);
  const report = usePublisherReport(cfg.api, {
    product,
    enabled: Boolean(presetItem),
    defaultBreakdownDim: cfg.breakdownDim,
    defaultTableDim: 'ad_unit',
    includeExtraFilters: kind === 'reporting',
  });
  const { applySavedSnapshot, setRange, setDatePreset } = report;

  useEffect(() => {
    if (presetItem) applySavedSnapshot(presetItem.snapshot || {});
  }, [presetItem, applySavedSnapshot]);

  useEffect(() => {
    if (!dates.applied.startDate || !dates.applied.endDate) return;
    setRange({ startDate: dates.applied.startDate, endDate: dates.applied.endDate });
    setDatePreset(dates.preset);
  }, [dates.applied.startDate, dates.applied.endDate, dates.preset, setRange, setDatePreset]);

  if (!presetItem) {
    return (
      <div className="presets-detail-empty" role="status">
        <div className="presets-detail-empty-icon" aria-hidden><EmptyIcon size={36} /></div>
        <div className="warn-card-title">Select a {cfg.label} {kindLabel} preset</div>
        <p className="form-note" style={{ margin: '8px 0 0' }}>
          Choose a saved {cfg.label} {kindLabel} combo on the left to preview its overview and table.
        </p>
      </div>
    );
  }

  const currency = report.overview?.currency || 'USD';
  const openSnapshot = mergePresetWithDates(presetItem.snapshot, {
    startDate: dates.applied.startDate,
    endDate: dates.applied.endDate,
    preset: dates.preset,
  });

  return (
    <div className="presets-roi-detail">
      <PresetDetailHead
        presetItem={presetItem}
        openLabel={`Open in ${cfg.label} ${kindLabel}`}
        onOpen={() => navigate(hrefForPreset(cfg.pages[kind], openSnapshot))}
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
        kind={kind}
        filters={presetItem.snapshot}
        startDate={dates.applied.startDate}
        endDate={dates.applied.endDate}
      />

      {report.error ? <div className="login-error" style={{ marginTop: 12 }}>{report.error}</div> : null}

      <div style={{ marginTop: 8 }}>
        <ProductKpiStrip
          kpis={report.overview?.kpis || []}
          currency={currency}
          accentColor={cfg.accent}
          compareLabel={report.compareLabel}
        />
      </div>

      <div style={{ marginTop: 16 }}>
        <ProductDetailTable
          title={kind === 'reporting' ? `${cfg.label} report` : 'Ad units'}
          product={product}
          dim={report.table.dim || 'ad_unit'}
          currency={currency}
          visibility={report.visibility}
          loading={report.loading}
          rows={report.table.rows || []}
          emptyMessage="No rows for this preset in the selected range"
        />
      </div>
    </div>
  );
}
