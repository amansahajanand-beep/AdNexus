import React, { useCallback, useEffect, useRef, useState } from 'react';
import PageHeader from '../components/ui/PageHeader';
import ForecastChart from '../components/ai/ForecastChart';
import { Change, formatValue } from '../components/ai/AiCharts';
import { aiAPI } from '../utils/api';
import { loadAiStatus } from '../utils/ai/presetAnalysis';
import { streamForecast } from '../utils/ai/forecast';
import { getUserFacingMessage } from '../utils/userFacingError';
import { readStoredProduct } from '../utils/productWorkspace';
import { showToast } from '../hooks/useToast';

const PRODUCTS = [
  { id: 'gam', label: 'Google Ad Manager' },
  { id: 'admob', label: 'AdMob' },
  { id: 'adsense', label: 'AdSense' },
];

const STATUS = {
  will_reach: { label: 'Likely to reach the target', cls: 'good' },
  on_track: { label: 'On track for the target', cls: 'good' },
  at_risk: { label: 'At risk of missing the target', cls: 'warn' },
  will_miss: { label: 'Likely to miss the target', cls: 'crit' },
  ahead: { label: 'Ahead of last month', cls: 'good' },
  behind: { label: 'Behind last month', cls: 'warn' },
  similar: { label: 'In line with last month', cls: 'info' },
};

function Sparkle({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M12 2.5l1.9 5.6 5.6 1.9-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.9L12 2.5zM19 15l.9 2.6 2.6.9-2.6.9L19 22l-.9-2.6-2.6-.9 2.6-.9L19 15z" />
    </svg>
  );
}

function Facts({ ids, facts }) {
  const shown = (ids || []).map((id) => facts?.[id]?.display).filter(Boolean).slice(0, 3);
  if (!shown.length) return null;
  return <div className="rep-facts">{shown.map((t) => <span key={t}>{t}</span>)}</div>;
}

/** Earned so far, expected range and target on one bar. */
function ProgressBar({ figures, money }) {
  const { mtd, projectedEnd: p, target } = figures;
  const scale = Math.max(p.high, target || 0, 1) * 1.04;
  const pct = (v) => `${Math.min(100, (v / scale) * 100)}%`;
  return (
    <div className="fc-progress" role="img" aria-label={`Earned ${money(mtd)}, projected ${money(p.mid)}${target ? `, target ${money(target)}` : ''}`}>
      <div className="fc-progress-track">
        <div className="fc-progress-range" style={{ left: pct(p.low), width: `calc(${pct(p.high)} - ${pct(p.low)})` }} />
        <div className="fc-progress-earned" style={{ width: pct(mtd) }} />
        <i className="fc-progress-mid" style={{ left: pct(p.mid) }} title={`Projected ${money(p.mid)}`} />
        {target ? <i className="fc-progress-target" style={{ left: pct(target) }} title={`Target ${money(target)}`} /> : null}
      </div>
      <div className="fc-progress-key">
        <span><i className="earned" /> Earned so far</span>
        <span><i className="range" /> Likely range</span>
        {target ? <span><i className="target" /> Target</span> : null}
      </div>
    </div>
  );
}

