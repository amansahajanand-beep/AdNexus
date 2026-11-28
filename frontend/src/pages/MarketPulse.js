import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { marketIntelAPI } from '../utils/api';
import PageHeader from '../components/ui/PageHeader';
import AppBuildingTabs from './appBuilding/AppBuildingTabs';
import CreativeCard from '../components/ads/CreativeCard';
import AppIcon from '../components/ads/AppIcon';
import { getUserFacingMessage, logErrorForDebug } from '../utils/userFacingError';
import './AdInsights.css';
import './AdsViewer.css';
import './MarketPulse.css';

const nf = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const fmtDate = (v) => (v ? new Date(v).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '—');
const pct = (now, before) => (before > 0 ? Math.round(((now - before) / before) * 1000) / 10 : null);
const VIEWER = '/app-building/viewer';
const TABS = [['overview', 'Overview'], ['burst', 'Burst board'], ['changes', 'Changes this week'], ['watch', 'Watchlist']];

function Delta({ value }) {
  if (value == null) return <span className="mp-delta">new</span>;
  const up = value >= 0;
  return <span className={`mp-delta ${up ? 'is-up' : 'is-down'}`}>{up ? '▲' : '▼'} {up ? '+' : ''}{value}%</span>;
}

function Kpi({ label, value, hint, delta, mix }) {
  return (
    <div className="gam-overview-metric kpi-tile">
      <span className="gam-overview-metric-value">{value}</span>
      <span className="gam-overview-metric-label">{label}</span>
      <span className="gam-overview-metric-hint">{delta !== undefined ? <><Delta value={delta} /> </> : null}{hint}</span>
      {mix ? (
        <div className="mp-mix">
          <i className="mp-seg--video" style={{ width: `${mix.video}%` }} />
          <i className="mp-seg--image" style={{ width: `${mix.image}%` }} />
          <i className="mp-seg--text" style={{ width: `${mix.text}%` }} />
        </div>
      ) : null}
    </div>
  );
}

