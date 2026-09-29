import React from 'react';
import PageHeader from '../../components/ui/PageHeader';
import ProductDetailTable from '../../components/ui/ProductDetailTable';
import { ADSENSE_SAMPLE } from '../../utils/productSampleData';
import { adsenseAPI } from '../../utils/api';
import { usePermissions } from '../../hooks/usePermissions';
import usePublisherReport from '../../hooks/usePublisherReport';

export default function AdSenseSites() {
  const { visibility } = usePermissions();
  const report = usePublisherReport(adsenseAPI, {
    product: 'adsense',
    canUseFilters: visibility.filters !== false,
    defaultBreakdownDim: 'site',
    defaultTableDim: 'site',
  });

  const useSample = report.isSample;
  const currency = report.overview?.currency || 'USD';
  const sampleRows = ADSENSE_SAMPLE.topSites.map((r) => ({
    name: r.name,
    earnings: r.earnings,
    impressions: r.impressions || 0,
    page_views: r.pageViews || 0,
    clicks: 0,
    rpm: 0,
    ctr: 0,
  }));

  return (
    <div className="page product-page product-page--adsense">
      <PageHeader title="Sites" subtitle="Earnings and traffic by site" />
      {report.error ? <p className="form-error" role="alert">{report.error}</p> : null}
      <ProductDetailTable
        title="Sites"
        product="adsense"
        dim="site"
        currency={currency}
        visibility={report.visibility}
        rows={useSample ? sampleRows : (report.breakdown.rows || [])}
        emptyMessage={report.loading ? 'Loading…' : 'No site data yet.'}
      />
    </div>
  );
}
