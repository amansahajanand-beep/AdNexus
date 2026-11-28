import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { marketIntelAPI } from '../../utils/api';
import PageHeader from '../../components/ui/PageHeader';
import AppIcon from '../../components/ads/AppIcon';
import AppBuildingTabs from './AppBuildingTabs';
import { getUserFacingMessage, logErrorForDebug } from '../../utils/userFacingError';
import '../AdInsights.css';
import '../AdsViewer.css';

const nf = new Intl.NumberFormat();
const VIEWER = '/app-building/viewer';
const WINDOWS = [[7, '7 days'], [14, '14 days'], [30, '30 days']];

function Tile({ label, value, hint }) {
  return (
    <div className="gam-overview-metric kpi-tile">
      <span className="gam-overview-metric-value">{value}</span>
      <span className="gam-overview-metric-label">{label}</span>
      {hint ? <span className="gam-overview-metric-hint">{hint}</span> : null}
    </div>
  );
}

const who = (r) => r.app_name || r.advertiser_name;

function AdvertiserCell({ r }) {
  return (
    <td className="left">
      <span className="mi-who">
        <AppIcon src={r.app_icon} name={who(r)} size={30} />
        <span>
          <b>{r.app_name || r.advertiser_name}</b>
          {r.app_name ? <small>{r.advertiser_name}</small> : null}
        </span>
      </span>
    </td>
  );
}

function Section({ title, hint, children }) {
  return (
    <section className="chart-card">
      <div className="chart-header"><h3 className="chart-title">{title}</h3></div>
      {hint ? <div className="ai-kpi-hint" style={{ marginBottom: 10 }}>{hint}</div> : null}
      {children}
    </section>
  );
}

const ViewLink = ({ r, extra = '' }) => (
  <td><Link to={`${VIEWER}?advertiser=${encodeURIComponent(r.advertiser_id)}${extra}`}>Ads →</Link></td>
);

