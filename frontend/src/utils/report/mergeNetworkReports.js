/**
 * Merge dashboard / report payloads from multiple GAM networks (domain-user combined view).
 * Each network is queried with X-Gam-Client-Id; inventory scope is applied per request on the server.
 */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function mergeTrend(trends = []) {
  const byDate = new Map();
  for (const series of trends) {
    for (const row of (Array.isArray(series) ? series : [])) {
      const date = row?.date;
      if (!date) continue;
      const prev = byDate.get(date) || { date, earning: 0, revenue: 0, impressions: 0, clicks: 0 };
      prev.earning += num(row.earning ?? row.revenue);
      prev.revenue += num(row.revenue ?? row.earning);
      prev.impressions += num(row.impressions);
      prev.clicks += num(row.clicks);
      byDate.set(date, prev);
    }
  }
  return [...byDate.values()]
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map((r) => ({
      ...r,
      earning: +r.earning.toFixed(2),
      revenue: +r.revenue.toFixed(2),
      impressions: Math.round(r.impressions),
      clicks: Math.round(r.clicks),
    }));
}

function weightedPct(parts) {
  let weight = 0;
  let sum = 0;
  for (const { value, impressions } of parts) {
    const imps = num(impressions);
    if (imps <= 0) continue;
    weight += imps;
    sum += num(value) * imps;
  }
  return weight > 0 ? +(sum / weight).toFixed(2) : 0;
}

/** Merge overview (or detail) summary objects by summing metrics. */
export function mergeReportSummaries(summaries = [], currencyFallback = 'USD') {
  const list = (summaries || []).filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return { ...list[0] };

  let impressions = 0;
  let revenue = 0;
  let clicks = 0;
  const viewParts = [];
  let currency = currencyFallback;

  for (const s of list) {
    const imps = num(s.impressions ?? s.pageViews);
    const rev = num(s.revenue ?? s.selectRange ?? s.totalEarning);
    impressions += imps;
    revenue += rev;
    clicks += num(s.clicks);
    viewParts.push({ value: num(s.viewability), impressions: imps });
    if (s.currency) currency = s.currency;
  }

  const ecpm = impressions > 0 ? +((revenue / impressions) * 1000).toFixed(2) : 0;
  const ctr = impressions > 0 ? +((clicks / impressions) * 100).toFixed(4) : 0;
  const viewability = weightedPct(viewParts);
  const rev2 = +revenue.toFixed(2);
  const imps2 = Math.round(impressions);

  return {
    ...list[0],
    impressions: imps2,
    pageViews: imps2,
    revenue: rev2,
    selectRange: rev2,
    totalEarning: rev2,
    clicks: Math.round(clicks),
    ctr,
    ecpm,
    viewability,
    currency,
    // Period deltas are not meaningful when merging networks with different baselines.
    impressionsChange: undefined,
    revenueChange: undefined,
    selectRangeChange: undefined,
    ecpmChange: undefined,
    viewabilityChange: undefined,
    totalEarningChange: undefined,
    pageViewsChange: undefined,
    clicksChange: undefined,
  };
}

export function mergeOverviewResponses(responses = []) {
  const list = (responses || []).filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return list[0];

  const summary = mergeReportSummaries(list.map((r) => r.summary || r));
  const trend = mergeTrend(list.map((r) => r.trend || r.daily));
  return {
    ...list[0],
    summary,
    trend,
    daily: trend,
    currency: summary?.currency || list[0].currency,
    _mergedFrom: list.length,
    _client: undefined,
  };
}

export function mergeDashboardResponses(responses = []) {
  const list = (responses || []).filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return list[0];

  const summary = mergeReportSummaries(list.map((r) => r.summary));
  const trend = mergeTrend(list.map((r) => r.trend));
  const rows = [];
  for (const res of list) {
    const netLabel = res._networkName || res._client?.name || res._clientId || '';
    for (const row of (Array.isArray(res.rows) ? res.rows : [])) {
      rows.push(netLabel ? { ...row, network_name: netLabel } : { ...row });
    }
  }

  const charts = { revenue: [], device: [], country: [], performance: [] };
  // Prefer first non-empty chart series; full chart merge is optional.
  for (const res of list) {
    const c = res.charts || {};
    for (const key of Object.keys(charts)) {
      if (!charts[key].length && Array.isArray(c[key]) && c[key].length) {
        charts[key] = c[key];
      }
    }
  }

  return {
    ...list[0],
    summary,
    trend,
    rows,
    charts,
    currency: summary?.currency || list[0].currency,
    pagination: {
      totalRows: rows.length,
      returnedRows: rows.length,
      truncated: list.some((r) => r.pagination?.truncated),
      compact: true,
      merged: true,
    },
    _mergedFrom: list.length,
    _client: undefined,
  };
}

/** Client UUIDs a domain user should query (all accessible networks). */
export function domainMergeClientIds(user, accountNetworks = []) {
  if (!user || user.role === 'admin') return [];
  const fromNetworks = (accountNetworks || []).map((n) => String(n?.id || '').trim()).filter(Boolean);
  if (fromNetworks.length) return [...new Set(fromNetworks)];
  const primary = user.clientId ? [String(user.clientId)] : [];
  const allowed = Array.isArray(user.permissions?.allowedClientIds)
    ? user.permissions.allowedClientIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  return [...new Set([...primary, ...allowed])];
}
