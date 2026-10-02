/**
 * Fact sheets for Google Ad Manager presets. Dashboard and ROI use the fast overview and summary
 * endpoints for both periods. The Reporting preset reads the detailed report, which can be slow, so
 * it runs with a time budget and the analysis still works from totals when it is unavailable.
 */
const {
  num, pctChange, formatMoney, formatCount, formatPercent, formatChange, topShare, findAnomalies,
} = require('./factBook');
const { todayInTZ, shiftYMD } = require('../../utils/datetime');
const {
  newSheet, downsample, round, isSmall, MATERIAL_AMOUNT, setTrendChart, addBarChart, addCompare,
} = require('./common');

const INVENTORY_KEYS = ['domain', 'site', 'domainName', 'domainId', 'country'];
const ROI_KEYS = ['accountIds', 'campaignIds', 'appKeys', 'siteKeys', 'countryCodes'];
const DETAIL_BUDGET_MS = 12_000;

function csv(request, keys) {
  const q = {};
  for (const k of keys) if (request.filters[k]?.length) q[k] = request.filters[k].join(',');
  return q;
}

function lists(request, keys) {
  const q = {};
  for (const k of keys) if (request.filters[k]?.length) q[k] = [...request.filters[k]];
  return q;
}

function coverageSignals(sheet, coverage) {
  if (!coverage) return;
  if (coverage.complete === false) {
    const missing = (coverage.missingDates || []).slice(0, 3).join(', ');
    sheet.signals.add(
      'warning', 'coverage', 'Some days are not loaded yet',
      `${coverage.missingDays ?? 'Some'} of ${coverage.totalDays ?? 'the'} days in this range have no data yet${missing ? ` (${missing}${(coverage.missingDates || []).length > 3 ? ', ...' : ''})` : ''}, so totals are understated.`,
      [], { priority: 7 }
    );
  } else if (coverage.revenueConfidence && coverage.revenueConfidence !== 'verified') {
    sheet.notes.push(`Revenue is ${coverage.revenueConfidence}, not yet verified against Google's final figures.`);
  }
  if (coverage.newestFilled) sheet.syncedAt = `${coverage.newestFilled}T23:59:59.000Z`;
}

function revenueSignals(sheet, { revenue, impressions, ecpm }, prevRevenue) {
  if (!revenue) return;
  if (isSmall(revenue.value, prevRevenue)) {
    sheet.small = true;
    sheet.notes.push('Revenue is very small in both periods, so percentage changes are not meaningful.');
    return;
  }
  const ch = revenue.change;
  if (ch != null) {
    const base = `Revenue is ${formatMoney(revenue.value, sheet.currency)}, ${formatChange(ch)} against ${formatMoney(prevRevenue, sheet.currency)} in the prior period.`;
    if (ch <= -25) {
      sheet.signals.add('critical', 'metric_drop', `Revenue fell ${Math.abs(ch).toFixed(0)}%`, base, [revenue.id], {
        priority: 9,
        action: { title: 'Find where the drop comes from', detail: 'Open Reporting and compare domains, ad units and countries with the prior period.' },
      });
    } else if (ch <= -10) {
      sheet.signals.add('warning', 'metric_drop', `Revenue is down ${Math.abs(ch).toFixed(0)}%`, base, [revenue.id], { priority: 7 });
    } else if (ch >= 20) {
      sheet.signals.add('positive', 'metric_rise', `Revenue is up ${ch.toFixed(0)}%`, base, [revenue.id], { priority: 6 });
    }
  }
  if (impressions && ecpm && impressions.change != null && ecpm.change != null && impressions.change >= 5 && ecpm.change <= -8) {
    sheet.signals.add(
      'warning', 'price_volume', 'Volume is up but eCPM is down',
      `Impressions rose ${formatChange(impressions.change)} while eCPM fell ${formatChange(ecpm.change)}, so growth is coming from volume at lower prices.`,
      [impressions.id, ecpm.id], { priority: 8 }
    );
  }
}

