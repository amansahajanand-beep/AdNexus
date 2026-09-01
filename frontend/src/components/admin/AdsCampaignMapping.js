import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { adsAPI } from '../../utils/api';
import TableSearchBar from '../ui/TableSearchBar';
import SearchableSelect from '../ui/SearchableSelect';
import MultiSelect from '../ui/MultiSelect';
import { getUserFacingMessage, logErrorForDebug } from '../../utils/userFacingError';
import { confirmDialog } from '../../hooks/useConfirmDialog';
import {
  ALL_SENTINEL,
  isAllSelection,
  toAllSelection,
} from '../../utils/inventorySelection';

const PAGE_SIZE = 12;

export default function AdsCampaignMapping({ siteHosts = [], appIds = [] }) {
  const [accounts, setAccounts] = useState([]);
  const [maps, setMaps] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [campaigns, setCampaigns] = useState([]);
  const [selectedCampaignIds, setSelectedCampaignIds] = useState([]);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [form, setForm] = useState({
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
      setSelectedCampaignIds([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setCampaignsLoading(true);
      try {
        const data = await adsAPI.listCampaigns(accountId);
        if (!cancelled) {
          const list = data.campaigns || [];
          setCampaigns(list);
          // Default: select all campaigns for this account
          setSelectedCampaignIds(list.length ? toAllSelection() : []);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setCampaigns([]);
          setSelectedCampaignIds([]);
          setError(getUserFacingMessage(err, 'Could not list campaigns (connect account / sync first).'));
        }
      } finally {
        if (!cancelled) setCampaignsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [accountId]);

  const accountOptions = useMemo(
    () => accounts.map((a) => ({
      value: a.id,
      id: a.id,
      label: a.descriptiveName || a.customerId,
      customerId: a.customerId,
    })),
    [accounts]
  );

  const campaignOptions = useMemo(
    () => campaigns.map((c) => ({
      value: c.campaignId,
      id: c.campaignId,
      label: c.campaignName || c.campaignId,
      campaignName: c.campaignName,
    })),
    [campaigns]
  );

  const targetOptions = useMemo(() => {
    if (form.targetType === 'site') {
      return (siteHosts || []).map((h) => ({
        value: String(h).toLowerCase(),
        id: String(h).toLowerCase(),
        label: h,
      }));
    }
    return (appIds || []).map((a) => ({
      value: String(a).toLowerCase(),
      id: String(a).toLowerCase(),
      label: a,
    }));
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

  const selectedCampaignCount = isAllSelection(selectedCampaignIds)
    ? campaigns.length
    : selectedCampaignIds.filter((id) => id !== ALL_SENTINEL).length;

  const save = async (e) => {
    e.preventDefault();
    if (!accountId) {
      setError('Select an Ads account.');
      return;
    }
    if (!form.targetKey) {
      setError(form.targetType === 'site' ? 'Select a site host.' : 'Select an app ID / package.');
      return;
    }
    const ids = isAllSelection(selectedCampaignIds)
      ? campaigns.map((c) => c.campaignId)
      : selectedCampaignIds.filter((id) => id && id !== ALL_SENTINEL);
    if (!ids.length) {
      setError('Select at least one campaign (all are selected by default).');
      return;
    }

    setBusy(true);
    setError(null);
    setOkMsg(null);
    try {
      const payloadCampaigns = ids.map((id) => {
        const c = campaigns.find((x) => String(x.campaignId) === String(id));
        return {
          campaignId: id,
          campaignName: c?.campaignName || '',
        };
      });
      const res = await adsAPI.saveCampaignMapsBulk({
        adsAccountId: accountId,
        targetType: form.targetType,
        targetKey: form.targetKey,
        campaigns: payloadCampaigns,
      });
      setForm((f) => ({ ...f, targetKey: '' }));
      setOkMsg(`Saved ${res.saved || payloadCampaigns.length} campaign mapping(s).`);
      setPage(1);
      await load();
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not save mapping.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id) => {
    const ok = await confirmDialog({
      title: 'Remove mapping?',
      message: 'Remove this campaign mapping?',
    });
    if (!ok) return;
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
            Select an Ads account — all campaigns are selected by default. Paste names to refine, pick one app/site, then save.
          </p>
        </div>
      </div>

      {error && <div className="login-error">{error}</div>}
      {okMsg && <div className="client-settings-ok">{okMsg}</div>}

      <form className="filter-card ads-form-card" onSubmit={save}>
        <div className="filter-card-head">
          <span className="filter-card-title">New mapping</span>
          <div className="filter-actions">
            <button
              type="submit"
              className="btn-generate"
              disabled={busy || !accountId || !selectedCampaignCount}
            >
              {busy
                ? 'Saving…'
                : `Save mapping${selectedCampaignCount ? ` (${selectedCampaignCount})` : ''}`}
            </button>
          </div>
        </div>
        <div className="filter-grid ads-map-filter-grid">
          <div className="filter-field">
            <label htmlFor="ads-map-account">Ads account</label>
            <SearchableSelect
              id="ads-map-account"
              options={accountOptions}
              value={accountId}
              onChange={(next) => {
                setAccountId(next);
                setForm((f) => ({ ...f, targetKey: f.targetKey }));
              }}
              placeholder="Search or paste account…"
              fieldKeys={['value', 'label', 'id', 'customerId']}
            />
          </div>

          <div className="filter-field">
            <label>Campaigns</label>
            <MultiSelect
              options={campaignOptions}
              value={selectedCampaignIds}
              onChange={setSelectedCampaignIds}
              placeholder="All campaigns selected by default — paste names to refine…"
              disabled={!accountId}
              loading={campaignsLoading}
              searchable
              showSelectAll
              selectAllLabel="Select all campaigns"
            />
          </div>

          <div className="filter-field">
            <label htmlFor="ads-map-target-type">Target type</label>
            <select
              id="ads-map-target-type"
              value={form.targetType}
              onChange={(e) => setForm((f) => ({ ...f, targetType: e.target.value, targetKey: '' }))}
            >
              <option value="app">App</option>
              <option value="site">Site</option>
            </select>
          </div>

          <div className="filter-field">
            <label htmlFor="ads-map-target-key">
              {form.targetType === 'site' ? 'Site host' : 'App ID / package'}
            </label>
            {targetOptions.length > 0 ? (
              <SearchableSelect
                id="ads-map-target-key"
                options={targetOptions}
                value={form.targetKey}
                onChange={(next) => setForm((f) => ({ ...f, targetKey: next }))}
                placeholder={
                  form.targetType === 'site'
                    ? 'Search or paste site host…'
                    : 'Search or paste app ID / package…'
                }
                required
                fieldKeys={['value', 'label', 'id']}
              />
            ) : (
              <input
                id="ads-map-target-key"
                type="text"
                value={form.targetKey}
                onChange={(e) => setForm((f) => ({ ...f, targetKey: e.target.value }))}
                onPaste={(e) => {
                  const pasted = e.clipboardData?.getData('text') || '';
                  if (!pasted.trim()) return;
                  e.preventDefault();
                  setForm((f) => ({ ...f, targetKey: pasted.trim().toLowerCase() }));
                }}
                placeholder={form.targetType === 'site' ? 'Paste example.com' : 'Paste com.example.app'}
                required
              />
            )}
          </div>
        </div>
        {!campaigns.length && accountId && !campaignsLoading && (
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
