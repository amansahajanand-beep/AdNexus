import React from 'react';
import { buildFreshnessLabel, relativeFreshness } from '../../utils/dataFreshness';

/**
 * Compact “data as of” line for page Live chips / Layout.
 * Prefer server sync times from network info; fall back to client fetch time.
 */
export default function DataFreshness({
  networkInfo,
  fetchedAt = null,
  tzLabel = 'SGT',
  className = '',
  compact = false,
}) {
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
