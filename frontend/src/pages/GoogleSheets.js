import React, { useCallback, useEffect, useState } from 'react';
import PageHeader from '../components/ui/PageHeader';
import Button from '../components/ui/Button';
import { TextField } from '../components/ui/Field';
import { sheetsAPI } from '../utils/api';
import { showToast } from '../hooks/useToast';
import { confirmDialog } from '../hooks/useConfirmDialog';

function errMsg(e, fallback) {
  return e?.response?.data?.error || e?.message || fallback;
}

function fmtWhen(iso) {
  if (!iso) return 'Never';
  try { return new Date(iso).toLocaleString(); } catch { return String(iso); }
}

function tabSummary(t) {
  if (!t) return '';
  if (t.skipped) return `skipped — ${t.skipped}`;
  if (t.error) return `failed — ${t.error}`;
  return `${t.appended} added, ${t.updated} updated`;
}

export default function GoogleSheets() {
  const [state, setState] = useState({ loading: true, configured: false, email: null, connection: null });
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [days, setDays] = useState(7);

  const load = useCallback(async () => {
    try {
      const data = await sheetsAPI.status(); // api.js interceptors already unwrap res.data
      setState({ loading: false, configured: data.configured, email: data.serviceAccountEmail, connection: data.connection });
    } catch (e) {
      setState((s) => ({ ...s, loading: false }));
      setError(errMsg(e, 'Could not load Google Sheets settings'));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const act = async (key, fn, okMsg) => {
    setBusy(key);
    setError('');
    try {
      const res = await fn();
      if (okMsg) showToast({ message: okMsg });
      return res;
    } catch (e) {
      setError(errMsg(e, 'Something went wrong'));
      return null;
    } finally {
      setBusy('');
    }
  };

  const connect = async (e) => {
    e.preventDefault();
    const res = await act('connect', () => sheetsAPI.connect(link.trim()), 'Sheet connected');
    if (res) { setLink(''); await load(); }
  };

  const runNow = async () => {
    const res = await act('run', () => sheetsAPI.runNow(days), 'Export finished');
    await load();
    return res;
  };

  const toggle = async () => {
    const next = !state.connection.enabled;
    const res = await act('toggle', () => sheetsAPI.setEnabled(next), next ? 'Daily export resumed' : 'Daily export paused');
    if (res) await load();
  };

  const disconnect = async () => {
    const ok = await confirmDialog({
      title: 'Disconnect sheet?',
      message: 'Daily updates will stop. Data already in the sheet stays there.',
      yesLabel: 'Disconnect',
      noLabel: 'Cancel',
    });
    if (!ok) return;
    const res = await act('disconnect', () => sheetsAPI.disconnect(), 'Sheet disconnected');
    if (res) await load();
  };

  const { loading, configured, email, connection } = state;
  const result = connection?.lastResult;

  return (
    <div className="dashboard-page">
      <PageHeader
        title="Google Sheets"
        subtitle="Get your daily data in your own Google Sheet, updated automatically every morning"
      />

      {loading && <p>Loading…</p>}

      {!loading && !configured && (
        <div className="card" style={{ padding: 20 }}>
          {error
            ? <span role="alert" style={{ color: 'var(--danger, #b91c1c)' }}>{error}</span>
            : 'Google Sheets export is not set up on this server yet. Ask your administrator to configure it.'}
        </div>
      )}

      {!loading && configured && !connection && (
        <form className="card" style={{ padding: 20, display: 'grid', gap: 16, maxWidth: 680 }} onSubmit={connect}>
          <ol style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 8 }}>
            <li>Create a Google Sheet (or open an existing one).</li>
            <li>
              Click <strong>Share</strong> and add this email as <strong>Editor</strong>:
              <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <code style={{ wordBreak: 'break-all' }}>{email}</code>
                <Button
                  variant="secondary"
                  onClick={() => navigator.clipboard?.writeText(email).then(() => showToast({ message: 'Email copied' }))}
                >
                  Copy
                </Button>
              </div>
            </li>
            <li>Paste the sheet link below.</li>
          </ol>
          <TextField
            label="Google Sheet link"
            value={link}
            onChange={setLink}
            placeholder="https://docs.google.com/spreadsheets/d/…"
          />
          {error && <div role="alert" style={{ color: 'var(--danger, #b91c1c)' }}>{error}</div>}
          <div>
            <Button type="submit" loading={busy === 'connect'} disabled={!link.trim()}>Connect sheet</Button>
          </div>
        </form>
      )}

      {!loading && configured && connection && (
        <div className="card" style={{ padding: 20, display: 'grid', gap: 16, maxWidth: 680 }}>
          <div>
            <div style={{ fontWeight: 600 }}>{connection.spreadsheetTitle || 'Connected sheet'}</div>
            <a href={connection.spreadsheetUrl} target="_blank" rel="noreferrer">Open in Google Sheets</a>
          </div>

          <div>
            Daily export: <strong>{connection.enabled ? 'On (06:30 SGT)' : 'Paused'}</strong>
            <br />
            Last run: {fmtWhen(connection.lastRunAt)}
            {connection.lastStatus === 'error' && (
              <div role="alert" style={{ color: 'var(--danger, #b91c1c)' }}>
                Last run failed: {connection.lastError}
              </div>
            )}
            {result?.tabs && (
              <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
                {Object.entries(result.tabs).map(([name, t]) => (
                  <li key={name}><strong>{name}</strong>: {tabSummary(t)}</li>
                ))}
              </ul>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <label>
              Export last{' '}
              <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {[1, 7, 30, 90].map((d) => <option key={d} value={d}>{d} day{d > 1 ? 's' : ''}</option>)}
              </select>
            </label>
            <Button loading={busy === 'run'} onClick={runNow}>Export now</Button>
            <Button variant="secondary" loading={busy === 'toggle'} onClick={toggle}>
              {connection.enabled ? 'Pause daily export' : 'Resume daily export'}
            </Button>
            <Button variant="danger" loading={busy === 'disconnect'} onClick={disconnect}>Disconnect</Button>
          </div>

          {error && <div role="alert" style={{ color: 'var(--danger, #b91c1c)' }}>{error}</div>}

          <p style={{ margin: 0, opacity: 0.75 }}>
            These tabs are created in your sheet: <strong>GAM</strong> (daily totals), <strong>GAM Sites</strong>{' '}
            (domain and site), <strong>GAM Apps</strong> (app ID and name), <strong>GAM Countries</strong>,{' '}
            <strong>GAM Catalog</strong> (every site, app and ad unit), <strong>AdMob</strong> and <strong>AdSense</strong>.
            Re-running never duplicates rows; recent days are refreshed as Google revises them.
            You only get data you have access to.
          </p>
        </div>
      )}
    </div>
  );
}
