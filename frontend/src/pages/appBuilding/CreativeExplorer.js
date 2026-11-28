import React from 'react';
import { Link } from 'react-router-dom';
import { marketIntelAPI } from '../../utils/api';
import PageHeader from '../../components/ui/PageHeader';
import AppBuildingTabs from './AppBuildingTabs';
import { Section, Skeleton, useLoad, nf, VIEWER } from './shared';
import '../AdInsights.css';
import '../AdsViewer.css';

function Bars({ rows, label, value, sub, to }) {
  const max = Math.max(1, ...rows.map((r) => r[value]));
  return (
    <div className="ce-bars">
      {rows.map((r) => {
        const row = (
          <>
            <span className="ce-name" title={label(r)}>{label(r)}</span>
            <span className="op-bar"><i style={{ width: `${Math.max(2, Math.round((r[value] / max) * 100))}%` }} /></span>
            <span className="ce-n">{nf.format(r[value])}{sub ? ` · ${sub(r)}` : ''}</span>
          </>
        );
        return to ? <Link key={label(r)} className="ce-row" to={to(r)}>{row}</Link> : <div key={label(r)} className="ce-row">{row}</div>;
      })}
    </div>
  );
}

export default function CreativeExplorer() {
  const { data: d, error } = useLoad(() => marketIntelAPI.explorer(), [], 'CreativeExplorer', 'Could not load Creative Explorer.');

  return (
    <div className="ai-page">
      <PageHeader title="Creative Explorer" subtitle="Browse every collected creative by advertiser, format, size, age and launch month." />
      <AppBuildingTabs />
      {error ? <div className="ai-note">{error}</div> : null}

      <div className="mi-two">
        <Section title="By format" hint="Ads collected, with how many are still running and their average days shown.">
          {!d ? <Skeleton h={120} /> : (
            <Bars
              rows={d.formats}
              label={(r) => r.format || 'other'}
              value="ads"
              sub={(r) => `${nf.format(r.active)} live · avg ${r.avg_days}d`}
              to={(r) => `${VIEWER}?format=${encodeURIComponent(r.format)}`}
            />
          )}
        </Section>
        <Section title="How long ads run" hint="Days an ad has been shown. Long runs mean the advertiser keeps paying for it.">
          {!d ? <Skeleton h={120} /> : <Bars rows={d.longevity} label={(r) => r.bucket} value="ads" />}
        </Section>
      </div>

      <Section title="Launches by month" hint="New ads by the month they first appeared (last 12 months).">
        {!d ? <Skeleton h={120} /> : !d.monthly.length ? <div className="ai-kpi-hint">No launches in the last 12 months.</div> : (
          <Bars rows={d.monthly} label={(r) => r.month} value="ads" />
        )}
      </Section>

      <div className="mi-two">
        <Section title="Top advertisers" hint="Most ads collected. Click one to see its ads.">
          {!d ? <Skeleton /> : (
            <Bars
              rows={d.top}
              label={(r) => r.advertiser_name || r.advertiser_id}
              value="ads"
              sub={(r) => `${nf.format(r.active)} live`}
              to={(r) => `${VIEWER}?advertiser=${encodeURIComponent(r.advertiser_id)}`}
            />
          )}
        </Section>
        <Section title="Ad sizes" hint="Most common image and display sizes (pixels).">
          {!d ? <Skeleton /> : !d.sizes.length ? <div className="ai-kpi-hint">No size data.</div> : (
            <Bars rows={d.sizes} label={(r) => `${r.width} × ${r.height}`} value="ads" />
          )}
        </Section>
      </div>
    </div>
  );
}
