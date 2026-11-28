import React, { useCallback, useEffect, useRef, useState } from 'react';
import { marketIntelAPI } from '../utils/api';
import { useAuth } from '../store/useAuth';
import PageHeader from '../components/ui/PageHeader';
import AppBuildingTabs from './appBuilding/AppBuildingTabs';
import CreativeCard from '../components/ads/CreativeCard';
import Button from '../components/ui/Button';
import { getUserFacingMessage, logErrorForDebug } from '../utils/userFacingError';
import './AdInsights.css';
import './AdsViewer.css';

const WINNER_DAYS = 60; // an ad still running after this long is tagged "Winner"

const SEEN = [['', 'Any'], ['today', 'Today'], ['3d', '3d'], ['7d', '7d'], ['30d', '30d'], ['90d', '90d']];
const FIRST = [['', 'Any'], ['24h', '24h'], ['3d', '3d'], ['7d', '7d'], ['30d', '30d']];
const FORMATS = [['', 'All'], ['video', 'Video'], ['image', 'Image'], ['text', 'Text']];
const STATUS = [['', 'All'], ['active', 'Active'], ['inactive', 'Inactive']];
const SORTS = [['new', 'Newest first'], ['recent', 'Recently shown'], ['longest', 'Longest running']];

const EMPTY = { q: '', seen: '', first: '', format: '', status: '', advertiser: '', domain: '', minDays: '', sort: 'new', page: 1 };