async function buildDashboardSheet({ request, call }) {
  const sheet = newSheet(request, 'Google Ad Manager dashboard');
  const inv = csv(request, INVENTORY_KEYS);
  const [cur, prev] = await Promise.all([
    call('reports', '/dashboard/overview', { startDate: request.start, endDate: request.end, ...inv }, { required: true }),
    call('reports', '/dashboard/overview', { startDate: request.compare.start, endDate: request.compare.end, ...inv }),
  ]);
  const s = cur.summary || {};
  const p = prev?.summary || {};
  sheet.currency = cur.currency || s.currency || 'USD';
  sheet.book.currency = sheet.currency;
  coverageSignals(sheet, cur.coverage);

  if (!(num(s.revenue) > 0) && !(num(s.impressions) > 0)) {
    sheet.noData = true;
    sheet.signals.add('info', 'no_data', 'No data for this period', 'There is no revenue or traffic for these filters in the selected dates.', [], { priority: 1 });
    return sheet;
  }

  const m = {};
  const add = (key, label, value, unit, prevValue) => {
    if (value == null || (unit === 'count' && key === 'clicks' && !(num(value) > 0))) return;
    const id = sheet.book.add(label, value, unit, { prev: prevValue });
    m[key] = { id, value: num(value), change: pctChange(value, prevValue), label };
    sheet.metricIds.push(id);
  };
  add('revenue', 'Revenue', s.revenue, 'money', p.revenue);
  add('impressions', 'Impressions', s.impressions, 'count', p.impressions);
  add('ecpm', 'eCPM', s.ecpm, 'money', p.ecpm);
  add('viewability', 'Viewability', s.viewability, 'percent', p.viewability);
  add('clicks', 'Clicks', s.clicks, 'count', p.clicks);
  addCompare(sheet, 'Revenue', 'money', s.revenue, p.revenue);
  addCompare(sheet, 'Impressions', 'count', s.impressions, p.impressions);
  addCompare(sheet, 'eCPM', 'money', s.ecpm, p.ecpm);
  revenueSignals(sheet, m, num(p.revenue));
  sheet.notes.push('Breakdowns by domain, ad unit and country are not part of this summary.');
  return sheet;
}

