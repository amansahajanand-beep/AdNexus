import React, { useMemo, useState } from 'react';

/* Small, dependency-free charts for the AI analysis: trend line, period comparison, ranked bars and a share ring.
   Everything animates in with CSS (see .aic-* in App.css) and respects reduced motion. */

const DONUT_COLORS = ['var(--accent)', '#8B5CF6', '#0EA5E9', '#14B8A6', '#F59E0B', 'var(--border-strong)'];

const W = 640;
const H = 190;
const pad = { l: 46, r: 12, t: 12, b: 24 };

export function formatValue(kind, v, currency = 'USD', { compact = false } = {}) {
  const n = v == null ? NaN : Number(v);
  if (!Number.isFinite(n)) return '—';
  if (kind === 'percent') return `${n.toFixed(Math.abs(n) >= 100 ? 0 : 1)}%`;
  if (kind === 'money') {
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        notation: compact ? 'compact' : 'standard',
        maximumFractionDigits: compact ? 1 : Math.abs(n) >= 10000 ? 0 : 2,
        minimumFractionDigits: compact || Math.abs(n) >= 10000 ? 0 : 2,
      }).format(n);
    } catch {
      return `${currency} ${n.toFixed(2)}`;
    }
  }
  return new Intl.NumberFormat('en-US', { notation: compact || Math.abs(n) >= 1e4 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n);
}

function shortDate(d) {
  if (!d) return '';
  const s = String(d);
  if (s.includes('..')) {
    const [a, b] = s.split('..');
    return `${a.slice(5)} – ${b}`;
  }
  return s.slice(5);
}

export function Change({ pct }) {
  if (pct == null || !Number.isFinite(pct)) return null;
  const up = pct >= 0;
  return (
    <span className={`aic-chg ${up ? 'up' : 'down'}`}>
      <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
        <path d={up ? 'M5 1.5l4 6H1z' : 'M5 8.5l4-6H1z'} fill="currentColor" />
      </svg>
      {Math.abs(pct).toFixed(Math.abs(pct) >= 100 ? 0 : 1)}%
    </span>
  );
}

/** Daily line with a soft area, a hover read-out and markers on unusual days. */
export function TrendChart({ chart, currency }) {
  const [hover, setHover] = useState(null);
  const pts = chart.points;
  const geo = useMemo(() => {
    if (pts.length < 2) return null;
    const values = pts.map((p) => p.v);
    const max = Math.max(...values, 0);
    const min = Math.min(...values, 0);
    const span = max - min || 1;
    const x = (i) => pad.l + (pts.length === 1 ? (W - pad.l - pad.r) / 2 : (i / (pts.length - 1)) * (W - pad.l - pad.r));
    const y = (v) => pad.t + (1 - (v - min) / span) * (H - pad.t - pad.b);
    const coords = pts.map((p, i) => [x(i), y(p.v)]);
    const line = coords.map(([cx, cy], i) => `${i ? 'L' : 'M'}${cx.toFixed(1)} ${cy.toFixed(1)}`).join(' ');
    const base = y(Math.max(min, 0));
    const area = `${line} L${coords[coords.length - 1][0].toFixed(1)} ${base.toFixed(1)} L${coords[0][0].toFixed(1)} ${base.toFixed(1)} Z`;
    const ticks = [0, 0.5, 1].map((t) => ({ y: pad.t + t * (H - pad.t - pad.b), v: max - t * span }));
    return { coords, line, area, ticks, max, min };
  }, [pts]);

  if (!geo) return null;
  const first = pts[0].v;
  const last = pts[pts.length - 1].v;
  const peak = pts.reduce((a, p) => (p.v > a.v ? p : a), pts[0]);
  const odd = new Set(chart.anomalies || []);
  const gid = `aic-grad-${chart.label.replace(/\W/g, '')}`;

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    geo.coords.forEach(([cx], i) => { if (Math.abs(cx - px) < Math.abs(geo.coords[best][0] - px)) best = i; });
    setHover(best);
  };
  const h = hover != null ? { p: pts[hover], c: geo.coords[hover] } : null;

  return (
    <figure className="aic-card aic-trend">
      <figcaption className="aic-cap">
        <span className="aic-cap-title">{chart.label}</span>
        <span className="aic-cap-meta">
          {formatValue(chart.kind, first, currency, { compact: true })} → {formatValue(chart.kind, last, currency, { compact: true })}
          {first ? <Change pct={((last - first) / Math.abs(first)) * 100} /> : null}
        </span>
      </figcaption>
      <div className="aic-plot" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`${chart.label}: from ${formatValue(chart.kind, first, currency)} to ${formatValue(chart.kind, last, currency)}, highest ${formatValue(chart.kind, peak.v, currency)} on ${shortDate(peak.date)}`}
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {geo.ticks.map((t) => (
            <g key={t.y}>
              <line x1={pad.l} x2={W - pad.r} y1={t.y} y2={t.y} className="aic-grid" />
              <text x={pad.l - 6} y={t.y + 3} textAnchor="end" className="aic-tick">{formatValue(chart.kind, t.v, currency, { compact: true })}</text>
            </g>
          ))}
          <path d={geo.area} fill={`url(#${gid})`} className="aic-area" />
          <path d={geo.line} className="aic-line" pathLength="1" fill="none" />
          {pts.map((p, i) => (odd.has(p.date) ? (
            <circle key={p.date} cx={geo.coords[i][0]} cy={geo.coords[i][1]} r="4.5" className="aic-odd" />
          ) : null))}
          {h ? (
            <g>
              <line x1={h.c[0]} x2={h.c[0]} y1={pad.t} y2={H - pad.b} className="aic-guide" />
              <circle cx={h.c[0]} cy={h.c[1]} r="4" className="aic-dot" />
            </g>
          ) : null}
          <text x={pad.l} y={H - 6} className="aic-tick">{shortDate(pts[0].date)}</text>
          <text x={W - pad.r} y={H - 6} textAnchor="end" className="aic-tick">{shortDate(pts[pts.length - 1].date)}</text>
        </svg>
        {h ? (
          <div className="aic-tip" style={{ left: `${(h.c[0] / W) * 100}%`, top: `${(h.c[1] / H) * 100}%` }}>
            <b>{formatValue(chart.kind, h.p.v, currency)}</b>
            <span>{shortDate(h.p.date)}{odd.has(h.p.date) ? ' · unusual day' : ''}</span>
          </div>
        ) : null}
      </div>
      {odd.size ? <div className="aic-legend"><i className="aic-odd-key" /> Unusual day</div> : null}
    </figure>
  );
}

