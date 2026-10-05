import React, { useCallback, useEffect, useState } from 'react';
import { aiAPI } from '../../utils/api';
import { resetAiStatus } from '../../utils/ai/presetAnalysis';
import Button from '../ui/Button';
import { getUserFacingMessage, logErrorForDebug } from '../../utils/userFacingError';
import { showToast } from '../../hooks/useToast';

const FEATURE_LABEL = {
  'preset-analysis': 'Preset analysis',
  'ask-data': 'Ask AI',
  'mapping-suggestions': 'Campaign mapping',
  'weekly-report': 'Weekly report',
  'explain-change': 'Why did it change?',
  forecast: 'Forecast',
  ping: 'Connection test',
};
const TIER_LABEL = { fast: 'Summary', deep: 'Deep analysis', chat: 'Ask AI' };
const JOBS = [
  { key: 'alerts', label: 'Nightly alert scan', env: 'AI_ALERTS_ENABLED' },
  { key: 'weeklyReport', label: 'Weekly report (Mondays)', env: 'AI_REPORT_ENABLED' },
  { key: 'prewarm', label: 'Pre-analyze pinned presets', env: 'AI_PREWARM_ENABLED' },
];

const HEADLINE_FEATURES = [['preset-analysis', 'Preset analysis'], ['ask-data', 'Ask AI'], ['weekly-report', 'Weekly report']];
const label = (f) => FEATURE_LABEL[f] || f;
const count = (n) => Number(n || 0).toLocaleString();
const compact = (n) => {
  const v = Number(n || 0);
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
};
const secs = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`);

function when(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/** What to do about each reason AI is off. */
function offHelp(reason, provider) {
  if (reason === 'server_off') return 'Set AI_ENABLED=true in backend/.env and restart the backend.';
  if (reason === 'no_credentials') {
    return provider?.kind === 'openai'
      ? 'Set AI_API_URL, AI_API_KEY and AI_MODEL in backend/.env and restart the backend.'
      : 'Set ANTHROPIC_API_KEY in backend/.env and restart the backend.';
  }
  return 'Turn the switch below on to enable AI for this account.';
}

function Meter({ value, limit, name }) {
  const pct = limit ? Math.min(100, Math.round((value / limit) * 100)) : 0;
  return (
    <div className="aia-meter">
      <div className="aia-meter-row"><span>{name}</span><span>{compact(value)} of {compact(limit)}</span></div>
      <div className="aia-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={name}>
        <div className={`aia-fill${pct >= 90 ? ' is-high' : ''}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

const RANGES = [
  { key: 'day', label: 'Day', hint: 'Last 30 days' },
  { key: 'month', label: 'Month', hint: 'Last 12 months' },
  { key: 'year', label: 'Year', hint: 'Last 5 years' },
];

function periodLabel(period, by) {
  if (by === 'day') return period.slice(5);
  return period;
}