async function buildRoiSheet({ request, call }) {
  const sheet = newSheet(request, 'Google Ad Manager ROI');
  const base = { targetType: 'all', summaryOnly: '1', ...csv(request, ROI_KEYS) };
  const [cur, prev] = await Promise.all([
    call('roi', '/summary', { start: request.start, end: request.end, ...base }, { required: true }),
    call('roi', '/summary', { start: request.compare.start, end: request.compare.end, ...base }),
  ]);
  const s = cur.summary || {};
  const p = prev?.summary || {};
  sheet.currency = s.adsSpendCurrency || cur.spendCurrency || 'USD';
  sheet.book.currency = sheet.currency;

  if (!(num(s.earn) > 0) && !(num(s.adsSpend) > 0)) {
    sheet.noData = true;
    sheet.signals.add('info', 'no_data', 'No data for this period', 'There is no GAM earnings or Google Ads spend for these filters in the selected dates.', [], { priority: 1 });
    return sheet;
  }

  const spendId = sheet.book.add('Google Ads spend', s.adsSpend, 'money', { prev: p.adsSpend });
  const earnId = sheet.book.add('GAM earnings', s.earn, 'money', { prev: p.earn });
  const profitId = sheet.book.add('Profit (earnings minus spend)', s.profit, 'money', { prev: p.profit });
  const roiNow = num(s.roiSpendPercent ?? s.roiPercent);
  const roiPrev = num(p.roiSpendPercent ?? p.roiPercent);
  const roiId = sheet.book.add('ROI on spend', roiNow, 'percent', {
    change: null,
    detail: roiNow != null && roiPrev != null
      ? `${roiNow - roiPrev >= 0 ? '+' : '−'}${Math.abs(roiNow - roiPrev).toFixed(1)} points vs prior`
      : undefined,
  });
  sheet.metricIds.push(spendId, earnId, profitId, roiId);
  addCompare(sheet, 'Google Ads spend', 'money', s.adsSpend, p.adsSpend);
  addCompare(sheet, 'GAM earnings', 'money', s.earn, p.earn);
  addCompare(sheet, 'Profit', 'money', s.profit, p.profit);
  if (num(s.impressions) > 0) sheet.metricIds.push(sheet.book.add('Ads impressions', s.impressions, 'count', { prev: p.impressions }));
  if (num(s.clicks) > 0) sheet.metricIds.push(sheet.book.add('Ads clicks', s.clicks, 'count', { prev: p.clicks }));
  const unmappedId = num(s.unmappedSpend) > 0
    ? sheet.book.add('Spend not mapped to a site or app', s.unmappedSpend, 'money')
    : null;
  if (unmappedId) sheet.metricIds.push(unmappedId);

  const spend = num(s.adsSpend) || 0;
  if (spend <= 0) {
    sheet.signals.add(
      'warning', 'no_spend', 'No Google Ads spend is matched',
      'No mapped Google Ads spend is found for these filters, so ROI cannot be calculated.',
      [spendId],
      { priority: 8, action: { title: 'Check campaign mapping', detail: 'In Admin, open Google Ads accounts and check Campaign mapping for each campaign.' } }
    );
  } else {
    if (roiNow != null && roiNow < 0) {
      sheet.signals.add('critical', 'negative_roi', `ROI is ${roiNow.toFixed(0)}%: spend exceeds earnings`,
        `Google Ads spend is ${formatMoney(spend, sheet.currency)} against ${formatMoney(s.earn, sheet.currency)} of GAM earnings.`,
        [spendId, earnId, roiId], { priority: 10 });
    }
    if (roiNow != null && roiPrev != null) {
      const delta = roiNow - roiPrev;
      if (delta <= -20) sheet.signals.add('warning', 'roi_drop', 'ROI fell against the prior period', `ROI is ${formatPercent(roiNow)}, down ${Math.abs(delta).toFixed(1)} points from ${formatPercent(roiPrev)}.`, [roiId], { priority: 7 });
      else if (delta >= 20) sheet.signals.add('positive', 'roi_rise', 'ROI improved against the prior period', `ROI is ${formatPercent(roiNow)}, up ${delta.toFixed(1)} points from ${formatPercent(roiPrev)}.`, [roiId], { priority: 5 });
    }
    const unmapped = num(s.unmappedSpend) || 0;
    if (unmappedId && unmapped >= MATERIAL_AMOUNT && unmapped / (spend + unmapped) >= 0.05) {
      sheet.signals.add('warning', 'unmatched_spend', `${formatMoney(unmapped, sheet.currency)} of spend is not mapped`,
        'Some campaign spend is not linked to a site or app, so it cannot be attributed to earnings.',
        [unmappedId], {
          priority: 6,
          action: { title: 'Map the remaining campaigns', detail: 'In Admin, open Google Ads accounts and use Campaign mapping to link the unmapped campaigns.' },
        });
    }
  }
  sheet.notes.push('Per-site and per-app ROI rows are not part of this summary.');
  return sheet;
}

/** Revenue and impressions per date from a date-level report. */
function dailyTotals(res) {
  const out = new Map();
  for (const r of Array.isArray(res?.rows) ? res.rows : []) {
    if (!r.date) continue;
    const d = out.get(r.date) || { rev: 0, imp: 0 };
    d.rev += num(r.revenue) || 0;
    d.imp += num(r.impression ?? r.impressions) || 0;
    out.set(r.date, d);
  }
  return out;
}

function sumRange(daily, from, to) {
  const t = { rev: 0, imp: 0, days: 0 };
  for (const [date, v] of daily) {
    if (date >= from && date <= to) { t.rev += v.rev; t.imp += v.imp; t.days += 1; }
  }
  return t;
}

const LABEL_FIELDS =['domainName', 'siteName', 'appName', 'country', 'device', 'site', 'appPackage'];
const BLANK = new Set(['', '—', '-', 'null', 'undefined']);

