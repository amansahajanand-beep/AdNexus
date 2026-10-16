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

const countryName = (r) => String(r.countryName || r.countryCode || '').trim().toLowerCase().replace(/_/g, ' ');

/**
 * A country with no Ads spend in a network is listed under a code made from its name (UNITED_STATES), while the same
 * country with spend carries its real code (US). Across networks they are one country: copy every row so the real
 * two-letter code (and its name) is used for all of them.
 */
function unifyCountries(parts) {
  const real = new Map();
  for (const p of parts) {
    for (const k of ['countryBreakdown', 'countryTargetBreakdown', 'countryTargetDailyBreakdown']) {
      for (const r of p[k] || []) {
        if (/^[A-Za-z]{2}$/.test(String(r.countryCode || '')) && r.countryName) real.set(countryName(r), { code: String(r.countryCode).toUpperCase(), name: r.countryName });
      }
    }
  }
  const fix = (r) => {
    if (/^[A-Za-z]{2}$/.test(String(r.countryCode || ''))) return r;
    const hit = real.get(countryName(r));
    return hit ? { ...r, countryCode: hit.code, countryName: hit.name } : r;
  };
  return parts.map((p) => ({
    ...p,
    ...Object.fromEntries(['countryBreakdown', 'countryTargetBreakdown', 'countryTargetDailyBreakdown']
      .filter((k) => Array.isArray(p[k])).map((k) => [k, p[k].map(fix)])),
  }));
}


const cKey = (r) => String(r.countryName || r.countryCode || '').trim().toLowerCase().replace(/_/g, ' ');

/**
 * Earn one network holds for an app that another network has the Ads spend rows for (spend in network A, revenue in
 * network B). Each network can only attach earn to its own spend rows, so B hands the earn back as `earnOnlyTargets`
 * and it is added here to the matching spend rows (shared out by spend when several accounts spend on it).
 * Earn with no spend row anywhere is dropped, as in a single network ("Ads-linked apps only").
 */
function foldEarnOnly(rows, entries, withDate) {
  const addedByCountry = new Map();
  if (!Array.isArray(rows) || !entries?.length) return addedByCountry;
  const groups = new Map();
  for (const r of rows) {
    if (!(Number(r.adsSpend) > 0)) continue;
    const k = `${withDate ? `${r.date}|` : ''}${r.targetType}|${String(r.targetKey || '').toLowerCase()}|${cKey(r)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const touched = new Set();
  for (const e of entries) {
    const k = `${withDate ? `${e.date}|` : ''}${e.targetType}|${String(e.targetKey || '').toLowerCase()}|${String(e.countryKey || '').replace(/_/g, ' ')}`;
    const list = groups.get(k);
    if (!list) continue;
    const total = list.reduce((a, r) => a + (Number(r.adsSpend) || 0), 0);
    const cc = String(e.countryKey || '').replace(/_/g, ' ');
    addedByCountry.set(cc, (addedByCountry.get(cc) || 0) + (Number(e.earn) || 0));
    for (const r of list) {
      const part = (Number(e.earn) || 0) * ((Number(r.adsSpend) || 0) / total);
      r.earn = (Number(r.earn) || 0) + part;
      r.profitSpend = (Number(r.profitSpend) || 0) + part;
      r.profitExpense = (Number(r.profitExpense) || 0) + part;
      touched.add(r);
    }
  }
  for (const r of touched) redoRatios(r, r);
  return addedByCountry;
}

/** parts: the getRoiSummary results of each network (any of summaryOnly, breakdownOnly or full). */
function mergeRoiParts(parts) {
  const found = parts.filter(Boolean);
  if (found.length <= 1) return found[0] || null;
  const ok = unifyCountries(found);
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
  const entries = (k) => ok.flatMap((p) => p.earnOnlyTargets?.[k] || []);
  if (ok.some((p) => p.earnOnlyTargets)) {
    const added = foldEarnOnly(out.countryTargetBreakdown, entries('range'), false);
    foldEarnOnly(out.countryTargetDailyBreakdown, entries('daily'), true);
    // The country rows' own totals must carry the same earn as the packages under them.
    if (Array.isArray(out.countryBreakdown) && added.size) {
      for (const r of out.countryBreakdown) {
        const extra = added.get(cKey(r));
        if (!extra) continue;
        r.earn = (Number(r.earn) || 0) + extra;
        if (r.profitSpend != null) r.profitSpend = (Number(r.profitSpend) || 0) + extra;
        if (r.profitExpense != null) r.profitExpense = (Number(r.profitExpense) || 0) + extra;
        redoRatios(r, r);
      }
    }
    delete out.earnOnlyTargets;
  }
  return out;
}

module.exports = { mergeRoiParts };
