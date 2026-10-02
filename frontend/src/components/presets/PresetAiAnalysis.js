import React, { useMemo, useState } from 'react';
import usePresetAnalysis from '../../hooks/usePresetAnalysis';
import { aiAPI } from '../../utils/api';
import { showToast } from '../../hooks/useToast';
import ExplainChange from '../ai/ExplainChange';
import AiCharts, { Change } from '../ai/AiCharts';

const COLLAPSE_KEY = 'adnexus.presetAi.collapsed';
const SEVERITY = {
  critical: { label: 'Needs action', cls: 'crit' },
  warning: { label: 'Watch', cls: 'warn' },
  positive: { label: 'Good news', cls: 'good' },
  info: { label: 'Note', cls: 'info' },
};

const FALLBACK_NOTICE = {
  ai_rate_limited: 'You have reached the AI request limit for this minute. Basic insights are shown instead.',
  ai_budget_exceeded: 'The daily AI limit is used up. Basic insights are shown until it resets.',
};
const DEFAULT_FALLBACK_NOTICE = 'The AI summary is unavailable right now. These insights come from fixed rules on your data.';

function readCollapsed() {
  try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
}

function formatWhen(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return null;
  }
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
}

function Sparkle({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 2.5l1.9 5.6 5.6 1.9-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.9L12 2.5zM19 15l.9 2.6 2.6.9-2.6.9L19 22l-.9-2.6-2.6-.9 2.6-.9L19 15z"
      />
    </svg>
  );
}

function FactChips({ ids, facts }) {
  const shown = (ids || []).map((id) => facts?.[id]?.display).filter(Boolean).slice(0, 3);
  if (!shown.length) return null;
  return (
    <div className="pai-ev">
      {shown.map((text) => <span key={text} className="pai-fact">{text}</span>)}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="pai-skel-wrap" aria-hidden="true">
      <div className="pai-skel" style={{ width: '92%' }} />
      <div className="pai-skel" style={{ width: '78%' }} />
      <div className="pai-skel" style={{ width: '60%' }} />
    </div>
  );
}

