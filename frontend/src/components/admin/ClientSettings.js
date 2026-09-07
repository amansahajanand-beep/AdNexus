import React, { useEffect, useState } from 'react';
import { TextField } from '../ui/Field';
import Button from '../ui/Button';
import { clientsAPI } from '../../utils/api';
import { getUserFacingMessage, logErrorForDebug } from '../../utils/userFacingError';

const MASK = '••••••••';

export default function ClientSettings() {
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [okMsg, setOkMsg] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [picker, setPicker] = useState(null);
  const [pickingCode, setPickingCode] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await clientsAPI.me();
      setInfo(data);
    } catch (err) {
      logErrorForDebug(err, 'Client settings');
      setError(getUserFacingMessage(err, 'Could not load client settings.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauth = params.get('oauth');
    if (oauth === 'error') {
      setError(`Google OAuth failed${params.get('reason') ? `: ${params.get('reason')}` : ''}. Try Connect with Google again.`);
    } else if (oauth === 'connected') {
      setOkMsg(
        params.get('network')
          ? `GAM connected (network ${params.get('network')}). Inventory sync started — domains, sites, and app IDs will appear shortly.`
          : 'GAM connected. Inventory sync started.'
      );
      load();
    } else if (oauth === 'pick') {
      const sessionId = params.get('session');
      if (sessionId) {
        setConnecting(true);
        clientsAPI.oauthPending(sessionId)
          .then((data) => {
            setPicker({ sessionId: data.sessionId, networks: data.networks || [] });
            setOkMsg('Select a GAM network to continue.');
          })
          .catch((err) => {
            setError(getUserFacingMessage(err, 'Could not load GAM networks.'));
          })
          .finally(() => setConnecting(false));
      }
    }
    if (oauth) {
      const tab = params.get('tab') || 'client';
      window.history.replaceState({}, '', `${window.location.pathname}?tab=${tab}${window.location.hash || ''}`);
    }
  }, []);

  const selectNetwork = async (networkCode) => {
    if (!picker?.sessionId) return;
    setPickingCode(networkCode);
    setError(null);
    try {
      const result = await clientsAPI.oauthSelect(picker.sessionId, { networkCode });
      setPicker(null);
      setInfo(result.client || info);
      setOkMsg('GAM network connected. Inventory sync started — domains, sites, and app IDs will appear after sync.');
      await load();
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not select network.'));
    } finally {
      setPickingCode(null);
    }
  };

  if (loading) return <div className="spinner" />;

  return (
    <div className="client-settings-wrap">
      <div className="client-settings-card">
        <p className="reporting-sub">
          Connection: {info?.hasRefreshToken ? 'Configured' : 'Not connected'}
          {info?.isMock ? ' · mock / not live' : ' · live'}
          {info?.networkCode ? ` · network ${info.networkCode}` : ''}
        </p>
        {error && <div className="login-error">{error}</div>}
        {okMsg && <div className="client-settings-ok">{okMsg}</div>}

        {picker && (
          <div className="filter-card ads-form-card" style={{ marginBottom: 16 }}>
            <div className="filter-card-head">
              <span className="filter-card-title">Select a GAM network</span>
              <Button type="button" variant="ghost" onClick={() => setPicker(null)}>Cancel</Button>
            </div>
            <div className="table-wrap">
              <table className="data-table report-table report-table--comfortable">
                <thead>
                  <tr>
                    <th>Network</th>
                    <th>Network code</th>
                    <th style={{ textAlign: 'right' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {(picker.networks || []).map((n) => (
                    <tr key={n.networkCode}>
                      <td>{n.displayName || n.networkCode}</td>
                      <td className="td-mono">{n.networkCode}</td>
                      <td style={{ textAlign: 'right' }}>
                        <Button
                          type="button"
                          variant="primary"
                          loading={pickingCode === n.networkCode}
                          disabled={!!pickingCode}
                          onClick={() => selectNetwork(n.networkCode)}
                        >
                          Select
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <TextField label="Publisher name" value={info?.name || ''} readOnly />
        <TextField label="GAM network code" value={info?.networkCode || ''} readOnly />
        <TextField label="Google client ID" value={info?.googleClientId || MASK} readOnly />
        <TextField label="Google client secret" value={MASK} readOnly />
        <TextField label="Google refresh token" value={info?.hasRefreshToken ? MASK : 'Not set'} readOnly />
        <Button
          type="button"
          variant="primary"
          loading={connecting}
          onClick={async () => {
            setConnecting(true);
            setError(null);
            try {
              const { url } = await clientsAPI.oauthUrl();
              window.location.href = url;
            } catch (err) {
              logErrorForDebug(err, 'Connect Google');
              setError(getUserFacingMessage(err, 'Could not start Google OAuth.'));
              setConnecting(false);
            }
          }}
        >
          Connect with Google
        </Button>
      </div>
    </div>
  );
}
