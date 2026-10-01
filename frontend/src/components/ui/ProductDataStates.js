import React from 'react';
import { EmptyIcon } from './Icon';

export function ProductChartsSkeleton() {
  return (
    <div className="dash-skeleton-grid" aria-busy="true" aria-label="Loading charts">
      <div className="chart-card wide dash-skeleton-card">
        <div className="skeleton dash-skeleton-title" />
        <div className="skeleton dash-skeleton-chart" />
      </div>
      <div className="chart-card dash-skeleton-card">
        <div className="skeleton dash-skeleton-title" />
        <div className="skeleton dash-skeleton-chart sm" />
      </div>
      <div className="chart-card dash-skeleton-card">
        <div className="skeleton dash-skeleton-title" />
        <div className="skeleton dash-skeleton-chart sm" />
      </div>
    </div>
  );
}

export function ProductEmptyState({ productLabel = 'Product' }) {
  return (
    <div className="gam-report-empty" role="status">
      <div className="gam-report-empty-icon" aria-hidden="true"><EmptyIcon size={40} /></div>
      <p className="gam-report-empty-title">No {productLabel} data for this period</p>
      <p className="gam-report-empty-hint">Try a different date range or check that the account has synced.</p>
    </div>
  );
}