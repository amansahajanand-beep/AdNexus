import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { marketIntelAPI } from '../../utils/api';
import PageHeader from '../../components/ui/PageHeader';
import AppBuildingTabs from './AppBuildingTabs';
import { Tile, Tiles, Skeleton, useLoad, useDebounced, nf, day, VIEWER } from './shared';
import '../AdInsights.css';
import '../AdsViewer.css';

export default function Websites() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('active');
  const dq = useDebounced(q);
  const { data: d, error } = useLoad(() => marketIntelAPI.websites({ q: dq, status }), [dq, status], 'Websites', 'Could not load Websites.');

  return (
    <div className="ai-page">
      <PageHeader title="Websites" subtitle="Competitor ads that send people to a website instead of an app. Google shows only the domain, never the full page." />
      <AppBuildingTabs />
      {error ? <div className="ai-note">{error}</div> : null}
      <Tiles>
        <Tile label="Websites" value={d ? nf.format(d.websites) : '—'} hint="found on competitor ads" />
        <Tile label="Advertisers" value={d ? nf.format(d.advertisers) : '—'} hint="that run website ads" />
      </Tiles>

      <div className="chart-card op-find">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search website or advertiser" aria-label="Search websites" />
        <select className="ui-input" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="active">Ads running now</option>
          <option value="">All websites</option>
        </select>
      </div>

      {!d ? <Skeleton /> : !d.rows.length ? (
        <div className="chart-card ai-kpi-hint">No websites match. Only ads that carry a target domain are listed; most app ads do not.</div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th className="left">Website</th><th className="left">Advertiser</th>
                <th className="num">Running</th><th className="num">Ads</th><th className="num">New 7d</th>
                <th className="num">Video</th><th className="num">Image</th><th>First seen</th><th>Last seen</th><th />
              </tr>
            </thead>
            <tbody>
              {d.rows.map((w) => (
                <tr key={w.domain}>
                  <td className="left">
                    <a href={`https://${w.domain}`} target="_blank" rel="noopener noreferrer nofollow"><b>{w.domain}</b></a>
                    {w.youtube_id ? <a className="op-btn" style={{ marginLeft: 8 }} href={`https://www.youtube.com/watch?v=${w.youtube_id}`} target="_blank" rel="noopener noreferrer">▶ video</a> : null}
                  </td>
                  <td className="left">{w.advertiser_name}{w.advertisers > 1 ? <span className="ai-kpi-hint"> +{w.advertisers - 1}</span> : null}</td>
                  <td className="num"><b>{nf.format(w.running)}</b></td>
                  <td className="num">{nf.format(w.ads)}</td>
                  <td className="num">{w.new_7d ? nf.format(w.new_7d) : '—'}</td>
                  <td className="num">{nf.format(w.video_ads)}</td>
                  <td className="num">{nf.format(w.image_ads)}</td>
                  <td>{day(w.first_seen)}</td>
                  <td>{day(w.last_seen)}</td>
                  <td><Link to={`${VIEWER}?domain=${encodeURIComponent(w.domain)}`}>Ads →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
