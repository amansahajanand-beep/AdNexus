import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import RoiCountryTreeTable from './RoiCountryTreeTable';
import RoiSummaryBoards from './RoiSummaryBoards';
import PresetDateToolbar from '../presets/PresetDateToolbar';
import { useAuth } from '../../store/useAuth';
import { usePresetDateRange } from '../../hooks/usePresetDateRange';
import { roiAPI } from '../../utils/api';
import { hrefForPreset, mergePresetWithDates, summaryForPreset } from '../../utils/reportPresets';
import {
  buildCountryTree,
  formatRoiMoney,
  mergeRoiBreakdownPayload,
  mergeRoiSummaryPayload,
  snapshotToRoiSummaryParams,
} from '../../utils/report/roiView';
import { getUserFacingMessage, logErrorForDebug } from '../../utils/userFacingError';
import { useMedia } from '../../hooks/useMedia';

const PAGE_SIZE = 50;

/**
 * Live ROI overview + table for a saved ROI preset (used on Presets page).
 */
export default function RoiPresetDetail({
  presetItem,
  onPin,
  onRename,
  onDelete,
}) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isNarrow = useMedia('(max-width: 768px)');
  const snapshot = presetItem?.snapshot || {};

  const {
    preset,
    startDate,
    endDate,
    applied,
    dateRestriction,
    dateFilterLocked,
    presetOptions,
    presetLabel,
    customDatesIncomplete,
    onPreset,
    applyDates,
    setStartDate,
    setEndDate,
  } = usePresetDateRange(user, presetItem?.id);

  const activeSnapshot = useMemo(
    () => mergePresetWithDates(snapshot, {
      startDate: applied.startDate,
      endDate: applied.endDate,
      preset,
    }),
    [snapshot, applied.startDate, applied.endDate, preset]
  );

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [breakdownLoading, setBreakdownLoading] = useState(false);
  const [error, setError] = useState(null);
  const [countryPage, setCountryPage] = useState(1);
  const [countrySearch, setCountrySearch] = useState('');

  useEffect(() => {
    setCountryPage(1);
    setCountrySearch('');
  }, [presetItem?.id]);

  useEffect(() => {
    const params = snapshotToRoiSummaryParams(activeSnapshot);
    if (!params) {
      setData(null);
      setError('Select a date range and click Apply dates.');
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setBreakdownLoading(true);
    setError(null);

    const summaryPromise = roiAPI.summary({ ...params, summaryOnly: '1' })
      .then((fast) => {
        if (cancelled) return null;
        setData((prev) => mergeRoiSummaryPayload(prev, fast));
        setLoading(false);
        return fast;
      })
      .catch((err) => {
        if (cancelled) return null;
        logErrorForDebug(err, 'ROI preset summary');
        return { __err: err };
      });

    const breakdownPromise = roiAPI.summary({ ...params, breakdownOnly: '1' })
      .then((breakdown) => {
        if (cancelled) return null;
        setData((prev) => mergeRoiBreakdownPayload(prev, breakdown));
        setBreakdownLoading(false);
        setLoading(false);
        return breakdown;
      })
      .catch((err) => {
        if (cancelled) return null;
        logErrorForDebug(err, 'ROI preset breakdown');
        return { __err: err };
      });

    (async () => {
      try {
        const [sumRes, bdRes] = await Promise.all([summaryPromise, breakdownPromise]);
        if (cancelled) return;
        const summaryFailed = !sumRes || sumRes.__err;
        const breakdownFailed = !bdRes || bdRes.__err;
        if (summaryFailed && breakdownFailed) {
          setError(getUserFacingMessage(
            sumRes?.__err || bdRes?.__err,
            'Could not load ROI for this preset.'
          ));
          setData(null);
        } else if (summaryFailed) {
          setError(getUserFacingMessage(sumRes?.__err, 'Could not load ROI overview cards.'));
        } else {
          setError(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          setBreakdownLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [
    presetItem?.id,
    activeSnapshot.startDate,
    activeSnapshot.endDate,
    activeSnapshot.targetType,
    JSON.stringify(activeSnapshot.accountIds || []),
    JSON.stringify(activeSnapshot.campaignIds || []),
    JSON.stringify(activeSnapshot.appKeys || []),
    JSON.stringify(activeSnapshot.siteKeys || []),
    JSON.stringify(activeSnapshot.countryCodes || []),
  ]);

  const summary = data?.summary || {};
  const countryTargetBreakdown = data?.countryTargetBreakdown || [];
  const countryBreakdown = data?.countryBreakdown || [];
  const countryTargetDailyBreakdown = data?.countryTargetDailyBreakdown || [];
  const countryTree = useMemo(
    () => buildCountryTree(
      countryBreakdown,
      countryTargetBreakdown,
      countryTargetDailyBreakdown,
      { startDate: applied.startDate, endDate: applied.endDate },
    ),
    [
      countryBreakdown,
      countryTargetBreakdown,
      countryTargetDailyBreakdown,
      applied.startDate,
      applied.endDate,
    ]
  );

  const openInRoi = () => {
    navigate(hrefForPreset('roi', activeSnapshot));
  };

  if (!presetItem) {
    return (
      <div className="presets-detail-empty" role="status">
        <div className="warn-card-title">Select an ROI preset</div>
        <p className="form-note" style={{ margin: '8px 0 0' }}>
          Choose a saved ROI combo on the left to preview overview cards and the results table here.
        </p>
      </div>
    );
  }

  return (
    <div className="presets-roi-detail">
      <div className="presets-roi-detail-head">
        <div>
          <h2 className="presets-roi-detail-title">
            {presetItem.pinned ? <span className="presets-pin-badge" title="Pinned">★</span> : null}
            {presetItem.name}
          </h2>
          <p className="presets-roi-detail-summary">
            {presetItem.summary || summaryForPreset(snapshot)}
          </p>
        </div>
        <div className="presets-item-actions">
          <button type="button" className="btn-generate" onClick={openInRoi}>
            Open in ROI
          </button>
          {onPin ? (
            <button
              type="button"
              className={`btn-reset${presetItem.pinned ? ' presets-pin-active' : ''}`}
              onClick={onPin}
            >
              {presetItem.pinned ? 'Unpin' : 'Pin'}
            </button>
          ) : null}
          {onRename ? (
            <button type="button" className="btn-reset" onClick={onRename}>Rename</button>
          ) : null}
          {onDelete ? (
            <button type="button" className="btn-reset" onClick={onDelete}>Delete</button>
          ) : null}
        </div>
      </div>

      <PresetDateToolbar
        preset={preset}
        startDate={startDate}
        endDate={endDate}
        presetLabel={presetLabel}
        presetOptions={presetOptions}
        customDatesIncomplete={customDatesIncomplete}
        dateFilterLocked={dateFilterLocked}
        dateRestriction={dateRestriction}
        onPreset={onPreset}
        onStartDateChange={setStartDate}
        onEndDateChange={setEndDate}
        onApply={applyDates}
      />

      {error ? <div className="login-error" style={{ marginTop: 12 }}>{error}</div> : null}

      <RoiSummaryBoards
        summary={summary}
        loading={loading}
        showLive={false}
      />

      {summary.unmappedSpend > 0 && (
        <p className="form-note" style={{ marginTop: 12 }}>
          Unmapped Ads spend: {formatRoiMoney(summary.unmappedSpend)} (hidden from table / ROI cards).
        </p>
      )}

      {(countryTree.length > 0 || loading) && (
        <div style={{ marginTop: 16 }}>
          <RoiCountryTreeTable
            tree={countryTree}
            loading={loading || breakdownLoading}
            search={countrySearch}
            onSearchChange={setCountrySearch}
            onPageReset={() => setCountryPage(1)}
            page={countryPage}
            pageSize={isNarrow ? 12 : PAGE_SIZE}
            onPageChange={setCountryPage}
            density="comfortable"
            freezeFirst
            className="reporting-table"
            exportName={`roi_preset_countries_${applied.startDate || 'x'}_${applied.endDate || 'y'}`}
            headerExtra={
              applied.startDate && applied.endDate ? (
                <span className="report-range">{applied.startDate} → {applied.endDate}</span>
              ) : null
            }
          />
        </div>
      )}
    </div>
  );
}
