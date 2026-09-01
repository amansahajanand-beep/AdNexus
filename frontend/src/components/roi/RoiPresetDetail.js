import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import RoiCountryTreeTable from './RoiCountryTreeTable';
import { roiAPI } from '../../utils/api';
import { hrefForPreset, summaryForPreset } from '../../utils/reportPresets';
import {
  buildRoiSummaryCards,
  buildCountryTree,
  formatRoiMoney,
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
  const isNarrow = useMedia('(max-width: 768px)');
  const snapshot = presetItem?.snapshot || {};

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [countryPage, setCountryPage] = useState(1);
  const [countrySearch, setCountrySearch] = useState('');

  useEffect(() => {
    setCountryPage(1);
    setCountrySearch('');
  }, [presetItem?.id]);

  useEffect(() => {
    const params = snapshotToRoiSummaryParams(snapshot);
    if (!params) {
      setData(null);
      setError('This preset is missing a date range.');
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const summary = await roiAPI.summary(params);
        if (!cancelled) setData(summary);
      } catch (err) {
        logErrorForDebug(err, 'ROI preset detail');
        if (!cancelled) {
          setError(getUserFacingMessage(err, 'Could not load ROI for this preset.'));
          setData(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [
    presetItem?.id,
    snapshot.startDate,
    snapshot.endDate,
    snapshot.targetType,
    JSON.stringify(snapshot.accountIds || []),
    JSON.stringify(snapshot.campaignIds || []),
    JSON.stringify(snapshot.appKeys || []),
    JSON.stringify(snapshot.siteKeys || []),
    JSON.stringify(snapshot.countryCodes || []),
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
      { startDate: snapshot.startDate, endDate: snapshot.endDate },
    ),
    [
      countryBreakdown,
      countryTargetBreakdown,
      countryTargetDailyBreakdown,
      snapshot.startDate,
      snapshot.endDate,
    ]
  );
  const summaryCards = useMemo(() => buildRoiSummaryCards(summary), [summary]);

  const openInRoi = () => {
    navigate(hrefForPreset('roi', snapshot));
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

      {error ? <div className="login-error" style={{ marginTop: 12 }}>{error}</div> : null}

      <div className={`report-summary-row roi-summary-grid${loading ? ' is-loading' : ''}`}>
        {summaryCards.map((card) => (
          <div key={card.key} className={`report-sum-card${loading ? ' is-loading' : ''}`}>
            <span className={`rsc-icon ${card.tone}`}>{card.icon}</span>
            <div>
              <div className="rsc-label">{card.label}</div>
              <div className="rsc-value">
                {loading ? <span className="card-spinner card-spinner-lg" aria-label="Loading" /> : card.value}
              </div>
            </div>
          </div>
        ))}
      </div>

      {summary.unmappedSpend > 0 && (
        <p className="form-note" style={{ marginTop: 12 }}>
          Unmapped Ads spend: {formatRoiMoney(summary.unmappedSpend)} (hidden from table / ROI cards).
        </p>
      )}

      {(countryTree.length > 0 || loading) && (
        <div style={{ marginTop: 16 }}>
          <RoiCountryTreeTable
            tree={countryTree}
            loading={loading}
            search={countrySearch}
            onSearchChange={setCountrySearch}
            onPageReset={() => setCountryPage(1)}
            page={countryPage}
            pageSize={isNarrow ? 12 : PAGE_SIZE}
            onPageChange={setCountryPage}
            density="comfortable"
            freezeFirst
            className="reporting-table"
            exportName={`roi_preset_countries_${snapshot.startDate || 'x'}_${snapshot.endDate || 'y'}`}
            headerExtra={
              snapshot.startDate && snapshot.endDate ? (
                <span className="report-range">{snapshot.startDate} → {snapshot.endDate}</span>
              ) : null
            }
          />
        </div>
      )}
    </div>
  );
}
