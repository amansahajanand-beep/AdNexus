/**
 * Adds ROI responses of several networks into one (a domain user assigned to more than one network sees them together,
 * like the Dashboard). Amounts, impressions, clicks and conversions are added; every percentage and rate is worked out
 * again from the added totals, never averaged.
 */
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const ADD = [
  'adsSpend', 'otherExpenses', 'totalCost', 'earn', 'profitSpend', 'profitExpense', 'profit',
  'impressions', 'clicks', 'conversions', 'mappedSpend', 'unmappedSpend', 'mappedCampaigns', 'accountsWithSpend',
];

function roiPercent(earn, cost) {
  const c = Number(cost) || 0;
  if (c <= 0) return null;
  return round2((((Number(earn) || 0) - c) / c) * 100);
}

/** Add the numeric fields of `src` into `dst` (only the ones `src` has), then redo the ratios `dst` carries. */
function accumulate(dst, src) {
  for (const f of ADD) {
    if (src[f] != null && Number.isFinite(Number(src[f]))) dst[f] = (Number(dst[f]) || 0) + Number(src[f]);
  }
  if (src.spendByAccount && typeof src.spendByAccount === 'object') {
    const sum = { ...(dst.spendByAccount || {}) };
    for (const [id, v] of Object.entries(src.spendByAccount)) sum[id] = round2((Number(sum[id]) || 0) + (Number(v) || 0));
    dst.spendByAccount = sum;
  }
  return dst;
}

function redoRatios(row, template) {
  for (const f of ADD) if (row[f] != null && typeof row[f] === 'number') row[f] = f === 'impressions' || f === 'clicks' ? Math.round(row[f]) : round2(row[f]);
  const has = (k) => Object.prototype.hasOwnProperty.call(template, k);
  const spend = Number(row.adsSpend) || 0;
  const imps = Number(row.impressions) || 0;
  const cost = row.totalCost != null ? Number(row.totalCost) : spend + (Number(row.otherExpenses) || 0);
  // Earn-only rows (sites without Ads spend) show no ROI on spend.
  if (has('roiSpendPercent')) row.roiSpendPercent = row.earnOnly ? null : roiPercent(row.earn, spend);
  if (has('roiExpensePercent')) row.roiExpensePercent = roiPercent(row.earn, row.otherExpenses);
  if (has('roiPercent')) row.roiPercent = roiPercent(row.earn, cost);
  if (has('ctr')) row.ctr = imps > 0 ? round2(((Number(row.clicks) || 0) / imps) * 100) : null;
  if (has('ecpm')) {
    const revenueEcpm = row.earnOnly && !(spend > 0);
    row.ecpm = imps > 0 ? round2(((revenueEcpm ? Number(row.earn) || 0 : spend) / imps) * 1000) : null;
  }
  return row;
}

function mergeKeyed(lists, keyOf) {
  const out = new Map();
  for (const list of lists) {
    for (const r of list || []) {
      const key = keyOf(r);
      const cur = out.get(key);
      if (!cur) out.set(key, { template: r, row: { ...r, ...(r.spendByAccount ? { spendByAccount: { ...r.spendByAccount } } : {}) } });
      else accumulate(cur.row, r);
    }
  }
  return [...out.values()].map(({ row, template }) => redoRatios(row, template));
}

const dedupeBy = (lists, keyOf) => {
  const seen = new Map();
  for (const list of lists) for (const r of list || []) if (!seen.has(keyOf(r))) seen.set(keyOf(r), r);
  return [...seen.values()];
};

/** parts: the getRoiSummary results of each network (any of summaryOnly, breakdownOnly or full). */
function mergeRoiParts(parts) {
  const ok = parts.filter(Boolean);
  if (ok.length <= 1) return ok[0] || null;
  const first = ok[0];
  const out = { ...first };

  if (ok.some((p) => p.summary)) {
    const summaries = ok.map((p) => p.summary).filter(Boolean);
    const sum = { ...summaries[0] };
    for (const s of summaries.slice(1)) accumulate(sum, s);
    out.summary = redoRatios(sum, summaries[0]);
  }
  const lists = (k) => ok.map((p) => p[k]);
  if (ok.some((p) => Array.isArray(p.accounts))) {
    out.accounts = dedupeBy(lists('accounts'), (a) => String(a.id ?? a.adsAccountId ?? JSON.stringify(a)));
  }
  if (ok.some((p) => Array.isArray(p.rows))) {
    out.rows = mergeKeyed(lists('rows'), (r) => `${r.date}|${r.targetType}|${r.targetKey}`);
  }
  if (ok.some((p) => Array.isArray(p.countryBreakdown))) {
    out.countryBreakdown = mergeKeyed(lists('countryBreakdown'), (r) => String(r.countryCode || r.countryName || '').toUpperCase())
      .sort((a, b) => (b.adsSpend - a.adsSpend) || String(a.countryName).localeCompare(String(b.countryName)));
  }
  if (ok.some((p) => Array.isArray(p.countryTargetBreakdown))) {
    out.countryTargetBreakdown = mergeKeyed(
      lists('countryTargetBreakdown'),
      (r) => `${r.adsAccountId}|${r.targetType}|${r.targetKey}|${r.countryCode}|${r.countryName}`
    );
  }
  if (ok.some((p) => Array.isArray(p.countryTargetDailyBreakdown))) {
    out.countryTargetDailyBreakdown = mergeKeyed(
      lists('countryTargetDailyBreakdown'),
      (r) => `${r.date}|${r.adsAccountId}|${r.targetType}|${r.targetKey}|${r.countryCode}|${r.countryName}`
    );
  }
  for (const k of ['generalExpenses', 'expenses']) {
    if (ok.some((p) => Array.isArray(p[k]))) out[k] = dedupeBy(lists(k), (e) => String(e.id ?? JSON.stringify(e)));
  }
  return out;
}

module.exports = { mergeRoiParts };
