import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { adsAPI } from '../../utils/api';
import Button from '../ui/Button';
import TableSearchBar from '../ui/TableSearchBar';
import { getUserFacingMessage, logErrorForDebug } from '../../utils/userFacingError';

const PAGE_SIZE = 12;

export default function AdsCampaignMapping({ siteHosts = [], appIds = [] }) {
  const [accounts, setAccounts] = useState([]);
  const [maps, setMaps] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [campaigns, setCampaigns] = useState([]);
  const [form, setForm] = useState({
    campaignId: '',
    campaignName: '',
    targetType: 'app',
    targetKey: '',
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [okMsg, setOkMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [acc, mapData] = await Promise.all([
        adsAPI.listAccounts(),
        adsAPI.listCampaignMaps(),
      ]);
      const clients = (acc.accounts || []).filter((a) => a.accountType === 'client');
      setAccounts(clients);
      setMaps(mapData.maps || []);
      setAccountId((prev) => prev || (clients[0]?.id || ''));
    } catch (err) {
      logErrorForDebug(err, 'Campaign maps');
      setError(getUserFacingMessage(err, 'Could not load campaign maps.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!accountId) {
      setCampaigns([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await adsAPI.listCampaigns(accountId);
        if (!cancelled) {
          setCampaigns(data.campaigns || []);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setCampaigns([]);
          setError(getUserFacingMessage(err, 'Could not list campaigns (connect account / sync first).'));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [accountId]);

  const targetOptions = useMemo(() => {
    if (form.targetType === 'site') {
      return (siteHosts || []).map((h) => ({ id: h, label: h }));
    }
    return (appIds || []).map((a) => ({ id: a, label: a }));
  }, [form.targetType, siteHosts, appIds]);

  const accountNameById = useMemo(() => {
    const m = new Map();
    accounts.forEach((a) => m.set(a.id, a.descriptiveName || a.customerId));
    return m;
  }, [accounts]);

  const filteredMaps = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return maps;
    return maps.filter((m) => {
      const blob = [
        m.accountName,
        m.customerId,
        m.campaignName,
        m.campaignId,
        m.targetType,
        m.targetKey,
        accountNameById.get(m.adsAccountId),
      ].join(' ').toLowerCase();
      return blob.includes(q);
    });
  }, [maps, search, accountNameById]);

  const totalPages = Math.max(1, Math.ceil(filteredMaps.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = filteredMaps.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOkMsg(null);
    try {
      const campaign = campaigns.find((c) => c.campaignId === form.campaignId);
      await adsAPI.saveCampaignMap({
        adsAccountId: accountId,
        campaignId: form.campaignId,
        campaignName: campaign?.campaignName || form.campaignName,
        targetType: form.targetType,
        targetKey: form.targetKey,
      });
      setForm((f) => ({ ...f, campaignId: '', campaignName: '', targetKey: '' }));
      setOkMsg('Mapping saved.');
      setPage(1);
      await load();
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not save mapping.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id) => {
    if (!window.confirm('Remove this campaign mapping?')) return;
    try {
      await adsAPI.deleteCampaignMap(id);
      await load();
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not delete mapping.'));
    }
  };

  if (loading) return <div className="spinner" />;

  return (
    <div className="ads-admin-page">
      <div className="admin-panel-head">
        <div>
          <h3 className="admin-panel-title">Campaign mapping</h3>
          <p className="reporting-sub" style={{ margin: '4px 0 0' }}>
            Map each Google Ads campaign to a site host or app package so spend appears on the correct ROI row.
          </p>
        </div>
      </div>

      {error && <div className="login-error">{error}</div>}
      {okMsg && <div className="client-settings-ok">{okMsg}</div>}

      <form className="filter-card ads-form-card" onSubmit={save}>
        <div className="filter-card-head">
          <span className="filter-card-title">New mapping</span>
          <div className="filter-actions">
            <Button type="submit" loading={busy} disabled={!accountId}>Save mapping</Button>
          </div>
        </div>
        <div className="ads-form-grid ads-map-grid">
          <label className="ui-field">
            <span className="ui-label">Ads account</span>
            <select
              className="ui-input"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              <option value="">Select account</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.descriptiveName || a.customerId}</option>
              ))}
            </select>
          </label>

          <label className="ui-field">
            <span className="ui-label">Campaign</span>
            <select
              className="ui-input"
              value={form.campaignId}
              onChange={(e) => {
                const id = e.target.value;
                const c = campaigns.find((x) => x.campaignId === id);
                setForm((f) => ({
                  ...f,
                  campaignId: id,
                  campaignName: c?.campaignName || '',
                }));
              }}
              required
            >
              <option value="">Select campaign</option>
              {campaigns.map((c) => (
                <option key={c.campaignId} value={c.campaignId}>{c.campaignName || c.campaignId}</option>
              ))}
            </select>
          </label>

          <label className="ui-field">
            <span className="ui-label">Target type</span>
            <select
              className="ui-input"
              value={form.targetType}
              onChange={(e) => setForm((f) => ({ ...f, targetType: e.target.value, targetKey: '' }))}
            >
              <option value="app">App</option>
              <option value="site">Site</option>
            </select>
          </label>

          <label className="ui-field">
            <span className="ui-label">{form.targetType === 'site' ? 'Site host' : 'App ID / package'}</span>
            {targetOptions.length > 0 ? (
              <select
                className="ui-input"
                value={form.targetKey}
                onChange={(e) => setForm((f) => ({ ...f, targetKey: e.target.value }))}
                required
              >
                <option value="">Select…</option>
                {targetOptions.map((o) => (
                  <option key={o.id} value={String(o.id).toLowerCase()}>{o.label}</option>
                ))}
              </select>
            ) : (
              <input
                className="ui-input"
                value={form.targetKey}
                onChange={(e) => setForm((f) => ({ ...f, targetKey: e.target.value }))}
                placeholder={form.targetType === 'site' ? 'example.com' : 'com.example.app'}
                required
              />
            )}
          </label>
        </div>
        {!campaigns.length && accountId && (
          <p className="form-note" style={{ marginTop: 10 }}>
            No campaigns listed yet — connect the account and run <strong>Sync spend</strong> on Google Ads accounts.
          </p>
        )}
      </form>

      <div className="filter-card ads-section-card">
        <div className="filter-card-head">
          <span className="filter-card-title">Saved mappings</span>
          <div className="filter-actions">
            <TableSearchBar
              value={search}
              onChange={setSearch}
              onPageReset={() => setPage(1)}
              placeholder="Search campaign / target…"
            />
          </div>
        </div>
        <div className="table-wrap">
          <table className="data-table responsive-table admin-table report-table report-table--comfortable">
            <thead>
              <tr>
                <th>Account</th>
                <th>Campaign</th>
                <th>Type</th>
                <th>Target</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((m) => (
                <tr key={m.id}>
                  <td data-label="Account">{m.accountName || m.customerId || accountNameById.get(m.adsAccountId) || '—'}</td>
                  <td data-label="Campaign">
                    <div className="ads-campaign-cell">
                      <span className="td-name">{m.campaignName || m.campaignId}</span>
                      {m.campaignName && m.campaignId && (
                        <span className="muted td-mono ads-campaign-id">{m.campaignId}</span>
                      )}
                    </div>
                  </td>
                  <td data-label="Type">
                    <span className={`ads-badge ads-type-${m.targetType}`}>{m.targetType}</span>
                  </td>
                  <td className="td-mono" data-label="Target">{m.targetKey}</td>
                  <td data-label="Actions">
                    <div className="row-actions">
                      <button type="button" className="link-action danger" onClick={() => remove(m.id)}>
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {!pageRows.length && (
                <tr>
                  <td colSpan={5} className="ads-table-empty">
                    {search.trim()
                      ? 'No mappings match your search.'
                      : 'No campaign mappings yet. Create one above.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {filteredMaps.length > 0 && (
          <div className="pagination">
            <span className="pag-info">
              Page {safePage} of {totalPages} · {filteredMaps.length} mapping{filteredMaps.length === 1 ? '' : 's'}
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