export default function MarketingIntel() {
  const [days, setDays] = useState(7);
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let off = false;
    setD(null);
    setError(null);
    marketIntelAPI.intel(days)
      .then((r) => { if (!off) setD(r); })
      .catch((e) => {
        logErrorForDebug('MarketingIntel', e);
        if (!off) setError(getUserFacingMessage(e, 'Could not load Marketing Intel.'));
      });
    return () => { off = true; };
  }, [days]);

  const skeleton = <div className="ai-card ai-skeleton" style={{ height: 180 }} />;
  const fmtTotal = d ? d.formats.reduce((n, f) => n + f.n, 0) : 0;

  return (
    <div className="ai-page">
      <PageHeader
        title="Marketing Intel"
        subtitle="Which advertisers push hardest, launch the most or keep going — and which are worth cloning."
      >
        <select className="ui-input" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Window">
          {WINDOWS.map(([v, l]) => <option key={v} value={v}>Last {l}</option>)}
        </select>
      </PageHeader>
      <AppBuildingTabs />
      {error ? <div className="ai-note">{error}</div> : null}

      <div className="gam-overview-card ab-kpis">
        <div className="gam-overview-metrics">
          <Tile label="Advertisers active" value={d ? nf.format(d.advertisers) : '—'} hint={`with an ad shown in ${days} days`} />
          <Tile label="Ads running" value={d ? nf.format(d.totals.live_ads) : '—'} hint="shown in the window" />
          <Tile label="New ads" value={d ? nf.format(d.totals.new_ads) : '—'} hint="first shown in the window" />
          <Tile label="Surging advertisers" value={d ? nf.format(d.totals.surging) : '—'} hint="more new ads than the period before" />
        </div>
      </div>

      <Section title="Clone recommendations" hint={`Advertisers pushing hard right now: new ads, ads running and days active in the last ${days} days → score 0–100.`}>
        {!d ? skeleton : !d.recommendations.length ? <div className="ai-kpi-hint">No activity in this window yet.</div> : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>#</th><th className="num">Score</th><th className="left">App / advertiser</th><th className="num">Live ads</th><th className="num">New</th><th className="num">Days active</th><th /></tr></thead>
              <tbody>
                {d.recommendations.map((r, i) => (
                  <tr key={r.advertiser_id}>
                    <td>{i + 1}</td>
                    <td className="num"><span className="mi-score">{r.score}</span></td>
                    <AdvertiserCell r={r} />
                    <td className="num">{nf.format(r.live_ads)}</td>
                    <td className="num"><b>{nf.format(r.new_ads)}</b></td>
                    <td className="num">{r.days_active}</td>
                    <ViewLink r={r} extra={`&seen=${days}d`} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <div className="mi-two">
        <Section title="Best marketing" hint="Most ads running in the window.">
          {!d ? skeleton : (
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th className="left">App / advertiser</th><th className="num">Live ads</th><th className="num">Video</th><th className="num">Longest run</th><th /></tr></thead>
                <tbody>
                  {d.best.map((r) => (
                    <tr key={r.advertiser_id}>
                      <AdvertiserCell r={r} />
                      <td className="num"><b>{nf.format(r.live_ads)}</b></td>
                      <td className="num">{nf.format(r.video_ads)}</td>
                      <td className="num">{r.longest_days}d</td>
                      <ViewLink r={r} extra={`&seen=${days}d`} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <Section title="Surging" hint="Biggest jump in new ads compared with the period before.">
          {!d ? skeleton : !d.surging.length ? <div className="ai-kpi-hint">Nobody has launched 3+ new ads in this window yet.</div> : (
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th className="left">App / advertiser</th><th className="num">New</th><th className="num">Before</th><th className="num">Change</th><th /></tr></thead>
                <tbody>
                  {d.surging.map((r) => (
                    <tr key={r.advertiser_id}>
                      <AdvertiserCell r={r} />
                      <td className="num"><b>{nf.format(r.new_ads)}</b></td>
                      <td className="num">{nf.format(r.prev_new_ads)}</td>
                      <td className="num"><i className={r.new_ads > r.prev_new_ads ? 'op-up' : ''}>{r.growth === null ? 'new' : `${r.growth > 0 ? '+' : ''}${r.growth}%`}</i></td>
                      <ViewLink r={r} extra={`&first=${days}d`} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>

      <Section title="Most consistent" hint="Advertisers that had at least one ad running on the most days of the last 30 — steady spenders.">
        {!d ? skeleton : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th className="left">App / advertiser</th><th className="num">Days with ads (of 30)</th><th className="num">Ads</th><th /></tr></thead>
              <tbody>
                {d.consistent.map((r) => (
                  <tr key={r.advertiser_id}>
                    <AdvertiserCell r={r} />
                    <td className="num">
                      <span className="mi-days"><i style={{ width: `${Math.round((r.days_with_ads / 30) * 100)}%` }} /></span> <b>{r.days_with_ads}</b>
                    </td>
                    <td className="num">{nf.format(r.ads)}</td>
                    <ViewLink r={r} extra="&seen=30d" />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <div className="mi-two">
        <Section title="Format mix" hint={`Ads shown in the last ${days} days.`}>
          {!d ? skeleton : (
            <div className="mi-mix">
              {d.formats.map((f) => (
                <div key={f.format || 'other'} className="mi-mix-row">
                  <span className="mi-mix-name">{f.format || 'other'}</span>
                  <span className="op-bar"><i style={{ width: `${fmtTotal ? Math.max(2, Math.round((f.n / fmtTotal) * 100)) : 0}%` }} /></span>
                  <span className="mi-mix-n">{nf.format(f.n)} · {fmtTotal ? Math.round((f.n / fmtTotal) * 100) : 0}%</span>
                </div>
              ))}
            </div>
          )}
        </Section>
        <Section title="Topics" hint="Words most used in the names of apps being advertised.">
          {!d ? skeleton : !d.topics.length ? <div className="ai-kpi-hint">App names are still being identified by the collector.</div> : (
            <div className="mi-topics">
              {d.topics.map((t) => (
                <Link key={t.word} className="op-btn" to={`${VIEWER}?q=${encodeURIComponent(t.word)}&seen=${days}d`}>{t.word} <b>{nf.format(t.ads)}</b></Link>
              ))}
            </div>
          )}
        </Section>
      </div>

      <p className="ai-kpi-hint">
        Scores use only what the Transparency Center search returns (ad counts, launch dates, days shown). Impression ranges and country footprints are not collected, so there is no reach panel here.
      </p>
    </div>
  );
}