const nf = new Intl.NumberFormat();
const fmtDate = (v) => (v ? new Date(v).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

function Pills({ value, options, onChange }) {
  return (
    <div className="av-pills">
      {options.map(([id, label]) => (
        <button key={id || 'any'} type="button" className={`av-pill${value === id ? ' is-active' : ''}`} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function Kpi({ label, value, hint }) {
  return (
    <div className="gam-overview-metric kpi-tile">
      <span className="gam-overview-metric-value">{value}</span>
      <span className="gam-overview-metric-label">{label}</span>
      {hint ? <span className="gam-overview-metric-hint">{hint}</span> : null}
    </div>
  );
}

export default function AdsViewer({
  title = 'Ads Viewer',
  subtitle = 'Competitor Google ads from the Ads Transparency Center — find, inspect and compare.',
  preset = {},
}) {
  const base = { ...EMPTY, ...preset };
  const { isAdmin } = useAuth();
  const [f, setF] = useState(() => {
    // Deep links from Market Pulse: ?first=7d or ?firstDate=YYYY-MM-DD
    const sp = new URLSearchParams(window.location.search);
    const init = { ...base };
    if (sp.get('q')) init.q = sp.get('q');
    if (sp.get('advertiser')) init.advertiser = sp.get('advertiser');
    if (sp.get('domain')) init.domain = sp.get('domain');
    if (['video', 'image', 'text'].includes(sp.get('format'))) init.format = sp.get('format');
    if (FIRST.some(([id]) => id && id === sp.get('first'))) init.first = sp.get('first');
    if (SEEN.some(([id]) => id && id === sp.get('seen'))) init.seen = sp.get('seen');
    if (SORTS.some(([id]) => id === sp.get('sort'))) init.sort = sp.get('sort');
    if (/^[0-9]{1,4}$/.test(sp.get('minDays') || '')) init.minDays = sp.get('minDays');
    if (/^\d{4}-\d{2}-\d{2}$/.test(sp.get('firstDate') || '')) init.firstDate = sp.get('firstDate');
    return init;
  });
  const [q, setQ] = useState(() => new URLSearchParams(window.location.search).get('q') || '');
  const [data, setData] = useState({ creatives: [], total: 0, pageSize: 24 });
  const [sum, setSum] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [addText, setAddText] = useState('');
  const [adminMsg, setAdminMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const reqId = useRef(0);

  const set = (patch) => setF((cur) => ({ ...cur, page: 1, ...patch }));

  const load = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    const params = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '' && v != null));
    try {
      const [list, s] = await Promise.all([marketIntelAPI.creatives(params), marketIntelAPI.summary(params)]);
      if (id !== reqId.current) return;
      setData({ creatives: [], total: 0, pageSize: 24, ...list });
      setSum(s);
    } catch (e) {
      if (id !== reqId.current) return;
      logErrorForDebug('AdsViewer', e);
      setError(getUserFacingMessage(e, 'Could not load competitor ads.'));
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [f]);

  useEffect(() => { load(); }, [load]);

  const pages = Math.max(1, Math.ceil((data.total || 0) / (data.pageSize || 24)));

  const addAdvertisers = async () => {
    const items = addText.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    if (!items.length) return;
    setBusy(true);
    setAdminMsg('');
    try {
      const ids = items.filter((s) => /^AR\d+$/i.test(s));
      const domains = items.filter((s) => !/^AR\d+$/i.test(s));
      const r = await marketIntelAPI.addAdvertisers({ advertiserIds: ids, domains });
      setAdminMsg(`Tracking ${r.added.length} advertiser(s). Run “Sync now” to pull their ads.`);
      setAddText('');
    } catch (e) {
      setAdminMsg(getUserFacingMessage(e, 'Could not add advertisers.'));
    } finally {
      setBusy(false);
    }
  };

  const syncNow = async () => {
    setBusy(true);
    setAdminMsg('');
    try {
      const r = await marketIntelAPI.sync({});
      const head = `Collected ${r.saved} ads in ${r.calls} request(s).`;
      if (r.blocked) setAdminMsg(`${head} Google asked us to slow down — paused automatically (${r.cooldownMinutes} min). Progress is saved.`);
      else if (r.pending !== undefined) setAdminMsg(`${head} History collected for ${r.backfilled} of ${r.tracked} advertisers${r.pending ? ` — press Sync again, or enable the background collector, to continue.` : '.'}`);
      else setAdminMsg(`Synced ${r.advertisers} advertiser(s): ${r.saved} ads saved, ${r.calls} call(s), ${r.failed} failed.`);
      await load();
    } catch (e) {
      setAdminMsg(getUserFacingMessage(e, 'Sync failed.'));
    } finally {
      setBusy(false);
    }
  };

  const mix = sum && sum.results ? Math.round((sum.video / sum.results) * 100) : 0;

  return (
    <div className="ai-page">
      <PageHeader
        title={title}
        subtitle={subtitle}
      />

      <AppBuildingTabs />

      {isAdmin ? (
        <div className="av-admin">
          <input
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
            placeholder="Track advertisers: domains (duolingo.com) or ids (AR0132…), separated by spaces"
            onKeyDown={(e) => { if (e.key === 'Enter') addAdvertisers(); }}
          />
          <Button onClick={addAdvertisers} disabled={busy || !addText.trim()}>Track</Button>
          <Button onClick={syncNow} disabled={busy}>Sync now</Button>
          {adminMsg ? <span className="ai-kpi-hint">{adminMsg}</span> : null}
        </div>
      ) : null}

      <form className="av-search" onSubmit={(e) => { e.preventDefault(); set({ q: q.trim() }); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search advertiser, domain or creative id" />
        <Button type="submit">Search</Button>
      </form>

      <div className="av-chips">
        <button type="button" className="av-pill" onClick={() => set({ ...EMPTY, first: '24h', sort: 'new' })}>New today</button>
        <button type="button" className="av-pill" onClick={() => set({ ...EMPTY, first: '7d', sort: 'new' })}>New this week</button>
        <button type="button" className="av-pill" onClick={() => set({ ...EMPTY, seen: '7d', minDays: String(WINNER_DAYS), sort: 'longest' })}>Winners</button>
        <button type="button" className="av-pill" onClick={() => set({ ...EMPTY, sort: 'longest' })}>Longest running</button>
        <button type="button" className="av-pill" onClick={() => { setQ(''); setF(base); }}>Reset</button>
      </div>

      <div className="gam-overview-card ab-kpis"><div className="gam-overview-metrics">
        <Kpi label="Results" value={sum ? nf.format(sum.results) : '—'} hint="ads matching your filters" />
        <Kpi label="Live now" value={sum ? nf.format(sum.live_now) : '—'} hint="shown in the last 3 days" />
        <Kpi label="New · 7 days" value={sum ? nf.format(sum.new_7d) : '—'} hint="first shown in the last 7 days" />
        <Kpi label="Advertisers" value={sum ? nf.format(sum.advertisers) : '—'} hint={sum ? `${sum.trackedAdvertisers} tracked` : ''} />
        <Kpi label="Avg running" value={sum ? `${sum.avg_days} d` : '—'} hint="first → last shown" />
        <Kpi label="Format mix" value={sum ? `${mix}% video` : '—'} hint={sum ? `${sum.image} image · ${sum.text} text` : ''} />
      </div></div>

      <div className="av-layout">
        <aside className="av-filters">
          <div className="av-filters-head">Filters <button type="button" onClick={() => { setQ(''); setF(base); }}>Reset all</button></div>
          <div className="av-group"><span>Seen on Google</span><Pills value={f.seen} options={SEEN} onChange={(v) => set({ seen: v })} /></div>
          <div className="av-group"><span>First shown (new)</span><Pills value={f.first} options={FIRST} onChange={(v) => set({ first: v })} /></div>
          <div className="av-group"><span>Format</span><Pills value={f.format} options={FORMATS} onChange={(v) => set({ format: v })} /></div>
          <div className="av-group"><span>Status</span><Pills value={f.status} options={STATUS} onChange={(v) => set({ status: v })} /></div>
          <div className="av-group"><span>Advertiser</span>
            <input type="text" value={f.advertiser} placeholder="Name or AR id" onChange={(e) => set({ advertiser: e.target.value })} />
          </div>
          <div className="av-group"><span>Domain</span>
            <input type="text" value={f.domain} placeholder="example.com" onChange={(e) => set({ domain: e.target.value })} />
          </div>
          <div className="av-group"><span>Running at least (days)</span>
            <input type="number" min="0" value={f.minDays} placeholder="Any" onChange={(e) => set({ minDays: e.target.value })} />
          </div>
        </aside>

        <section className="ai-section">
          <div className="av-bar">
            <span className="ai-kpi-hint">
              {loading ? 'Loading…' : `Showing ${data.creatives.length ? (f.page - 1) * data.pageSize + 1 : 0}–${(f.page - 1) * data.pageSize + data.creatives.length} of ${nf.format(data.total)}`}
            </span>
            <select value={f.sort} onChange={(e) => set({ sort: e.target.value })} aria-label="Sort">
              {SORTS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </div>

          {error ? <div className="ai-note">{error}</div> : null}

          <div className="av-grid">
            {loading && !data.creatives.length
              ? Array.from({ length: 8 }).map((_, i) => <div key={i} className="ai-card ai-skeleton" />)
              : data.creatives.map((c) => <CreativeCard key={c.id} c={c} />)}
            {!loading && !error && !data.creatives.length ? (
              <div className="ai-empty">
                <div className="ai-empty-title">No competitor ads yet</div>
                <div className="ai-empty-body">
                  {isAdmin
                    ? 'Track an advertiser above (a domain like duolingo.com or an AR… id), then press “Sync now”.'
                    : 'Ask an admin to track advertisers. Ads appear here after the first sync.'}
                </div>
              </div>
            ) : null}
          </div>

          {pages > 1 ? (
            <div className="av-pager">
              <Button onClick={() => setF((c) => ({ ...c, page: Math.max(1, c.page - 1) }))} disabled={f.page <= 1}>Prev</Button>
              <span>Page {f.page} of {pages}</span>
              <Button onClick={() => setF((c) => ({ ...c, page: Math.min(pages, c.page + 1) }))} disabled={f.page >= pages}>Next</Button>
            </div>
          ) : null}
        </section>
      </div>
      <div className="ai-kpi-hint">
        Data: Google Ads Transparency Center, tracked advertisers only{sum?.lastSynced ? ` · last synced ${fmtDate(sum.lastSynced)}` : ''}.
        Winner = shown for {WINNER_DAYS}+ days.
      </div>
    </div>
  );
}
