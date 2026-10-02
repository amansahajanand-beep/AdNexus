/**
 * Fact sheets for AdMob and AdSense: Dashboard, Reporting and ROI presets.
 * Data comes from the product's own endpoints through `call`, so permissions and filters match the pages.
 */
const {
  num, formatMoney, formatCount, formatPercent, formatChange,
  findAnomalies, topShare, computeMovers,
} = require('./factBook');
const {
  newSheet, downsample, round, applyFreshness, isSmall, reliableDims, MATERIAL_AMOUNT,
  setTrendChart, addBarChart, addCompare,
} = require('./common');

const PRODUCTS = {
  admob: {
    label: 'AdMob',
    router: 'admob',
    primary: 'app',
    others: ['country', 'format', 'platform'],
    volumeKey: 'impressions',
    priceKey: 'ecpm',
    entities: { key: 'apps', label: 'App', plural: 'apps', countKey: 'linkedAppCount', totalKey: 'appCount', unmatchedKey: 'unmatchedAppSpend' },
  },
  adsense: {
    label: 'AdSense',
    router: 'adsense',
    primary: 'site',
    others: ['country', 'platform'],
    volumeKey: 'pageViews',
    priceKey: 'rpm',
    entities: { key: 'sites', label: 'Site', plural: 'sites', countKey: 'linkedSiteCount', totalKey: 'siteCount', unmatchedKey: 'unmatchedSiteSpend' },
  },
};

const DIM_LABEL = {
  app: 'App', site: 'Site', country: 'Country', format: 'Format', platform: 'Platform', ad_unit: 'Ad unit',
};
const UNIT_BY_FORMAT = { money: 'money', number: 'count', percent: 'percent' };
const PAGE_LABEL = { dashboard: 'dashboard', reporting: 'reporting', roi: 'ROI' };

function csvFilters(request, keys) {
  const q = {};
  for (const k of keys) if (request.filters[k]?.length) q[k] = request.filters[k].join(',');
  return q;
}

const INVENTORY_KEYS = [
  'apps', 'formats', 'countries', 'platforms', 'sites',
  'adUnits', 'adSources', 'adSourceInstances', 'mediationGroups',
];

function hasNoData(overview) {
  const t = overview?.totals || {};
  return overview?.isSample === true
    || (!(num(t.earnings) > 0) && !(num(t.impressions) > 0) && !(num(t.page_views) > 0));
}

function metricSignals(sheet, cfg, kpis, overview) {
  const earn = kpis.earnings;
  const prevEarn = num(overview.previous?.earnings);
  if (earn && isSmall(earn.value, prevEarn)) {
    sheet.small = true;
    sheet.notes.push('Earnings are very small in both periods, so percentage changes are not meaningful.');
    return;
  }
  if (earn && earn.change != null) {
    const ch = earn.change;
    const prevText = prevEarn != null ? formatMoney(prevEarn, sheet.currency) : 'the prior period';
    const base = `Estimated earnings are ${formatMoney(earn.value, sheet.currency)}, ${formatChange(ch)} against ${prevText} in the prior period.`;
    if (ch <= -25) {
      sheet.signals.add('critical', 'metric_drop', `Earnings fell ${Math.abs(ch).toFixed(0)}%`, base, [earn.id], {
        priority: 9,
        action: { title: 'Find where the drop comes from', detail: `Open ${cfg.label} Reporting and compare the top items with the prior period.` },
      });
    } else if (ch <= -10) {
      sheet.signals.add('warning', 'metric_drop', `Earnings are down ${Math.abs(ch).toFixed(0)}%`, base, [earn.id], { priority: 7 });
    } else if (ch >= 20) {
      sheet.signals.add('positive', 'metric_rise', `Earnings are up ${ch.toFixed(0)}%`, base, [earn.id], { priority: 6 });
    }
  }
  const vol = kpis[cfg.volumeKey];
  const price = kpis[cfg.priceKey];
  if (vol && price && vol.change != null && price.change != null && vol.change >= 5 && price.change <= -8) {
    sheet.signals.add(
      'warning', 'price_volume', 'Volume is up but price is down',
      `${vol.label} rose ${formatChange(vol.change)} while ${price.label} fell ${formatChange(price.change)}, so growth is coming from volume at lower prices.`,
      [vol.id, price.id],
      {
        priority: 8,
        action: {
          title: 'Check what is lowering price',
          detail: `Compare the breakdowns in ${cfg.label} Reporting to find where price fell.`,
        },
      }
    );
  }
  const match = kpis.matchRate;
  if (match && match.change != null && match.change <= -4) {
    sheet.signals.add(
      'warning', 'match_rate', 'Match rate is dropping',
      `Match rate is ${formatPercent(match.value)}, ${formatChange(match.change)} against the prior period, so more ad requests go unfilled.`,
      [match.id], { priority: 6 }
    );
  }
  const ctr = kpis.ctr;
  if (ctr && ctr.change != null && ctr.change <= -20 && !sheet.small) {
    sheet.signals.add('info', 'ctr_drop', 'Click rate is down', `CTR is ${formatPercent(ctr.value)}, ${formatChange(ctr.change)} against the prior period.`, [ctr.id], { priority: 3 });
  }
}

