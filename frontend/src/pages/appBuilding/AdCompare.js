import React, { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { marketIntelAPI } from '../../utils/api';
import PageHeader from '../../components/ui/PageHeader';
import CreativeCard from '../../components/ads/CreativeCard';
import AppBuildingTabs from './AppBuildingTabs';
import { Skeleton, useLoad, nf, day, VIEWER } from './shared';
import '../AdInsights.css';
import '../AdsViewer.css';

const ROWS = [
  ['Advertiser', (a) => a.advertiser || '—'],
  ['App', (a) => a.appName || '—'],
  ['Format', (a) => a.format || '—'],
  ['Status', (a) => (a.active ? 'Running' : 'Stopped')],
  ['First shown', (a) => day(a.firstShown)],
  ['Last shown', (a) => day(a.lastShown)],
  ['Days shown', (a) => nf.format(a.daysShown || 0)],
  ['Size', (a) => (a.width && a.height ? `${a.width} × ${a.height}` : '—')],
  ['Website', (a) => a.domain || '—'],
  ['YouTube video', (a) => a.youtubeId || '—'],
];

export default function AdCompare() {
  const [params, setParams] = useSearchParams();
  const ids = params.get('ids') || '';
  const [text, setText] = useState(ids.replace(/,/g, '\n'));
  const { data: d, error, loading } = useLoad(
    () => (ids ? marketIntelAPI.compare(ids) : Promise.resolve(null)), [ids], 'AdCompare', 'Could not load the ads.'
  );

  const go = (e) => {
    e.preventDefault();
    const found = [...new Set((text.match(/CR\d{10,}/gi) || []).map((s) => s.toUpperCase()))].slice(0, 4);
    setParams(found.length ? { ids: found.join(',') } : {});
  };
  const typed = (text.match(/CR\d{10,}/gi) || []).length;

  return (
    <div className="ai-page">
      <PageHeader title="Ad Compare" subtitle="2–4 ads side by side. Paste Ads Transparency links or CR… ids." />
      <AppBuildingTabs />
      <form className="chart-card op-find" onSubmit={go}>
        <textarea
          className="ac-ids"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder={'One per line, e.g.\nhttps://adstransparency.google.com/advertiser/AR…/creative/CR0123456789012345678\nCR0123456789012345678'}
          aria-label="Ad links or ids"
        />
        <button type="submit" className="ui-btn ui-btn-primary" disabled={loading || typed < 1}>{loading ? 'Loading…' : 'Compare'}</button>
        <button type="button" className="ui-btn" onClick={() => { setText(''); setParams({}); }}>Clear</button>
        <div className="ai-kpi-hint">
          Nothing picked yet? Find ads in the <Link to={VIEWER}>Ads Viewer</Link> or <Link to="/app-building/search">Search</Link> and copy their CR… ids.
        </div>
      </form>
      {error ? <div className="ai-note">{error}</div> : null}
      {loading && !d ? <Skeleton /> : null}
      {d && d.missing?.length ? <div className="ai-note">Not in our data yet: {d.missing.join(', ')}</div> : null}
      {d && d.ads.length ? (
        <>
          <div className="ac-grid" style={{ gridTemplateColumns: `repeat(${d.ads.length}, minmax(0, 1fr))` }}>
            {d.ads.map((c) => <CreativeCard key={c.id} c={c} />)}
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th className="left" /> {d.ads.map((a) => <th key={a.id} className="left">{a.id}</th>)}</tr></thead>
              <tbody>
                {ROWS.map(([label, get]) => {
                  const vals = d.ads.map(get);
                  const differs = new Set(vals).size > 1;
                  return (
                    <tr key={label}>
                      <td className="left"><b>{label}</b></td>
                      {vals.map((v, i) => <td key={d.ads[i].id} className={`left${differs ? ' ac-diff' : ''}`}>{v}</td>)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="ai-kpi-hint">Highlighted rows differ between the ads. Ad copy and country reach are not available from the Transparency Center search, so they are not compared.</p>
        </>
      ) : null}
    </div>
  );
}
