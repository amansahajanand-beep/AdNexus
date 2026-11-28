import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
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
const TYPES = [['all', 'All'], ['ads', 'Ads'], ['advertisers', 'Advertisers'], ['apps', 'Apps'], ['videos', 'Videos']];
const KIND = {
  youtube: 'YouTube video id', advertiser: 'Advertiser id', creative: 'Creative id', package: 'Package name', domain: 'Website',
};
const day = (v) => (v ? new Date(v).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

function Group({ title, count, shown, onMore, children }) {
  return (
    <section className="chart-card">
      <div className="chart-header">
        <h3 className="chart-title">{title} <span className="ai-kpi-hint">· {nf.format(count)}</span></h3>
        {onMore && count > shown ? <button type="button" className="ui-btn" onClick={onMore}>See all {nf.format(count)}</button> : null}
      </div>
      {children}
    </section>
  );
}

export default function UniversalSearch() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const type = params.get('type') || 'all';
  const [text, setText] = useState(q);
  const [res, setRes] = useState(null);
  const [sugg, setSugg] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const reqId = useRef(0);
  const box = useRef(null);

  useEffect(() => { setText(q); }, [q]);

  const run = useCallback(async () => {
    if (q.trim().length < 2) { setRes(null); return; }
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const r = await marketIntelAPI.search({ q, type, perPage: type === 'all' ? 12 : 48 });
      if (id === reqId.current) setRes(r);
    } catch (e) {
      if (id !== reqId.current) return;
      logErrorForDebug('UniversalSearch', e);
      setError(getUserFacingMessage(e, 'Search failed.'));
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [q, type]);

  useEffect(() => { run(); }, [run]);

  // Typeahead: apps, advertisers and videos as you type.
  useEffect(() => {
    const t = text.trim();
    if (t.length < 2 || t === q) { setSugg(null); return undefined; }
    let off = false;
    const timer = setTimeout(() => {
      marketIntelAPI.search({ q: t, mode: 'suggest', type: 'all' }).then((r) => { if (!off) setSugg(r); }).catch(() => {});
    }, 250);
    return () => { off = true; clearTimeout(timer); };
  }, [text, q]);

  const go = (value, nextType = type) => {
    setSugg(null);
    setParams(value.trim() ? { q: value.trim(), type: nextType } : {});
  };
  const submit = (e) => { e.preventDefault(); go(text); };
  const setType = (t) => setParams(q ? { q, type: t } : {});

  const showAds = res && (type === 'all' || type === 'ads');
  const showAdv = res && (type === 'all' || type === 'advertisers');
  const showApps = res && (type === 'all' || type === 'apps');
  const showVid = res && (type === 'all' || type === 'videos');
  const empty = res && !res.counts.ads && !res.counts.advertisers && !res.counts.apps;

  return (
    <div className="ai-page">
      <PageHeader title="Universal Search" subtitle="Ads, advertisers, apps and YouTube videos — by words, AR… / CR… id, package, website or YouTube link." />
      <AppBuildingTabs />

      <form className="chart-card op-find us-box" onSubmit={submit} ref={box}>
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. photo cleaner, com.example.app, AR0123…"
          aria-label="Search"
        />
        <button type="submit" className="ui-btn ui-btn-primary" disabled={loading || text.trim().length < 2}>{loading ? 'Searching…' : 'Search'}</button>
        {sugg && (sugg.apps.length || sugg.advertisers.length || sugg.videos.length) ? (
          <div className="us-sugg" role="listbox">
            {sugg.apps.map((a) => (
              <button type="button" key={`a${a.advertiser_id}${a.name}`} onClick={() => go(a.name, 'apps')}>
                <AppIcon src={a.icon} name={a.name} size={22} /><span>{a.name}</span><i>app</i>
              </button>
            ))}
            {sugg.advertisers.map((a) => (
              <button type="button" key={`d${a.advertiser_id}`} onClick={() => go(a.name, 'advertisers')}>
                <AppIcon src={a.top_app_icon} name={a.name} size={22} /><span>{a.name}</span><i>advertiser</i>
              </button>
            ))}
            {sugg.videos.map((v) => (
              <button type="button" key={`v${v.id}`} onClick={() => go(v.appName || v.advertiser, 'videos')}>
                <AppIcon src={v.appIcon} name={v.appName || v.advertiser} size={22} /><span>{v.appName || v.advertiser}</span><i>video</i>
              </button>
            ))}
          </div>
        ) : null}
        <div className="av-pills us-types">
          {TYPES.map(([id, label]) => (
            <button key={id} type="button" className={`av-pill${type === id ? ' is-active' : ''}`} onClick={() => setType(id)}>
              {label}{res && id !== 'all' && res.counts[id] !== undefined ? ` · ${nf.format(res.counts[id])}` : ''}
            </button>
          ))}
        </div>
      </form>

      {error ? <div className="ai-note">{error}</div> : null}
      {res && KIND[res.kind] ? <div className="ai-kpi-hint">Recognised as: {KIND[res.kind]} — <b>{res.q}</b></div> : null}
      {loading && !res ? <div className="ai-card ai-skeleton" style={{ height: 160 }} /> : null}
      {!q && !loading ? <div className="chart-card ai-kpi-hint">Type at least two characters. Try an app name, an advertiser, a website, or paste a YouTube link to find every ad using that video.</div> : null}
      {empty ? <div className="chart-card ai-kpi-hint">Nothing matched “{res.q}”. Only advertisers and ads collected so far are searched.</div> : null}

      {showAdv && res.advertisers.length ? (
        <Group title="Advertisers" count={res.counts.advertisers} shown={res.advertisers.length} onMore={type === 'all' ? () => setType('advertisers') : null}>
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th /><th className="left">Advertiser</th><th className="left">Latest app</th><th className="num">Ads</th><th className="num">Live</th><th className="num">New (7d)</th><th>Last shown</th><th /></tr></thead>
              <tbody>
                {res.advertisers.map((a) => (
                  <tr key={a.advertiser_id}>
                    <td><AppIcon src={a.top_app_icon} name={a.name} size={30} /></td>
                    <td className="left"><b>{a.name || a.advertiser_id}</b><div className="ai-kpi-hint">{a.advertiser_id}</div></td>
                    <td className="left">{a.top_app_name || '—'}</td>
                    <td className="num">{nf.format(a.total_ads)}</td>
                    <td className="num">{nf.format(a.live_ads)}</td>
                    <td className="num">{nf.format(a.new_7d)}</td>
                    <td>{day(a.last_ad)}</td>
                    <td><Link to={`${VIEWER}?advertiser=${encodeURIComponent(a.advertiser_id)}`}>Ads →</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Group>
      ) : null}

      {showApps && res.apps.length ? (
        <Group title="Apps" count={res.counts.apps} shown={res.apps.length} onMore={type === 'all' ? () => setType('apps') : null}>
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th /><th className="left">App</th><th className="left">Advertiser</th><th>First ad</th><th className="num">Ads</th><th className="num">Live</th><th className="num">New (7d)</th><th className="num">Longest</th><th /></tr></thead>
              <tbody>
                {res.apps.map((a) => (
                  <tr key={`${a.advertiser_id}|${a.name}`}>
                    <td><AppIcon src={a.icon} name={a.name} size={30} /></td>
                    <td className="left"><b>{a.name}</b></td>
                    <td className="left">{a.advertiser_name}</td>
                    <td>{day(a.first_seen)}</td>
                    <td className="num">{nf.format(a.ads)}</td>
                    <td className="num">{nf.format(a.live_ads)}</td>
                    <td className="num">{nf.format(a.new_7d)}</td>
                    <td className="num">{a.longest_days}d</td>
                    <td><Link to={`${VIEWER}?q=${encodeURIComponent(a.name)}`}>Ads →</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Group>
      ) : null}

      {showVid && res.videos.length ? (
        <Group title="Videos" count={res.counts.videos} shown={res.videos.length} onMore={type === 'all' ? () => setType('videos') : null}>
          <div className="av-grid">{res.videos.map((c) => <CreativeCard key={c.id} c={c} />)}</div>
        </Group>
      ) : null}

      {showAds && res.ads.length ? (
        <Group title="Ads" count={res.counts.ads} shown={res.ads.length} onMore={type === 'all' ? () => setType('ads') : null}>
          <div className="av-grid">{res.ads.map((c) => <CreativeCard key={c.id} c={c} />)}</div>
          {type === 'ads' && res.counts.ads > res.ads.length ? (
            <p className="ai-kpi-hint">Showing the latest {res.ads.length}. <Link to={`${VIEWER}?q=${encodeURIComponent(res.q)}`}>Open all {nf.format(res.counts.ads)} in the Ads Viewer →</Link></p>
          ) : null}
        </Group>
      ) : null}
    </div>
  );
}
