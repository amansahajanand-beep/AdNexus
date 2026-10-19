import React, { useCallback, useEffect, useState } from 'react';
import { adsAPI } from '../../utils/api';
import Button from '../ui/Button';
import { getUserFacingMessage, logErrorForDebug } from '../../utils/userFacingError';
import { showToast } from '../../hooks/useToast';

const errText = (err, fallback) => err?.response?.data?.error || getUserFacingMessage(err, fallback);
const data = (res) => (res && res.data !== undefined ? res.data : res);

const BENEFITS = [
  ['Pick an App ID on the ROI page', 'its subdomain is found and added to the filter automatically.'],
  ['Reads Remote Config only', 'nothing in your Firebase project is ever changed.'],
  ['Uses the newest app version', 'older versions are listed as suggestions, never added silently.'],
];

function ParamCard({ param }) {
  const [open, setOpen] = useState(false);
  const text = JSON.stringify(param.json, null, 2);
  return (
    <div className="fb-param">
      <button type="button" className="fb-param-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="fb-param-key">{param.key}</span>
        <span className="fb-badge">{param.source}</span>
        <span className="fb-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="fb-param-body">
          <div className="fb-param-actions">
            <Button
              variant="ghost"
              onClick={() => navigator.clipboard?.writeText(text).then(() => showToast({ message: 'JSON copied', replaceKey: 'fb-copy' }))}
            >
              Copy JSON
            </Button>
          </div>
          <pre className="fb-json">{text}</pre>
        </div>
      )}
    </div>
  );
}

