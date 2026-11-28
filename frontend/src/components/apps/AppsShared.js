import React from 'react';
import { AreaChart, Area, ResponsiveContainer } from 'recharts';
import { CHART_SERIES } from '../../utils/chartTheme';

export const fmtInr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
export const fmtUsd = (n) => `US$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const fmtNum = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
export const fmtPct = (n, d = 1) => `${(Number(n) || 0).toFixed(d)}%`;
export const fmtRatio = (n) => `${(Number(n) || 0).toFixed(2)}x`;

export function StatusBadge({ status }) {
  const cls = status === 'Active' ? 'active' : status === 'Paused' ? 'paused' : 'inactive';
  return <span className={`apps-badge apps-badge--status-${cls}`}>{status}</span>;
}

export function SignalBadge({ signal }) {
  return <span className={`apps-badge apps-badge--signal-${String(signal).toLowerCase()}`}>{signal}</span>;
}

export function ChangeText({ value, suffix = '%' }) {
  if (value === null || value === undefined) return <span className="apps-change is-flat" title="No prior period">—</span>;
  const n = Number(value) || 0;
  if (Math.abs(n) < 0.05) return <span className="apps-change is-flat">0{suffix}</span>;
  return (
    <span className={`apps-change ${n < 0 ? 'down' : 'up'}`}>
      {n < 0 ? '▼' : '▲'} {Math.abs(n).toFixed(1)}{suffix}
    </span>
  );
}

function kpiValue(kpi) {
  switch (kpi.format) {
    case 'money': return kpi.currency === 'INR' ? fmtInr(kpi.value) : fmtUsd(kpi.value);
    case 'percent': return fmtPct(kpi.value);
    case 'ratio': return fmtRatio(kpi.value);
    default: return fmtNum(kpi.value);
  }
}

/** KPI cards using the same chrome as the GAM / AdMob dashboards (gam-overview-*). */
export function AppKpiStrip({ kpis = [], idPrefix = 'apps', compareLabel = 'vs previous period' }) {
  return (
    <div className="gam-overview-card product-kpi-overview apps-kpi-strip">
      <div className="gam-overview-metrics">
        {kpis.map((kpi) => {
          const n = Number(kpi.change) || 0;
          const gid = `${idPrefix}-spark-${kpi.key}`;
          return (
            <div key={kpi.key} className="gam-overview-metric kpi-tile">
              <span className="gam-overview-metric-value">{kpiValue(kpi)}</span>
              <span className="gam-overview-metric-label">{kpi.label}</span>
              {kpi.change === undefined ? null : kpi.change === null ? (
                <span className="gam-overview-delta is-flat">No prior period</span>
              ) : Math.abs(n) < 0.05 ? (
                <span className="gam-overview-delta is-flat">No change</span>
              ) : (
                <span className={`gam-overview-delta ${n < 0 ? 'down' : 'up'}`}>
                  {n < 0 ? '▼' : '▲'} {Math.abs(n).toFixed(1)}%
                  <span className="gam-overview-delta-vs"> {compareLabel}</span>
                </span>
              )}
              {kpi.spark?.length ? (
                <div className="gam-overview-spark" aria-hidden>
                  <ResponsiveContainer width="100%" height={36}>
                    <AreaChart data={kpi.spark} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={CHART_SERIES.primary} stopOpacity={0.28} />
                          <stop offset="95%" stopColor={CHART_SERIES.primary} stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <Area type="monotone" dataKey="v" stroke={CHART_SERIES.primary} strokeWidth={1.5} fill={`url(#${gid})`} isAnimationActive={false} dot={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              ) : <div className="gam-overview-spark gam-overview-spark-empty" aria-hidden />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
