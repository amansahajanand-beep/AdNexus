import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useDispatch } from 'react-redux';
import { adsAPI, sessionAPI } from '../utils/api';
import PageHeader from '../components/ui/PageHeader';
import Button from '../components/ui/Button';
import { Megaphone } from '../components/ui/Icon';
import { getUserFacingMessage, logErrorForDebug } from '../utils/userFacingError';
import { confirmDialog } from '../hooks/useConfirmDialog';
import { authSuccess } from '../store/actions/authActions';

function formatCustomerId(id) {
  const d = String(id || '').replace(/\D/g, '');
  if (d.length !== 10) return id || '—';
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

function formatSyncAt(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

export default function MyAds() {
  const dispatch = useDispatch();
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [okMsg, setOkMsg] = useState(null);
  const [picker, setPicker] = useState(null);
  const [pickingId, setPickingId] = useState(null);

  const refreshSessionUser = useCallback(async () => {
    try {
      const user = await sessionAPI.me();
      dispatch(authSuccess(user));
    } catch {
      /* keep current session */
    }
  }, [dispatch]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await adsAPI.myListAccounts();
      setAccounts(Array.isArray(data?.accounts) ? data.accounts : Array.isArray(data) ? data : []);
    } catch (err) {
      logErrorForDebug(err, 'My Ads accounts');
      setError(getUserFacingMessage(err, 'Could not load your Google Ads accounts.'));
      setAccounts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('ads_oauth');
    if (status === 'error') {
      setError(`Google Ads OAuth failed${params.get('reason') ? `: ${params.get('reason')}` : ''}`);
    } else if (status === 'connected' || status === 'connected_individual') {
      setOkMsg('Google Ads connected successfully.');
      load();
      refreshSessionUser();
    } else if (status === 'pick') {
      const sessionId = params.get('session');
      if (sessionId) {
        setBusy(true);
        adsAPI.myOauthPending(sessionId)
          .then((data) => {
            setPicker({
              sessionId: data.sessionId,
              managers: data.managers || [],
              individuals: data.individuals || [],
            });
            setOkMsg('Select a manager account to continue.');
          })
          .catch((err) => {
            setError(getUserFacingMessage(err, 'Could not load manager accounts from Google.'));
          })
          .finally(() => setBusy(false));
      }
    }
    if (status) {
      params.delete('ads_oauth');
      params.delete('reason');
      params.delete('session');
      const next = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${next ? `?${next}` : ''}${window.location.hash || ''}`);
    }
  }, [load, refreshSessionUser]);

  const mccs = useMemo(() => accounts.filter((a) => a.accountType === 'mcc'), [accounts]);
  const clients = useMemo(() => accounts.filter((a) => a.accountType === 'client'), [accounts]);
  const orphans = useMemo(
    () => clients.filter((c) => !c.parentMccId || !mccs.some((m) => m.id === c.parentMccId)),
    [clients, mccs]
  );

  const connectOAuth = async () => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await adsAPI.myOauthUrl();
      if (!url) {
        setError('Could not start Google Ads OAuth: no redirect URL returned.');
        setBusy(false);
        return;
      }
      window.location.href = url;
    } catch (err) {
      logErrorForDebug(err, 'My Ads connect');
      const detail = err?.technicalMessage || err?.response?.data?.error;
      setError(
        getUserFacingMessage(
          err,
          detail
            ? `Could not start Google Ads OAuth: ${detail}`
            : 'Could not start Google Ads OAuth.'
        )
      );
      setBusy(false);
    }
  };

  const selectPendingAccount = async (customerId) => {
    if (!picker?.sessionId) return;
    setPickingId(customerId);
    setError(null);
    try {
      const result = await adsAPI.myOauthSelect(picker.sessionId, { customerId });
      setPicker(null);
      setOkMsg(
        result.accountType === 'mcc'
          ? `MCC connected. Loaded ${result.childrenCount || 0} partner account(s).`
          : 'Google Ads account connected.'
      );
      await refreshSessionUser();
      await load();
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not select account.'));
    } finally {
      setPickingId(null);
    }
  };

  const reconnect = async (id) => {
    setBusy(true);
    try {
      const { url } = await adsAPI.myAccountOauthUrl(id);
      window.location.href = url;
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not start OAuth.'));
      setBusy(false);
    }
  };

  const disconnect = async (account, childCount = 0) => {
    const isMcc = account.accountType === 'mcc';
    const ok = await confirmDialog({
      title: isMcc ? 'Disconnect manager?' : 'Disconnect account?',
      message: isMcc
        ? (childCount > 0
          ? `This removes the MCC and ${childCount} partner account(s) from your ROI view. Network accounts stay available for admin.`
          : 'This removes the MCC from your ROI view. Network accounts stay available for admin.')
        : 'This removes the account from your ROI view. It is not deleted from the network.',
    });
    if (!ok) return;
    try {
      await adsAPI.myDisconnectAccount(account.id);
      setOkMsg('Account disconnected from your profile.');
      await refreshSessionUser();
      await load();
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not disconnect account.'));
    }
  };

  const syncSpend = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await adsAPI.mySync();
      const syncErrors = Array.isArray(result?.errors) ? result.errors : [];
      setOkMsg(
        syncErrors.length
          ? (result.message || `Synced with ${syncErrors.length} error(s).`)
          : (result.message || 'Spend sync completed.')
      );
      await load();
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not sync spend.'));
    } finally {
      setBusy(false);
    }
  };

  const renderAccountRow = (account, { indent = false, childCount = 0 } = {}) => (
    <tr key={account.id}>
      <td style={indent ? { paddingLeft: 28 } : undefined}>
        {indent ? '└─ ' : ''}
        {account.descriptiveName || formatCustomerId(account.customerId)}
      </td>
      <td className="td-mono">{formatCustomerId(account.customerId)}</td>
      <td>{account.accountType === 'mcc' ? 'Manager (MCC)' : 'Client'}</td>
      <td>
        {account.hasRefreshToken ? 'Connected' : 'Needs reconnect'}
        {account.lastSyncAt ? (
          <div className="reporting-sub" style={{ margin: 0 }}>{formatSyncAt(account.lastSyncAt)}</div>
        ) : null}
      </td>
      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        <Button type="button" variant="secondary" loading={busy} onClick={() => reconnect(account.id)}>
          Reconnect
        </Button>
        {' '}
        <Button type="button" variant="ghost" onClick={() => disconnect(account, childCount)}>
          Disconnect
        </Button>
      </td>
    </tr>
  );

  return (
    <div className="dashboard-page ads-admin-page my-ads-page">
      <PageHeader
        title="My Google Ads"
        subtitle="Connect your Google Ads account so spend can appear in ROI for your assigned domains."
      >
        <div className="admin-panel-actions ads-toolbar">
          {accounts.length > 0 && (
            <Button type="button" variant="secondary" loading={busy} onClick={connectOAuth}>
              Connect another
            </Button>
          )}
          {accounts.length > 0 && (
            <Button type="button" variant="primary" loading={busy} onClick={syncSpend}>
              Sync spend
            </Button>
          )}
          {accounts.length === 0 && !picker && (
            <Button type="button" variant="primary" loading={busy} onClick={connectOAuth}>
              Connect with Google
            </Button>
          )}
        </div>
      </PageHeader>

      {error && <div className="login-error">{error}</div>}
      {okMsg && <div className="client-settings-ok">{okMsg}</div>}

      {picker && (
        <div className="filter-card ads-form-card">
          <div className="filter-card-head">
            <span className="filter-card-title">Select a manager account</span>
            <Button type="button" variant="ghost" onClick={() => setPicker(null)}>Cancel</Button>
          </div>
          <p className="reporting-sub">
            These manager (MCC) accounts are linked to the Google account you signed in with.
          </p>
          {(picker.managers || []).length === 0 && (picker.individuals || []).length === 0 && (
            <div className="ads-empty">
              <p className="ads-empty-title">No accounts found</p>
            </div>
          )}
          <div className="table-wrap">
            <table className="data-table report-table report-table--comfortable">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Customer ID</th>
                  <th>Type</th>
                  <th style={{ textAlign: 'right' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {(picker.managers || []).map((m) => (
                  <tr key={`mcc-${m.customerId}`}>
                    <td>{m.descriptiveName || formatCustomerId(m.customerId)}</td>
                    <td className="td-mono">{formatCustomerId(m.customerId)}</td>
                    <td>Manager (MCC)</td>
                    <td style={{ textAlign: 'right' }}>
                      <Button
                        type="button"
                        variant="primary"
                        loading={pickingId === m.customerId}
                        disabled={!!pickingId}
                        onClick={() => selectPendingAccount(m.customerId)}
                      >
                        Select
                      </Button>
                    </td>
                  </tr>
                ))}
                {(picker.individuals || []).map((m) => (
                  <tr key={`cli-${m.customerId}`}>
                    <td>{m.descriptiveName || formatCustomerId(m.customerId)}</td>
                    <td className="td-mono">{formatCustomerId(m.customerId)}</td>
                    <td>Client</td>
                    <td style={{ textAlign: 'right' }}>
                      <Button
                        type="button"
                        variant="secondary"
                        loading={pickingId === m.customerId}
                        disabled={!!pickingId}
                        onClick={() => selectPendingAccount(m.customerId)}
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

      {!picker && loading && (
        <div className="app-boot" style={{ minHeight: 160 }}><div className="spinner" /></div>
      )}

      {!picker && !loading && accounts.length === 0 && (
        <div className="filter-card ads-form-card ads-empty-card">
          <div className="ads-empty" style={{ padding: '48px 24px', textAlign: 'center' }}>
            <div className="kpi-icon-badge" style={{ margin: '0 auto 16px', width: 48, height: 48 }}>
              <Megaphone size={22} />
            </div>
            <p className="ads-empty-title">No Google Ads account connected yet</p>
            <p className="reporting-sub" style={{ maxWidth: 420, margin: '8px auto 20px' }}>
              Sign in with Google to link a manager or client account you have access to.
              Only accounts you connect will show here.
            </p>
            <Button type="button" variant="primary" loading={busy} onClick={connectOAuth}>
              Connect with Google
            </Button>
          </div>
        </div>
      )}

      {!picker && !loading && accounts.length > 0 && (
        <div className="filter-card ads-form-card">
          <div className="filter-card-head">
            <span className="filter-card-title">Connected accounts</span>
          </div>
          <div className="table-wrap">
            <table className="data-table report-table report-table--comfortable">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Customer ID</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {mccs.map((mcc) => {
                  const children = clients.filter((c) => c.parentMccId === mcc.id);
                  return (
                    <React.Fragment key={mcc.id}>
                      {renderAccountRow(mcc, { childCount: children.length })}
                      {children.map((child) => renderAccountRow(child, { indent: true }))}
                    </React.Fragment>
                  );
                })}
                {orphans.map((acc) => renderAccountRow(acc))}
              </tbody>
            </table>
          </div>
          <p className="reporting-sub" style={{ marginTop: 12 }}>
            Spend from these accounts is used on the ROI page for your assigned domains.
          </p>
        </div>
      )}
    </div>
  );
}
