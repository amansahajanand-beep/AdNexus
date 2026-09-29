import React from 'react';
import { AreaChart, Area, ResponsiveContainer } from 'recharts';
import { CHART_SERIES } from '../../utils/chartTheme';

function formatValue(value, format, currency = 'USD') {
  const n = Number(value) || 0;
  if (format === 'money') {
    const sym = currency === 'INR' ? '\u20B9' : 'US$';
    return `${sym}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (format === 'percent') {
    return `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
  }
  return n.toLocaleString();
}

function Delta({ change, compareLabel = 'vs prior' }) {
  if (change === undefined || change === null) return null;
  const n = Number(change);
  if (!Number.isFinite(n) || Math.abs(n) < 0.05) {
    return <span className="gam-overview-delta is-flat">No change</span>;
  }
  const isDown = n < 0;
  const phrase = String(compareLabel || 'vs prior').replace(/^vs\s+/i, '');
  return (
    <span className={`gam-overview-delta ${isDown ? 'down' : 'up'}`}>
      {isDown ? '▼' : '▲'} {Math.abs(n).toFixed(1)}%
      <span className="gam-overview-delta-vs"> vs {phrase}</span>
    </span>
  );
}

function Sparkline({ data = [], color = CHART_SERIES.primary, gradId }) {
  if (!data.length) return <div className="gam-overview-spark gam-overview-spark-empty" aria-hidden />;
  const id = `prod-spark-${gradId}`;
  return (
    <div className="gam-overview-spark" aria-hidden>
      <ResponsiveContainer width="100%" height={36}>
        <AreaChart data={data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color} stopOpacity={0.28} />
              <stop offset="95%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={1.5}
            fill={`url(#${id})`}
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function ProductKpiStrip({
  kpis = [],
  currency = 'USD',
  accentColor = CHART_SERIES.primary,
  compareLabel = 'vs prior',
}) {
  return (
    <div className="gam-overview-card product-kpi-overview">
      <div className="gam-overview-metrics">
        {kpis.map((kpi) => (
          <div key={kpi.key} className="gam-overview-metric kpi-tile">
            <span className="gam-overview-metric-value">
              {formatValue(kpi.value, kpi.format, currency)}
            </span>
            <span className="gam-overview-metric-label">{kpi.label}</span>
            <Delta change={kpi.change} compareLabel={compareLabel} />
            <Sparkline data={kpi.spark || []} color={accentColor} gradId={kpi.key} />
          </div>
        ))}
      </div>
    </div>
  );
}
