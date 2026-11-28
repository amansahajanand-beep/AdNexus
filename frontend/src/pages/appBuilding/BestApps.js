import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { marketIntelAPI } from '../../utils/api';
import PageHeader from '../../components/ui/PageHeader';
import AppIcon from '../../components/ads/AppIcon';
import AppBuildingTabs from './AppBuildingTabs';
import { Tile, Tiles, Skeleton, useLoad, useDebounced, nf, day, VIEWER } from './shared';
import '../AdInsights.css';
import '../AdsViewer.css';

const SORTS = [['score', 'Performance score'], ['live', 'Most live ads'], ['new', 'Most new (7d)'], ['longest', 'Longest-running ad']];

export default function BestApps() {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('score');
  const [status, setStatus] = useState('');
  const dq = useDebounced(q);
  const { data: d, error } = useLoad(() => marketIntelAPI.bestApps({ q: dq, sort, status }), [dq, sort, status], 'BestApps', 'Could not load Best Apps.');

  return (
    <div className="ai-page">
      <PageHeader title="Best Apps" subtitle="The strongest apps by ads running, launches and how long their ads last." />
      <AppBuildingTabs />
      {error ? <div className="ai-note">{error}</div> : null}
      <Tiles>
        <Tile label="Apps" value={d ? nf.format(d.total) : '—'} hint="identified from video ads" />
        <Tile label="Active apps" value={d ? nf.format(d.active) : '—'} hint="an ad shown in the last 3 days" />
        <Tile label="Avg longest ad" value={d ? `${d.avg_days}d` : '—'} hint="days the best ad of each app ran" />
      </Tiles>

      <div className="chart-card op-find">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search app or advertiser" aria-label="Search apps" />
        <select className="ui-input" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
          {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select className="ui-input" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          <option value="active">Active now</option>
        </select>
      </div>

      {!d ? <Skeleton /> : !d.apps.length ? (
        <div className="chart-card ai-kpi-hint">No apps identified yet. App names come from the collector's video lookup, so this fills in as it runs.</div>
      ) : (
        <div className="bp-grid">
          {d.apps.map((a, i) => (
            <div key={`${a.advertiser_id}|${a.name}`} className="chart-card bp-card">
              <div className="bp-head">
                <span className={`bp-rank${i < 3 ? ' is-top' : ''}`}>#{i + 1}</span>
                <AppIcon src={a.icon} name={a.name} size={44} />
                <div className="bp-title">
                  <b>{a.name}</b>
                  <small>{a.advertiser_name}</small>
                </div>
                <span className="mi-score" title="Performance score 0–100">{a.score}</span>
              </div>
              <div className="op-bar"><i style={{ width: `${Math.max(4, a.score)}%` }} /></div>
              <div className="bp-stats">
                <div><b>{nf.format(a.ads)}</b><span>Ads</span></div>
                <div><b>{nf.format(a.live_ads)}</b><span>Live</span></div>
                <div><b>{nf.format(a.new_7d)}</b><span>New 7d</span></div>
                <div><b>{a.longest_days}d</b><span>Longest</span></div>
              </div>
              <div className="ai-kpi-hint">{day(a.first_seen)} → {day(a.last_seen)}</div>
              <div className="op-actions">
                <Link className="op-btn" to={`${VIEWER}?q=${encodeURIComponent(a.name)}`}>All ads</Link>
                <Link className="op-btn" to={`${VIEWER}?q=${encodeURIComponent(a.name)}&seen=7d&minDays=30&sort=longest`}>🏆 Winners</Link>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="ai-kpi-hint">
        Score 0–100 = ads running now (40) + ads launched in the last 30 days (30) + longest-running ad (30), each relative to the strongest app. Store ratings, installs and country reach are not available from the Transparency Center.
      </p>
    </div>
  );
}
