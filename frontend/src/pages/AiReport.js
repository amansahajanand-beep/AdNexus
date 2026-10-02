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
  return <div className="pai-ev rep-ev">{shown.map((t) => <span key={t} className="pai-fact">{t}</span>)}</div>;
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

  return (
    <div className="dashboard-page rep-page">
      <PageHeader
        title="Weekly report"
        subtitle="Last 7 days across Google Ad Manager, AdMob and AdSense, compared with the week before"
        summary={report ? period(report) : null}
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
      {loading ? <p className="reporting-sub">Loading…</p> : null}

      {!loading && !report && !generating ? (
        <div className="filter-card rep-empty">
          <p className="form-note">No report yet. Write one now; it takes up to a minute.</p>
        </div>
      ) : null}

      {content ? (
        <article className="rep-doc">
          {report.source === 'rules' ? (
            <div className="pai-notice" role="status">
              <span>The AI was unavailable, so this report was written from fixed rules on your data.</span>
            </div>
          ) : null}

          <header className="rep-lead">
            <h2 className="rep-headline">{content.headline}</h2>
            {content.summary ? <p className="rep-summary">{content.summary}</p> : null}
          </header>

          {content.sections.map((s) => (
            <section key={s.product} className="rep-section">
              <h3 className="rep-h3">{PRODUCT_LABEL[s.product] || s.product}</h3>
              {s.summary ? <p className="rep-section-sum">{s.summary}</p> : null}
              <ul className="pai-finds">
                {s.points.map((p) => {
                  const sev = SEVERITY[p.severity] || SEVERITY.info;
                  return (
                    <li key={p.text} className="pai-find">
                      <span className={`pai-sev ${sev.cls}`}>{sev.label}</span>
                      <b>{p.text}</b>
                      <Facts ids={p.factIds} facts={report.facts} />
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}

          {content.risks.length || content.actions.length ? (
            <div className="pai-cols rep-cols">
              {content.risks.length ? (
                <section>
                  <div className="pai-blk-title">Risks for next week</div>
                  <ul className="rep-risks">
                    {content.risks.map((r) => (
                      <li key={r.text}>{r.text}<Facts ids={r.factIds} facts={report.facts} /></li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {content.actions.length ? (
                <section>
                  <div className="pai-blk-title">What to do next</div>
                  <ol className="pai-actions">
                    {content.actions.map((a) => (
                      <li key={a.title} className="pai-act">
                        <div><b>{a.title}</b>{a.detail ? <span>{a.detail}</span> : null}</div>
                      </li>
                    ))}
                  </ol>
                </section>
              ) : null}
            </div>
          ) : null}

          <footer className="rep-foot">
            Written {new Date(report.createdAt).toLocaleString()} · {report.source === 'ai' ? 'AI summary of your data' : 'Rule-based summary'}
          </footer>
        </article>
      ) : null}
    </div>
  );
}