function processBreakdown(sheet, cfg, { dim, cur, prev, total, limit, rowIds, withSignals }) {
  const rows = cur?.rows || [];
  if (!rows.length) return;
  const label = DIM_LABEL[dim] || dim;
  const sum = rows.reduce((a, r) => a + (num(r.earnings) || 0), 0);
  const denom = num(total) > 0 ? num(total) : sum;
  const movers = prev ? computeMovers(rows, prev.rows || [], 'earnings') : [];
  const moverBy = new Map(movers.map((m) => [m.name, m]));

  const factFor = (r) => {
    const key = `${dim}:${r.name}`;
    if (rowIds.has(key)) return rowIds.get(key);
    const m = moverBy.get(r.name);
    const price = num(r.ecpm ?? r.rpm);
    const detailParts = [];
    if (price != null) detailParts.push(`${cfg.priceKey === 'rpm' ? 'RPM' : 'eCPM'} ${formatMoney(price, sheet.currency)}`);
    if (r.impressions != null) detailParts.push(`${formatCount(r.impressions)} impressions`);
    if (r.ctr != null) detailParts.push(`CTR ${formatPercent(r.ctr)}`);
    const id = sheet.book.add(`${label} ${r.name}`, r.earnings, 'money', {
      share: denom > 0 ? ((num(r.earnings) || 0) / denom) * 100 : null,
      change: m ? m.pct : undefined,
      detail: detailParts.join(', ') || undefined,
    });
    rowIds.set(key, id);
    return id;
  };

  const shown = rows.slice(0, limit);
  const ids = shown.map(factFor);
  addBarChart(sheet, label, 'money', shown.map((r) => ({
    name: String(r.name),
    value: num(r.earnings) || 0,
    share: denom > 0 ? ((num(r.earnings) || 0) / denom) * 100 : null,
    change: moverBy.get(r.name)?.pct ?? null,
  })), { totalValue: denom > 0 ? denom : null });
  sheet.breakdowns.push({
    by: label,
    rows: ids,
    top1_share_pct: round(topShare(rows, 'earnings', 1), 1),
    top3_share_pct: round(topShare(rows, 'earnings', 3), 1),
    items_in_period: rows.length,
  });

  if (!withSignals || sheet.small) return;

  const top1 = topShare(rows, 'earnings', 1);
  const top2 = topShare(rows, 'earnings', 2);
  if (rows.length >= 3 && top1 != null && top1 >= 45) {
    sheet.signals.add(
      'warning', 'concentration', `${label} ${rows[0].name} carries ${top1.toFixed(0)}% of earnings`,
      `One ${label.toLowerCase()} produces most of the earnings, so a problem there would move the whole result.`,
      [ids[0]], { priority: 5 }
    );
  } else if (rows.length >= 4 && top2 != null && top2 >= 65) {
    sheet.signals.add(
      'warning', 'concentration', `Two ${label.toLowerCase()}s carry ${top2.toFixed(0)}% of earnings`,
      `${rows[0].name} and ${rows[1].name} together produce most of the earnings.`,
      [ids[0], ids[1]], { priority: 4 }
    );
  }

  const prevTotal = (prev?.rows || []).reduce((a, r) => a + (num(r.earnings) || 0), 0);
  const totalDelta = movers.reduce((a, m) => a + m.delta, 0);
  const top = movers[0];
  if (top && Math.abs(top.delta) >= Math.max(MATERIAL_AMOUNT, 0.15 * Math.abs(totalDelta))) {
    const id = factFor({ name: top.name, earnings: top.curr, ecpm: undefined });
    const dir = top.delta >= 0 ? 'up' : 'down';
    sheet.signals.add(
      top.delta >= 0 ? 'positive' : 'warning', 'top_mover',
      `${label} ${top.name} is the biggest mover`,
      `${label} ${top.name} earned ${formatMoney(top.curr, sheet.currency)}, ${dir} ${formatMoney(Math.abs(top.delta), sheet.currency)} against the prior period.`,
      [id], { priority: 5 }
    );
  }
  for (const m of movers) {
    if (m.pct != null && m.pct <= -50 && m.prev >= MATERIAL_AMOUNT * 2 && prevTotal > 0 && m.prev / prevTotal >= 0.03) {
      const id = factFor({ name: m.name, earnings: m.curr });
      sheet.signals.add(
        'warning', 'drop_off', `${label} ${m.name} fell sharply`,
        `${label} ${m.name} earned ${formatMoney(m.curr, sheet.currency)} against ${formatMoney(m.prev, sheet.currency)} in the prior period.`,
        [id], { priority: 6 }
      );
      break;
    }
  }
}

