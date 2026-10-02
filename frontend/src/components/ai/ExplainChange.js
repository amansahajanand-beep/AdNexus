import React, { useEffect, useRef, useState } from 'react';
import { streamExplainChange } from '../../utils/ai/explain';

const EFFECT_LABEL = {
  pureVolume: 'Traffic change',
  mix: 'Shift between items',
  price: 'Price change within items',
  newItems: 'New items',
  lostItems: 'Items that disappeared',
  other: 'Not attributed to a listed item',
};

function makeMoney(currency) {
  let fmt;
  try {
    fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 2 });
  } catch {
    fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
  }
  return (v) => `${v < 0 ? '−' : v > 0 ? '+' : ''}${fmt.format(Math.abs(v))}`;
}

function pct(v) {
  if (v == null || !Number.isFinite(v)) return '';
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}%`;
}

/** One signed bar per cause, scaled to the largest, growing right for gains and left for losses. */
function EffectBars({ rows, money }) {
  const max = Math.max(1e-9, ...rows.map((r) => Math.abs(r.value)));
  return (
    <ul className="exc-bars">
      {rows.map((r) => (
        <li key={r.label} className="exc-bar-row">
          <span className="exc-bar-label">{r.label}</span>
          <span className="exc-bar-track" aria-hidden="true">
            <span className="exc-bar-axis" />
            <span className={`exc-bar ${r.value < 0 ? 'neg' : 'pos'}`} style={{ width: `${(Math.abs(r.value) / max) * 50}%` }} />
          </span>
          <span className={`exc-bar-val ${r.value < 0 ? 'neg' : 'pos'}`}>{money(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}

function Movers({ dim, money }) {
  return (
    <div className="exc-movers">
      <div className="exc-sub">{dim.by}: biggest movers</div>
      <ul>
        {dim.items.slice(0, 5).map((i) => (
          <li key={i.name}>
            <span className="exc-mover-name">{i.name}</span>
            <span className={`exc-bar-val ${i.delta < 0 ? 'neg' : 'pos'}`}>{money(i.delta)}</span>
            <span className="exc-mover-meta">
              {i.status === 'new' ? 'new' : i.status === 'lost' ? 'stopped earning' : `traffic ${money(i.volume)}, price ${money(i.price)}`}
              {i.sharePct != null ? ` · ${Math.abs(i.sharePct).toFixed(0)}% of the change` : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * "Why did it change?" for one product and period. Starts on click, shows the exact figures at once and then
 * the written explanation. `filters` are the saved preset filters, if any.
 */
export default function ExplainChange({
  product, startDate, endDate, filters, label = 'Why did it change?',
}) {
  const [state, setState] = useState({ phase: 'idle', drivers: null, result: null, error: null });
  const controllerRef = useRef(null);
  const key = JSON.stringify({ product, startDate, endDate, filters });

  // A different period or preset makes an earlier answer stale.
  useEffect(() => {
    controllerRef.current?.abort();
    setState({ phase: 'idle', drivers: null, result: null, error: null });
    return () => controllerRef.current?.abort();
  }, [key]);

  const start = async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ phase: 'loading', drivers: null, result: null, error: null });
    try {
      const result = await streamExplainChange(
        { product, startDate, endDate, filters },
        { signal: controller.signal, onDrivers: (drivers) => { if (!controller.signal.aborted) setState((s) => ({ ...s, drivers })); } }
      );
      if (!controller.signal.aborted) setState({ phase: 'ready', drivers: result.drivers, result, error: null });
    } catch (err) {
      if (controller.signal.aborted || err.name === 'AbortError') return;
      setState({ phase: 'error', drivers: null, result: null, error: err.message || 'Could not explain this change.' });
    }
  };

  const { phase, drivers, result, error } = state;

  if (phase === 'idle') {
    return <button type="button" className="btn-reset exc-start" onClick={start}>{label}</button>;
  }

  const money = makeMoney(drivers?.currency);
  const narration = result || drivers?.rules || null;
  const primary = drivers?.dimensions?.[0];
  const loading = phase === 'loading';

  return (
    <div className="exc" aria-live="polite">
      {phase === 'error' ? (
        <div className="pai-notice" role="alert">
          <span>{error}</span>
          <button type="button" className="btn-reset" onClick={start}>Try again</button>
        </div>
      ) : null}

      {drivers ? (
        <>
          <p className="exc-headline">
            {narration?.headline || (drivers.tooSmall ? 'The change is too small to explain.' : '')}
            {loading && !result && !drivers.tooSmall ? <span className="exc-pending"> Writing the explanation…</span> : null}
          </p>
          {result?.explanation ? <p className="exc-expl">{result.explanation}</p> : null}

          {!drivers.tooSmall ? (
            <>
              <div className="exc-totals">
                <span>{money(drivers.totals.earningsPrev).replace(/^[+−]/, '')} → {money(drivers.totals.earningsNow).replace(/^[+−]/, '')}</span>
                <span className={drivers.totals.delta < 0 ? 'neg' : 'pos'}>{money(drivers.totals.delta)} ({pct(drivers.totals.changePct)})</span>
                <span>{drivers.totals.volumeUnit} {pct(drivers.totals.volumeChangePct)}</span>
                <span>{drivers.totals.priceName} {pct(drivers.totals.priceChangePct)}</span>
              </div>

              <div className="exc-sub">Where the change came from</div>
              {primary ? (
                <EffectBars
                  money={money}
                  rows={Object.entries(primary.effects)
                    .filter(([, v]) => v !== 0)
                    .map(([k, v]) => ({ label: EFFECT_LABEL[k], value: v }))}
                />
              ) : (
                <EffectBars
                  money={money}
                  rows={[
                    { label: 'Traffic change', value: drivers.aggregate.volume },
                    { label: 'Price change', value: drivers.aggregate.price },
                  ]}
                />
              )}

              {(drivers.dimensions || []).map((d) => <Movers key={d.by} dim={d} money={money} />)}

              {result?.points?.length ? (
                <ul className="exc-points">
                  {result.points.map((p) => (
                    <li key={p.text}>
                      {p.text}
                      {p.factIds.map((id) => result.facts?.[id]?.display).filter(Boolean).slice(0, 2).map((t) => (
                        <span key={t} className="pai-fact">{t}</span>
                      ))}
                    </li>
                  ))}
                </ul>
              ) : null}
              {drivers.note ? <p className="exc-note">{drivers.note}</p> : null}
              {result?.meta?.source === 'rules' && result.meta.error ? (
                <p className="exc-note">The AI explanation was unavailable, so this one is written from the figures.</p>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
      {loading && !drivers ? <p className="exc-pending">Working out what changed…</p> : null}
    </div>
  );
}