/** Where the analysis is: data read, patterns found, insights being written. */
function Stages({ hasFacts, hasHeadline, deep }) {
  const active = hasHeadline ? 2 : hasFacts ? 1 : 0;
  const steps = ['Reading your data', 'Spotting patterns', deep ? 'Working through the detail' : 'Writing insights'];
  return (
    <ol className="pai-stages" aria-label="Progress">
      {steps.map((s, i) => (
        <li key={s} className={i < active ? 'done' : i === active ? 'now' : ''}>
          <span className="pai-stage-dot" aria-hidden="true">
            {i < active ? <svg width="10" height="10" viewBox="0 0 12 12"><path d="M2.5 6.5l2.3 2.3L9.5 3.8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg> : null}
          </span>
          {s}
        </li>
      ))}
    </ol>
  );
}

/** Headline figures as tiles; facts without structured fields (older saved results) fall back to text. */
function KpiTiles({ ids, facts }) {
  const items = (ids || []).map((id) => facts?.[id]).filter(Boolean).slice(0, 6);
  if (!items.length) return null;
  return (
    <div className="pai-kfs">
      {items.map((f, i) => (f.valueText ? (
        <div key={f.label} className="pai-kpi" style={{ '--i': i }}>
          <span className="pai-kpi-l">{f.label}</span>
          <span className="pai-kpi-v">{f.valueText}</span>
          <Change pct={f.change} />
        </div>
      ) : (
        <span key={f.display} className="pai-kf" style={{ '--i': i }}>{f.display}</span>
      )))}
    </div>
  );
}

function Feedback({ analysisId }) {
  const [rating, setRating] = useState(null);
  const send = async (value) => {
    const next = rating === value ? null : value;
    setRating(next);
    if (!next) return;
    try {
      await aiAPI.feedback({ feature: 'preset-analysis', targetKey: analysisId, rating: next });
      showToast({ message: 'Thanks for the feedback', replaceKey: 'ai-feedback' });
    } catch {
      setRating(null);
    }
  };
  return (
    <div className="pai-fb">
      <span>Was this useful?</span>
      <button type="button" aria-pressed={rating === 'up'} onClick={() => send('up')}>Yes</button>
      <button type="button" aria-pressed={rating === 'down'} onClick={() => send('down')}>No</button>
    </div>
  );
}

/**
 * AI analysis card for the Presets detail pane. Renders nothing when AI is turned off.
 * `filters` is the saved preset snapshot; the dates are the ones chosen on the page.
 */
export default function PresetAiAnalysis({
  product, kind, filters, startDate, endDate,
}) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [mode, setMode] = useState('fast');
  const { enabled, fast, deep, analyze } = usePresetAnalysis({
    product, kind, filters, startDate, endDate, active: !collapsed,
  });

  const toggle = () => {
    setCollapsed((c) => {
      try { localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1'); } catch { /* ignore */ }
      return !c;
    });
  };

  const selectMode = (next) => {
    setMode(next);
    if (next === 'deep' && deep.phase === 'idle') analyze('deep');
  };

  const view = mode === 'deep' ? deep : fast;
  const result = view.result;
  const analysis = result?.analysis;
  const facts = result?.facts || {};
  const early = view.early || fast.early;
  const meta = result?.meta;
  const charts = early?.charts || result?.charts || null;
  const currency = early?.currency || result?.currency || 'USD';
  const keyFacts = useMemo(() => ({ ...(result?.facts || {}), ...(early?.facts || {}) }), [early, result]);
  const keyIds = useMemo(() => early?.metricIds || [], [early]);

  if (!enabled) return null;

  const regenerate = () => analyze(mode, { force: true });
  const loading = view.phase === 'loading' || (mode === 'deep' && deep.phase === 'idle');
  const fallback = meta?.source === 'rules' && meta?.error;
  const total = meta ? (meta.factsMs || 0) + (meta.aiMs || 0) : null;

  return (
    <section className={`pai${loading ? ' is-loading' : ''}`} aria-label="AI analysis">
      <div className="pai-top">
        <button type="button" className="pai-title pai-toggle" onClick={toggle} aria-expanded={!collapsed}>
          <span className="pai-spark"><Sparkle /></span>
          AI analysis
          <span className="pai-chip">Beta</span>
          <span className="pai-caret" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
        </button>
        {!collapsed ? (
          <div className="pai-tools">
            <div className="pai-seg" role="group" aria-label="Analysis depth">
              <button type="button" className={mode === 'fast' ? 'on' : ''} aria-pressed={mode === 'fast'} onClick={() => selectMode('fast')}>Summary</button>
              <button type="button" className={mode === 'deep' ? 'on' : ''} aria-pressed={mode === 'deep'} onClick={() => selectMode('deep')}>Deep analysis</button>
            </div>
            <button type="button" className="btn-reset pai-regen" onClick={regenerate} disabled={loading}>Regenerate</button>
          </div>
        ) : null}
      </div>

      {!collapsed ? (
        <>
          <div className="pai-progress" aria-hidden="true"><span /></div>
          <div className="pai-body" key={mode}>
            {loading ? (
              <>
                <Stages hasFacts={Boolean(early)} hasHeadline={Boolean(view.headline)} deep={mode === 'deep'} />
                <KpiTiles ids={keyIds} facts={keyFacts} />
                {view.headline ? <p className="pai-headline pai-in">{view.headline}</p> : null}
                <AiCharts charts={charts} currency={currency} />
                <Skeleton />
                {mode === 'deep' ? <p className="pai-hint">Running a deeper analysis. This can take a minute or two.</p> : null}
              </>
            ) : null}

            {view.phase === 'error' ? (
              <div className="pai-notice" role="alert">
                <span>{view.error?.message || 'Could not analyze this preset.'}</span>
                <button type="button" className="btn-reset" onClick={regenerate}>Try again</button>
              </div>
            ) : null}

            {analysis ? (
              <>
                {fallback ? (
                  <div className="pai-notice" role="status">
                    <span>{FALLBACK_NOTICE[meta.error.code] || DEFAULT_FALLBACK_NOTICE}</span>
                    {!FALLBACK_NOTICE[meta.error.code] ? (
                      <button type="button" className="btn-reset" onClick={regenerate}>Try AI again</button>
                    ) : null}
                  </div>
                ) : null}
                <div className="pai-in" key={meta?.generatedAt || 'result'}>
                  <p className="pai-headline">{analysis.headline}</p>
                  {analysis.summary ? <p className="pai-lede">{analysis.summary}</p> : null}
                </div>

                <KpiTiles ids={keyIds} facts={keyFacts} />
                <AiCharts charts={charts} currency={currency} />

                {analysis.findings.length || analysis.actions.length ? (
                  <div className="pai-cols">
                    <div>
                      <div className="pai-blk-title">Findings</div>
                      <ul className="pai-finds">
                        {analysis.findings.map((f, i) => (
                          <li key={`${f.severity}-${f.title}`} className={`pai-find ${(SEVERITY[f.severity] || SEVERITY.info).cls}`} style={{ '--i': i }}>
                            <span className={`pai-sev ${(SEVERITY[f.severity] || SEVERITY.info).cls}`}>
                              {(SEVERITY[f.severity] || SEVERITY.info).label}
                            </span>
                            <b>{f.title}</b>
                            {f.detail ? <p>{f.detail}</p> : null}
                            <FactChips ids={f.factIds} facts={facts} />
                          </li>
                        ))}
                      </ul>
                    </div>
                    {analysis.actions.length ? (
                      <div>
                        <div className="pai-blk-title">What to do next</div>
                        <ol className="pai-actions">
                          {analysis.actions.map((a, i) => (
                            <li key={a.title} className="pai-act" style={{ '--i': i + analysis.findings.length }}>
                              <div>
                                <b>{a.title}</b>
                                {a.detail ? <span>{a.detail}</span> : null}
                              </div>
                            </li>
                          ))}
                        </ol>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {kind !== 'roi' ? (
                  <ExplainChange product={product} startDate={startDate} endDate={endDate} filters={filters} />
                ) : null}

                {mode === 'deep' && analysis.deepDive?.length ? (
                  <div className="pai-deep">
                    <div className="pai-blk-title">Deep analysis</div>
                    {analysis.deepDive.map((d) => (
                      <div key={d.title} className="pai-deep-item">
                        <b>{d.title}</b>
                        <p>{d.body}</p>
                        <FactChips ids={d.factIds} facts={facts} />
                      </div>
                    ))}
                    {analysis.confidence ? (
                      <p className="pai-hint">
                        Confidence: <b>{analysis.confidence.level}</b>
                        {analysis.confidence.note ? ` · ${analysis.confidence.note}` : ''}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>

          {meta ? (
            <div className="pai-foot">
              <div className="pai-stamps">
                <span>
                  <b>{mode === 'deep' ? 'Deep' : 'Summary'}</b>
                  {meta.source === 'rules' ? ' · rule-based' : meta.cached ? ' · saved result' : ''}
                </span>
                {formatWhen(meta.generatedAt) ? <span>Generated <b>{formatWhen(meta.generatedAt)}</b></span> : null}
                {formatWhen(meta.dataSyncedAt) ? <span>Data synced <b>{formatWhen(meta.dataSyncedAt)}</b></span> : null}
                {total ? <span>Ready in <b>{seconds(total)}</b></span> : null}
              </div>
              {meta.source === 'ai' ? <Feedback analysisId={meta.analysisId} /> : null}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