async function buildOverviewSheet({ request, call, deep }) {
  const cfg = PRODUCTS[request.product];
  const extended = deep || request.kind === 'reporting';
  const sheet = newSheet(request, `${cfg.label} ${PAGE_LABEL[request.kind]}`);

  const inv = csvFilters(request, INVENTORY_KEYS);
  const cur = { startDate: request.start, endDate: request.end, ...inv };
  const prv = { startDate: request.compare.start, endDate: request.compare.end, ...inv };
  let dimsCur = [cfg.primary, 'country'];
  if (extended) dimsCur.push(...cfg.others.filter((d) => d !== 'country'));
  const limit = extended ? 10 : 6;
  // Only splits that the active filters can narrow correctly are read (see reliableDims).
  const reliable = reliableDims(request.filters, [...dimsCur, 'ad_unit']);
  if (reliable.note) sheet.notes.push(reliable.note);
  dimsCur = dimsCur.filter((d) => reliable.dims.includes(d));
  const prevDims = [cfg.primary, 'country'].filter((d) => dimsCur.includes(d));

  const overviewP = call(cfg.router, '/overview', cur, { required: true });
  const breakdownP = Promise.all(dimsCur.map((dim) => call(cfg.router, '/breakdowns', { ...cur, dim, limit: 15 })));
  const prevBreakdownP = Promise.all(prevDims.map((dim) => call(cfg.router, '/breakdowns', { ...prv, dim, limit: 100 })));
  const tableP = extended && reliable.dims.includes('ad_unit')
    ? call(cfg.router, '/table', { ...cur, dim: 'ad_unit', limit: 10 })
    : Promise.resolve(null);

  const overview = await overviewP;
  sheet.currency = overview.currency || 'USD';
  sheet.book.currency = sheet.currency;
  applyFreshness(sheet, overview.accounts?.length ? overview.accounts : [overview.account].filter(Boolean));

  if (hasNoData(overview)) {
    sheet.noData = true;
    sheet.signals.add('info', 'no_data', 'No data for this period', 'There is no earnings or traffic for these filters in the selected dates.', [], { priority: 1 });
    return sheet;
  }

  const kpis = {};
  for (const k of overview.kpis || []) {
    const id = sheet.book.add(k.label, k.value, UNIT_BY_FORMAT[k.format] || 'count', { change: k.change });
    kpis[k.key] = { id, value: num(k.value), change: num(k.change), label: k.label };
    sheet.metricIds.push(id);
  }
  metricSignals(sheet, cfg, kpis, overview);

  const rowsKey = overview.visibility?.revenue === false ? 'impressions' : 'earnings';
  const trendRows = (overview.trend || []).map((t) => ({ date: t.date, v: num(t[rowsKey]) })).filter((p) => p.v != null);
  if (trendRows.length) {
    const label = rowsKey === 'earnings' ? 'Estimated earnings' : 'Impressions';
    const anomalies = rowsKey === 'earnings' && !sheet.small ? findAnomalies(trendRows) : [];
    const anomalyOut = anomalies.map((a) => {
      const id = sheet.book.add(`${a.date} earnings`, a.value, 'money', {
        detail: `${formatChange(a.deviationPct)} compared with the period's other days`,
      });
      sheet.signals.add(
        a.deviationPct < 0 ? 'warning' : 'info', 'anomaly',
        a.deviationPct < 0 ? `Earnings dipped on ${a.date}` : `Earnings spiked on ${a.date}`,
        `${a.date} earned ${formatMoney(a.value, sheet.currency)}, ${formatChange(a.deviationPct)} compared with the other days in the period.`,
        [id], { priority: 4 }
      );
      return { day: a.date, factId: id, deviation_pct: round(a.deviationPct, 1) };
    });
    sheet.trend = { label, points: downsample(trendRows), anomalies: anomalyOut };
    setTrendChart(sheet, label, rowsKey === 'earnings' ? 'money' : 'count', sheet.trend.points, anomalyOut.map((a) => a.day));
  }

  const [curRes, prevRes, table] = await Promise.all([breakdownP, prevBreakdownP, tableP]);
  if (overview.visibility?.revenue === false) {
    // Breakdowns are ranked by earnings; do not rank or describe what this user cannot see.
    sheet.notes.push('Revenue is hidden for this account, so only traffic figures are analyzed.');
    return sheet;
  }
  const rowIds = new Map();
  const total = overview.totals?.earnings;
  dimsCur.forEach((dim, i) => {
    const prevIdx = prevDims.indexOf(dim);
    processBreakdown(sheet, cfg, {
      dim,
      cur: curRes[i],
      prev: prevIdx >= 0 ? prevRes[prevIdx] : null,
      total,
      limit,
      rowIds,
      withSignals: dim === cfg.primary,
    });
  });
  if (table?.rows?.length) {
    processBreakdown(sheet, cfg, { dim: 'ad_unit', cur: table, prev: null, total, limit: 8, rowIds, withSignals: false });
  }
  return sheet;
}

