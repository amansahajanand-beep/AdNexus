import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { mappingAPI } from '../../utils/api';
import Button from '../ui/Button';
import { getUserFacingMessage, logErrorForDebug } from '../../utils/userFacingError';
import { confirmDialog } from '../../hooks/useConfirmDialog';
import { showToast } from '../../hooks/useToast';

const NOUN = { adsense: 'sites', admob: 'apps', gam: 'sites and apps' };
const CONFIDENCE = {
  high: 'Likely',
  medium: 'Probable',
  low: 'Unsure',
  none: 'No match',
};

const rowKey = (s) => `${s.adsAccountId}:${s.campaignId}`;
const money = (v) => Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });

/** Rows are pre-ticked only when the match is likely or probable. */
function initialRows(suggestions) {
  const rows = {};
  for (const s of suggestions) {
    rows[rowKey(s)] = {
      checked: Boolean(s.target) && (s.confidence === 'high' || s.confidence === 'medium'),
      targetKey: s.target?.key || '',
    };
  }
  return rows;
}

/**
 * Admin: link Google Ads campaigns to the site or app they promote, so their spend counts toward ROI.
 * Suggestions come from name matching, with AI settling the unclear ones when it is turned on.
 */
export default function CampaignMappingPanel({ product, clientId = null }) {
  const [data, setData] = useState(null);
  const [maps, setMaps] = useState([]);
  const [rows, setRows] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [applying, setApplying] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const noun = NOUN[product] || 'sites and apps';

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [suggest, saved] = await Promise.all([
        mappingAPI.suggest({ product }, clientId),
        mappingAPI.listMaps(clientId).catch(() => ({ maps: [] })),
      ]);
      setData(suggest);
      setRows(initialRows(suggest.suggestions || []));
      setMaps(saved.maps || []);
    } catch (err) {
      logErrorForDebug(err, 'Campaign mapping suggestions');
      setError(getUserFacingMessage(err, 'Could not load campaign suggestions.'));
    } finally {
      setLoading(false);
    }
  }, [product, clientId]);

  useEffect(() => { load(); }, [load]);

  const targetByKey = useMemo(() => new Map((data?.targets || []).map((t) => [t.key, t])), [data]);
  const suggestions = data?.suggestions || [];
  const selected = suggestions.filter((s) => rows[rowKey(s)]?.checked && rows[rowKey(s)]?.targetKey);

  const update = (s, patch) => setRows((prev) => ({ ...prev, [rowKey(s)]: { ...prev[rowKey(s)], ...patch } }));
  const chooseTarget = (s, targetKey) => update(s, { targetKey, checked: Boolean(targetKey) });

  const apply = async () => {
    setApplying(true);
    setError(null);
    try {
      const groups = new Map();
      for (const s of selected) {
        const target = targetByKey.get(rows[rowKey(s)].targetKey) || s.target;
        if (!target) continue;
        const k = `${s.adsAccountId}|${target.type}|${target.key}`;
        if (!groups.has(k)) groups.set(k, { adsAccountId: s.adsAccountId, targetType: target.type, targetKey: target.key, campaigns: [] });
        groups.get(k).campaigns.push({ campaignId: s.campaignId, campaignName: s.campaignName });
      }
      let saved = 0;
      for (const group of groups.values()) {
        const res = await mappingAPI.saveBulk(group, clientId);
        saved += res.saved || group.campaigns.length;
      }
      showToast({ message: `Saved ${saved} campaign mapping${saved === 1 ? '' : 's'}. ROI now counts their spend.`, replaceKey: 'cmp-save' });
      await load();
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not save the mappings.'));
    } finally {
      setApplying(false);
    }
  };

  const removeMap = async (m) => {
    const ok = await confirmDialog({ title: 'Remove mapping?', message: `Remove the mapping for “${m.campaignName || m.campaignId}”?` });
    if (!ok) return;
    try {
      await mappingAPI.deleteMap(m.id, clientId);
      await load();
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not remove the mapping.'));
    }
  };

  const ai = data?.stats?.ai;

  return (
    <div className="ads-admin-page cmp-panel">
      <div className="admin-panel-head">
        <div>
          <h3 className="admin-panel-title">Campaign mapping</h3>
          <p className="reporting-sub" style={{ margin: '4px 0 0' }}>
            Link Google Ads campaigns to the {noun} they promote so their spend counts toward ROI.
            App campaigns that carry a store ID match on their own.
          </p>
        </div>
        <div className="admin-panel-actions ads-toolbar">
          <Button type="button" variant="secondary" loading={loading} onClick={load}>Find suggestions</Button>
          <Button type="button" variant="primary" loading={applying} disabled={!selected.length} onClick={apply}>
            {selected.length ? `Save ${selected.length} mapping${selected.length === 1 ? '' : 's'}` : 'Save mappings'}
          </Button>
        </div>
      </div>

      {error ? <div className="login-error" role="alert" style={{ marginBottom: 12 }}>{error}</div> : null}

      <div className="filter-card">
        <div className="filter-card-head">
          <span className="filter-card-title">
            Campaigns without a mapping
            {data ? ` · ${data.stats.unmappedCampaigns}` : ''}
          </span>
          {ai?.used ? <span className="cmp-ai-note">AI helped with {ai.asked} unclear campaign{ai.asked === 1 ? '' : 's'}</span> : null}
          {ai?.error ? <span className="cmp-ai-note">AI was unavailable; showing name matches only</span> : null}
        </div>

        {loading && !data ? <p className="reporting-sub">Looking at your campaigns…</p> : null}

        {data && !data.targets.length ? (
          <p className="form-note">
            No {noun} found yet. Connect the account and let it sync first, then come back.
          </p>
        ) : null}

        {data && data.targets.length && !suggestions.length ? (
          <p className="form-note">Every campaign with spend is already mapped or matches on its own.</p>
        ) : null}

        {suggestions.length ? (
          <div className="table-wrap">
            <table className="data-table responsive-table admin-table report-table report-table--comfortable">
              <thead>
                <tr>
                  <th style={{ width: 36 }} aria-label="Select" />
                  <th>Campaign</th>
                  <th style={{ textAlign: 'right' }}>Spend (90 days)</th>
                  <th>Maps to</th>
                  <th>Match</th>
                </tr>
              </thead>
              <tbody>
                {suggestions.map((s) => {
                  const state = rows[rowKey(s)] || { checked: false, targetKey: '' };
                  const near = [s.target, ...s.alternatives].filter(Boolean);
                  const nearKeys = new Set(near.map((t) => t.key));
                  const rest = (data.targets || []).filter((t) => !nearKeys.has(t.key));
                  return (
                    <tr key={rowKey(s)}>
                      <td data-label="Select">
                        <input
                          type="checkbox"
                          checked={state.checked}
                          disabled={!state.targetKey}
                          onChange={(e) => update(s, { checked: e.target.checked })}
                          aria-label={`Map ${s.campaignName}`}
                        />
                      </td>
                      <td data-label="Campaign">
                        <div className="cmp-name">{s.campaignName}</div>
                        <div className="cmp-sub">{s.accountName}</div>
                      </td>
                      <td data-label="Spend" style={{ textAlign: 'right' }} className="td-mono">{money(s.spend)}</td>
                      <td data-label="Maps to">
                        <select
                          className="ui-input cmp-select"
                          value={state.targetKey}
                          onChange={(e) => chooseTarget(s, e.target.value)}
                          aria-label={`Target for ${s.campaignName}`}
                        >
                          <option value="">Choose…</option>
                          {near.length ? (
                            <optgroup label="Closest">
                              {near.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                            </optgroup>
                          ) : null}
                          {rest.length ? (
                            <optgroup label={`All ${noun}`}>
                              {rest.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                            </optgroup>
                          ) : null}
                        </select>
                      </td>
                      <td data-label="Match">
                        <span className={`cmp-conf ${s.confidence}`}>{CONFIDENCE[s.confidence] || CONFIDENCE.none}</span>
                        {s.source === 'ai' ? <span className="cmp-src">AI</span> : null}
                        {s.reason ? <div className="cmp-sub">{s.reason}</div> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      <div className="filter-card" style={{ marginTop: 12 }}>
        <div className="filter-card-head">
          <button type="button" className="filter-card-title filter-card-toggle" onClick={() => setShowSaved((v) => !v)} aria-expanded={showSaved}>
            Saved mappings · {maps.length} {showSaved ? '▾' : '▸'}
          </button>
        </div>
        {showSaved ? (
          maps.length ? (
            <div className="table-wrap">
              <table className="data-table responsive-table admin-table report-table report-table--comfortable">
                <thead>
                  <tr><th>Campaign</th><th>Account</th><th>Maps to</th><th style={{ textAlign: 'right' }}>Actions</th></tr>
                </thead>
                <tbody>
                  {maps.map((m) => (
                    <tr key={m.id}>
                      <td data-label="Campaign">{m.campaignName || m.campaignId}</td>
                      <td data-label="Account">{m.accountName || m.customerId}</td>
                      <td data-label="Maps to"><span className={`ads-badge ads-type-${m.targetType}`}>{m.targetType}</span> {m.targetKey}</td>
                      <td data-label="Actions" style={{ textAlign: 'right' }}>
                        <Button type="button" variant="ghost" onClick={() => removeMap(m)}>Remove</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="form-note">No mappings saved yet.</p>
        ) : null}
      </div>
    </div>
  );
}
