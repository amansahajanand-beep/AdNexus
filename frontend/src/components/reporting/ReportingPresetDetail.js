import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import DynamicReportTable from '../ui/DynamicReportTable';
import PresetDateToolbar from '../presets/PresetDateToolbar';
import { useAuth } from '../../store/useAuth';
import { usePresetDateRange } from '../../hooks/usePresetDateRange';
import { reportsAPI } from '../../utils/api';
import { hrefForPreset, mergePresetWithDates, summaryForPreset } from '../../utils/reportPresets';
import {
  snapshotToReportingParams,
  formatReportingMoney,
} from '../../utils/report/reportingView';
import { buildReportColumns } from '../../utils/report/dynamicReportTable';
import { enrichReportRows } from '../../utils/enrichReportRows';
import { getUserFacingMessage, logErrorForDebug } from '../../utils/userFacingError';
import { useMedia } from '../../hooks/useMedia';

const PAGE_SIZE = 50;

export default function ReportingPresetDetail({
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
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');

  const resolved = useMemo(
    () => snapshotToReportingParams(activeSnapshot),
    [
      activeSnapshot.startDate,
      activeSnapshot.endDate,
      JSON.stringify(activeSnapshot.country || []),
      JSON.stringify(activeSnapshot.domain || []),
      JSON.stringify(activeSnapshot.site || []),
      JSON.stringify(activeSnapshot.domainName || []),
      JSON.stringify(activeSnapshot.domainId || []),
      JSON.stringify(activeSnapshot.reportDimensions || []),
      JSON.stringify(activeSnapshot.reportMetrics || []),
    ]
  );

  useEffect(() => {
    setPage(1);
    setSearch('');
  }, [presetItem?.id]);

  useEffect(() => {
    if (!resolved) {
      setData(null);
      setError(presetItem
        ? 'Select a date range and click Apply dates, or fix the report selection in this preset.'
        : null);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const payload = resolved.tableConfig.mode === 'programmatic'
          ? await reportsAPI.getProgrammatic(resolved.reportFilters)
          : await reportsAPI.getDetailed(resolved.reportFilters);
        if (!cancelled) setData(payload);
      } catch (err) {
        logErrorForDebug(err, 'Reporting preset detail');
        if (!cancelled) {
          setError(getUserFacingMessage(err, 'Could not load Reporting for this preset.'));
          setData(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [presetItem?.id, resolved]);

  const tableConfig = resolved?.tableConfig || { dimensions: [], metrics: [] };
  const columns = useMemo(
    () => buildReportColumns(tableConfig.dimensions, tableConfig.metrics, {}),
    [tableConfig.dimensions, tableConfig.metrics]
  );

  const tableRows = useMemo(() => {
    const raw = data?.rows || [];
    return enrichReportRows(raw, tableConfig.dimensions, tableConfig.metrics);
  }, [data, tableConfig]);

  const summary = data?.summary || {};
  const currency = data?.currency || summary.currency || 'USD';

  if (!presetItem) {
    return (
      <div className="presets-detail-empty" role="status">
        <div className="warn-card-title">Select a Reporting preset</div>
        <p className="form-note" style={{ margin: '8px 0 0' }}>
          Choose a saved Reporting combo on the left to preview summary cards and the results table.
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
          <button
            type="button"
            className="btn-generate"
            onClick={() => navigate(hrefForPreset('reporting', activeSnapshot))}
          >
            Open in Reporting
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

      <div className={`report-summary-row${loading ? ' is-loading' : ''}`}>
        <div className={`report-sum-card${loading ? ' is-loading' : ''}`}>
          <span className="rsc-icon green">$</span>
          <div>
            <div className="rsc-label">Total Revenue</div>
            <div className="rsc-value">
              {loading
                ? <span className="card-spinner card-spinner-lg" aria-label="Loading" />
                : formatReportingMoney(summary.totalRevenue, currency)}
            </div>
          </div>
        </div>
        <div className={`report-sum-card${loading ? ' is-loading' : ''}`}>
          <span className="rsc-icon blue">▣</span>
          <div>
            <div className="rsc-label">Total App & Website Domain</div>
            <div className="rsc-value">
              {loading
                ? <span className="card-spinner card-spinner-lg" aria-label="Loading" />
                : (Number(summary.totalDomains) || 0).toLocaleString()}
            </div>
          </div>
        </div>
        <div className={`report-sum-card${loading ? ' is-loading' : ''}`}>
          <span className="rsc-icon amber">#</span>
          <div>
            <div className="rsc-label">Offered Records</div>
            <div className="rsc-value">
              {loading
                ? <span className="card-spinner card-spinner-lg" aria-label="Loading" />
                : (Number(summary.offeredRecords) || 0).toLocaleString()}
            </div>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <DynamicReportTable
          title="Reporting results"
          rows={tableRows}
          dimensions={tableConfig.dimensions}
          metrics={tableConfig.metrics}
          columns={columns}
          currency={currency}
          loading={loading}
          search={search}
          onSearchChange={setSearch}
          onPageReset={() => setPage(1)}
          searchPlaceholder="Search rows…"
          page={page}
          pageSize={isNarrow ? 12 : PAGE_SIZE}
          onPageChange={setPage}
          showTotals={tableRows.length > 0}
          density="comfortable"
          freezeFirst
          noReportMessage="No Reporting rows for this preset"
          emptyMessage="No Reporting rows for this preset"
          columnStorageKey={`reporting-preset-${presetItem.id}`}
          canDownload
          exportName={`reporting_preset_${applied.startDate || 'x'}_${applied.endDate || 'y'}`}
        />
      </div>
    </div>
  );
}
