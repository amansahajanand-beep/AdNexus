import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { marketIntelAPI } from '../../utils/api';
import PageHeader from '../../components/ui/PageHeader';
import AppIcon from '../../components/ads/AppIcon';
import AppBuildingTabs from './AppBuildingTabs';
import { Tile, Tiles, Skeleton, useLoad, nf, day } from './shared';
import '../AdInsights.css';
import '../AdsViewer.css';

export default function MatchVideos() {
  const [min, setMin] = useState(2);
  const { data: d, error } = useLoad(() => marketIntelAPI.matchVideos({ minAdvertisers: min }), [min], 'MatchVideos', 'Could not load Match Videos.');
  const pct = d && d.coverage.videos ? Math.round((d.coverage.identified / d.coverage.videos) * 100) : 0;

  return (
    <div className="ai-page">
      <PageHeader title="Match Videos" subtitle="The same YouTube creative run by more than one advertiser — shared agencies, networks or copycats.">
        <select className="ui-input" value={min} onChange={(e) => setMin(Number(e.target.value))} aria-label="Match type">
          <option value={2}>Shared by 2+ advertisers</option>
          <option value={1}>Reused in 2+ ads (any advertiser)</option>
        </select>
      </PageHeader>
      <AppBuildingTabs />
      {error ? <div className="ai-note">{error}</div> : null}
      <Tiles>
        <Tile label="Matches" value={d ? nf.format(d.groups.length) : '—'} hint={min === 2 ? 'videos used by several advertisers' : 'videos used in several ads'} />
        <Tile label="Videos identified" value={d ? nf.format(d.coverage.identified) : '—'} hint={d ? `of ${nf.format(d.coverage.videos)} video ads (${pct}%)` : ''} />
      </Tiles>

      {!d ? <Skeleton /> : !d.groups.length ? (
        <div className="chart-card ai-kpi-hint">
          No video is shared yet. A match needs the YouTube id of each video, which the collector reads one video at a time ({nf.format(d.coverage.identified)} of {nf.format(d.coverage.videos)} so far), so matches appear as more are identified.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th /><th className="left">Video</th><th className="left">Advertisers</th><th className="num">Advertisers</th><th className="num">Ads</th><th className="num">Running</th><th>First seen</th><th>Last seen</th></tr></thead>
            <tbody>
              {d.groups.map((g) => (
                <tr key={g.youtube_id}>
                  <td>
                    <a href={`https://www.youtube.com/watch?v=${g.youtube_id}`} target="_blank" rel="noopener noreferrer">
                      <img className="mv-thumb" src={`https://i.ytimg.com/vi/${g.youtube_id}/mqdefault.jpg`} alt="" loading="lazy" />
                    </a>
                  </td>
                  <td className="left">
                    <span className="mi-who"><AppIcon src={g.app_icon} name={g.app_name || g.youtube_id} size={26} /><span><b>{g.app_name || 'Unidentified app'}</b><small>{g.youtube_id}</small></span></span>
                  </td>
                  <td className="left">{g.advertiser_names.join(', ')}</td>
                  <td className="num"><b>{nf.format(g.advertisers)}</b></td>
                  <td className="num">{nf.format(g.ads)}</td>
                  <td className="num">{nf.format(g.running)}</td>
                  <td>{day(g.first_seen)}</td>
                  <td>{day(g.last_seen)}</td>
                  <td><Link to={`/app-building/search?q=${g.youtube_id}&type=videos`}>Ads →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
