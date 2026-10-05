import React, { useMemo, useState } from 'react';
import { formatValue } from './AiCharts';

/* Forecast chart: what was earned (solid), what is expected (dashed) and how sure we are (shaded band).
   "Daily" shows each day; "Month total" adds the days up, which is where a target or last month's total can be drawn. */

const W = 860;
const H = 270;
const pad = { l: 56, r: 14, t: 14, b: 28 };

const shortDate = (d) => String(d || '').slice(5);

/** Points for either view, in date order. Actual days carry `v`; projected days carry `mid`, `low`, `high`. */
function buildSeries(figures, mode) {
  const monthStart = figures.month.start;
  const projected = figures.projected || [];
  const actual = (figures.actual || []).filter((p) => (mode === 'total' ? p.date >= monthStart : true));
  if (mode === 'daily') {
    return {
      actual: actual.map((p) => ({ date: p.date, v: p.value })),
      projected: projected.map((p) => ({ date: p.date, mid: p.mid, low: p.low, high: p.high })),
    };
  }
  let run = 0;
  const cumActual = actual.map((p) => { run += p.value; return { date: p.date, v: run }; });
  const mtd = run;
  let cum = 0;
  const cumMid = projected.map((p) => { cum += p.mid; return mtd + cum; });
  const endMid = cumMid.length ? cumMid[cumMid.length - 1] : mtd;
  const low = figures.projectedEnd?.low ?? endMid;
  const high = figures.projectedEnd?.high ?? endMid;
  const span = endMid - mtd;
  return {
    actual: cumActual,
    // the band opens up from nothing today to the full range at month end
    projected: projected.map((p, i) => {
      const share = span > 0 ? (cumMid[i] - mtd) / span : 0;
      return { date: p.date, mid: cumMid[i], low: cumMid[i] - (endMid - low) * share, high: cumMid[i] + (high - endMid) * share };
    }),
  };
}

