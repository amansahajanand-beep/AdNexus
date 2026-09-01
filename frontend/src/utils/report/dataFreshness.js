/**
 * Format sync / freshness timestamps for UI.
 */

export function formatFreshnessTime(iso, tzLabel = 'SGT') {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const text = d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    return `${text} ${tzLabel}`.trim();
  } catch {
    return null;
  }
}

export function relativeFreshness(iso) {
  if (!iso) return null;
  try {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return null;
    const mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 36) return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    return `${days}d ago`;
  } catch {
    return null;
  }
}

/** Prefer GAM sync, then Ads sync, for a short label. */
export function buildFreshnessLabel(info, { fetchedAt = null, tzLabel = 'SGT' } = {}) {
  const gam = info?.gamLastSyncedAt || info?.gamLastSyncAt;
  const ads = info?.adsLastSyncedAt || info?.adsLastSyncAt;
  const parts = [];
  if (gam) {
    const rel = relativeFreshness(gam);
    parts.push(`GAM sync ${rel || formatFreshnessTime(gam, tzLabel)}`);
  }
  if (ads) {
    const rel = relativeFreshness(ads);
    parts.push(`Ads ${rel || formatFreshnessTime(ads, tzLabel)}`);
  }
  if (!parts.length && fetchedAt) {
    parts.push(`Updated ${fetchedAt}${tzLabel ? ` ${tzLabel}` : ''}`);
  }
  return parts.join(' · ') || null;
}

export default {
  formatFreshnessTime,
  relativeFreshness,
  buildFreshnessLabel,
};
