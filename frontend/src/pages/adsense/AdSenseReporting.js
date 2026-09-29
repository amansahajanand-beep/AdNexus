import React, { useState } from 'react';
import PageHeader from '../../components/ui/PageHeader';
import DataFreshness from '../../components/ui/DataFreshness';
import SavePresetButton from '../../components/ui/SavePresetButton';
import ProductReportFilters, { useProductCompareState } from '../../components/ui/ProductReportFilters';
import ProductDetailTable from '../../components/ui/ProductDetailTable';
import { ADSENSE_SAMPLE } from '../../utils/productSampleData';
import { adsenseAPI } from '../../utils/api';
import { copyReportLink } from '../../utils/report/reportShare';
import { SAVED_FILTERS_PAGES } from '../../utils/savedFilters';
import { PRESET_PAGES } from '../../utils/reportPresets';
import { showToast } from '../../hooks/useToast';
import { usePermissions } from '../../hooks/usePermissions';
import { useAuth } from '../../store/useAuth';
import usePublisherReport from '../../hooks/usePublisherReport';

const DIM_OPTIONS = [
  { value: 'ad_unit', label: 'Ad unit' },
  { value: 'site', label: 'Site' },
  { value: 'country', label: 'Country' },
  { value: 'platform', label: 'Platform' },
];

export default function AdSenseReporting() {
  const { user } = useAuth();
  const { visibility } = usePermissions();
  const compare = useProductCompareState(user?.id);
  const [tableDim, setTableDim] = useState('ad_unit');
  const report = usePublisherReport(adsenseAPI, {
    product: 'adsense',
    canUseFilters: visibility.filters !== false,
    defaultBreakdownDim: 'site',
    defaultTableDim: tableDim,
    compareMode: compare.compareMode,
    compareStart: compare.compareStart,
    compareEnd: compare.compareEnd,
  });

  const useSample = report.isSample;
  const currency = report.overview?.currency || 'USD';
  const canFilter = visibility.filters !== false;
  const lastSyncAt = report.freshness?.lastSyncAt;

  const sampleRows = ADSENSE_SAMPLE.tableRows.map((r) => ({
    name: `${r.site} · ${r.adUnit}`,
    impressions: r.impressions,
    page_views: r.pageViews,
    clicks: r.clicks,
    earnings: r.earnings,
    rpm: r.rpm,
    ctr: r.ctr,
  }));

  const handleCopyLink = async () => {
    await copyReportLink(report.getSharePayload());
    showToast({ message: 'Link copied — opens this exact report' });
  };

  return (
    <div className="dashboard-page page product-page product-page--adsense">
      <PageHeader
        title="AdSense Reporting"
        subtitle="Filter by site, country, or platform — drill into any dimension"
        summary={report.filterSummary}
      >
        {canFilter && (
          <>
            <button type="button" className="btn-reset btn-copy-link" onClick={handleCopyLink}>
              Copy link
            </button>
            <SavePresetButton
              page={PRESET_PAGES.adsenseReporting}
              userId={user?.id}
              getSnapshot={report.getPresetSnapshot}
              disabled={!canFilter}
            />
          </>
        )}
        {useSample ? <span className="product-sample-badge">Sample data</span> : null}
      </PageHeader>
      <DataFreshness lastSyncAt={lastSyncAt} productLabel="AdSense" className="dash-freshness" />

      {report.error ? <p className="form-error" role="alert">{report.error}</p> : null}

      <ProductReportFilters
        product="adsense"
        range={report.range}
        onRangeChange={report.setRange}
        datePreset={report.datePreset}
        onDatePresetChange={report.setDatePreset}
        filters={report.filters}
        filterOptions={report.filterOptions}
        onFilterChange={report.setFilter}
        onFiltersApply={report.applyDimensionFilters}
        onClear={report.clearFilters}
        canUseFilters={canFilter}
        disabled={report.loading}
        compareMode={compare.compareMode}
        onCompareModeChange={compare.setCompareMode}
        compareStart={compare.compareStart}
        compareEnd={compare.compareEnd}
        onCompareStart={compare.setCompareStart}
        onCompareEnd={compare.setCompareEnd}
        userId={user?.id}
        savedPage={SAVED_FILTERS_PAGES.adsenseReporting}
        presetPage={PRESET_PAGES.adsenseReporting}
        getSavedFilterSnapshot={report.getSavedFilterSnapshot}
        getPresetSnapshot={report.getPresetSnapshot}
        getSharePayload={report.getSharePayload}
        onApplySavedFilter={report.applySavedSnapshot}
        onApplyRecentFilter={report.applyRecentSnapshot}
      />

      <div className="filter-card" style={{ marginBottom: 14, padding: '12px 16px' }}>
        <div className="filter-field" style={{ maxWidth: 220 }}>
          <label htmlFor="adsense-dim">Breakdown</label>
          <select
            id="adsense-dim"
            value={tableDim}
            onChange={(e) => setTableDim(e.target.value)}
            disabled={report.loading}
          >
            {DIM_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        {report.compareLabel ? (
          <p className="gam-filter-toolbar-note" style={{ marginTop: 8 }}>
            KPI deltas use {report.compareLabel}
          </p>
        ) : null}
      </div>

      <ProductDetailTable
        title={DIM_OPTIONS.find((o) => o.value === tableDim)?.label || 'Detail'}
        product="adsense"
        dim={useSample ? 'ad_unit' : tableDim}
        currency={currency}
        visibility={report.visibility}
        loading={report.loading}
        rows={useSample ? sampleRows : (report.table.rows || [])}
        emptyMessage="No data available"
      />
    </div>
  );
}
