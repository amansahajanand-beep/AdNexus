import React, { useMemo, useState } from 'react';
import DynamicReportTable from './DynamicReportTable';
import { useMedia } from '../../hooks/useMedia';

const DIM_LABELS = {
  app: 'App',
  format: 'Format',
  country: 'Country',
  platform: 'Platform',
  ad_unit: 'Ad unit',
  ad_source: 'Ad source',
  ad_source_instance: 'Ad source instance',
  mediation_group: 'Mediation group',
  site: 'Site',
  date: 'Date',
};

/**
 * AdMob / AdSense inventory table — same GAM Dashboard DynamicReportTable chrome.
 */
export default function ProductDetailTable({
  title = 'Inventory Breakdown',
  rows = [],
  dim = 'ad_unit',
  product = 'admob',
  currency = 'USD',
  visibility = { revenue: true, impressions: true, ctr: true, ecpm: true },
  emptyMessage = 'No data available',
  loading = false,
  onReset,
}) {
  const isNarrow = useMedia('(max-width: 768px)');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [density, setDensity] = useState('comfortable');
  const nameLabel = DIM_LABELS[dim] || 'Name';
  const showPageViews = product === 'adsense';
  const vis = visibility || {};

  const columns = useMemo(() => {
    const cols = [
      {
        id: 'name',
        type: 'dimension',
        label: nameLabel,
        cellClass: '',
        getValue: (r) => r.name || '—',
        aggregate: 'label',
      },
    ];
    if (vis.impressions !== false) {
      cols.push({
        id: 'impressions',
        type: 'metric',
        label: 'Impressions',
        getValue: (r) => Number(r.impressions) || 0,
        format: 'num',
        aggregate: 'sum',
      });
    }
    if (showPageViews && vis.impressions !== false) {
      cols.push({
        id: 'page_views',
        type: 'metric',
        label: 'Page views',
        getValue: (r) => Number(r.page_views ?? r.pageViews) || 0,
        format: 'num',
        aggregate: 'sum',
      });
    }
    if (vis.ctr !== false) {
      cols.push({
        id: 'clicks',
        type: 'metric',
        label: 'Clicks',
        getValue: (r) => Number(r.clicks) || 0,
        format: 'num',
        aggregate: 'sum',
      });
    }
    if (vis.revenue !== false) {
      cols.push({
        id: 'earnings',
        type: 'metric',
        label: 'Earnings',
        getValue: (r) => Number(r.earnings) || 0,
        format: 'money',
        aggregate: 'sum',
      });
    }
    if (vis.ecpm !== false) {
      cols.push({
        id: showPageViews ? 'rpm' : 'ecpm',
        type: 'metric',
        label: showPageViews ? 'RPM' : 'eCPM',
        getValue: (r) => Number(showPageViews ? r.rpm : r.ecpm) || 0,
        format: 'money',
        aggregate: 'avg',
      });
    }
    if (vis.ctr !== false) {
      cols.push({
        id: 'ctr',
        type: 'metric',
        label: 'CTR',
        getValue: (r) => Number(r.ctr) || 0,
        format: 'percent',
        aggregate: 'avg',
      });
    }
    return cols;
  }, [nameLabel, vis.impressions, vis.ctr, vis.revenue, vis.ecpm, showPageViews]);

  return (
    <DynamicReportTable
      title={title}
      rows={rows}
      columns={columns}
      visibility={vis}
      currency={currency}
      loading={loading}
      search={search}
      onSearchChange={(v) => {
        setSearch(v);
        setPage(1);
      }}
      onPageReset={() => setPage(1)}
      searchPlaceholder={`Search ${nameLabel.toLowerCase()}…`}
      page={page}
      pageSize={isNarrow ? 12 : 50}
      onPageChange={setPage}
      showTotals={rows.length > 0}
      density={density}
      freezeFirst
      headerExtra={(
        <div className="multi-network-table-tools">
          <div className="table-density-toggle" role="group" aria-label="Table density">
            <button
              type="button"
              className={`table-density-btn${density === 'compact' ? ' active' : ''}`}
              onClick={() => setDensity('compact')}
            >
              Compact
            </button>
            <button
              type="button"
              className={`table-density-btn${density === 'comfortable' ? ' active' : ''}`}
              onClick={() => setDensity('comfortable')}
            >
              Comfortable
            </button>
          </div>
        </div>
      )}
      noReportMessage="No data available for this period"
      emptyMessage={emptyMessage}
      onReset={onReset}
      columnStorageKey={`${product}-${dim}-inventory`}
      canDownload={vis.download !== false}
      exportName={`${product}_${dim}`}
      className="reporting-table"
    />
  );
}