/** This period against the prior one, one pair of bars per figure. */
export function CompareBars({ items, currency }) {
  return (
    <figure className="aic-card aic-compare">
      <figcaption className="aic-cap"><span className="aic-cap-title">Against the prior period</span></figcaption>
      <ul className="aic-cmp-list">
        {items.map((it, i) => {
          const max = Math.max(Math.abs(it.now), Math.abs(it.prev), 1e-9);
          const change = it.prev ? ((it.now - it.prev) / Math.abs(it.prev)) * 100 : null;
          return (
            <li key={it.label} style={{ '--i': i }}>
              <div className="aic-cmp-head"><span>{it.label}</span><Change pct={change} /></div>
              <div className="aic-cmp-row">
                <div className="aic-cmp-track"><div className="aic-cmp-bar now" style={{ width: `${Math.max(2, (Math.abs(it.now) / max) * 100)}%` }} /></div>
                <span className="aic-cmp-val">{formatValue(it.kind, it.now, currency, { compact: true })}</span>
              </div>
              <div className="aic-cmp-row">
                <div className="aic-cmp-track"><div className="aic-cmp-bar prev" style={{ width: `${Math.max(2, (Math.abs(it.prev) / max) * 100)}%` }} /></div>
                <span className="aic-cmp-val muted">{formatValue(it.kind, it.prev, currency, { compact: true })}</span>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="aic-legend"><i className="aic-key now" /> This period <i className="aic-key prev" /> Prior period</div>
    </figure>
  );
}

/** Ranked list. Money lists show share of the total; percent lists (ROI) diverge from zero. */
export function BarList({ chart, currency }) {
  const diverging = chart.kind === 'percent';
  const max = Math.max(...chart.items.map((i) => Math.abs(i.value)), 1e-9);
  return (
    <ul className={`aic-bars${diverging ? ' is-diverging' : ''}`}>
      {chart.items.map((it, i) => {
        const w = Math.max(1.5, (Math.abs(it.value) / max) * (diverging ? 50 : 100));
        const neg = it.value < 0;
        return (
          <li key={it.name} style={{ '--i': i }} title={it.extra || undefined}>
            <span className="aic-bar-name">{it.name}</span>
            <div className="aic-bar-track">
              {diverging ? <span className="aic-bar-axis" /> : null}
              <div className={`aic-bar-fill${neg ? ' neg' : ''}${diverging ? ` d-${neg ? 'l' : 'r'}` : ''}`} style={{ width: `${w}%` }} />
            </div>
            <span className="aic-bar-val">
              {formatValue(chart.kind, it.value, currency, { compact: true })}
              {it.share != null ? <small>{it.share.toFixed(it.share >= 10 ? 0 : 1)}%</small> : null}
            </span>
            <Change pct={it.change} />
          </li>
        );
      })}
    </ul>
  );
}

/** Share ring for the biggest items; the rest is grouped as "Other". */
export function ShareRing({ chart, currency }) {
  const total = chart.totalValue || chart.items.reduce((a, i) => a + Math.max(0, i.value), 0);
  if (!(total > 0) || chart.items.length < 2) return null;
  const top = chart.items.filter((i) => i.value > 0).slice(0, 5);
  const rest = total - top.reduce((a, i) => a + i.value, 0);
  const parts = [...top.map((i) => ({ name: i.name, value: i.value })), ...(rest > total * 0.005 ? [{ name: 'Other', value: rest }] : [])];
  const R = 38;
  const C = 2 * Math.PI * R;
  let acc = 0;
  return (
    <div className="aic-ring" role="img" aria-label={`Share of total: ${parts.map((p) => `${p.name} ${((p.value / total) * 100).toFixed(0)}%`).join(', ')}`}>
      <svg viewBox="0 0 100 100" width="112" height="112">
        <circle cx="50" cy="50" r={R} className="aic-ring-bg" />
        {parts.map((p, i) => {
          const len = (p.value / total) * C;
          const el = (
            <circle
              key={p.name}
              cx="50"
              cy="50"
              r={R}
              className="aic-ring-seg"
              style={{ stroke: DONUT_COLORS[i % DONUT_COLORS.length], '--i': i }}
              strokeDasharray={`${Math.max(0, len - 1.5)} ${C}`}
              strokeDashoffset={-acc}
              transform="rotate(-90 50 50)"
            />
          );
          acc += len;
          return el;
        })}
        <text x="50" y="48" textAnchor="middle" className="aic-ring-v">{((parts[0].value / total) * 100).toFixed(0)}%</text>
        <text x="50" y="60" textAnchor="middle" className="aic-ring-l">top item</text>
      </svg>
      <ul className="aic-ring-key">
        {parts.map((p, i) => (
          <li key={p.name}><i style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }} />{p.name}<b>{formatValue(chart.kind, p.value, currency, { compact: true })}</b></li>
        ))}
      </ul>
    </div>
  );
}

/** All charts for one analysis. Renders nothing when the data had none. */
export default function AiCharts({ charts, currency = 'USD' }) {
  const breakdowns = (charts?.breakdowns || []).filter((b) => b.items?.length);
  const [tab, setTab] = useState(0);
  if (!charts) return null;
  const trend = charts.trend && charts.trend.points?.length >= 2 ? charts.trend : null;
  const compare = (charts.compare || []).length ? charts.compare : null;
  if (!trend && !compare && !breakdowns.length) return null;
  const active = breakdowns[Math.min(tab, breakdowns.length - 1)];

  return (
    <div className="aic" aria-label="Charts">
      {trend || compare ? (
        <div className={`aic-row${trend && compare ? ' two' : ''}`}>
          {trend ? <TrendChart chart={trend} currency={currency} /> : null}
          {compare ? <CompareBars items={compare} currency={currency} /> : null}
        </div>
      ) : null}
      {active ? (
        <figure className="aic-card">
          <figcaption className="aic-cap">
            <span className="aic-cap-title">Breakdown</span>
            {breakdowns.length > 1 ? (
              <div className="aic-tabs" role="tablist" aria-label="Break down by">
                {breakdowns.map((b, i) => (
                  <button key={b.by} type="button" role="tab" aria-selected={i === tab} className={i === tab ? 'on' : ''} onClick={() => setTab(i)}>{b.by}</button>
                ))}
              </div>
            ) : <span className="aic-cap-meta">{active.by}</span>}
          </figcaption>
          <div className="aic-split" key={active.by}>
            <BarList chart={active} currency={currency} />
            {active.kind === 'money' ? <ShareRing chart={active} currency={currency} /> : null}
          </div>
        </figure>
      ) : null}
    </div>
  );
}
