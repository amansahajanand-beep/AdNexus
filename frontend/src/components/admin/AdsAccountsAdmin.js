import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { adsAPI } from '../../utils/api';
import { TextField } from '../ui/Field';
import Button from '../ui/Button';
import TableSearchBar from '../ui/TableSearchBar';
import { getUserFacingMessage, logErrorForDebug } from '../../utils/userFacingError';
import { confirmDialog } from '../../hooks/useConfirmDialog';

const PAGE_SIZE = 10;

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

const EMPTY_INDIVIDUAL = {
  customerId: '',
  descriptiveName: '',
  loginCustomerId: '',
  refreshToken: '',
};

const EMPTY_MCC = {
  customerId: '',
  descriptiveName: '',
  refreshToken: '',
};

export default function AdsAccountsAdmin() {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [okMsg, setOkMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showIndividual, setShowIndividual] = useState(false);
  const [showMccForm, setShowMccForm] = useState(false);
  const [form, setForm] = useState(EMPTY_INDIVIDUAL);
  const [mccForm, setMccForm] = useState(EMPTY_MCC);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await adsAPI.listAccounts();
      setAccounts(data.accounts || []);
    } catch (err) {
      logErrorForDebug(err, 'Ads accounts');
      setError(getUserFacingMessage(err, 'Could not load Google Ads accounts. Restart the backend if /api/ads is missing.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('ads_oauth') === 'error') {
      setError(`Google Ads OAuth failed${params.get('reason') ? `: ${params.get('reason')}` : ''}`);
    } else if (params.get('ads_oauth') === 'connected' || params.get('ads_oauth') === 'connected_individual') {
      setOkMsg('Google Ads connected successfully.');
      load();
    }
  }, [load]);

  const mccs = accounts.filter((a) => a.accountType === 'mcc');
  const clients = accounts.filter((a) => a.accountType === 'client');
  const individualClients = useMemo(
    () => clients.filter((c) => !c.parentMccId),
    [clients]
  );

  const filteredIndividuals = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return individualClients;
    return individualClients.filter((a) => {
      const blob = [
        a.descriptiveName,
        a.customerId,
        formatCustomerId(a.customerId),
        a.hasRefreshToken ? 'connected' : 'needs',
      ].join(' ').toLowerCase();
      return blob.includes(q);
    });
  }, [individualClients, search]);

  const totalPages = Math.max(1, Math.ceil(filteredIndividuals.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = filteredIndividuals.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const saveIndividual = async ({ startOAuth = false } = {}) => {
    setBusy(true);
    setError(null);
    setOkMsg(null);
    try {
      const result = await adsAPI.createIndividual({
        customerId: form.customerId,
        descriptiveName: form.descriptiveName,
        loginCustomerId: form.loginCustomerId || undefined,
        refreshToken: form.refreshToken || undefined,
        startOAuth,
      });
      if (startOAuth && result?.url) {
        window.location.href = result.url;
        return;
      }
      if (result?.error) {
        setError(result.error);
      } else {
        setOkMsg(result?.message || 'Account saved.');
        setForm(EMPTY_INDIVIDUAL);
        setShowIndividual(false);
        await load();
      }
    } catch (err) {
      logErrorForDebug(err, 'Add individual Ads');
      const detail = err?.technicalMessage || err?.response?.data?.error;
      setError(
        detail && !/request failed|axios/i.test(String(detail))
          ? detail
          : getUserFacingMessage(err, 'Could not save Ads account.')
      );
    } finally {
      setBusy(false);
    }
  };

  const saveMcc = async ({ startOAuth = false } = {}) => {
    setBusy(true);
    setError(null);
    setOkMsg(null);
    try {
      const result = await adsAPI.createMcc({
        customerId: mccForm.customerId,
        descriptiveName: mccForm.descriptiveName,
        refreshToken: mccForm.refreshToken || undefined,
        startOAuth,
      });
      if (startOAuth && result?.url) {
        window.location.href = result.url;
        return;
      }
      setOkMsg(result?.message || 'MCC saved.');
      setMccForm(EMPTY_MCC);
      setShowMccForm(false);
      await load();
    } catch (err) {
      logErrorForDebug(err, 'Save MCC');
      const detail = err?.technicalMessage || err?.response?.data?.error;
      setError(detail || getUserFacingMessage(err, 'Could not save MCC.'));
    } finally {
      setBusy(false);
    }
  };

  const connectMccOAuth = async () => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await adsAPI.mccOauthUrl();
      window.location.href = url;
    } catch (err) {
      logErrorForDebug(err, 'Connect MCC');
      setError(getUserFacingMessage(err, 'Could not start MCC OAuth.'));
      setBusy(false);
    }
  };

  const patchAccount = async (id, patch) => {
    try {
      await adsAPI.updateAccount(id, patch);
      await load();
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not update account.'));
    }
  };

  const setChildrenIncludeInRoi = async (childAccounts, includeInRoi) => {
    if (!childAccounts?.length) return;
    setBusy(true);
    setError(null);
    try {
      const toUpdate = childAccounts.filter((c) => !!c.includeInRoi !== includeInRoi);
      await Promise.all(toUpdate.map((c) => adsAPI.updateAccount(c.id, { includeInRoi })));
      setOkMsg(
        includeInRoi
          ? `Included ${childAccounts.length} child account(s) in ROI.`
          : `Excluded ${childAccounts.length} child account(s) from ROI.`
      );
      await load();
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not update Include in ROI.'));
    } finally {
      setBusy(false);
    }
  };

  const connectAccount = async (id) => {
    setBusy(true);
    try {
      const { url } = await adsAPI.accountOauthUrl(id);
      window.location.href = url;
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not start OAuth.'));
      setBusy(false);
    }
  };

  const removeAccount = async (id) => {
    const ok = await confirmDialog({
      title: 'Remove account?',
      message: 'Remove this Google Ads account link?',
    });
    if (!ok) return;
    try {
      await adsAPI.deleteAccount(id);
      await load();
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not delete account.'));
    }
  };

  const syncAll = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await adsAPI.syncAll();
      const syncErrors = Array.isArray(result?.errors) ? result.errors : [];
      if (syncErrors.length) {
        setError(syncErrors.map((e) => e.error || e.message).filter(Boolean).join(' · ') || 'Ads sync failed for one or more accounts.');
      }
      if (result?.queued) {
        setOkMsg(result.message || `Spend sync queued for ${result.accounts || 0} account(s). This can take several minutes.`);
      } else {
        setOkMsg(`Synced ${result.total || 0} spend row(s) across ${result.accounts || 0} account(s).`);
      }
      await load();
    } catch (err) {
      setError(getUserFacingMessage(err, 'Ads sync failed.'));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="spinner" />;

  return (
    <div className="ads-admin-page">
      <div className="admin-panel-head">
        <div>
          <h3 className="admin-panel-title">Google Ads accounts</h3>
          <p className="reporting-sub" style={{ margin: '4px 0 0' }}>
            Add accounts with customer ID + optional refresh token. Set <code>GOOGLE_ADS_DEVELOPER_TOKEN</code> for spend sync.
          </p>
        </div>
        <div className="admin-panel-actions ads-toolbar">
          <Button
            type="button"
            variant="primary"
            onClick={() => { setShowIndividual(true); setShowMccForm(false); }}
          >
            Add account
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => { setShowMccForm(true); setShowIndividual(false); }}
          >
            Add MCC
          </Button>
          <Button type="button" variant="ghost" loading={busy} onClick={connectMccOAuth}>
            Connect MCC
          </Button>
          <Button type="button" variant="secondary" loading={busy} onClick={syncAll}>
            Sync spend
          </Button>
        </div>
      </div>

      {error && <div className="login-error">{error}</div>}
      {okMsg && <div className="client-settings-ok">{okMsg}</div>}

      {showIndividual && (
        <form
          className="filter-card ads-form-card"
          onSubmit={(e) => {
            e.preventDefault();
            saveIndividual({ startOAuth: false });
          }}
        >
          <div className="filter-card-head">
            <span className="filter-card-title">Add individual account</span>
            <div className="filter-actions">
              <Button type="submit" loading={busy}>Save account</Button>
              <Button type="button" variant="secondary" loading={busy} onClick={() => saveIndividual({ startOAuth: true })}>
                Save &amp; Connect
              </Button>
              <Button type="button" variant="ghost" onClick={() => setShowIndividual(false)}>Cancel</Button>
            </div>
          </div>
          <p className="reporting-sub">No Google redirect required unless you choose Connect.</p>
          <div className="ads-form-grid">
            <TextField
              label="Account label"
              value={form.descriptiveName}
              onChange={(v) => setForm((f) => ({ ...f, descriptiveName: v }))}
              placeholder="Acc 1"
            />
            <TextField
              label="Customer ID"
              value={form.customerId}
              onChange={(v) => setForm((f) => ({ ...f, customerId: v }))}
              placeholder="123-456-7890"
              required
            />
            <TextField
              label="MCC / login customer ID"
              value={form.loginCustomerId}
              onChange={(v) => setForm((f) => ({ ...f, loginCustomerId: v }))}
              placeholder="Optional"
            />
            <TextField
              label="Refresh token"
              type="password"
              value={form.refreshToken}
              onChange={(v) => setForm((f) => ({ ...f, refreshToken: v }))}
              placeholder="Optional"
            />
          </div>
        </form>
      )}

      {showMccForm && (
        <form
          className="filter-card ads-form-card"
          onSubmit={(e) => {
            e.preventDefault();
            saveMcc({ startOAuth: false });
          }}
        >
          <div className="filter-card-head">
            <span className="filter-card-title">Add MCC (manager)</span>
            <div className="filter-actions">
              <Button type="submit" loading={busy}>Save MCC</Button>
              <Button type="button" variant="secondary" loading={busy} onClick={() => saveMcc({ startOAuth: true })}>
                Save &amp; Connect
              </Button>
              <Button type="button" variant="ghost" onClick={() => setShowMccForm(false)}>Cancel</Button>
            </div>
          </div>
          <div className="ads-form-grid">
            <TextField
              label="MCC label"
              value={mccForm.descriptiveName}
              onChange={(v) => setMccForm((f) => ({ ...f, descriptiveName: v }))}
              placeholder="Main MCC"
            />
            <TextField
              label="MCC customer ID"
              value={mccForm.customerId}
              onChange={(v) => setMccForm((f) => ({ ...f, customerId: v }))}
              placeholder="111-222-3333"
              required
            />
            <TextField
              label="Refresh token"
              type="password"
              value={mccForm.refreshToken}
              onChange={(v) => setMccForm((f) => ({ ...f, refreshToken: v }))}
              placeholder="Optional"
            />
          </div>
        </form>
      )}

      <div className="filter-card ads-section-card">
        <div className="filter-card-head">
          <span className="filter-card-title">MCC connections</span>
          <span className="filter-section-hint">{mccs.length} manager{mccs.length === 1 ? '' : 's'}</span>
        </div>
        {!mccs.length && (
          <div className="ads-empty">
            <p className="ads-empty-title">No MCC linked</p>
            <p className="ads-empty-desc">Add an MCC or connect via Google, then refresh children.</p>
          </div>
        )}
        {mccs.map((mcc) => {
          const children = clients.filter((c) => c.parentMccId === mcc.id);
          return (
            <div key={mcc.id} className="ads-mcc-card">
              <div className="ads-mcc-head">
                <div className="ads-mcc-identity">
                  <strong className="ads-mcc-name">{mcc.descriptiveName || 'MCC'}</strong>
                  <span className="td-mono ads-mcc-id">{formatCustomerId(mcc.customerId)}</span>
                  <span className={`ads-badge ${mcc.hasRefreshToken ? 'ok' : 'warn'}`}>
                    {mcc.hasRefreshToken ? 'Connected' : 'Needs token'}
                  </span>
                </div>
                <div className="row-actions">
                  {!mcc.hasRefreshToken && (
                    <button type="button" className="link-action" onClick={() => connectAccount(mcc.id)}>
                      Connect with Google
                    </button>
                  )}
                  <button
                    type="button"
                    className="link-action"
                    disabled={!mcc.hasRefreshToken}
                    title={mcc.hasRefreshToken ? 'Fetch client accounts under this MCC' : 'Connect with Google first'}
                    onClick={async () => {
                      if (!mcc.hasRefreshToken) {
                        setError('Connect this MCC with Google first, then refresh children.');
                        return;
                      }
                      try {
                        await adsAPI.refreshChildren(mcc.id);
                        setOkMsg('Child accounts refreshed.');
                        await load();
                      } catch (err) {
                        setError(getUserFacingMessage(err, 'Could not refresh children.'));
                      }
                    }}
                  >
                    Refresh children
                  </button>
                  <button type="button" className="link-action danger" onClick={() => removeAccount(mcc.id)}>
                    Remove
                  </button>
                </div>
              </div>
              {children.length > 0 && (
                <>
                  <div className="ads-children-toolbar">
                    <span className="muted">
                      {children.filter((c) => c.includeInRoi).length} of {children.length} in ROI
                    </span>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="link-action"
                        disabled={busy || children.every((c) => c.includeInRoi)}
                        onClick={() => setChildrenIncludeInRoi(children, true)}
                      >
                        Select all
                      </button>
                      <button
                        type="button"
                        className="link-action"
                        disabled={busy || children.every((c) => !c.includeInRoi)}
                        onClick={() => setChildrenIncludeInRoi(children, false)}
                      >
                        Clear all
                      </button>
                    </div>
                  </div>
                  <div className="table-wrap ads-nested-table">
                    <table className="data-table report-table report-table--compact">
                      <thead>
                        <tr>
                          <th>Child account</th>
                          <th>Customer ID</th>
                          <th>
                            <label className="ads-check ads-check-header">
                              <input
                                type="checkbox"
                                checked={children.length > 0 && children.every((c) => c.includeInRoi)}
                                ref={(el) => {
                                  if (el) {
                                    const n = children.filter((c) => c.includeInRoi).length;
                                    el.indeterminate = n > 0 && n < children.length;
                                  }
                                }}
                                disabled={busy}
                                onChange={(e) => setChildrenIncludeInRoi(children, e.target.checked)}
                                title="Select all for ROI"
                              />
                              <span>In ROI</span>
                            </label>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {children.map((child) => (
                          <tr key={child.id}>
                            <td data-label="Child">{child.descriptiveName || formatCustomerId(child.customerId)}</td>
                            <td className="td-mono" data-label="Customer ID">{formatCustomerId(child.customerId)}</td>
                            <td data-label="In ROI">
                              <label className="ads-check">
                                <input
                                  type="checkbox"
                                  checked={!!child.includeInRoi}
                                  disabled={busy}
                                  onChange={(e) => patchAccount(child.id, { includeInRoi: e.target.checked })}
                                />
                                <span>{child.includeInRoi ? 'Yes' : 'No'}</span>
                              </label>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              {!children.length && (
                <p className="muted ads-mcc-hint">
                  {mcc.hasRefreshToken
                    ? 'No children yet — click Refresh children. If it fails, your developer token may still be Test-only (need Basic/Standard access).'
                    : 'No children yet — Connect with Google first, then Refresh children.'}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="filter-card ads-section-card">
        <div className="filter-card-head">
          <span className="filter-card-title">Individual accounts</span>
          <div className="filter-actions">
            <TableSearchBar
              value={search}
              onChange={setSearch}
              onPageReset={() => setPage(1)}
              placeholder="Search label / customer ID…"
            />
          </div>
        </div>
        <div className="table-wrap">
          <table className="data-table responsive-table admin-table report-table report-table--comfortable">
            <thead>
              <tr>
                <th>Label</th>
                <th>Customer ID</th>
                <th>In ROI</th>
                <th>Status</th>
                <th>Last sync</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((a) => (
                <tr key={a.id}>
                  <td data-label="Label">
                    <input
                      className="ui-input ads-inline-input"
                      defaultValue={a.descriptiveName}
                      aria-label="Account label"
                      onBlur={(e) => {
                        if (e.target.value !== a.descriptiveName) {
                          patchAccount(a.id, { descriptiveName: e.target.value });
                        }
                      }}
                    />
                  </td>
                  <td className="td-mono" data-label="Customer ID">{formatCustomerId(a.customerId)}</td>
                  <td data-label="In ROI">
                    <label className="ads-check">
                      <input
                        type="checkbox"
                        checked={!!a.includeInRoi}
                        onChange={(e) => patchAccount(a.id, { includeInRoi: e.target.checked })}
                      />
                      <span>{a.includeInRoi ? 'Yes' : 'No'}</span>
                    </label>
                  </td>
                  <td data-label="Status">
                    <span className={`ads-badge ${a.hasRefreshToken ? 'ok' : 'warn'}`}>
                      {a.hasRefreshToken ? 'Connected' : 'Needs token'}
                    </span>
                    {a.lastSyncError && (
                      <div className="ads-sync-err" title={a.lastSyncError}>{a.lastSyncError}</div>
                    )}
                  </td>
                  <td className="muted" data-label="Last sync">{formatSyncAt(a.lastSyncAt)}</td>
                  <td data-label="Actions">
                    <div className="row-actions">
                      {!a.hasRefreshToken && (
                        <button type="button" className="link-action" onClick={() => connectAccount(a.id)}>
                          Connect
                        </button>
                      )}
                      <button type="button" className="link-action danger" onClick={() => removeAccount(a.id)}>
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {!pageRows.length && (
                <tr>
                  <td colSpan={6} className="ads-table-empty">
                    {search.trim() ? 'No accounts match your search.' : 'No individual accounts yet. Click Add account.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {filteredIndividuals.length > 0 && (
          <div className="pagination">
            <span className="pag-info">
              Page {safePage} of {totalPages} · {filteredIndividuals.length} account{filteredIndividuals.length === 1 ? '' : 's'}
            </span>
            <div className="pag-btns">
              <button type="button" className="pag-btn" disabled={safePage <= 1} onClick={() => setPage(1)}>«</button>
              <button type="button" className="pag-btn" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>‹</button>
              <button type="button" className="pag-btn" disabled={safePage >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>›</button>
              <button type="button" className="pag-btn" disabled={safePage >= totalPages} onClick={() => setPage(totalPages)}>»</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
