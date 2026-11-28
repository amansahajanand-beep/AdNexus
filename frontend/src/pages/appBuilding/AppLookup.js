import React, { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { marketIntelAPI } from '../../utils/api';
import PageHeader from '../../components/ui/PageHeader';
import AppIcon from '../../components/ads/AppIcon';
import CreativeCard from '../../components/ads/CreativeCard';
import AppBuildingTabs from './AppBuildingTabs';
import { Section, Skeleton, useLoad, nf, day, VIEWER } from './shared';
import '../AdInsights.css';
import '../AdsViewer.css';

const KIND = { package: 'Package id', appstore: 'App Store id', name: 'App name' };

export default function AppLookup() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const [text, setText] = useState(q);
  const { data: d, error, loading } = useLoad(
    () => (q.trim().length >= 2 ? marketIntelAPI.lookup(q) : Promise.resolve(null)), [q], 'AppLookup', 'Lookup failed.'
  );

  const submit = (e) => { e.preventDefault(); setParams(text.trim() ? { q: text.trim() } : {}); };

  return (
    <div className="ai-page">
      <PageHeader title="App Lookup" subtitle="Paste an app name, package id or Play / App Store link to see who advertises it, from the data we already have." />
      <AppBuildingTabs />
      <form className="chart-card op-find" onSubmit={submit}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="com.example.app · https://play.google.com/store/apps/details?id=… · https://apps.apple.com/…/id123456" aria-label="App" />
        <button type="submit" className="ui-btn ui-btn-primary" disabled={loading || text.trim().length < 2}>{loading ? 'Looking up…' : 'Look up'}</button>
      </form>
      {error ? <div className="ai-note">{error}</div> : null}
      {loading && !d ? <Skeleton h={140} /> : null}
      {d ? (
        <>
          <div className="ai-kpi-hint">Searched as: {KIND[d.kind]} — <b>{d.term}</b></div>
          {!d.apps.length && !d.ads.length ? (
            <div className="chart-card ai-kpi-hint">
              Nothing in our data matches. We match on the app names the collector has identified and on ad links; the Transparency Center does not publish package ids, so a package id only matches when its name appears in an ad.
            </div>
          ) : null}
          {d.apps.length ? (
            <Section title={`Advertisers running this app (${d.apps.length})`}>
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th /><th className="left">App</th><th className="left">Advertiser</th><th>First ad</th><th className="num">Ads</th><th className="num">Live</th><th className="num">New 7d</th><th className="num">Longest</th><th /></tr></thead>
                  <tbody>
                    {d.apps.map((a) => (
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
            </Section>
          ) : null}
          {d.ads.length ? (
            <Section title="Latest ads">
              <div className="av-grid">{d.ads.map((c) => <CreativeCard key={c.id} c={c} />)}</div>
            </Section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
