import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { marketIntelAPI } from '../../utils/api';
import PageHeader from '../../components/ui/PageHeader';
import AppIcon from '../../components/ads/AppIcon';
import CreativeCard from '../../components/ads/CreativeCard';
import AppBuildingTabs from './AppBuildingTabs';
import { getUserFacingMessage, logErrorForDebug } from '../../utils/userFacingError';
import '../AdInsights.css';
import '../AdsViewer.css';

const nf = new Intl.NumberFormat();
const VIEWER = '/app-building/viewer';
const TABS = [['niches', 'Niches to build'], ['rising', 'Fast new entrants'], ['mine', 'My apps vs competitors']];
const CROWD = { open: 'Open', busy: 'Busy', crowded: 'Crowded' };
const cap = (w) => String(w || '').charAt(0).toUpperCase() + String(w || '').slice(1);
const day = (v) => (v ? new Date(v).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '—');

function Tile({ label, value, hint }) {
  return (
    <div className="gam-overview-metric kpi-tile">
      <span className="gam-overview-metric-value">{value}</span>
      <span className="gam-overview-metric-label">{label}</span>
      {hint ? <span className="gam-overview-metric-hint">{hint}</span> : null}
    </div>
  );
}

function NicheCard({ x }) {
  const q = encodeURIComponent(x.word);
  return (
    <div className="chart-card op-card">
      <div className="op-head">
        <div>
          <div className="op-word">{cap(x.word)}</div>
          <div className="ai-kpi-hint">
            {nf.format(x.apps)} apps · {nf.format(x.advertisers)} advertisers · <b className={`op-crowd op-crowd--${x.crowd}`}>{CROWD[x.crowd]}</b>
          </div>
        </div>
        <div className="op-score" title="Opportunity score 0–100"><b>{x.score}</b><span>score</span></div>
      </div>
      <div className="op-bar"><i style={{ width: `${Math.max(4, x.score)}%` }} /></div>
      {x.why.length ? <ul className="op-why">{x.why.map((w) => <li key={w}>{w}</li>)}</ul> : <div className="ai-kpi-hint">No recent movement yet.</div>}
      <div className="op-apps">
        {x.examples.map((a) => (
          <span
            key={a.product_id}
            className="op-app"
            title={`${a.name} · ${a.advertiser_name}${a.is_new ? ' · new this fortnight' : ''}${a.winner_ads ? ` · ${a.winner_ads} winner ads` : ''}`}
          >
            <AppIcon src={a.icon} name={a.name} size={36} />
            {a.is_new ? <i className="op-dot op-dot--new">new</i> : a.winner_ads ? <i className="op-dot op-dot--win">🏆</i> : null}
          </span>
        ))}
      </div>
      <div className="op-actions">
        <Link className="op-btn" to={`${VIEWER}?q=${q}&seen=7d&minDays=30&sort=longest`}>🏆 Winner ads</Link>
        <Link className="op-btn" to={`${VIEWER}?q=${q}&first=7d`}>New this week</Link>
      </div>
    </div>
  );
}

