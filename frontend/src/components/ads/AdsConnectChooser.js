import React, { useEffect, useState } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { adsAPI } from '../../utils/api';
import { getUserFacingMessage, logErrorForDebug } from '../../utils/userFacingError';

function formatCustomerId(id) {
  const d = String(id || '').replace(/\D/g, '');
  if (d.length !== 10) return id || '—';
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

/**
 * Choose between an already-connected Google Ads login ("Use this account")
 * and a fresh Google OAuth ("Connect with Google").
 * onUsed receives the /ads/logins/use response: either { alreadyConnected, accountIds }
 * or a pending picker session { sessionId, managers, individuals }.
 */
export default function AdsConnectChooser({
  open,
  onClose,
  clientId = null,
  onConnectGoogle,
  onUsed,
  reconnectReturnTo = null,
  title = 'Add Google Ads account',
}) {
  const [logins, setLogins] = useState([]);
  const [loading, setLoading] = useState(false);
  const [usingId, setUsingId] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    adsAPI.logins(clientId)
      .then((res) => { if (!cancelled) setLogins(res?.logins || []); })
      .catch((err) => {
        logErrorForDebug(err, 'Ads logins');
        if (!cancelled) setError(getUserFacingMessage(err, 'Could not load connected Google Ads accounts.'));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, clientId]);

  const useLogin = async (login) => {
    setUsingId(login.id);
    setError(null);
    try {
      const res = await adsAPI.useLogin({ adsAccountId: login.id, sourceClientId: login.sourceClientId }, clientId);
      onUsed?.(res, login);
    } catch (err) {
      logErrorForDebug(err, 'Ads use login');
      setError(getUserFacingMessage(err, 'Could not use that Google Ads account.'));
    } finally {
      setUsingId(null);
    }
  };

  const reconnect = async (login) => {
    setUsingId(login.id);
    setError(null);
    try {
      const { url } = await adsAPI.accountOauthUrl(
        login.id,
        reconnectReturnTo ? { returnTo: reconnectReturnTo } : undefined,
        clientId
      );
      window.location.href = url;
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not start Google sign-in.'));
      setUsingId(null);
    }
  };

  const connect = async () => {
    setConnecting(true);
    setError(null);
    try {
      await onConnectGoogle?.();
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not start Google sign-in.'));
      setConnecting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width={620}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={connecting || !!usingId}>Cancel</Button>
          <Button variant="primary" onClick={connect} loading={connecting} disabled={!!usingId}>
            Connect with Google
          </Button>
        </>
      )}
    >
      <p className="form-note" style={{ marginTop: 0 }}>
        Use a Google Ads account that is already connected, or connect a new one with Google.
      </p>

      {error ? <div className="login-error" style={{ marginBottom: 10 }}>{error}</div> : null}

      {loading ? <div className="spinner" /> : null}

      {!loading && !logins.length ? (
        <p className="muted">No Google Ads accounts connected yet — use Connect with Google.</p>
      ) : null}

      {!loading && logins.length > 0 ? (
        <div className="table-wrap" style={{ maxHeight: 360, overflow: 'auto' }}>
          <table className="data-table report-table report-table--comfortable">
            <thead>
              <tr>
                <th>Account</th>
                <th>Customer ID</th>
                <th>Type</th>
                <th aria-label="Action" />
              </tr>
            </thead>
            <tbody>
              {logins.map((l) => (
                <tr key={`${l.sourceClientId}:${l.id}`}>
                  <td>
                    {l.descriptiveName || l.customerId}
                    {!l.inTarget ? (
                      <span className="muted" style={{ display: 'block', fontSize: 11 }}>Connected in {l.networkName}</span>
                    ) : null}
                    {!l.hasToken ? (
                      <span className="form-error" style={{ display: 'block', fontSize: 11 }}>
                        Google login disconnected — synced spend is kept; reconnect to sync new spend
                      </span>
                    ) : null}
                    {l.hasToken && l.lastSyncError ? (
                      <span className="form-error" style={{ display: 'block', fontSize: 11 }}>Last sync failed — may need reconnect</span>
                    ) : null}
                  </td>
                  <td>{formatCustomerId(l.customerId)}</td>
                  <td>
                    {l.accountType === 'mcc'
                      ? `Manager (MCC)${l.childCount ? ` · ${l.childCount} accounts` : ''}`
                      : 'Account'}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                      {!l.hasToken && l.inTarget ? (
                        <Button
                          variant="ghost"
                          onClick={() => reconnect(l)}
                          disabled={connecting || !!usingId}
                        >
                          Reconnect
                        </Button>
                      ) : null}
                      <Button
                        variant="secondary"
                        onClick={() => useLogin(l)}
                        loading={usingId === l.id}
                        disabled={connecting || (!!usingId && usingId !== l.id) || (!l.inTarget && !l.hasToken)}
                      >
                        Use this account
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Modal>
  );
}