function TargetEditor({ figures, onSaved }) {
  const [value, setValue] = useState(figures.target ? String(figures.target) : '');
  const [saving, setSaving] = useState(false);
  useEffect(() => { setValue(figures.target ? String(figures.target) : ''); }, [figures.target, figures.product]);

  const save = async (amount) => {
    setSaving(true);
    try {
      await aiAPI.setForecastTarget(figures.product, amount);
      showToast({ message: amount ? 'Target saved' : 'Target removed', replaceKey: 'fc-target' });
      onSaved();
    } catch (err) {
      showToast({ message: getUserFacingMessage(err, 'Could not save the target.'), replaceKey: 'fc-target' });
    } finally {
      setSaving(false);
    }
  };
  const amount = Number(value);
  const valid = value !== '' && Number.isFinite(amount) && amount > 0;
  return (
    <form className="fc-target" onSubmit={(e) => { e.preventDefault(); if (valid) save(amount); }}>
      <label htmlFor="fc-target-input" className="aic-cap-title">Monthly target</label>
      <p className="form-note">Set what you want {figures.label} to earn each month. The forecast then says whether the month is on track, and the alerts bell warns you when it looks likely to be missed.</p>
      <div className="fc-target-row">
        <span className="fc-target-cur">{figures.currency}</span>
        <input
          id="fc-target-input"
          className="ui-input"
          inputMode="decimal"
          placeholder="e.g. 600000"
          value={value}
          onChange={(e) => setValue(e.target.value.replace(/[^0-9.]/g, ''))}
          aria-label="Monthly target amount"
        />
        <button type="submit" className="btn-generate" disabled={!valid || saving}>{saving ? 'Saving…' : 'Save target'}</button>
        {figures.target ? <button type="button" className="btn-outline-action" disabled={saving} onClick={() => save(0)}>Remove</button> : null}
      </div>
    </form>
  );
}

