import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import DynamicReportTable from '../ui/DynamicReportTable';
import GamOverviewCard from '../ui/GamOverviewCard';
import { reportsAPI } from '../../utils/api';
import { hrefForPreset, summaryForPreset } from '../../utils/reportPresets';
import { snapshotToDashboardParams } from '../../utils/report/dashboardView';
import {
  resolveDashboardTableConfig,
  buildReportColumns,
} from '../../utils/report/dynamicReportTable';
import { enrichReportRows } from '../../utils/enrichReportRows';
import { getUserFacingMessage, logErrorForDebug } from '../../utils/userFacingError';
import { useMedia } from '../../hooks/useMedia';

const PAGE_SIZE = 50;

export default function DashboardPresetDetail({
  presetItem,
  onPin,
  onRename,
  onDelete,
}) {
  const navigate = useNavigate();
  const isNarrow = useMedia('(max-width: 768px)');
  const snapshot = presetItem?.snapshot || {};

  const [overview, setOverview] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');

  useEffect(() => {
    setPage(1);
    setSearch('');
  }, [presetItem?.id]);

  useEffect(() => {
    const params = snapshotToDashboardParams(snapshot);
    if (!params) {
      setOverview(null);
      setDetail(null);
      setError('This preset is missing a date range.');
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const [ov, det] = await Promise.all([
          reportsAPI.getDashboardOverview(params.overview),
          reportsAPI.getDashboard(params.detail),
        ]);
        if (cancelled) return;
        setOverview(ov);
        setDetail(det);
      } catch (err) {
        logErrorForDebug(err, 'Dashboard preset detail');
        if (!cancelled) {
          setError(getUserFacingMessage(err, 'Could not load Dashboard for this preset.'));
          setOverview(null);
          setDetail(null);
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
    JSON.stringify(snapshot.domain || []),
    JSON.stringify(snapshot.site || []),
    JSON.stringify(snapshot.domainName || []),
    JSON.stringify(snapshot.domainId || []),
  ]);

  const dashParams = useMemo(() => snapshotToDashboardParams(snapshot), [
    snapshot.startDate,
    snapshot.endDate,
    JSON.stringify(snapshot.domain || []),
    JSON.stringify(snapshot.site || []),
    JSON.stringify(snapshot.domainName || []),
    JSON.stringify(snapshot.domainId || []),
  ]);

  const tableConfig = useMemo(
    () => resolveDashboardTableConfig(dashParams?.applied || {}, Boolean(dashParams?.filterApplied)),
    [dashParams]
  );

  const columns = useMemo(
    () => buildReportColumns(tableConfig.dimensions, tableConfig.metrics, {}),
    [tableConfig]
  );

  const tableRows = useMemo(() => {
    const raw = detail?.rows || [];
    return enrichReportRows(raw, tableConfig.dimensions, tableConfig.metrics, { useProxy: false });
  }, [detail, tableConfig]);

  const currency = overview?.summary?.currency || overview?.currency || detail?.currency || 'USD';
  const summary = overview?.summary || {};

  if (!presetItem) {
    return (
      <div className="presets-detail-empty" role="status">
        <div className="warn-card-title">Select a Dashboard preset</div>
        <p className="form-note" style={{ margin: '8px 0 0' }}>
          Choose a saved Dashboard combo on the left to preview overview and the results table.
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
            onClick={() => navigate(hrefForPreset('dashboard', snapshot))}
          >
            Open in Dashboard
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

      <div className="dash-overview-row" style={{ marginTop: 8 }}>
        <GamOverviewCard
          summary={summary}
          currency={currency}
          loading={loading}
          sparkSeries={[]}
        />
      </div>

      <div style={{ marginTop: 16 }}>
        <DynamicReportTable
          title="Dashboard report"
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
          noReportMessage="No Dashboard rows for this preset"
          emptyMessage="No Dashboard rows for this preset"
          columnStorageKey={`dash-preset-${presetItem.id}`}
          canDownload
          exportName={`dashboard_preset_${snapshot.startDate || 'x'}_${snapshot.endDate || 'y'}`}
        />
      </div>
    </div>
  );
}