/** Tokens used per day, month or year. */
function TokenChart({ by, onBy, rows, loading, error }) {
  const max = Math.max(1, ...rows.map((r) => r.tokens));
  const total = rows.reduce((a, r) => a + r.tokens, 0);
  const hint = RANGES.find((r) => r.key === by)?.hint;
  const every = Math.ceil(rows.length / 6);
  return (
    <div className="aia-chart">
      <div className="aia-chart-head">
        <div>
          <b>Tokens used</b>
          <span className="aia-chart-sub"> · {hint} · {count(total)} in total</span>
        </div>
        <div className="aia-range" role="group" aria-label="Group tokens by">
          {RANGES.map((r) => (
            <button key={r.key} type="button" className={`aia-range-btn${by === r.key ? ' is-active' : ''}`} aria-pressed={by === r.key} onClick={() => onBy(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      {error ? <div className="login-error" role="alert">{error}</div> : null}
      <div className={`aia-bars aia-bars--tall${loading ? ' is-loading' : ''}`} role="img" aria-label={`Tokens used per ${by}`}>
        {rows.map((r) => (
          <div key={r.period} className="aia-bar-col" title={`${r.period}: ${count(r.tokens)} tokens (${count(r.input)} in, ${count(r.output)} out) · ${count(r.requests)} requests`}>
            <div className="aia-bar" style={{ height: `${Math.max(r.tokens ? 4 : 1, (r.tokens / max) * 100)}%` }} />
          </div>
        ))}
      </div>
      <div className="aia-axis" aria-hidden="true">
        {rows.map((r, i) => <span key={r.period}>{i % every === 0 ? periodLabel(r.period, by) : ''}</span>)}
      </div>
    </div>
  );
}

/** Admin → AI: switch, connection test, usage, limits, feedback and scheduled jobs. */
export default function AiAdminPanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState(null);
  const [testError, setTestError] = useState(null);
  const [by, setBy] = useState('day');
  const [series, setSeries] = useState(null);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [seriesError, setSeriesError] = useState(null);

  const loadSeries = useCallback(async (next) => {
    setSeriesLoading(true);
    setSeriesError(null);
    try {
      const res = await aiAPI.tokenSeries(next);
      setSeries({ by: res.by || next, rows: res.rows || [] });
    } catch (err) {
      logErrorForDebug(err, 'AI token series');
      setSeriesError(getUserFacingMessage(err, 'Could not load token usage.'));
    } finally {
      setSeriesLoading(false);
    }
  }, []);

  const pickRange = (next) => {
    if (next === by) return;
    setBy(next);
    loadSeries(next);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await aiAPI.admin();
      setData(res);
      setBy('day');
      setSeries(res.tokens?.series || null);
    } catch (err) {
      logErrorForDebug(err, 'AI admin');
      setError(getUserFacingMessage(err, 'Could not load the AI settings.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const setEnabled = async (enabled) => {
    setSaving(true);
    setError(null);
    try {
      await aiAPI.setEnabled(enabled);
      resetAiStatus();
      showToast({ message: enabled ? 'AI is on for this account. Reload the page to see it everywhere.' : 'AI is off for this account.', replaceKey: 'ai-toggle' });
      await load();
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not save the setting.'));
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    setTestError(null);
    try {
      const res = await aiAPI.ping();
      setTest(res.results);
      load();
    } catch (err) {
      setTestError(getUserFacingMessage(err, 'The connection test could not run.'));
    } finally {
      setTesting(false);
    }
  };

  if (loading && !data) return <p className="reporting-sub">Loading…</p>;
  if (!data) return error ? <div className="login-error" role="alert">{error}</div> : null;

  const { server, account, limits, jobs, usage, feedback, failures } = data;
  const averages = data.tokens?.averages || [];
  const averagesDays = data.tokens?.averagesDays || 90;
  const provider = server.provider;
  const canToggle = server.enabled && provider.credentials;
  const on = account.enabled;
  const hitRate = usage.totals.calls + usage.totals.cacheHits
    ? Math.round((usage.totals.cacheHits / (usage.totals.calls + usage.totals.cacheHits)) * 100)
    : 0;

  return (
    <div className="ads-admin-page aia">
      <div className="admin-panel-head">
        <div>
          <h3 className="admin-panel-title">AI</h3>
          <p className="reporting-sub" style={{ margin: '4px 0 0' }}>
            Turn AI features on or off for this account, check the connection, and see how they are used.
          </p>
        </div>
        <div className="admin-panel-actions">
          <Button type="button" variant="secondary" loading={loading} onClick={load}>Refresh</Button>
        </div>
      </div>

      {error ? <div className="login-error" role="alert" style={{ marginBottom: 12 }}>{error}</div> : null}

      <div className="filter-card aia-card">
        <div className="aia-status">
          <span className={`aia-dot ${on ? 'on' : 'off'}`} aria-hidden="true" />
          <div>
            <div className="aia-status-title">{on ? 'AI is on for this account' : 'AI is off for this account'}</div>
            {!on && account.reason ? <p className="aia-help">{offHelp(account.reason, provider)}</p> : null}
            {on ? <p className="aia-help">Preset analysis, Ask AI, campaign mapping, alerts and the weekly report are available.</p> : null}
          </div>
        </div>
        <label className={`aia-switch${canToggle ? '' : ' is-disabled'}`} htmlFor="ai-account-switch">
          <input
            id="ai-account-switch"
            type="checkbox"
            checked={account.setting == null ? server.defaultForAccounts : Boolean(account.setting)}
            disabled={!canToggle || saving}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>
            Enable AI features for this account
            {account.setting == null && canToggle ? <em> · currently follows the server default</em> : null}
          </span>
        </label>
      </div>

      <div className="filter-card aia-card">
        <div className="filter-card-head">
          <span className="filter-card-title">Connection</span>
          <Button type="button" variant="primary" loading={testing} disabled={!server.enabled || !provider.credentials} onClick={runTest}>
            Test connection
          </Button>
        </div>
        <dl className="aia-facts">
          <div><dt>Provider</dt><dd>{provider.kind === 'openai' ? 'OpenAI-style endpoint' : 'Anthropic'} · {provider.host}</dd></div>
          <div><dt>Model</dt><dd>{provider.models.fast}</dd></div>
          <div><dt>Credentials</dt><dd>{provider.credentials ? 'Set' : 'Missing'}</dd></div>
          {provider.thinking ? (
            <div><dt>Private thinking</dt><dd>{['fast', 'deep', 'chat'].map((t) => `${TIER_LABEL[t]} ${provider.thinking[t] ? 'on' : 'off'}`).join(' · ')}</dd></div>
          ) : null}
          <div><dt>Time limits</dt><dd>{['fast', 'deep', 'chat'].map((t) => `${TIER_LABEL[t]} ${provider.timeoutsSec[t]} s`).join(' · ')}</dd></div>
        </dl>
        {!server.enabled ? <p className="form-note">The server switch is off (AI_ENABLED), so the test is unavailable.</p> : null}
        {testError ? <div className="login-error" role="alert">{testError}</div> : null}
        {test ? (
          <ul className="aia-test">
            {Object.entries(test).map(([tier, r]) => (
              <li key={tier} className={r.ok ? 'ok' : 'bad'}>
                <b>{TIER_LABEL[tier] || tier}</b>
                {r.ok
                  ? <span>Answered in {secs(r.latencyMs)}</span>
                  : <span>{r.error || 'Failed'}</span>}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="filter-card aia-card">
        <div className="filter-card-head"><span className="filter-card-title">Last 7 days</span></div>
        <div className="aia-tiles">
          <div className="aia-tile"><span className="v">{count(usage.totals.calls)}</span><span className="l">Model requests</span></div>
          <div className="aia-tile"><span className="v">{hitRate}%</span><span className="l">Served from saved results</span></div>
          <div className="aia-tile"><span className="v">{count(usage.totals.failures)}</span><span className="l">Failed or fell back</span></div>
          <div className="aia-tile"><span className="v">{compact(usage.totals.inputTokens + usage.totals.outputTokens)}</span><span className="l">Tokens used</span></div>
          {usage.totals.cost > 0 ? <div className="aia-tile"><span className="v">${usage.totals.cost.toFixed(2)}</span><span className="l">Estimated cost</span></div> : null}
        </div>
        {usage.features.length ? (
          <div className="table-wrap">
            <table className="data-table responsive-table admin-table report-table report-table--comfortable">
              <thead>
                <tr><th>Feature</th><th style={{ textAlign: 'right' }}>Requests</th><th style={{ textAlign: 'right' }}>Saved</th><th style={{ textAlign: 'right' }}>Failed</th><th style={{ textAlign: 'right' }}>Typical</th><th style={{ textAlign: 'right' }}>Slowest 5%</th></tr>
              </thead>
              <tbody>
                {usage.features.map((f) => (
                  <tr key={f.feature}>
                    <td data-label="Feature">{label(f.feature)}</td>
                    <td data-label="Requests" style={{ textAlign: 'right' }}>{count(f.ok + f.failures)}</td>
                    <td data-label="Saved" style={{ textAlign: 'right' }}>{count(f.cache_hits)}</td>
                    <td data-label="Failed" style={{ textAlign: 'right' }}>{count(f.failures)}</td>
                    <td data-label="Typical" style={{ textAlign: 'right' }}>{secs(f.p50_ms)}</td>
                    <td data-label="Slowest 5%" style={{ textAlign: 'right' }}>{secs(f.p95_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="form-note">No AI activity yet.</p>}
      </div>

      <div className="filter-card aia-card">
        <div className="filter-card-head"><span className="filter-card-title">Token consumption</span></div>
        <div className="aia-tiles">
          {HEADLINE_FEATURES.map(([key, name]) => {
            const a = averages.find((x) => x.feature === key);
            return (
              <div className="aia-tile" key={key} data-testid={`avg-${key}`}>
                <span className="v">{a ? count(a.avgTotal) : '—'}</span>
                <span className="l">{name}: average tokens per request</span>
                <span className="aia-tile-sub">
                  {a ? `${count(a.avgInput)} in · ${count(a.avgOutput)} out · ${count(a.requests)} requests` : `No requests in the last ${averagesDays} days`}
                </span>
              </div>
            );
          })}
        </div>
        {averages.some((a) => !HEADLINE_FEATURES.some(([k]) => k === a.feature)) ? (
          <p className="form-note">
            Others: {averages.filter((a) => !HEADLINE_FEATURES.some(([k]) => k === a.feature)).map((a) => `${label(a.feature)} ${count(a.avgTotal)}`).join(' · ')}
            {' '}(average tokens per request, last {averagesDays} days).
          </p>
        ) : <p className="form-note">Averages cover the last {averagesDays} days. Answers served from saved results use no tokens and are not counted.</p>}
        <TokenChart by={by} onBy={pickRange} rows={series?.rows || []} loading={seriesLoading} error={seriesError} />
      </div>

      <div className="aia-two">
        <div className="filter-card aia-card">
          <div className="filter-card-head"><span className="filter-card-title">Your daily allowance</span></div>
          <Meter name="Tokens you used today" value={limits.userTokens} limit={limits.userLimit} />
          <Meter name="Tokens used by the account today" value={limits.clientTokens} limit={limits.clientLimit} />
          <p className="form-note">{limits.requestsPerMinute} requests per minute per person. Limits reset at midnight UTC.</p>
        </div>

        <div className="filter-card aia-card">
          <div className="filter-card-head"><span className="filter-card-title">Scheduled jobs</span></div>
          <ul className="aia-jobs">
            {JOBS.map((j) => (
              <li key={j.key}>
                <span>{j.label}</span>
                <span className={`aia-badge ${jobs[j.key] ? 'on' : ''}`} title={`${j.env}=${jobs[j.key]}`}>{jobs[j.key] ? 'On' : 'Off'}</span>
              </li>
            ))}
          </ul>
          <p className="form-note">Set in backend/.env. They run for accounts whose admin is signed in.</p>
        </div>
      </div>

      <div className="aia-two">
        <div className="filter-card aia-card">
          <div className="filter-card-head">
            <span className="filter-card-title">Feedback</span>
            <span className="aia-ai-note">{count(feedback.up)} helpful · {count(feedback.down)} not helpful</span>
          </div>
          {feedback.recent.length ? (
            <ul className="aia-list">
              {feedback.recent.map((f) => (
                <li key={`${f.createdAt}-${f.feature}-${f.rating}`}>
                  <span className={`aia-rate ${f.rating > 0 ? 'up' : 'down'}`}>{f.rating > 0 ? 'Helpful' : 'Not helpful'}</span>
                  <span>{label(f.feature)}{f.comment ? ` · ${f.comment}` : ''}</span>
                  <span className="aia-when">{when(f.createdAt)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="form-note">No feedback yet.</p>}
        </div>

        <div className="filter-card aia-card">
          <div className="filter-card-head"><span className="filter-card-title">Recent problems</span></div>
          {failures.length ? (
            <ul className="aia-list">
              {failures.map((f) => (
                <li key={`${f.createdAt}-${f.feature}-${f.status}`}>
                  <span className="aia-rate down">{f.status === 'fallback' ? 'Fell back' : f.status === 'error' ? 'Failed' : 'Limited'}</span>
                  <span>{label(f.feature)}{f.code ? ` · ${f.code.replace(/^ai_/, '').replace(/_/g, ' ')}` : ''}</span>
                  <span className="aia-when">{when(f.createdAt)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="form-note">Nothing has gone wrong recently.</p>}
        </div>
      </div>
    </div>
  );
}