/** Month-end earnings forecast for each product (admins). */
export default function AiForecast() {
  const [enabled, setEnabled] = useState(null);
  const [product, setProduct] = useState(() => {
    const stored = readStoredProduct();
    return PRODUCTS.some((p) => p.id === stored) ? stored : 'gam';
  });
  const [figures, setFigures] = useState(null);
  const [result, setResult] = useState(null);
  const [phase, setPhase] = useState('idle'); // idle | loading | explaining | ready | error
  const [error, setError] = useState(null);
  const controller = useRef(null);

  const load = useCallback(async (which) => {
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    setPhase('loading');
    setError(null);
    setFigures(null);
    setResult(null);
    try {
      const done = await streamForecast({ product: which }, {
        signal: c.signal,
        onFigures: (f) => { if (!c.signal.aborted) { setFigures(f); setPhase('explaining'); } },
      });
      if (c.signal.aborted) return;
      setFigures(done.figures);
      setResult(done);
      setPhase('ready');
    } catch (err) {
      if (c.signal.aborted || err.name === 'AbortError') return;
      setError(getUserFacingMessage(err, 'Could not build the forecast.'));
      setPhase('error');
    }
  }, []);

  useEffect(() => {
    let alive = true;
    loadAiStatus().then((s) => { if (alive) setEnabled(Boolean(s?.enabled)); });
    return () => { alive = false; controller.current?.abort(); };
  }, []);

  useEffect(() => {
    if (enabled) load(product);
  }, [enabled, product, load]);

  if (enabled === false) {
    return (
      <div className="dashboard-page">
        <PageHeader title="Forecast" subtitle="AI features are turned off for this account." />
      </div>
    );
  }

  const money = (v) => formatValue('money', v, figures?.currency || 'USD');
  const narration = result || figures?.rules || null;
  const status = figures?.ok ? STATUS[figures.status] : null;
  const busy = phase === 'loading' || phase === 'explaining';

  return (
    <div className="dashboard-page fc-page">
      <PageHeader title="Forecast" subtitle="Where this month's earnings are heading, based on recent daily earnings">
        <div className="aia-range" role="tablist" aria-label="Product">
          {PRODUCTS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={product === p.id}
              className={`aia-range-btn${product === p.id ? ' is-active' : ''}`}
              onClick={() => setProduct(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <button type="button" className="btn-outline-action" onClick={() => load(product)} disabled={busy}>Refresh</button>
      </PageHeader>

      {error ? (
        <div className="login-error" role="alert">
          {error} <button type="button" className="link-action" onClick={() => load(product)}>Try again</button>
        </div>
      ) : null}
      {phase === 'loading' ? <div className="rep-skel" aria-hidden="true"><div className="rep-skel-hero"><div className="pai-skel" style={{ width: '30%', height: 12 }} /><div className="pai-skel" style={{ width: '55%', height: 30 }} /><div className="pai-skel" style={{ width: '70%' }} /></div></div> : null}

      {figures && !figures.ok ? (
        <div className="rep-empty">
          <span className="rep-empty-icon"><Sparkle size={26} /></span>
          <h2>Not enough data to forecast {figures.label} yet</h2>
          <p className="form-note">{figures.reason}</p>
        </div>
      ) : null}

      {figures?.ok ? (
        <div className="fc-doc">
          <section className="fc-hero">
            <div className="fc-hero-main">
              <div className="rep-eyebrow"><Sparkle size={14} /> {figures.label} · {figures.month.name} forecast</div>
              <div className="fc-big">
                <span className="fc-big-v">{money(figures.projectedEnd.mid)}</span>
                <span className="fc-big-l">projected for the month</span>
              </div>
              <div className="fc-range">Likely between <b>{money(figures.projectedEnd.low)}</b> and <b>{money(figures.projectedEnd.high)}</b></div>
              {status ? <span className={`fc-status ${status.cls}`}>{status.label}</span> : null}
            </div>
            <div className="fc-hero-side">
              <ProgressBar figures={figures} money={money} />
            </div>
          </section>

          <ul className="fc-tiles">
            <li>
              <span className="l">Earned so far</span>
              <span className="v">{money(figures.mtd)}</span>
              <span className="s">{figures.month.elapsedDays} of {figures.month.daysInMonth} days, through yesterday</span>
            </li>
            <li>
              <span className="l">Still to come</span>
              <span className="v">{money(figures.remainingMid)}</span>
              <span className="s">{figures.remainingDays} days left, about {money(figures.dailyLevel)} a day</span>
            </li>
            <li>
              <span className="l">{figures.lastMonth ? `${figures.lastMonth.name} total` : 'Last month'}</span>
              <span className="v">{figures.lastMonth ? money(figures.lastMonth.total) : '—'}</span>
              <span className="s">{figures.paceVsLastMonthPct != null ? <><Change pct={figures.paceVsLastMonthPct} /> pace against the same days</> : 'Not enough history to compare'}</span>
            </li>
            <li>
              <span className="l">Last 7 days</span>
              <span className="v">{figures.weekOverWeekPct != null ? <Change pct={figures.weekOverWeekPct} /> : '—'}</span>
              <span className="s">against the 7 days before</span>
            </li>
          </ul>

          <ForecastChart figures={figures} currency={figures.currency} />

          {narration ? (
            <section className="fc-explain">
              <div className="fc-explain-head">
                <span className="aic-cap-title">What this means</span>
                {phase === 'explaining' ? <span className="exc-pending">Writing the explanation…</span> : null}
                {phase === 'ready' && result?.meta?.source === 'rules' ? <span className="rep-source">Rule-based</span> : null}
                {phase === 'ready' && result?.meta?.source === 'ai' ? <span className="rep-source ai">AI summary</span> : null}
              </div>
              <p className="fc-headline">{narration.headline}</p>
              {narration.explanation ? <p className="rep-summary">{narration.explanation}</p> : null}
              {narration.points?.length ? (
                <ul className="fc-points">
                  {narration.points.map((p) => (
                    <li key={p.text}>
                      <span>{p.text}</span>
                      <Facts ids={p.factIds} facts={result?.facts} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}

          <TargetEditor figures={figures} onSaved={() => load(product)} />

          {figures.timezone ? (
            <p className={`form-note tz-report-note${figures.timezone.applied ? '' : ' is-warn'}`} role="status">
              {figures.timezone.applied
                ? `Months and days follow ${figures.timezone.tz}; days before ${figures.timezone.from} stay in the network timezone (${figures.timezone.networkTz}).`
                : `Showing days in the network timezone (${figures.timezone.networkTz}), not ${figures.timezone.tz}: the hourly data does not cover this month yet.`}
            </p>
          ) : null}

          <footer className="rep-foot">
            <span>Figures run through yesterday · {figures.source}</span>
            <span>A projection from recent daily earnings, not a promise. The range holds the likely outcome about 8 times in 10.</span>
          </footer>
        </div>
      ) : null}
    </div>
  );
}