function entityRows(data, cfg) {
  return Array.isArray(data?.[cfg.entities.key]) ? data[cfg.entities.key] : [];
}

async function buildRoiSheet({ request, call, deep }) {
  const cfg = PRODUCTS[request.product];
  const ent = cfg.entities;
  const sheet = newSheet(request, `${cfg.label} ROI`);

  const q = {};
  if (request.filters.accountIds?.length) q.adsAccountIds = request.filters.accountIds.join(',');
  if (request.filters[ent.key]?.length) q[ent.key] = request.filters[ent.key].join(',');
  const cur = { startDate: request.start, endDate: request.end, ...q };
  const prv = { startDate: request.compare.start, endDate: request.compare.end, ...q };

  const [data, prev] = await Promise.all([
    call(cfg.router, '/roi', cur, { required: true }),
    call(cfg.router, '/roi', prv),
  ]);
  sheet.currency = data.currency || 'USD';
  sheet.book.currency = sheet.currency;
  applyFreshness(sheet, [data.account].filter(Boolean));

  const s = data.summary || {};
  const ps = prev?.summary || null;
  const rows = entityRows(data, cfg);
  if (!rows.length && !(num(s.totalEarnings) > 0)) {
    sheet.noData = true;
    sheet.signals.add('info', 'no_data', 'No data for this period', `There are no ${cfg.label} earnings for these filters in the selected dates.`, [], { priority: 1 });
    return sheet;
  }

  const spendId = sheet.book.add('Google Ads spend', s.adsSpend, 'money', { prev: ps?.adsSpend });
  const earnId = sheet.book.add(`${cfg.label} earnings on campaigns with spend`, s.linkedEarnings, 'money', { prev: ps?.linkedEarnings });
  const profitId = sheet.book.add('Profit (earnings minus spend)', s.profit, 'money', { prev: ps?.profit });
  const roiNow = num(s.roiPercent);
  const roiPrev = num(ps?.roiPercent);
  const roiId = sheet.book.add('ROI', roiNow, 'percent', {
    change: null,
    detail: roiNow != null && roiPrev != null
      ? `${roiNow - roiPrev >= 0 ? '+' : '−'}${Math.abs(roiNow - roiPrev).toFixed(1)} points vs prior`
      : undefined,
  });
  const totalId = sheet.book.add(`Total ${cfg.label} earnings (all ${ent.plural})`, s.totalEarnings, 'money', { prev: ps?.totalEarnings });
  const coverId = sheet.book.add(`${ent.plural === 'apps' ? 'Apps' : 'Sites'} with Ads spend`, s[ent.countKey], 'count', {
    detail: `out of ${s[ent.totalKey] ?? '?'}`,
  });
  sheet.metricIds.push(spendId, earnId, profitId, roiId, totalId, coverId);

  const spend = num(s.adsSpend) || 0;
  const daily = (data.daily || []).map((d) => ({ date: d.date, v: num(d.earnings) })).filter((p) => p.v != null);
  if (daily.length) {
    sheet.trend = { label: `Daily ${cfg.label} earnings (all ${ent.plural})`, points: downsample(daily), anomalies: [] };
    setTrendChart(sheet, `Daily ${cfg.label} earnings`, 'money', sheet.trend.points);
  }
  addCompare(sheet, 'Google Ads spend', 'money', s.adsSpend, ps?.adsSpend);
  addCompare(sheet, 'Earnings on campaigns with spend', 'money', s.linkedEarnings, ps?.linkedEarnings);
  addCompare(sheet, 'Profit', 'money', s.profit, ps?.profit);

  const linked = rows.filter((r) => r.linked || num(r.adsSpend) > 0);
  const noteRow = (r) => sheet.book.add(`${ent.label} ${r.name}`, r.roiPercent, 'percent', {
    change: null,
    detail: `spend ${formatMoney(r.adsSpend, sheet.currency)}, earnings ${formatMoney(r.earnings, sheet.currency)}, profit ${formatMoney(r.profit, sheet.currency)}`,
  });
  const limit = deep ? 10 : 6;
  const ids = new Map();
  const idFor = (r) => { if (!ids.has(r.name)) ids.set(r.name, noteRow(r)); return ids.get(r.name); };
  const bySpend = linked.slice().sort((a, b) => (num(b.adsSpend) || 0) - (num(a.adsSpend) || 0)).slice(0, limit);
  if (bySpend.length) sheet.breakdowns.push({ by: `${ent.label} (ROI, by spend)`, rows: bySpend.map(idFor) });
  addBarChart(sheet, `ROI by ${ent.label.toLowerCase()}`, 'percent', bySpend
    .filter((r) => num(r.roiPercent) != null)
    .map((r) => ({
      name: String(r.name),
      value: num(r.roiPercent),
      extra: `Spend ${formatMoney(r.adsSpend, sheet.currency)} · earnings ${formatMoney(r.earnings, sheet.currency)}`,
    })));

  if (spend <= 0) {
    if (rows.length) {
      sheet.signals.add(
        'warning', 'no_spend', `No Google Ads spend is matched to ${ent.plural}`,
        `${cfg.label} earned ${formatMoney(s.totalEarnings, sheet.currency)}, but no Google Ads spend is linked to any ${ent.label.toLowerCase()}, so ROI cannot be calculated.`,
        [totalId, coverId],
        {
          priority: 9,
          action: {
            title: `Map campaigns to ${ent.plural}`,
            detail: request.product === 'adsense'
              ? 'In Admin, open Google Ads accounts and use Campaign mapping to link each campaign to the site it promotes.'
              : 'In Admin, open Google Ads accounts and use Campaign mapping, or promote the same store app with an App campaign.',
          },
        }
      );
    }
  } else {
    if (roiNow != null && roiNow < 0) {
      sheet.signals.add(
        'critical', 'negative_roi', `ROI is ${roiNow.toFixed(0)}%: spend exceeds earnings`,
        `Google Ads spend is ${formatMoney(spend, sheet.currency)} against ${formatMoney(s.linkedEarnings, sheet.currency)} of earnings.`,
        [spendId, earnId, roiId], { priority: 10 }
      );
    }
    const losers = linked
      .filter((r) => num(r.roiPercent) != null && num(r.roiPercent) < 0 && (num(r.adsSpend) || 0) >= MATERIAL_AMOUNT)
      .sort((a, b) => (num(a.profit) || 0) - (num(b.profit) || 0));
    if (losers.length) {
      const worst = losers[0];
      sheet.signals.add(
        'critical', 'losing_entity',
        `${ent.label} ${worst.name} loses money`,
        `${ent.label} ${worst.name} spent ${formatMoney(worst.adsSpend, sheet.currency)} and earned ${formatMoney(worst.earnings, sheet.currency)} (${formatPercent(worst.roiPercent, 0)} ROI).${losers.length > 1 ? ` ${losers.length - 1} more ${ent.plural} are also below break-even.` : ''}`,
        losers.slice(0, 3).map(idFor), { priority: 9 }
      );
    }
    const best = linked
      .filter((r) => (num(r.adsSpend) || 0) >= MATERIAL_AMOUNT && num(r.roiPercent) != null)
      .sort((a, b) => num(b.roiPercent) - num(a.roiPercent))[0];
    if (best && num(best.roiPercent) >= 50) {
      sheet.signals.add(
        'positive', 'best_entity', `${ent.label} ${best.name} returns ${formatPercent(best.roiPercent, 0)}`,
        `${ent.label} ${best.name} earned ${formatMoney(best.earnings, sheet.currency)} on ${formatMoney(best.adsSpend, sheet.currency)} of spend.`,
        [idFor(best)], { priority: 6 }
      );
    }
    if (roiNow != null && roiPrev != null) {
      const delta = roiNow - roiPrev;
      if (delta <= -20) {
        sheet.signals.add('warning', 'roi_drop', 'ROI fell against the prior period', `ROI is ${formatPercent(roiNow)}, down ${Math.abs(delta).toFixed(1)} points from ${formatPercent(roiPrev)}.`, [roiId], { priority: 7 });
      } else if (delta >= 20) {
        sheet.signals.add('positive', 'roi_rise', 'ROI improved against the prior period', `ROI is ${formatPercent(roiNow)}, up ${delta.toFixed(1)} points from ${formatPercent(roiPrev)}.`, [roiId], { priority: 5 });
      }
    }
    const unmatched = num(s[ent.unmatchedKey]) || 0;
    if (unmatched >= MATERIAL_AMOUNT && unmatched / spend >= 0.03) {
      const uid = sheet.book.add(`Spend not matched to any ${ent.label.toLowerCase()}`, unmatched, 'money');
      sheet.signals.add(
        'warning', 'unmatched_spend', `${formatMoney(unmatched, sheet.currency)} of spend is not counted`,
        `Some Google Ads spend belongs to ${ent.plural} outside this ${cfg.label} publisher, so it is left out of ROI.`,
        [uid], { priority: 6 }
      );
    }
    if (data.adsAccounts?.usingAllAccounts) {
      sheet.notes.push('ROI counts spend from all connected Google Ads accounts (no saved default for this publisher).');
    }
  }

  if (deep) {
    const unlinkedTop = rows
      .filter((r) => !(r.linked || num(r.adsSpend) > 0))
      .sort((a, b) => (num(b.earnings) || 0) - (num(a.earnings) || 0))
      .slice(0, 4);
    if (unlinkedTop.length) {
      sheet.breakdowns.push({
        by: `${ent.label} earnings with no Ads spend`,
        rows: unlinkedTop.map((r) => sheet.book.add(`${ent.label} ${r.name}`, r.earnings, 'money')),
      });
    }
  }
  return sheet;
}

async function buildPublisherSheet(opts) {
  return opts.request.kind === 'roi' ? buildRoiSheet(opts) : buildOverviewSheet(opts);
}

module.exports = { buildPublisherSheet };
