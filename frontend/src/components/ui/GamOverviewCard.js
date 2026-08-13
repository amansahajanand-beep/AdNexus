import React from 'react';
import { Link } from 'react-router-dom';

function formatCompact(n) {
  const v = Math.abs(Number(n) || 0);
  return v.toLocaleString();
}

function moneyCompact(v, currency = 'USD') {
  const sym = currency === 'INR' ? '\u20B9' : 'US$';
  const n = Math.abs(parseFloat(v) || 0);
  return `${sym}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function Delta({ change, loading }) {
  if (loading || change === undefined || change === null) return null;
  const isDown = change < 0;
  const pct = Math.abs(change).toFixed(1);
  return (
    <span className={`gam-overview-delta ${isDown ? 'down' : 'up'}`}>
      {isDown ? '▼' : '▲'} {pct}%
    </span>
  );
}

/**
 * Network overview KPIs — Stripe/Mixpanel-style metric strip.
 */
export default function GamOverviewCard({
  summary = {},
  currency = 'USD',
  loading = false,
}) {
  const spin = <span className="card-spinner card-spinner-lg" aria-label="Loading" />;
  const kpis = [
    {
      label: 'Impressions',
      value: loading ? spin : formatCompact(summary.impressions),
      change: summary.impressionsChange,
    },
    {
      label: 'Revenue',
      value: loading ? spin : moneyCompact(summary.revenue ?? summary.selectRange, currency),
      change: summary.revenueChange ?? summary.selectRangeChange,
    },
    {
      label: 'eCPM',
      value: loading ? spin : moneyCompact(summary.ecpm, currency),
      change: summary.ecpmChange,
    },
    {
      label: 'Viewability',
      value: loading ? spin : `${Number(summary.viewability || 0).toFixed(1)}%`,
      change: summary.viewabilityChange,
    },
  ];

  return (
    <div className={`gam-overview-card${loading ? ' is-loading' : ''}`}>
      <div className="gam-overview-head">
        <div className="gam-overview-title-row">
          <h3 className="gam-overview-title">Overview</h3>
          {loading && <span className="overview-loading-badge" aria-live="polite">Fetching…</span>}
        </div>
        <span className="gam-overview-select" aria-label="Overview breakdown">Programmatic channels</span>
      </div>
      <div className="gam-overview-metrics">
        {kpis.map((k) => (
          <div key={k.label} className="gam-overview-metric">
            <span className="gam-overview-metric-label">{k.label}</span>
            <span className="gam-overview-metric-value">{k.value}</span>
            <Delta change={k.change} loading={loading} />
          </div>
        ))}
      </div>
      <div className="gam-overview-foot">
        <Link to="/reporting" className="gam-overview-link">View in reporting</Link>
      </div>
    </div>
  );
}
