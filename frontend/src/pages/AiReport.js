import React, { useCallback, useEffect, useState } from 'react';
import PageHeader from '../components/ui/PageHeader';
import { aiAPI } from '../utils/api';
import { loadAiStatus } from '../utils/ai/presetAnalysis';
import { getUserFacingMessage } from '../utils/userFacingError';

const PRODUCT_LABEL = { gam: 'Google Ad Manager', admob: 'AdMob', adsense: 'AdSense' };
const SEVERITY = {
  critical: { label: 'Needs action', cls: 'crit' },
  warning: { label: 'Watch', cls: 'warn' },
  positive: { label: 'Good news', cls: 'good' },
  info: { label: 'Note', cls: 'info' },
};

function formatDay(ymd) {
  if (!ymd) return '';
  try {
    return new Date(`${ymd}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return ymd;
  }
}

function period(r) {
  return r ? `${formatDay(r.periodStart)} – ${formatDay(r.periodEnd)}` : '';
}

function Facts({ ids, facts }) {
  const shown = (ids || []).map((id) => facts?.[id]).filter(Boolean).slice(0, 3);
  if (!shown.length) return null;
  return <div className="rep-facts">{shown.map((t) => <span key={t}>{t}</span>)}</div>;
}

function Sparkle({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M12 2.5l1.9 5.6 5.6 1.9-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.9L12 2.5zM19 15l.9 2.6 2.6.9-2.6.9L19 22l-.9-2.6-2.6-.9 2.6-.9L19 15z" />
    </svg>
  );
}

function countBySeverity(points = []) {
  const out = { crit: 0, warn: 0, good: 0, info: 0 };
  for (const p of points) out[(SEVERITY[p.severity] || SEVERITY.info).cls] += 1;
  return out;
}

function ReportSkeleton() {
  return (
    <div className="rep-skel" aria-hidden="true">
      <div className="rep-skel-hero">
        <div className="pai-skel" style={{ width: '38%', height: 12 }} />
        <div className="pai-skel" style={{ width: '82%', height: 22 }} />
        <div className="pai-skel" style={{ width: '64%' }} />
      </div>
      <div className="rep-skel-grid">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rep-skel-card">
            <div className="pai-skel" style={{ width: '50%', height: 14 }} />
            <div className="pai-skel" style={{ width: '90%' }} />
            <div className="pai-skel" style={{ width: '75%' }} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Weekly executive report across GAM, AdMob and AdSense (admins). */
export default function AiReport() {
  const [enabled, setEnabled] = useState(null);
  const [list, setList] = useState([]);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);

  const open = useCallback(async (id) => {
    setError(null);
    try {
      const res = await aiAPI.report(id);
      setReport(res.report);
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not open that report.'));
    }
  }, []);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await aiAPI.reports();
      setList(res.reports || []);
      if (res.reports?.length) await open(res.reports[0].id);
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not load reports.'));
    } finally {
      setLoading(false);
    }
  }, [open]);

  useEffect(() => {
    loadAiStatus().then((s) => {
      setEnabled(Boolean(s?.enabled));
      if (s?.enabled) loadList();
      else setLoading(false);
    });
  }, [loadList]);

  const generate = async (force) => {
    setGenerating(true);
    setError(null);
    try {
      const res = await aiAPI.generateReport(force);
      setReport(res.report);
      const refreshed = await aiAPI.reports();
      setList(refreshed.reports || []);
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not write the report right now.'));
    } finally {
      setGenerating(false);
    }
  };

  if (enabled === false) {
    return (
      <div className="dashboard-page">
        <PageHeader title="Weekly report" subtitle="AI features are turned off for this account." />
      </div>
    );
  }

  const content = report?.content;
  const all = (content?.sections || []).flatMap((s) => s.points || []);
  const counts = countBySeverity(all);
  const tally = [
    { cls: 'crit', label: 'Need action', count: counts.crit },
    { cls: 'warn', label: 'To watch', count: counts.warn },
    { cls: 'good', label: 'Good news', count: counts.good },
    { cls: 'info', label: 'Notes', count: counts.info },
  ].filter((t) => t.count > 0);

  return (
    <div className="dashboard-page rep-page">
      <PageHeader
        title="Weekly report"
        subtitle="Last 7 days across Google Ad Manager, AdMob and AdSense, compared with the week before"
      >
        {list.length > 1 ? (
          <select
            id="rep-history"
            className="ui-input rep-select"
            value={report?.id || ''}
            onChange={(e) => open(e.target.value)}
            aria-label="Earlier reports"
          >
            {list.map((r) => (
              <option key={r.id} value={r.id}>
                {period(r)} · {new Date(r.createdAt).toLocaleDateString()}{r.source === 'rules' ? ' (basic)' : ''}
              </option>
            ))}
          </select>
        ) : null}
        <button type="button" className="btn-outline-action" onClick={() => window.print()} disabled={!report}>Print</button>
        <button type="button" className="btn-generate" onClick={() => generate(Boolean(report))} disabled={generating}>
          {generating ? 'Writing… (up to a minute)' : report ? 'Write a fresh report' : 'Write this week\'s report'}
        </button>
      </PageHeader>

      {error ? <div className="login-error" role="alert">{error}</div> : null}
      {loading ? <ReportSkeleton /> : null}
      {generating && !loading ? (
        <div className="rep-writing" role="status">
          <span className="rep-writing-spark"><Sparkle size={18} /></span>
          <div>
            <b>Writing this week's report</b>
            <span>Reading Google Ad Manager, AdMob and AdSense, then writing it up. This can take up to a minute.</span>
          </div>
          <div className="pai-progress" aria-hidden="true"><span /></div>
        </div>
      ) : null}

      {!loading && !report && !generating ? (
        <div className="rep-empty">
          <span className="rep-empty-icon"><Sparkle size={26} /></span>
          <h2>No report yet</h2>
          <p className="form-note">No report yet. Write one now; it takes up to a minute.</p>
        </div>
      ) : null}

      {content ? (
        <article className={`rep-doc${generating ? ' is-stale' : ''}`}>
          {report.source === 'rules' ? (
            <div className="pai-notice" role="status">
              <span>The AI was unavailable, so this report was written from fixed rules on your data.</span>
            </div>
          ) : null}

          <header className="rep-hero">
            <div className="rep-hero-main">
              <div className="rep-eyebrow"><Sparkle size={14} /> Weekly report · {period(report)}</div>
              <h2 className="rep-headline">{content.headline}</h2>
              {content.summary ? <p className="rep-summary">{content.summary}</p> : null}
            </div>
            {tally.length ? (
              <ul className="rep-tally" aria-label="Findings by importance">
                {tally.map((t, i) => (
                  <li key={t.cls} className={t.cls} style={{ '--i': i }}>
                    <span className="n">{t.count}</span>
                    <span className="l">{t.label}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </header>

          <div className="rep-grid">
            {content.sections.map((s, i) => {
              const own = countBySeverity(s.points);
              return (
                <section key={s.product} className={`rep-card rep-card--${s.product}`} style={{ '--i': i }}>
                  <div className="rep-card-side">
                    <div className="rep-card-head">
                      <h3 className="rep-h3"><i className="rep-dot" aria-hidden="true" />{PRODUCT_LABEL[s.product] || s.product}</h3>
                      <span className="rep-card-count">{s.points.length} finding{s.points.length === 1 ? '' : 's'}{own.crit ? ` · ${own.crit} urgent` : ''}</span>
                    </div>
                    {s.summary ? <p className="rep-section-sum">{s.summary}</p> : null}
                  </div>
                  <ul className="rep-points">
                    {s.points.map((p, j) => {
                      const sev = SEVERITY[p.severity] || SEVERITY.info;
                      return (
                        <li key={p.text} className={`rep-point ${sev.cls}`} style={{ '--i': j }}>
                          <span className={`rep-sev ${sev.cls}`}>{sev.label}</span>
                          <div className="rep-point-body">
                            <b>{p.text}</b>
                            <Facts ids={p.factIds} facts={report.facts} />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>

          {content.risks.length || content.actions.length ? (
            <div className="rep-two">
              {content.risks.length ? (
                <section className="rep-card rep-card--risk">
                  <div className="pai-blk-title">Risks for next week</div>
                  <ul className="rep-risks">
                    {content.risks.map((r) => (
                      <li key={r.text}>
                        <span className="rep-risk-icon" aria-hidden="true">!</span>
                        <div>{r.text}<Facts ids={r.factIds} facts={report.facts} /></div>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {content.actions.length ? (
                <section className="rep-card rep-card--todo">
                  <div className="pai-blk-title">What to do next</div>
                  <ol className="pai-actions">
                    {content.actions.map((a, i) => (
                      <li key={a.title} className="pai-act" style={{ '--i': i }}>
                        <div><b>{a.title}</b>{a.detail ? <span>{a.detail}</span> : null}</div>
                      </li>
                    ))}
                  </ol>
                </section>
              ) : null}
            </div>
          ) : null}

          <footer className="rep-foot">
            <span>Written {new Date(report.createdAt).toLocaleString()}</span>
            <span className={`rep-source ${report.source === 'ai' ? 'ai' : ''}`}>{report.source === 'ai' ? 'AI summary of your data' : 'Rule-based summary'}</span>
          </footer>
        </article>
      ) : null}
    </div>
  );
}
