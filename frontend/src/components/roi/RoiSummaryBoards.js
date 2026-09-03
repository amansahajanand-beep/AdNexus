import React from 'react';
import DataFreshness from '../ui/DataFreshness';
import { buildRoiSummaryGroups } from '../../utils/report/roiView';

function DeltaLine({ change, compareLabel, loading }) {
  if (loading || change === undefined || change === null) return null;
  const n = Number(change);
  if (!Number.isFinite(n) || Math.abs(n) < 0.05) {
    return (
      <span className="gam-overview-delta is-flat">
        No change
        {compareLabel ? <span className="gam-overview-delta-vs"> {compareLabel}</span> : null}
      </span>
    );
  }
  const isDown = n < 0;
  return (
    <span className={`gam-overview-delta ${isDown ? 'down' : 'up'}`}>
      {isDown ? '▼' : '▲'} {Math.abs(n).toFixed(1)}%
      {compareLabel ? <span className="gam-overview-delta-vs"> {compareLabel}</span> : null}
    </span>
  );
}

/**
 * Grouped ROI KPI boards — Ads performance + ROI outcome (Dashboard-style).
 */
export default function RoiSummaryBoards({
  summary = {},
  deltas = {},
  compareLabel = '',
  loading = false,
  networkInfo = null,
  fetchedAt = null,
  showLive = true,
}) {
  const groups = buildRoiSummaryGroups(summary).map((group) => ({
    ...group,
    metrics: group.metrics.map((m) => {
      if (m.key === 'spend') return { ...m, delta: deltas.adsSpend };
      if (m.key === 'earn') return { ...m, delta: deltas.earn };
      if (m.key === 'roiSpend') return { ...m, delta: deltas.roiSpendPercent };
      return m;
    }),
  }));

  return (
    <div className={`roi-kpi-boards${loading ? ' is-loading' : ''}`}>
      {showLive && (
        <div className="roi-kpi-boards-meta">
          <span className="report-live">
            <span className="dot-pulse" /> Live
          </span>
          <DataFreshness networkInfo={networkInfo} fetchedAt={fetchedAt} compact />
        </div>
      )}

      <div className="roi-kpi-boards-grid">
        {groups.map((group) => (
          <section key={group.id} className={`roi-kpi-board roi-kpi-board--${group.id}`}>
            <header className="roi-kpi-board-head">
              <h3 className="roi-kpi-board-title">{group.title}</h3>
              {group.hint ? <span className="roi-kpi-board-hint">{group.hint}</span> : null}
            </header>
            <div
              className="roi-kpi-metrics"
              style={{ '--roi-kpi-cols': String(Math.min(group.metrics.length, 5)) }}
            >
              {group.metrics.map((m) => (
                <div
                  key={m.key}
                  className={`roi-kpi-metric${m.emphasis ? ' is-emphasis' : ''}${m.tone ? ` tone-${m.tone}` : ''}`}
                >
                  <span className="roi-kpi-label">{m.label}</span>
                  <span className={`roi-kpi-value${m.valueTone ? ` is-${m.valueTone}` : ''}`}>
                    {loading
                      ? <span className="card-spinner card-spinner-lg" aria-label="Loading" />
                      : m.value}
                  </span>
                  {'delta' in m ? (
                    <DeltaLine change={m.delta} compareLabel={compareLabel} loading={loading} />
                  ) : (
                    <span className="roi-kpi-spacer" aria-hidden />
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
