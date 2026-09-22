import React, { useCallback, useEffect, useState } from 'react';
import { useDispatch } from 'react-redux';
import { TextField } from '../ui/Field';
import Button from '../ui/Button';
import { clientsAPI, setToken } from '../../utils/api';
import { authSuccess } from '../../store/actions/authActions';
import { clearReportPages } from '../../store/slices/reportSlice';
import { getUserFacingMessage, logErrorForDebug } from '../../utils/userFacingError';

const MASK = '••••••••';

function applySessionFromResponse(dispatch, data) {
  if (data?.token && data?.user) {
    setToken(data.token);
    dispatch(clearReportPages());
    dispatch(authSuccess(data.user));
  }
}

async function flushReportsBeforeReload() {
  try {
    const { flushPersistedState, purgePersistedState } = await import('../../store/persistorRef');
    await flushPersistedState();
    // Drop sessionStorage report snapshot so reload cannot resurrect the other network.
    await purgePersistedState();
  } catch (_) { /* ignore */ }
}

export default function ClientSettings() {
  const dispatch = useDispatch();
  const [info, setInfo] = useState(null);
  const [networks, setNetworks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [okMsg, setOkMsg] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [picker, setPicker] = useState(null);
  const [pickingCode, setPickingCode] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await clientsAPI.me();
      setInfo(data);
      setNetworks(Array.isArray(data?.networks) ? data.networks : []);
    } catch (err) {
      logErrorForDebug(err, 'Client settings');
      setError(getUserFacingMessage(err, 'Could not load client settings.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

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
  }, [load]);

  const selectNetwork = async (networkCode) => {
    if (!picker?.sessionId) return;
    setPickingCode(networkCode);
    setError(null);
    try {
      const result = await clientsAPI.oauthSelect(picker.sessionId, { networkCode });
      applySessionFromResponse(dispatch, result);
      await flushReportsBeforeReload();
      setPicker(null);
      setOkMsg('GAM network connected. Inventory sync started — reloading for this network…');
      window.location.assign('/dashboard');
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not select network.'));
    } finally {
      setPickingCode(null);
    }
  };

  const startConnect = async () => {
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
  };

  if (loading) return <div className="spinner" />;

  const connectedNetworks = (networks || []).filter((n) => !n.isPending);
  const gamConnected = Boolean(info?.gamConnected) || connectedNetworks.length > 0;

  return (
    <div className="client-settings-wrap">
      <div className="client-settings-card" style={{ maxWidth: 960 }}>
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
                          Connect
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {!gamConnected && !picker && (
          <div className="ads-empty" style={{ marginBottom: 20 }}>
            <p className="ads-empty-title">No Ad Manager connected</p>
            <p className="ads-empty-desc">
              Connect with Google to list your GAM network codes, then choose which network to use.
              Multiple networks show together on the same Dashboard. Domain users can be granted one or more networks.
            </p>
            <Button type="button" variant="primary" loading={connecting} onClick={startConnect}>
              Connect with Google
            </Button>
          </div>
        )}

        {gamConnected && !picker && (
          <>
            <p className="reporting-sub" style={{ marginBottom: 12 }}>
              Status: Connected
              {connectedNetworks.length > 1
                ? ` · ${connectedNetworks.length} networks on one dashboard`
                : (info?.networkCode ? ` · network ${info.networkCode}` : '')}
              {info?.isMock ? ' · mock' : ' · live'}
            </p>

            <div className="filter-card ads-form-card" style={{ marginBottom: 16 }}>
              <div className="filter-card-head">
                <span className="filter-card-title">Linked networks</span>
                <Button type="button" variant="secondary" loading={connecting} onClick={startConnect}>
                  Connect another / refresh
                </Button>
              </div>
              <p className="reporting-sub" style={{ margin: '0 0 12px' }}>
                All linked networks appear together on the Dashboard — no switching required.
              </p>
              <div className="table-wrap">
                <table className="data-table report-table report-table--comfortable">
                  <thead>
                    <tr>
                      <th>Network</th>
                      <th>Name</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {connectedNetworks.map((n) => (
                      <tr key={n.id}>
                        <td className="td-mono">{n.networkCode || '—'}</td>
                        <td>{n.name}</td>
                        <td>{n.hasRefreshToken ? 'Linked' : 'Needs reconnect'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <TextField label="Publisher name" value={info?.name || ''} readOnly />
            <TextField
              label="Linked GAM network codes"
              value={connectedNetworks.map((n) => n.networkCode).filter(Boolean).join(', ') || info?.networkCode || ''}
              readOnly
            />
            <TextField label="Google client ID" value={info?.googleClientId || MASK} readOnly />
            <TextField label="Google refresh token" value={info?.hasRefreshToken ? MASK : 'Not set'} readOnly />
          </>
        )}
      </div>
    </div>
  );
}
