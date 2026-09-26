import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { admobAPI, adsenseAPI } from '../../utils/api';
import Button from '../ui/Button';
import { getUserFacingMessage, logErrorForDebug } from '../../utils/userFacingError';
import { confirmDialog } from '../../hooks/useConfirmDialog';

function formatSyncAt(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

/**
 * Admin: connect / manage AdMob or AdSense publisher accounts (OAuth).
 */
export default function ProductAccountsAdmin({
  product = 'admob',
  title,
  dashboardPath,
}) {
  const api = product === 'adsense' ? adsenseAPI : admobAPI;
  const label = product === 'adsense' ? 'AdSense' : 'AdMob';
  const oauthParam = product === 'adsense' ? 'adsense_oauth' : 'admob_oauth';

  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [okMsg, setOkMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(null);
  const [pickingId, setPickingId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listAccounts();
      setAccounts(data.accounts || []);
    } catch (err) {
      logErrorForDebug(err, `${label} accounts`);
      setError(getUserFacingMessage(err, `Could not load ${label} accounts.`));
    } finally {
      setLoading(false);
    }
  }, [api, label]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get(oauthParam);
    if (status === 'error') {
      setError(`${label} OAuth failed${params.get('reason') ? `: ${params.get('reason')}` : ''}`);
    } else if (status === 'connected') {
      setOkMsg(`${label} connected successfully.`);
      load();
    } else if (status === 'pick') {
      const sessionId = params.get('session');
      if (sessionId) {
        setBusy(true);
        api.oauthPending(sessionId)
          .then((data) => {
            setPicker({
              sessionId: data.sessionId,
              accounts: data.accounts || [],
            });
            setOkMsg(`Select a ${label} account to continue.`);
          })
          .catch((err) => {
            setError(getUserFacingMessage(err, `Could not load ${label} accounts from Google.`));
          })
          .finally(() => setBusy(false));
      }
    }
    if (status) {
      params.delete(oauthParam);
      params.delete('reason');
      params.delete('session');
      const next = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${next ? `?${next}` : ''}${window.location.hash || ''}`);
    }
  }, [api, label, load, oauthParam]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    setOkMsg(null);
    try {
      const { url } = await api.oauthUrl();
      if (url) {
        window.location.assign(url);
        return;
      }
      setError('No OAuth URL returned. Check backend AdMob/AdSense routes are running.');
    } catch (err) {
      logErrorForDebug(err, `${label} oauth`);
      const status = err?.response?.status || err?.status;
      if (status === 404) {
        setError(
          `${label} OAuth API not found (404). Restart the backend so /api/${product} routes load, then try again.`
        );
      } else {
        setError(getUserFacingMessage(err, `Could not start ${label} connect.`));
      }
    }
    setBusy(false);
  };

  const selectAccount = async (accountId) => {
    if (!picker?.sessionId) return;
    setPickingId(accountId);
    setError(null);
    try {
      await api.oauthSelect(picker.sessionId, { accountId });
      setPicker(null);
      setOkMsg(`${label} account connected. Syncing data…`);
      await load();
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not save selected account.'));
    } finally {
      setPickingId(null);
    }
  };

  const reconnect = async (id) => {
    setBusy(true);
    try {
      const { url } = await api.accountOauthUrl(id);
      if (url) window.location.href = url;
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not start reconnect.'));
      setBusy(false);
    }
  };

  const syncAll = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.syncAll();
      setOkMsg(result.message || 'Sync started.');
      await load();
    } catch (err) {
      setError(getUserFacingMessage(err, 'Sync failed.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id, name) => {
    const ok = await confirmDialog({
      title: `Remove ${label} account?`,
      message: `Remove ${name || id}? Daily report history for this account will be deleted.`,
      yesLabel: 'Remove',
      noLabel: 'Cancel',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.deleteAccount(id);
      setOkMsg('Account removed.');
      await load();
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not remove account.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-panel product-accounts-admin">
      <div className="chart-card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>{title || `${label} accounts`}</h3>
            <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13, lineHeight: 1.5, maxWidth: 520 }}>
              Connect a Google {label} account under this org. Data syncs into the {label} dashboard
              (separate from GAM). Enable the {label} API on your Google Cloud project and add the
              redirect URI to the OAuth client.
            </p>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <Button type="button" onClick={connect} disabled={busy} loading={busy}>
              Connect with Google
            </Button>
            <Button type="button" variant="secondary" onClick={syncAll} disabled={busy || !accounts.length}>
              Sync now
            </Button>
            {dashboardPath ? (
              <Link to={dashboardPath} className="ui-btn ui-btn-ghost" style={{ textDecoration: 'none' }}>
                Open dashboard
              </Link>
            ) : null}
          </div>
        </div>

        {error ? <p className="form-error" style={{ marginTop: 14 }} role="alert">{error}</p> : null}
        {okMsg ? <p className="form-ok" style={{ marginTop: 14, color: 'var(--success)' }}>{okMsg}</p> : null}

        {picker ? (
          <div style={{ marginTop: 18 }}>
            <h4 style={{ margin: '0 0 10px', fontSize: 14 }}>Select {label} account</h4>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(picker.accounts || []).map((a) => (
                <li key={a.accountId}>
                  <button
                    type="button"
                    className="ui-btn ui-btn-secondary"
                    style={{ width: '100%', justifyContent: 'flex-start' }}
                    disabled={!!pickingId}
                    onClick={() => selectAccount(a.accountId)}
                  >
                    <strong>{a.descriptiveName || a.accountId}</strong>
                    <span style={{ marginLeft: 8, color: 'var(--muted)', fontSize: 12 }}>{a.accountId}</span>
                    {pickingId === a.accountId ? '…' : ''}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="table-scroll" style={{ marginTop: 18 }}>
          {loading ? (
            <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p>
          ) : !accounts.length ? (
            <p style={{ color: 'var(--muted)', fontSize: 13 }}>
              No {label} accounts yet. Click Connect with Google.
            </p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Account ID</th>
                  <th>Status</th>
                  <th>Last sync</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id}>
                    <td>{a.descriptiveName || '—'}</td>
                    <td className="num" style={{ textAlign: 'left' }}>{a.accountId}</td>
                    <td>
                      {!a.hasRefreshToken ? (
                        <span style={{ color: 'var(--warning)' }}>Needs reconnect</span>
                      ) : a.lastSyncError ? (
                        <span style={{ color: 'var(--danger)' }} title={a.lastSyncError}>
                          Sync error
                          <div style={{ fontWeight: 400, fontSize: 12, maxWidth: 280, whiteSpace: 'normal' }}>
                            {a.lastSyncError}
                          </div>
                        </span>
                      ) : a.isActive ? (
                        <span style={{ color: 'var(--success)' }}>Connected</span>
                      ) : 'Inactive'}
                    </td>
                    <td>{formatSyncAt(a.lastSyncAt)}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <Button type="button" variant="ghost" disabled={busy} onClick={() => reconnect(a.id)}>
                          Reconnect
                        </Button>
                        <Button type="button" variant="danger" disabled={busy} onClick={() => remove(a.id, a.descriptiveName)}>
                          Remove
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