/** Stacked bars: launches per day by format. Click a bar to open that day in the Ads Viewer. */
function LaunchChart({ daily }) {
  const max = Math.max(1, ...daily.map((d) => d.total));
  const ticks = daily.map((d, i) => (i % 5 === 0 ? new Date(`${d.date}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : ''));
  return (
    <>
      <div className="mp-chart" role="img" aria-label="Creative launches per day, last 30 days">
        {daily.map((d) => (
          <Link
            key={d.date}
            className="mp-bar"
            to={`${VIEWER}?firstDate=${d.date}`}
            title={`${d.date} · ${d.total} new (${d.video} video, ${d.image} image, ${d.text} text)`}
          >
            <span className="mp-seg mp-seg--text" style={{ height: `${(d.text / max) * 100}%` }} />
            <span className="mp-seg mp-seg--image" style={{ height: `${(d.image / max) * 100}%` }} />
            <span className="mp-seg mp-seg--video" style={{ height: `${(d.video / max) * 100}%` }} />
          </Link>
        ))}
      </div>
      <div className="mp-axis">{ticks.map((t, i) => <span key={daily[i].date}>{t}</span>)}</div>
    </>
  );
}

function BurstList({ rows, limit }) {
  const list = limit ? rows.slice(0, limit) : rows;
  if (!list.length) return <div className="ai-kpi-hint">No launches in the last 7 days.</div>;
  return (
    <ol className="mp-list">
      {list.map((b, i) => (
        <li key={b.advertiser_id}>
          <span className="mp-rank">{i + 1}</span>
          <AppIcon src={b.top_app_icon} name={b.top_app_name || b.name} size={32} />
          <span className="mp-name">
            <b>{b.name || b.advertiser_id}</b>
            <small>{b.top_app_name ? `${b.top_app_name} · ` : ''}{b.video_7d} video · last launch {fmtDate(b.last_launch)}</small>
          </span>
          <span className="mp-num">{nf.format(b.new_7d)}</span>
          <Delta value={b.changePct} />
        </li>
      ))}
    </ol>
  );
}

function LaunchFeed({ feed }) {
  if (!feed.length) return <div className="ai-kpi-hint">No new creatives yet.</div>;
  return (
    <div className="av-grid mp-feed">
      {feed.map((c) => <CreativeCard key={c.id} c={c} />)}
    </div>
  );
}

export default function MarketPulse() {
  const [tab, setTab] = useState('overview');
  const [p, setP] = useState(null);
  const [feed, setFeed] = useState([]);
  const [watch, setWatch] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let off = false;
    marketIntelAPI.pulse()
      .then((r) => { if (!off) setP(r); })
      .catch((e) => {
        logErrorForDebug('MarketPulse', e);
        if (!off) setError(getUserFacingMessage(e, 'Could not load Market Pulse.'));
      });
    marketIntelAPI.creatives({ first: '3d', sort: 'new', pageSize: 12 })
      .then((r) => { if (!off) setFeed(r.creatives || []); })
      .catch(() => {});
    return () => { off = true; };
  }, []);

  useEffect(() => {
    if (tab !== 'watch' || watch) return;
    marketIntelAPI.advertisers({ sort: 'live' }).then((r) => setWatch(r.advertisers || [])).catch(() => setWatch([]));
  }, [tab, watch]);

  const liveTotal = p ? p.live_video + p.live_image + p.live_text : 0;
  const share = (n) => (liveTotal ? Math.round((n / liveTotal) * 100) : 0);
  const mix = p ? { video: share(p.live_video), image: share(p.live_image), text: share(p.live_text) } : null;
  const movers = p ? [...p.bursts].filter((b) => b.changePct != null).sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)).slice(0, 15) : [];

  return (
    <div className="ai-page">
      <PageHeader
        title="Market Pulse"
        subtitle={p ? `What your ${nf.format(p.trackedAdvertisers)} tracked advertisers are launching on Google right now.` : 'What your tracked advertisers are launching on Google right now.'}
      />
      <AppBuildingTabs />
      {error ? <div className="ai-note">{error}</div> : null}

      <div className="admin-tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={`admin-tab${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      {p && p.lastSynced ? <div className="ai-kpi-hint">Collector last synced {fmtDate(p.lastSynced)}.</div> : null}

      {tab === 'overview' ? (
        <>
          <div className="gam-overview-card ab-kpis"><div className="gam-overview-metrics">
            <Kpi label="New creatives · 7d" value={p ? compact.format(p.new_7d) : '—'} delta={p ? pct(p.new_7d, p.new_prev_7d) : undefined} hint={p ? `vs the 7 days before · ${p.new_today} today` : ''} />
            <Kpi label="Live creatives" value={p ? compact.format(p.live) : '—'} delta={p ? pct(p.live, p.live_week_ago) : undefined} hint="vs a week ago" />
            <Kpi label="Active advertisers" value={p ? nf.format(p.active_advertisers) : '—'} hint={p ? `of ${nf.format(p.trackedAdvertisers)} tracked have live ads` : ''} />
            <Kpi label="Real format mix" value={p ? `${share(p.live_video)}% video` : '—'} hint={p ? `${share(p.live_image)}% image · ${share(p.live_text)}% text · of ${compact.format(liveTotal)} live` : ''} mix={mix} />
          </div></div>

          {p && !p.live && !p.new_7d ? (
            <div className="ai-empty">
              <div className="ai-empty-title">No competitor data yet</div>
              <div className="ai-empty-body">Track advertisers and run a sync in the <Link to={VIEWER}>Ads Viewer</Link>; the pulse fills in from there.</div>
            </div>
          ) : null}

          {p ? (
            <>
              <section className="chart-card">
                <div className="chart-header"><h3 className="chart-title">Creative launches per day · last 30 days</h3></div>
                <LaunchChart daily={p.daily} />
                <div className="mp-legend">
                  <span><i className="mp-dot mp-seg--video" /> Video</span>
                  <span><i className="mp-dot mp-seg--image" /> Image</span>
                  <span><i className="mp-dot mp-seg--text" /> Text</span>
                  <span className="ai-kpi-hint">· click a bar to open that day</span>
                </div>
              </section>

              <div className="mp-cols">
                <section className="chart-card">
                  <div className="chart-header"><h3 className="chart-title">Burst board · most new creatives in 7 days</h3><button type="button" className="mp-link" onClick={() => setTab('burst')}>See all</button></div>
                  <BurstList rows={p.bursts} limit={8} />
                </section>
                <section className="chart-card">
                  <div className="chart-header"><h3 className="chart-title">New advertisers this week</h3></div>
                  {p.newApps.length ? (
                    <ol className="mp-list">
                      {p.newApps.map((a) => (
                        <li key={a.advertiser_id}>
                          <AppIcon src={a.top_app_icon} name={a.top_app_name || a.advertiser} size={32} />
                          <span className="mp-name"><b>{a.advertiser || a.advertiser_id}</b><small>{a.top_app_name ? `${a.top_app_name} · ` : ''}first ad {fmtDate(a.first_ad)}</small></span>
                          <span className="mp-num">{a.ads} ads</span>
                        </li>
                      ))}
                    </ol>
                  ) : <div className="ai-kpi-hint">No new advertisers this week.</div>}
                  <h3 className="mp-sub">Most live ads right now</h3>
                  <ol className="mp-list">
                    {p.topDomains.map((d) => (
                      <li key={d.advertiser_id}>
                        <AppIcon src={d.top_app_icon} name={d.top_app_name || d.advertiser} size={32} />
                        <span className="mp-name"><b>{d.advertiser || d.advertiser_id}</b><small>{d.top_app_name ? `${d.top_app_name} · ` : ''}{d.video} video</small></span>
                        <span className="mp-num">{nf.format(d.ads)}</span>
                      </li>
                    ))}
                  </ol>
                </section>
              </div>

              <section className="chart-card">
                <div className="chart-header"><h3 className="chart-title">Launch feed · first shown in the last 3 days</h3><Link className="mp-link" to={`${VIEWER}?first=3d`}>See all</Link></div>
                <LaunchFeed feed={feed} />
              </section>
            </>
          ) : !error ? <div className="ai-card ai-skeleton" style={{ height: 220 }} /> : null}
        </>
      ) : null}

      {tab === 'burst' && p ? (
        <section className="chart-card">
          <div className="chart-header"><h3 className="chart-title">Burst board · most new creatives in 7 days</h3><span className="ai-kpi-hint">top {p.bursts.length}</span></div>
          <BurstList rows={p.bursts} />
        </section>
      ) : null}

      {tab === 'changes' && p ? (
        <section className="chart-card">
          <div className="chart-header"><h3 className="chart-title">Biggest changes vs the week before</h3></div>
          {movers.length ? <BurstList rows={movers} /> : <div className="ai-kpi-hint">Not enough history yet — changes appear once advertisers have two weeks of data.</div>}
        </section>
      ) : null}

      {tab === 'watch' ? (
        <section className="chart-card">
          <div className="chart-header"><h3 className="chart-title">Watchlist · tracked advertisers</h3><Link className="mp-link" to="/app-building/advertisers">Open Advertisers</Link></div>
          {!watch ? <div className="ai-card ai-skeleton" style={{ height: 120 }} /> : (
            <ol className="mp-list">
              {watch.map((a) => (
                <li key={a.advertiser_id}>
                  <AppIcon src={a.top_app_icon} name={a.top_app_name || a.name} size={32} />
                  <span className="mp-name"><b>{a.name || a.advertiser_id}</b><small>{a.backfill_done ? 'history collected' : 'collecting history…'}</small></span>
                  <span className="mp-num">{nf.format(a.live_ads)} live</span>
                  <span className="mp-delta">{nf.format(a.total_ads)} total</span>
                </li>
              ))}
              {!watch.length ? <div className="ai-kpi-hint">Nothing tracked yet.</div> : null}
            </ol>
          )}
        </section>
      ) : null}
    </div>
  );
}
