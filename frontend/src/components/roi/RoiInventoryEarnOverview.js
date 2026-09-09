import React from 'react';
import { formatRoiMoney, formatRoiMoneyCompact } from '../../utils/report/roiView';
import { KpiIcon } from '../ui/Icon';

/**
 * Secondary ROI overview — App / Site / Total earn.
 * Shown only when exactly one Ads account is selected.
 */
export default function RoiInventoryEarnOverview({
  appEarn = 0,
  siteEarn = 0,
  totalEarn = 0,
  currency = 'USD',
  loading = false,
}) {
  const metrics = [
    {
      key: 'app',
      label: 'App ID revenue',
      value: formatRoiMoneyCompact(appEarn, currency),
      title: formatRoiMoney(appEarn, currency),
    },
    {
      key: 'site',
      label: 'Site revenue',
      value: formatRoiMoneyCompact(siteEarn, currency),
      title: formatRoiMoney(siteEarn, currency),
    },
    {
      key: 'total',
      label: 'Total revenue',
      value: formatRoiMoneyCompact(totalEarn, currency),
      title: formatRoiMoney(totalEarn, currency),
      emphasis: true,
    },
  ];

  return (
    <div className={`roi-kpi-boards roi-inventory-earn-overview${loading ? ' is-loading' : ''}`}>
      <div className="roi-kpi-boards-grid roi-inventory-earn-overview-grid">
        <section
          className="roi-kpi-board roi-kpi-board--inventory"
          style={{ '--roi-kpi-cols': '3' }}
        >
          <header className="roi-kpi-board-head">
            <h3 className="roi-kpi-board-title">Inventory revenue</h3>
            <span className="roi-kpi-board-hint">App IDs + Sites for this Ads account</span>
          </header>
          <div className="roi-kpi-metrics">
            {metrics.map((m) => (
              <div
                key={m.key}
                className={`roi-kpi-metric${m.emphasis ? ' is-emphasis' : ''}`}
              >
                  <span className="roi-kpi-label">
                    <span className="kpi-icon-badge kpi-icon-badge--sm" aria-hidden>
                      <KpiIcon name={m.key === 'total' ? 'total' : m.key} size={13} />
                    </span>
                    {m.label}
                  </span>
                <span
                  className="roi-kpi-value"
                  title={!loading ? m.title : undefined}
                >
                  {loading
                    ? <span className="card-spinner card-spinner-lg" aria-label="Loading" />
                    : m.value}
                </span>
                <span className="roi-kpi-spacer" aria-hidden />
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
