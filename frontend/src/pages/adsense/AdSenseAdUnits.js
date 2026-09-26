import React from 'react';
import PageHeader from '../../components/ui/PageHeader';
import ProductDetailTable from '../../components/ui/ProductDetailTable';
import { ADSENSE_SAMPLE } from '../../utils/productSampleData';
import { adsenseAPI } from '../../utils/api';
import { usePermissions } from '../../hooks/usePermissions';
import usePublisherReport from '../../hooks/usePublisherReport';

export default function AdSenseAdUnits() {
  const { visibility } = usePermissions();
  const report = usePublisherReport(adsenseAPI, {
    product: 'adsense',
    canUseFilters: visibility.filters !== false,
    defaultBreakdownDim: 'ad_unit',
    defaultTableDim: 'ad_unit',
  });

  const useSample = report.isSample;
  const currency = report.overview?.currency || 'USD';
  const sampleRows = ADSENSE_SAMPLE.tableRows.map((r) => ({
    name: `${r.site} · ${r.adUnit}`,
    impressions: r.impressions,
    page_views: r.pageViews,
    clicks: r.clicks,
    earnings: r.earnings,
    rpm: r.rpm,
    ctr: r.ctr,
  }));

  return (
    <div className="page product-page product-page--adsense">
      <PageHeader title="Ad units" subtitle="Performance by AdSense ad unit" />
      {report.error ? <p className="form-error" role="alert">{report.error}</p> : null}
      <ProductDetailTable
        title="Ad units"
        product="adsense"
        dim="ad_unit"
        currency={currency}
        visibility={report.visibility}
        rows={useSample ? sampleRows : (report.table.rows || [])}
        emptyMessage={report.loading ? 'Loading…' : 'No ad-unit data yet.'}
      />
    </div>
  );
}