/** Admin → Firebase: connect a Google account once, then browse each project's Remote Config JSON. */
export default function FirebaseAdmin() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [okMsg, setOkMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [projects, setProjects] = useState([]);
  const [projectErrors, setProjectErrors] = useState([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [config, setConfig] = useState(null);
  const [configLoading, setConfigLoading] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(data(await adsAPI.getFirebaseStatus()));
    } catch (err) {
      logErrorForDebug(err, 'Firebase status');
      setError(errText(err, 'Could not load the Firebase connection.'));
    }
  }, []);

  // Back from Google's consent screen: ?firebase_oauth=success|error&reason=...
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get('firebase_oauth');
    if (result === 'success') setOkMsg('Firebase connected with Google.');
    else if (result) setError(`Firebase connection failed${params.get('reason') ? `: ${params.get('reason')}` : ''}`);
    if (result) {
      params.delete('firebase_oauth');
      params.delete('reason');
      const next = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${next ? `?${next}` : ''}${window.location.hash || ''}`);
    }
    loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (!status?.connected) {
      setProjects([]);
      setProjectErrors([]);
      return;
    }
    setProjectsLoading(true);
    adsAPI.listFirebaseProjects()
      .then((res) => {
        setProjects(data(res).projects || []);
        setProjectErrors(data(res).errors || []);
      })
      .catch((err) => setError(errText(err, 'Could not list Firebase projects.')))
      .finally(() => setProjectsLoading(false));
  }, [status?.connected, status?.accounts?.length]);

  const accountOfProject = useCallback((id) => projects.find((p) => p.projectId === id)?.accountId || null, [projects]);

  const loadConfig = useCallback(async (id, refresh = false) => {
    if (!id) {
      setConfig(null);
      return;
    }
    setConfigLoading(true);
    setError('');
    try {
      setConfig(data(await adsAPI.getFirebaseProjectConfig(id, refresh, accountOfProject(id))));
    } catch (err) {
      setConfig(null);
      setError(errText(err, 'Could not read Remote Config.'));
    } finally {
      setConfigLoading(false);
    }
  }, [accountOfProject]);

  const connect = async () => {
    setBusy(true);
    setError('');
    try {
      window.location.href = data(await adsAPI.getFirebaseOAuthUrl()).url;
    } catch (err) {
      setError(errText(err, 'Could not start Google sign-in.'));
      setBusy(false);
    }
  };

  const removeAccount = async (account) => {
    setBusy(true);
    setError('');
    try {
      await adsAPI.disconnectFirebase(account?.id);
      setProjectId('');
      setConfig(null);
      setOkMsg(account ? `Removed ${account.email}.` : 'Firebase disconnected.');
      await loadStatus();
    } catch (err) {
      setError(errText(err, 'Could not remove the account.'));
    } finally {
      setBusy(false);
    }
  };

  const accounts = status?.accounts || [];

  if (!status) {
    return (
      <div className="fb">
        <div className="filter-card fb-card">{error || 'Loading Firebase connection…'}</div>
      </div>
    );
  }

  return (
    <div className="fb">
      {error && <div className="fb-alert fb-alert-error" role="alert">{error}</div>}
      {okMsg && <div className="fb-alert fb-alert-ok" role="status">{okMsg}</div>}
      {projectErrors.map((e) => (
        <div key={e.email} className="fb-alert fb-alert-error" role="alert">{e.email}: {e.message}</div>
      ))}

      <div className="filter-card fb-card">
        <div className="fb-status">
          <span className={`fb-dot ${status.connected ? 'on' : 'off'}`} aria-hidden="true" />
          <div className="fb-status-text">
            <div className="fb-title">
              {status.connected
                ? `${accounts.length} Google account${accounts.length === 1 ? '' : 's'} connected`
                : 'Connect Firebase'}
            </div>
            <div className="fb-sub">
              {status.connected
                ? 'Apps are matched against the Firebase projects of every connected account.'
                : 'Sign in with the Google account that has access to your Firebase projects.'}
            </div>
          </div>
          <div className="fb-actions">
            <Button onClick={connect} loading={busy} variant={status.connected ? 'secondary' : 'primary'}>
              {status.connected ? 'Add another account' : 'Connect with Google'}
            </Button>
          </div>
        </div>
        {accounts.length > 0 && (
          <ul className="fb-accounts">
            {accounts.map((a) => (
              <li key={a.id} className="fb-account">
                <span className="fb-account-mail">{a.email}</span>
                <span className="fb-account-count">
                  {projects.filter((p) => p.accountId === a.id).length} projects
                </span>
                <Button variant="ghost" onClick={() => removeAccount(a)} disabled={busy}>Remove</Button>
              </li>
            ))}
          </ul>
        )}
        <ul className="fb-benefits">
          {BENEFITS.map(([head, rest]) => (
            <li key={head}><strong>{head}</strong> — {rest}</li>
          ))}
        </ul>
      </div>

      {status.connected && (
        <div className="filter-card fb-card">
          <div className="fb-title">Remote Config explorer</div>
          <div className="fb-sub">Pick a project to see every parameter whose value is valid JSON, including each app version.</div>
          <div className="fb-picker">
            <select
              className="fb-select"
              value={projectId}
              disabled={projectsLoading}
              onChange={(e) => { setProjectId(e.target.value); loadConfig(e.target.value); }}
              aria-label="Firebase project"
            >
              <option value="">{projectsLoading ? 'Loading projects…' : `Choose a project (${projects.length})`}</option>
              {projects.map((p) => (
                <option key={p.projectId} value={p.projectId}>{p.displayName.trim()} ({p.projectId}){accounts.length > 1 ? ` · ${p.accountEmail}` : ''}</option>
              ))}
            </select>
            {projectId && (
              <Button variant="ghost" onClick={() => loadConfig(projectId, true)} loading={configLoading}>Refresh</Button>
            )}
          </div>

          {configLoading && !config && <div className="fb-sub">Reading Remote Config…</div>}
          {config && (
            <div className="fb-params">
              <div className="fb-sub">
                {config.params.length} JSON parameter{config.params.length === 1 ? '' : 's'}
                {config.fetchedAt ? ` · fetched ${new Date(config.fetchedAt).toLocaleTimeString()}` : ''}
              </div>
              {config.params.map((p) => <ParamCard key={`${p.key}:${p.source}`} param={p} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