function Rising({ rows }) {
  if (!rows.length) return <div className="chart-card ai-kpi-hint">No new app has pushed several ads yet in the last 14 days.</div>;
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th />
            <th className="left">App</th>
            <th className="left">Advertiser</th>
            <th>First ad</th>
            <th className="num">Live ads</th>
            <th className="num">New this week</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.product_id}>
              <td><AppIcon src={a.icon} name={a.name} size={30} /></td>
              <td className="left"><b>{a.name}</b></td>
              <td className="left">{a.advertiser_name}</td>
              <td>{day(a.first_seen)}</td>
              <td className="num">{nf.format(a.live_ads)}</td>
              <td className="num"><b>{nf.format(a.new_7d)}</b></td>
              <td><Link to={`${VIEWER}?q=${encodeURIComponent(a.name)}&first=7d`}>Ads →</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Mine() {
  const [text, setText] = useState('');
  const [res, setRes] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const reqId = useRef(0);

  const find = async (e) => {
    e?.preventDefault();
    if (!text.trim()) return;
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const r = await marketIntelAPI.oppsMine(text.trim());
      if (id === reqId.current) setRes(r);
    } catch (err) {
      logErrorForDebug('WhatToBuild.mine', err);
      if (id === reqId.current) setError(getUserFacingMessage(err, 'Could not load competitors.'));
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  };

  return (
    <>
      <form className="chart-card op-find" onSubmit={find}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type your app's name, e.g. “All Video Downloader” or “Skin Tool Diamonds”" />
        <button type="submit" className="ui-btn ui-btn-primary" disabled={loading || !text.trim()}>{loading ? 'Searching…' : 'Find competitors'}</button>
        <div className="ai-kpi-hint">Its closest competitor apps are found from the words of its name.</div>
      </form>
      {error ? <div className="ai-note">{error}</div> : null}
      {res && !res.competitors.length ? (
        <div className="chart-card ai-kpi-hint">
          No competitor app matched the words of “{text}” ({res.words.join(', ') || 'no usable words'}). Try other words, or wait for the collector to identify more apps.
        </div>
      ) : null}
      {res && res.competitors.length ? (
        <>
          <section className="chart-card">
            <div className="chart-header"><h3 className="chart-title">Closest competitors of “{text}”</h3></div>
            <div className="ai-kpi-hint" style={{ marginBottom: 10 }}>Matched on: {res.words.join(', ')}</div>
            <div className="op-comp">
              {res.competitors.map((c) => (
                <Link key={c.product_id} className="op-ci" to={`${VIEWER}?q=${encodeURIComponent(c.name)}`}>
                  <AppIcon src={c.icon} name={c.name} size={34} />
                  <span>
                    <b>{c.name}</b>
                    <small>
                      {nf.format(c.ads)} ads · <i className={c.new_7d ? 'op-up' : ''}>{nf.format(c.new_7d)} new this week</i>
                      {c.winner_ads ? ` · 🏆 ${c.winner_ads}` : ''}
                    </small>
                  </span>
                </Link>
              ))}
            </div>
          </section>
          <h3 className="chart-title" style={{ margin: '4px 0 0' }}>What they launched this week</h3>
          {res.newAds.length ? (
            <div className="av-grid">{res.newAds.map((c) => <CreativeCard key={c.id} c={c} />)}</div>
          ) : <div className="chart-card ai-kpi-hint">No new ads from these competitors in the last 7 days.</div>}
        </>
      ) : null}
    </>
  );
}

export default function WhatToBuild() {
  const [tab, setTab] = useState('niches');
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let off = false;
    marketIntelAPI.opps()
      .then((r) => { if (!off) setD(r); })
      .catch((e) => {
        logErrorForDebug('WhatToBuild', e);
        if (!off) setError(getUserFacingMessage(e, 'Could not load What to build.'));
      });
    return () => { off = true; };
  }, []);

  const cov = d?.coverage;
  const pctCov = cov && cov.videos ? Math.round((cov.identified / cov.videos) * 100) : 0;

  return (
    <div className="ai-page">
      <PageHeader title="What to build" subtitle="Where competitors are putting money right now — niches with new apps coming in and ads that keep running." />
      <AppBuildingTabs />
      {error ? <div className="ai-note">{error}</div> : null}

      <div className="gam-overview-card ab-kpis">
        <div className="gam-overview-metrics">
          <Tile label="Apps advertising now" value={d ? nf.format(d.live_apps) : '—'} hint="with an ad seen in the last 3 days" />
          <Tile label={`New apps · ${d?.new_days || 14} days`} value={d ? nf.format(d.new_apps) : '—'} hint="first ad seen recently" />
          <Tile label="Apps with a winner ad" value={d ? nf.format(d.winner_apps) : '—'} hint={`an ad still running after ${d?.winner_days || 30}+ days`} />
          <Tile
            label="Niches found"
            value={d ? nf.format(d.niches.length) : '—'}
            hint={cov ? `${nf.format(cov.identified)} of ${nf.format(cov.videos)} video ads identified (${pctCov}%)` : ''}
          />
        </div>
      </div>

      <div className="admin-tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={`admin-tab${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      {tab === 'niches' ? (
        !d ? <div className="ai-card ai-skeleton" style={{ height: 180 }} /> : d.niches.length ? (
          <div className="op-grid">{d.niches.map((x) => <NicheCard key={x.word} x={x} />)}</div>
        ) : (
          <div className="chart-card ai-kpi-hint">
            No niche has enough apps yet. App names come from the collector's video lookup ({cov ? `${nf.format(cov.identified)} identified so far` : 'in progress'}), so this fills in over the next hours as it works through your tracked advertisers.
          </div>
        )
      ) : null}
      {tab === 'rising' ? (d ? <Rising rows={d.rising} /> : <div className="ai-card ai-skeleton" style={{ height: 180 }} />) : null}
      {tab === 'mine' ? <Mine /> : null}

      <p className="ai-kpi-hint">
        How this works: a <b>niche</b> is a word many competitor app names share (cleaner, loan, translator…). Its score (0–100) adds new apps that started advertising in the last 14 days (35), apps with a 🏆 winner ad — still running after 30+ days, which nobody keeps paying for unless it earns (30) and new ads this week (20), each relative to the strongest niche. YouTube views are not collected here. Only apps the collector has identified are counted.
      </p>
    </div>
  );
}