async function buildReportingSheet({ request, call }) {
  const sheet = newSheet(request, 'Google Ad Manager reporting');
  const query = {
    startDate: request.start,
    endDate: request.end,
    // The reporting endpoint reads lists as repeated parameters (as the page sends them), not as "a,b,c".
    ...lists(request, [...INVENTORY_KEYS, 'reportDimensions', 'reportMetrics']),
    allRows: 'true',
  };
  if (!query.reportDimensions) query.reportDimensions = ['date'];
  // A second query over a wider window gives the prior period and a daily trend for context (the report itself may
  // be a single day). It is optional: when it is slow or fails the analysis still works from the report.
  const ctxStart = [request.compare.start, shiftYMD(request.end, -13)].sort()[0];
  // It reuses the preset's own dimensions and metrics: a different query shape can fall onto a slow live path.
  const contextP = call('reports', '/detailed', { ...query, startDate: ctxStart, endDate: request.end }, { timeoutMs: DETAIL_BUDGET_MS });
  const [res, contextRes] = await Promise.all([
    call('reports', '/detailed', query, { required: true, timeoutMs: DETAIL_BUDGET_MS }),
    contextP,
  ]);
  const rows = Array.isArray(res.rows) ? res.rows : [];
  sheet.currency = res.summary?.currency || res.currency || 'USD';
  sheet.book.currency = sheet.currency;

  const revenue = rows.reduce((a, r) => a + (num(r.revenue) || 0), 0);
  const impressions = rows.reduce((a, r) => a + (num(r.impression ?? r.impressions) || 0), 0);
  if (!rows.length || (revenue <= 0 && impressions <= 0)) {
    sheet.noData = true;
    sheet.signals.add('info', 'no_data', 'No data for this period', 'The report has no rows for these filters in the selected dates.', [], { priority: 1 });
    return sheet;
  }

  const daily = dailyTotals(contextRes);
  const prior = sumRange(daily, request.compare.start, request.compare.end);
  const now = sumRange(daily, request.start, request.end);
  const hasPrior = prior.days > 0 && prior.rev > 0 && now.days > 0;
  const ecpmNow = impressions > 0 ? (revenue / impressions) * 1000 : 0;
  const ecpmPrior = prior.imp > 0 ? (prior.rev / prior.imp) * 1000 : null;
  // Today is still in progress, so setting it against a full earlier period would look like a drop that is not real.
  const partial = request.end >= todayInTZ();
  const showChange = hasPrior && !partial;
  const priorDetail = (text) => (hasPrior ? { detail: `${partial ? 'full prior period' : 'prior period'} ${text}` } : {});
  const m = {};
  const addMetric = (key, label, value, unit, change, text) => {
    const id = sheet.book.add(label, value, unit, { change: showChange ? change : null, ...priorDetail(text) });
    m[key] = { id, value, change: showChange ? change : null, label };
    sheet.metricIds.push(id);
  };
  addMetric('revenue', 'Revenue in this report', revenue, 'money', pctChange(now.rev, prior.rev), formatMoney(prior.rev, sheet.currency));
  addMetric('impressions', 'Impressions in this report', impressions, 'count', pctChange(now.imp, prior.imp), formatCount(prior.imp));
  addMetric('ecpm', 'eCPM', ecpmNow, 'money', ecpmPrior == null ? null : pctChange(now.imp > 0 ? (now.rev / now.imp) * 1000 : null, ecpmPrior), formatMoney(ecpmPrior, sheet.currency));
  if (showChange) {
    addCompare(sheet, 'Revenue', 'money', now.rev, prior.rev);
    addCompare(sheet, 'Impressions', 'count', now.imp, prior.imp);
    if (ecpmPrior != null && now.imp > 0) addCompare(sheet, 'eCPM', 'money', (now.rev / now.imp) * 1000, ecpmPrior);
    revenueSignals(sheet, m, prior.rev);
  } else if (hasPrior) {
    sheet.signals.add(
      'info', 'partial_period', 'Today is still in progress',
      `Revenue so far is ${formatMoney(revenue, sheet.currency)} against ${formatMoney(prior.rev, sheet.currency)} for the full prior period. Today's figures keep growing, so this is not a drop.`,
      [m.revenue.id], { priority: 3 }
    );
  }

  // Daily trend: from the context query when it has more than one day, else from the report itself.
  const byDate = new Map();
  for (const r of rows) {
    if (!r.date) continue;
    byDate.set(r.date, (byDate.get(r.date) || 0) + (num(r.revenue) || 0));
  }
  const dailyPoints = [...daily.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, v: v.rev }));
  const points = dailyPoints.length > 1
    ? dailyPoints
    : [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, v }));
  if (points.length > 1) {
    // Today's partial total would always look like a dip.
    const anomalies = !sheet.small ? findAnomalies(points.filter((p) => p.date < todayInTZ())) : [];
    const anomalyOut = anomalies.map((a) => {
      const id = sheet.book.add(`${a.date} revenue`, a.value, 'money', { detail: `${formatChange(a.deviationPct)} compared with the other days shown` });
      sheet.signals.add(
        a.deviationPct < 0 ? 'warning' : 'info', 'anomaly',
        a.deviationPct < 0 ? `Revenue dipped on ${a.date}` : `Revenue spiked on ${a.date}`,
        `${a.date} earned ${formatMoney(a.value, sheet.currency)}, ${formatChange(a.deviationPct)} compared with the other days shown.`,
        [id], { priority: 4 }
      );
      return { day: a.date, factId: id, deviation_pct: round(a.deviationPct, 1) };
    });
    const shown = downsample(points);
    sheet.trend = { label: 'Daily revenue', points: shown, anomalies: anomalyOut };
    setTrendChart(sheet, 'Daily revenue', 'money', shown, anomalyOut.map((a) => a.day));
  }
  if (partial) {
    sheet.notes.push('The range includes today, which is still in progress, so its figures will keep growing.');
  }

  const fields = LABEL_FIELDS.filter((f) => rows.some((r) => r[f] != null && !BLANK.has(String(r[f]).trim()))).slice(0, 3);
  if (!fields.length) {
    sheet.notes.push('The report rows carry no item names (site, domain, country) for these dates, so only totals can be analysed.');
  }
  for (const field of fields) {
    const groups = new Map();
    for (const r of rows) {
      const name = String(r[field] ?? '').trim();
      if (BLANK.has(name)) continue;
      const g = groups.get(name) || { name, revenue: 0, impressions: 0 };
      g.revenue += num(r.revenue) || 0;
      g.impressions += num(r.impression ?? r.impressions) || 0;
      groups.set(name, g);
    }
    const list = [...groups.values()].sort((a, b) => b.revenue - a.revenue);
    if (list.length) {
      const ids = list.slice(0, 8).map((g) => sheet.book.add(`${field} ${g.name}`, g.revenue, 'money', {
        share: revenue > 0 ? (g.revenue / revenue) * 100 : null,
        detail: g.impressions > 0 ? `eCPM ${formatMoney((g.revenue / g.impressions) * 1000, sheet.currency)}, ${formatCount(g.impressions)} impressions` : undefined,
      }));
      addBarChart(sheet, field, 'money', list.slice(0, 8).map((g) => ({
        name: g.name, value: g.revenue, share: revenue > 0 ? (g.revenue / revenue) * 100 : null,
      })), { totalValue: revenue });
      sheet.breakdowns.push({
        by: field,
        rows: ids,
        top1_share_pct: round(topShare(list, 'revenue', 1), 1),
        top3_share_pct: round(topShare(list, 'revenue', 3), 1),
        items_in_period: list.length,
      });
      const top1 = topShare(list, 'revenue', 1);
      if (list.length >= 3 && top1 != null && top1 >= 45) {
        sheet.signals.add('warning', 'concentration', `${field} ${list[0].name} carries ${top1.toFixed(0)}% of revenue`,
          'One item produces most of the revenue, so a problem there would move the whole result.', [ids[0]], { priority: 5 });
      }
    }
  }
  if (!hasPrior) sheet.notes.push('No prior-period figures were available for this report, so it is not compared with an earlier period.');
  return sheet;
}

async function buildGamSheet(opts) {
  if (opts.request.kind === 'roi') return buildRoiSheet(opts);
  if (opts.request.kind === 'reporting') return buildReportingSheet(opts);
  return buildDashboardSheet(opts);
}

module.exports = { buildGamSheet };
