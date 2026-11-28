import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { marketIntelAPI } from '../../utils/api';
import PageHeader from '../../components/ui/PageHeader';
import AppBuildingTabs from './AppBuildingTabs';
import AppIcon from '../../components/ads/AppIcon';
import { getUserFacingMessage, logErrorForDebug } from '../../utils/userFacingError';
import '../AdInsights.css';
import '../AdsViewer.css';

const nf = new Intl.NumberFormat();
const fmtDate = (v) => (v ? new Date(v).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const STATUS = [['', 'Any'], ['active', 'Has live ads'], ['inactive', 'No live ads']];
const SORTS = [['live', 'Most live ads'], ['total', 'Most ads overall'], ['new', 'Most new (7d)'], ['recent', 'Recently shown'], ['name', 'Name A–Z']];
const EMPTY = { q: '', status: '', onlyNew: false, hasAds: true, minAds: '', sort: 'live' };

export default function Advertisers() {
  const [f, setF] = useState(EMPTY);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const reqId = useRef(0);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    const params = { q: f.q, status: f.status, minAds: f.minAds, sort: f.sort, onlyNew: f.onlyNew ? '1' : '', hasAds: f.hasAds ? '1' : '' };
    try {
      const r = await marketIntelAPI.advertisers(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '')));
      if (id === reqId.current) setRows(r.advertisers || []);
    } catch (e) {
      if (id !== reqId.current) return;
      logErrorForDebug('Advertisers', e);
      setError(getUserFacingMessage(e, 'Could not load advertisers.'));
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [f]);

  useEffect(() => { const t = setTimeout(load, f.q ? 250 : 0); return () => clearTimeout(t); }, [load, f.q]);

  const set = (patch) => setF((c) => ({ ...c, ...patch }));

  return (
    <div className="ai-page">
      <PageHeader title="Advertisers" subtitle="Every advertiser we collect — size, growth and activity." />
      <AppBuildingTabs />
      <div className="av-layout">
        <aside className="av-filters">
          <div className="av-filters-head">Filters <button type="button" onClick={() => setF(EMPTY)}>Reset</button></div>
          <div className="av-group"><span>Search</span>
            <input type="text" value={f.q} placeholder="Name or AR id" onChange={(e) => set({ q: e.target.value })} />
          </div>
          <div className="av-group"><span>Status</span>
            <div className="av-pills">
              {STATUS.map(([id, label]) => (
                <button key={id || 'any'} type="button" className={`av-pill${f.status === id ? ' is-active' : ''}`} onClick={() => set({ status: id })}>{label}</button>
              ))}
            </div>
          </div>
          <label className="abx-check"><input type="checkbox" checked={f.onlyNew} onChange={(e) => set({ onlyNew: e.target.checked })} /> Only new (first ad in 30 days)</label>
          <label className="abx-check"><input type="checkbox" checked={f.hasAds} onChange={(e) => set({ hasAds: e.target.checked })} /> Has ads</label>
          <div className="av-group"><span>Min total ads</span>
            <input type="number" min="0" value={f.minAds} placeholder="Any" onChange={(e) => set({ minAds: e.target.value })} />
          </div>
          <div className="av-group"><span>Sort</span>
            <select value={f.sort} onChange={(e) => set({ sort: e.target.value })}>
              {SORTS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </div>
        </aside>

        <section className="ai-section">
          <div className="av-bar"><span className="ai-kpi-hint">{loading ? 'Loading…' : `${nf.format(rows.length)} advertiser(s)`}</span></div>
          {error ? <div className="ai-note">{error}</div> : null}
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="left">Advertiser</th><th className="num">Live</th><th className="num">Total</th><th className="num">New · 7d</th>
                  <th className="num">Video</th><th className="num">Avg days</th><th>First ad</th><th>Last shown</th><th />
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const isNew = a.first_ad && Date.now() - new Date(a.first_ad).getTime() < 30 * 86400000;
                  return (
                    <tr key={a.advertiser_id}>
                      <td className="left">
                        <div className="abx-who">
                          <AppIcon src={a.top_app_icon} name={a.top_app_name || a.name} size={34} />
                          <div className="abx-name">
                            <b>{a.name || a.advertiser_id}{isNew ? <> <span className="abx-badge abx-badge--new">New</span></> : null}</b>
                            <small>{a.top_app_name || a.advertiser_id}</small>
                          </div>
                        </div>
                      </td>
                      <td className="num"><span className={`abx-badge ${a.live_ads ? 'abx-badge--live' : 'abx-badge--idle'}`}>{nf.format(a.live_ads)}</span></td>
                      <td className="num">{nf.format(a.total_ads)}</td>
                      <td className="num">{nf.format(a.new_7d)}</td>
                      <td className="num">{a.total_ads ? `${Math.round((a.video / a.total_ads) * 100)}%` : '—'}</td>
                      <td className="num">{a.avg_days || '—'}</td>
                      <td>{fmtDate(a.first_ad)}</td>
                      <td>{fmtDate(a.last_ad)}</td>
                      <td><Link to={`/app-building/viewer?advertiser=${encodeURIComponent(a.advertiser_id)}`}>View ads</Link></td>
                    </tr>
                  );
                })}
                {!loading && !rows.length ? (
                  <tr><td colSpan={9}><div className="ai-kpi-hint" style={{ padding: 16 }}>No advertisers match. Track some in the Ads Viewer and run a sync.</div></td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