export default function ForecastChart({ figures, currency = 'USD' }) {
  const [mode, setMode] = useState('total');
  const [hover, setHover] = useState(null);

  const model = useMemo(() => {
    const { actual, projected } = buildSeries(figures, mode);
    const dates = [...actual.map((p) => p.date), ...projected.map((p) => p.date)];
    if (dates.length < 2) return null;
    const values = [
      ...actual.map((p) => p.v),
      ...projected.flatMap((p) => [p.high, p.low]),
      ...(mode === 'total' && figures.target ? [figures.target] : []),
      ...(mode === 'total' && figures.lastMonth ? [figures.lastMonth.total] : []),
    ];
    const max = Math.max(...values, 1);
    const x = (i) => pad.l + (i / (dates.length - 1)) * (W - pad.l - pad.r);
    const y = (v) => pad.t + (1 - v / (max * 1.05)) * (H - pad.t - pad.b);
    const ax = actual.map((p, i) => [x(i), y(p.v)]);
    const px = projected.map((p, i) => [x(actual.length + i), y(p.mid), y(p.high), y(p.low)]);
    const bridge = ax.length && px.length ? [ax[ax.length - 1]] : [];
    const path = (pts) => pts.map(([cx, cy], i) => `${i ? 'L' : 'M'}${cx.toFixed(1)} ${cy.toFixed(1)}`).join(' ');
    const bandTop = px.map(([cx, , hy]) => [cx, hy]);
    const bandBottom = px.map(([cx, , , ly]) => [cx, ly]).reverse();
    const start = bridge.length ? bridge[0] : null;
    const band = px.length
      ? `${path([...(start ? [start] : []), ...bandTop])} ${path(bandBottom).replace('M', 'L')} Z`
      : '';
    const ticks = [0, 0.5, 1].map((t) => ({ y: pad.t + t * (H - pad.t - pad.b), v: max * 1.05 * (1 - t) }));
    return {
      actual, projected, dates, ax, px, ticks, y, x,
      actualPath: path(ax),
      projectedPath: path([...bridge, ...px.map(([cx, cy]) => [cx, cy])]),
      band,
      todayX: px.length ? px[0][0] : ax[ax.length - 1]?.[0],
    };
  }, [figures, mode]);

  if (!model) return null;
  const { actual, projected } = model;
  const all = [...actual.map((p) => ({ ...p, kind: 'actual' })), ...projected.map((p) => ({ ...p, kind: 'projected' }))];

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    all.forEach((_, i) => { if (Math.abs(model.x(i) - px) < Math.abs(model.x(best) - px)) best = i; });
    setHover(best);
  };
  const h = hover != null && all[hover] ? all[hover] : null;
  const hx = hover != null ? model.x(hover) : 0;
  const hy = h ? model.y(h.kind === 'actual' ? h.v : h.mid) : 0;
  const money = (v) => formatValue('money', v, currency);

  return (
    <figure className="fc-chart">
      <figcaption className="fc-chart-head">
        <span className="aic-cap-title">{mode === 'total' ? 'Month total' : 'Day by day'}</span>
        <div className="aia-range" role="group" aria-label="Chart view">
          <button type="button" className={`aia-range-btn${mode === 'total' ? ' is-active' : ''}`} aria-pressed={mode === 'total'} onClick={() => setMode('total')}>Month total</button>
          <button type="button" className={`aia-range-btn${mode === 'daily' ? ' is-active' : ''}`} aria-pressed={mode === 'daily'} onClick={() => setMode('daily')}>Daily</button>
        </div>
      </figcaption>
      <div className="aic-plot" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Earnings forecast for ${figures.month.name}, ${mode === 'total' ? 'running total' : 'by day'}`} preserveAspectRatio="xMidYMid meet">
          {model.ticks.map((t) => (
            <g key={t.y}>
              <line x1={pad.l} x2={W - pad.r} y1={t.y} y2={t.y} className="aic-grid" />
              <text x={pad.l - 6} y={t.y + 3} textAnchor="end" className="aic-tick">{formatValue('money', t.v, currency, { compact: true })}</text>
            </g>
          ))}
          {mode === 'total' && figures.target ? (
            <g>
              <line x1={pad.l} x2={W - pad.r} y1={model.y(figures.target)} y2={model.y(figures.target)} className="fc-target-line" />
              <text x={W - pad.r} y={model.y(figures.target) - 5} textAnchor="end" className="fc-line-label target">Target {formatValue('money', figures.target, currency, { compact: true })}</text>
            </g>
          ) : null}
          {mode === 'total' && figures.lastMonth ? (
            <g>
              <line x1={pad.l} x2={W - pad.r} y1={model.y(figures.lastMonth.total)} y2={model.y(figures.lastMonth.total)} className="fc-last-line" />
              <text x={pad.l + 4} y={model.y(figures.lastMonth.total) - 5} className="fc-line-label">{figures.lastMonth.name} {formatValue('money', figures.lastMonth.total, currency, { compact: true })}</text>
            </g>
          ) : null}
          {model.band ? <path d={model.band} className="fc-band" /> : null}
          {model.todayX != null ? <line x1={model.todayX} x2={model.todayX} y1={pad.t} y2={H - pad.b} className="fc-today" /> : null}
          <path d={model.actualPath} className="aic-line" pathLength="1" fill="none" />
          {model.projectedPath ? <path d={model.projectedPath} className="fc-proj-line" fill="none" /> : null}
          {h ? (
            <g>
              <line x1={hx} x2={hx} y1={pad.t} y2={H - pad.b} className="aic-guide" />
              <circle cx={hx} cy={hy} r="4" className="aic-dot" />
            </g>
          ) : null}
          <text x={pad.l} y={H - 8} className="aic-tick">{shortDate(model.dates[0])}</text>
          {model.todayX != null ? <text x={model.todayX} y={H - 8} textAnchor="middle" className="aic-tick">today</text> : null}
          <text x={W - pad.r} y={H - 8} textAnchor="end" className="aic-tick">{shortDate(model.dates[model.dates.length - 1])}</text>
        </svg>
        {h ? (
          <div className="aic-tip" style={{ left: `${(hx / W) * 100}%`, top: `${(hy / H) * 100}%` }}>
            <b>{h.kind === 'actual' ? money(h.v) : `about ${money(h.mid)}`}</b>
            <span>
              {shortDate(h.date)}
              {h.kind === 'projected' ? ` · likely ${money(h.low)} to ${money(h.high)}` : ''}
            </span>
          </div>
        ) : null}
      </div>
      <div className="aic-legend fc-legend">
        <span><i className="fc-key actual" /> Earned</span>
        <span><i className="fc-key proj" /> Expected</span>
        <span><i className="fc-key band" /> Likely range</span>
        {mode === 'total' && figures.target ? <span><i className="fc-key target" /> Target</span> : null}
        {mode === 'total' && figures.lastMonth ? <span><i className="fc-key last" /> Last month</span> : null}
      </div>
    </figure>
  );
}
