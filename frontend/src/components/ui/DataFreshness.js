import React from 'react';
import { buildFreshnessLabel, relativeFreshness } from '../../utils/dataFreshness';
import { buildFreshnessHint } from '../../utils/report/dataFreshness';

/**
 * Compact sync-time line (Layout live chip) or coverage/reconciliation hint (Dashboard/Reporting).
 */
export default function DataFreshness({
  coverage,
  networkInfo,
  status,
  fetchedAt = null,
  tzLabel = 'SGT',
  className = '',
  compact = false,
}) {
  const hintMode = coverage != null || status != null;
  const hint = hintMode ? buildFreshnessHint({ coverage, networkInfo, status }) : null;

  if (hint) {
    const partial = status === 'partial' || (coverage && !coverage.complete);
    const fixing = networkInfo?.reconciliationStatus === 'fixing';
    const divergent = networkInfo?.reconciliationStatus === 'divergent';

    let tone = 'freshness-ok';
    if (fixing) tone = 'freshness-fixing';
    else if (divergent) tone = 'freshness-warn';
    else if (partial) tone = 'freshness-partial';

    return (
      <span className={`data-freshness ${tone} ${className}`.trim()} title={hint}>
        {fixing && <span className="dot-pulse" aria-hidden="true" />}
        {hint}
      </span>
    );
  }

  const label = buildFreshnessLabel(networkInfo, { fetchedAt, tzLabel });
  if (!label) return null;

  const gam = networkInfo?.gamLastSyncedAt;
  const title = [
    gam ? `GAM last sync: ${new Date(gam).toLocaleString()}` : null,
    networkInfo?.adsLastSyncedAt
      ? `Ads last sync: ${new Date(networkInfo.adsLastSyncedAt).toLocaleString()}`
      : null,
  ].filter(Boolean).join('\n');

  if (compact) {
    const short = gam
      ? `Synced ${relativeFreshness(gam) || '—'}`
      : label;
    return (
      <span className={`data-freshness data-freshness--compact ${className}`.trim()} title={title || label}>
        {short}
      </span>
    );
  }

  return (
    <span className={`data-freshness ${className}`.trim()} title={title || undefined}>
      {label}
    </span>
  );
}
