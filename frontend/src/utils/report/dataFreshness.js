/**
 * Format coverage + reconciliation freshness labels for Dashboard/Reporting.
 */

function formatRelativeTime(iso) {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return null;
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function buildCoverageLabel(coverage) {
  if (!coverage || !coverage.totalDays) return null;
  const { coveredDays, totalDays, complete } = coverage;
  if (complete) return `${totalDays}/${totalDays} days synced`;
  return `${coveredDays}/${totalDays} days synced — revenue incomplete`;
}

export function buildReconciliationLabel(networkInfo) {
  if (!networkInfo) return null;
  const status = networkInfo.reconciliationStatus;
  const rel = formatRelativeTime(networkInfo.lastReconciliationAt || networkInfo.gamLastSyncedAt);
  if (status === 'fixing') {
    const n = networkInfo.recentDivergent || networkInfo.recentFixes || 0;
    return n > 0 ? `Fixing ${n} day${n === 1 ? '' : 's'}…` : 'Reconciling vs GAM…';
  }
  if (status === 'divergent') {
    const worst = networkInfo.worstDeltaPct;
    return worst != null ? `Revenue gap ${worst}% vs GAM` : 'Revenue divergent vs GAM';
  }
  if (rel) return `Verified vs GAM ${rel}`;
  return null;
}

export function buildFreshnessHint({ coverage, networkInfo, status }) {
  const coverageLabel = buildCoverageLabel(coverage);
  const reconLabel = buildReconciliationLabel(networkInfo);
  const incomplete = Boolean(coverage && coverage.totalDays && !coverage.complete);
  if ((status === 'partial' || incomplete) && coverageLabel) {
    if (reconLabel && (networkInfo?.reconciliationStatus === 'fixing' || networkInfo?.reconciliationStatus === 'divergent')) {
      return `${coverageLabel} · ${reconLabel}`;
    }
    return coverageLabel;
  }
  if (reconLabel && coverageLabel && !coverage?.complete) {
    return `${coverageLabel} · ${reconLabel}`;
  }
  if (reconLabel) return reconLabel;
  if (coverageLabel && !coverage?.complete) return coverageLabel;
  return null;
}
