import React, { useEffect, useState } from 'react';
import { getUserFacingMessage, logErrorForDebug } from '../../utils/userFacingError';

export const nf = new Intl.NumberFormat();
export const VIEWER = '/app-building/viewer';
export const day = (v) => (v ? new Date(v).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

export function Tile({ label, value, hint }) {
  return (
    <div className="gam-overview-metric kpi-tile">
      <span className="gam-overview-metric-value">{value}</span>
      <span className="gam-overview-metric-label">{label}</span>
      {hint ? <span className="gam-overview-metric-hint">{hint}</span> : null}
    </div>
  );
}

export const Tiles = ({ children }) => (
  <div className="gam-overview-card ab-kpis"><div className="gam-overview-metrics">{children}</div></div>
);

export function Section({ title, hint, children }) {
  return (
    <section className="chart-card">
      {title ? <div className="chart-header"><h3 className="chart-title">{title}</h3></div> : null}
      {hint ? <div className="ai-kpi-hint" style={{ marginBottom: 10 }}>{hint}</div> : null}
      {children}
    </section>
  );
}

export const Skeleton = ({ h = 180 }) => <div className="ai-card ai-skeleton" style={{ height: h }} />;

/** Load once (and again whenever `deps` change); returns { data, error, loading }. */
export function useLoad(fn, deps, tag, failMsg) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  useEffect(() => {
    let off = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn()
      .then((data) => { if (!off) setState({ data, error: null, loading: false }); })
      .catch((e) => {
        logErrorForDebug(tag, e);
        if (!off) setState({ data: null, error: getUserFacingMessage(e, failMsg), loading: false });
      });
    return () => { off = true; };
  }, deps);
  return state;
}

/** Debounced copy of a value, for search boxes. */
export function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}
