import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { AreaChart, Area, ResponsiveContainer } from 'recharts';
import { CHART_SERIES } from '../../utils/chartTheme';
import { METRIC_DEFS } from '../../utils/metricDefs';

function formatCompact(n) {
  const v = Math.abs(Number(n) || 0);
  return v.toLocaleString();
}

function moneyCompact(v, currency = 'USD') {
  const sym = currency === 'INR' ? '\u20B9' : 'US$';
  const n = Math.abs(parseFloat(v) || 0);
  return `${sym}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function Delta({ change, loading, compareLabel }) {
  if (loading || change === undefined || change === null) return null;
  const n = Number(change);
  if (!Number.isFinite(n) || Math.abs(n) < 0.05) {
    return (
      <span className="gam-overview-delta is-flat">
        No change
        {compareLabel ? <span className="gam-overview-delta-vs"> {compareLabel}</span> : null}
      </span>
    );
  }
  const isDown = n < 0;
  const pct = Math.abs(n).toFixed(1);
  return (
    <span className={`gam-overview-delta ${isDown ? 'down' : 'up'}`}>
      {isDown ? '▼' : '▲'} {pct}%
      {compareLabel ? <span className="gam-overview-delta-vs"> {compareLabel}</span> : null}
    </span>
  );
}

function Sparkline({ data = [], color = CHART_SERIES.primary, gradId = 'spark' }) {
  if (!data.length) return <div className="gam-overview-spark gam-overview-spark-empty" aria-hidden />;
  const id = `spark-${gradId}`;
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

function MetricHelp({ defKey }) {
  const def = METRIC_DEFS[defKey];
  const [open, setOpen] = useState(false);
  const [popStyle, setPopStyle] = useState(null);
  const btnRef = useRef(null);
  const popRef = useRef(null);

  const place = useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const pad = 12;
    const width = Math.min(280, window.innerWidth - pad * 2);
    let left = rect.left;
    if (left + width > window.innerWidth - pad) left = window.innerWidth - pad - width;
    if (left < pad) left = pad;

    const spaceBelow = window.innerHeight - rect.bottom - pad;
    const spaceAbove = rect.top - pad;
    const openUp = spaceBelow < 120 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(80, openUp ? spaceAbove - 8 : spaceBelow - 8);

    setPopStyle({
      position: 'fixed',
      left,
      width,
      top: openUp ? undefined : rect.bottom + 8,
      bottom: openUp ? window.innerHeight - rect.top + 8 : undefined,
      maxHeight,
      zIndex: 260,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return undefined;
    place();
    const onMove = () => place();
    const onDoc = (e) => {
      if (btnRef.current?.contains(e.target)) return;
      if (popRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('touchstart', onDoc, { passive: true });
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('touchstart', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, place]);

  if (!def) return null;
  return (
    <span className="metric-help">
      <button
        type="button"
        ref={btnRef}
        className="metric-help-btn"
        aria-label={`${def.label} definition`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
      {open && popStyle && createPortal(
        <span className="metric-help-pop" role="tooltip" ref={popRef} style={popStyle}>
          <strong>{def.label}</strong>
          <span>{def.text}</span>
        </span>,
        document.body
      )}
    </span>
  );
}

/**
 * Network overview KPIs — Stripe/Mixpanel-style metric strip with sparklines.
 */
export default function GamOverviewCard({
  summary = {},
  currency = 'USD',
  loading = false,
  sparkSeries = [],
  compareLabel = 'vs prior period',
}) {
  const spin = <span className="card-spinner card-spinner-lg" aria-label="Loading" />;
  const sparks = {
    impressions: sparkSeries.map((d) => ({ v: Number(d.impressions) || 0 })),
    revenue: sparkSeries.map((d) => ({ v: Number(d.revenue) || 0 })),
    ecpm: sparkSeries.map((d) => ({ v: Number(d.ecpm) || 0 })),
    viewability: sparkSeries.map((d) => ({ v: Number(d.viewability) || 0 })),
  };

  const kpis = [
    {
      label: 'Impressions',
      value: loading ? spin : formatCompact(summary.impressions),
      change: summary.impressionsChange,
      spark: sparks.impressions,
      color: CHART_SERIES.primary,
      key: 'impressions',
    },
    {
      label: 'Revenue',
      value: loading ? spin : moneyCompact(summary.revenue ?? summary.selectRange, currency),
      change: summary.revenueChange ?? summary.selectRangeChange,
      spark: sparks.revenue,
      color: CHART_SERIES.secondary,
      key: 'revenue',
    },
    {
      label: 'eCPM',
      value: loading ? spin : moneyCompact(summary.ecpm, currency),
      change: summary.ecpmChange,
      spark: sparks.ecpm,
      color: CHART_SERIES.accent,
      key: 'ecpm',
    },
    {
      label: 'Viewability',
      value: loading ? spin : `${Number(summary.viewability || 0).toFixed(1)}%`,
      change: summary.viewabilityChange,
      spark: sparks.viewability,
      color: CHART_SERIES.muted,
      key: 'viewability',
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
            <span className="gam-overview-metric-label">
              {k.label}
              <MetricHelp defKey={k.key} />
            </span>
            <span className="gam-overview-metric-value">{k.value}</span>
            <Delta change={k.change} loading={loading} compareLabel={compareLabel} />
            {!loading && <Sparkline data={k.spark} color={k.color} gradId={k.key} />}
          </div>
        ))}
      </div>
      <div className="gam-overview-foot">
        <Link to="/reporting" className="gam-overview-link">View in reporting</Link>
      </div>
    </div>
  );
}
