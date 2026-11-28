import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { marketIntelAPI } from '../../utils/api';
import PageHeader from '../../components/ui/PageHeader';
import AppBuildingTabs from './AppBuildingTabs';
import { Tile, Tiles, Skeleton, useLoad, useDebounced, nf, VIEWER } from './shared';
import '../AdInsights.css';
import '../AdsViewer.css';

export default function OtherAssets() {
  const [q, setQ] = useState('');
  const [days, setDays] = useState(30);
  const dq = useDebounced(q);
  const { data: d, error } = useLoad(() => marketIntelAPI.otherAssets({ q: dq, days }), [dq, days], 'OtherAssets', 'Could not load Other assets.');
  const unchecked = d ? d.advertisers.reduce((n, a) => n + a.unchecked, 0) : 0;

  return (
    <div className="ai-page">
      <PageHeader title="Other assets" subtitle="Videos, images and text ads whose app has not been identified. Nothing here is counted for an app yet." />
      <AppBuildingTabs />
      {error ? <div className="ai-note">{error}</div> : null}
      <Tiles>
        <Tile label="Ads without an app" value={d ? nf.format(d.total) : '—'} hint={`shown in the last ${days} days`} />
        <Tile label="Advertisers" value={d ? nf.format(d.advertisers.length) : '—'} hint="with unidentified ads" />
        <Tile label="Videos not looked up yet" value={d ? nf.format(unchecked) : '—'} hint="the collector identifies these over time" />
      </Tiles>

      <div className="chart-card op-find">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search advertiser or AR id" aria-label="Search advertisers" />
        <select className="ui-input" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Window">
          <option value={7}>Ads seen in 7 days</option><option value={30}>Ads seen in 30 days</option><option value={90}>Ads seen in 90 days</option>
        </select>
      </div>

      {!d ? <Skeleton /> : !d.advertisers.length ? <div className="chart-card ai-kpi-hint">Every ad in this window is tied to an app.</div> : (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th className="left">Advertiser</th><th className="num">Ads without app</th><th className="num">Running now</th><th className="num">Video</th><th className="num">Image</th><th className="num">Text</th><th /></tr></thead>
            <tbody>
              {d.advertisers.map((a) => (
                <tr key={a.advertiser_id}>
                  <td className="left"><b>{a.advertiser_name || a.advertiser_id}</b><div className="ai-kpi-hint">{a.advertiser_id}</div></td>
                  <td className="num"><b>{nf.format(a.ads)}</b></td>
                  <td className="num">{nf.format(a.running)}</td>
                  <td className="num">{nf.format(a.video)}</td>
                  <td className="num">{nf.format(a.image)}</td>
                  <td className="num">{nf.format(a.text)}</td>
                  <td><Link to={`${VIEWER}?advertiser=${encodeURIComponent(a.advertiser_id)}&seen=${days}d`}>See assets →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
