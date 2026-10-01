/**
 * AdSense ROI — AdSense site earnings vs Google Ads spend on the same sites.
 *
 * AdSense facts are keyed by site host (adsense_dim_daily, dim_kind = 'site'). Ads spend is
 * attributed to a site through a manual campaign → site map (ads_campaign_map, target_type
 * 'site'), keyed by the same host.
 */
const { query, withTransaction } = require('../db');
const { loadMappedSpendDaily, roiPercent } = require('./roiService');
const {
  adsSpendDisplayCurrency,
  adsSpendSql,
  getUnitsPerUsd,
  normalizeCurrency,
} = require('../utils/adsCurrency');

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Lowercase host with scheme, leading www. and path stripped, so Ads map keys match AdSense site names. */
function normSite(v) {
  return String(v || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
}

function ymd(d) {
  if (d instanceof Date && !Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return String(d || '').slice(0, 10);
}

async function listLinkedAdsAccountIds(clientId, adsenseAccountId) {
  if (!adsenseAccountId) return [];
  const { rows } = await query(
    `SELECT ads_account_id FROM adsense_ads_account_links
     WHERE client_id = $1 AND adsense_account_id = $2`,
    [clientId, adsenseAccountId]
  );
  return rows.map((r) => r.ads_account_id);
}

async function setLinkedAdsAccountIds(clientId, adsenseAccountId, adsAccountIds = []) {
  const ids = [...new Set((adsAccountIds || []).map(String).filter(Boolean))];
  await withTransaction(async (q) => {
    await q(
      'DELETE FROM adsense_ads_account_links WHERE client_id = $1 AND adsense_account_id = $2',
      [clientId, adsenseAccountId]
    );
    if (ids.length) {
      await q(
        `INSERT INTO adsense_ads_account_links (client_id, adsense_account_id, ads_account_id)
         SELECT $1, $2, a.id FROM ads_accounts a
         WHERE a.client_id = $1 AND a.id = ANY($3::uuid[])
         ON CONFLICT DO NOTHING`,
        [clientId, adsenseAccountId, ids]
      );
    }
  });
  return listLinkedAdsAccountIds(clientId, adsenseAccountId);
}

/** Google Ads client accounts with range spend, flagged when linked to this AdSense publisher. */
async function listAdsAccountsForAdSense(clientId, { adsenseAccountId, start, end }) {
  const [linked, { rows }] = await Promise.all([
    listLinkedAdsAccountIds(clientId, adsenseAccountId),
    query(
      `SELECT a.id, a.customer_id, a.descriptive_name, a.include_in_roi, a.last_sync_at, a.last_sync_error,
              a.parent_mcc_id,
              p.descriptive_name AS mcc_name,
              COALESCE(SUM(${adsSpendSql('s')}), 0)::float8 AS spend
       FROM ads_accounts a
       LEFT JOIN ads_accounts p ON p.id = a.parent_mcc_id
       LEFT JOIN ads_spend_daily s
         ON s.client_id = a.client_id AND s.ads_account_id = a.id
        AND s.report_date BETWEEN $2::date AND $3::date
       WHERE a.client_id = $1 AND a.account_type = 'client' AND a.is_active = true
       GROUP BY a.id, p.descriptive_name
       ORDER BY spend DESC, a.descriptive_name ASC`,
      [clientId, start, end]
    ),
  ]);
  const linkedSet = new Set(linked);
  return {
    currency: adsSpendDisplayCurrency(),
    usingAllAccounts: linked.length === 0,
    accounts: rows.map((r) => ({
      id: r.id,
      customerId: r.customer_id || '',
      descriptiveName: r.descriptive_name || r.customer_id || '',
      mccName: r.mcc_name || '',
      parentMccId: r.parent_mcc_id || null,
      includeInGamRoi: r.include_in_roi !== false,
      lastSyncAt: r.last_sync_at || null,
      lastSyncError: r.last_sync_error || null,
      spend: round2(r.spend),
      appSpend: 0,
      linked: linkedSet.has(r.id),
    })),
  };
}

async function loadSiteEarningsDaily(clientId, { accountId, start, end, sites = null }) {
  const params = [clientId, start, end];
  let extra = '';
  if (accountId) {
    params.push(accountId);
    extra += ` AND account_id = $${params.length}`;
  }
  if (sites?.length) {
    params.push(sites);
    extra += ` AND dim_value = ANY($${params.length}::text[])`;
  }
  const { rows } = await query(
    `SELECT report_date, dim_value AS site,
            SUM(earnings)::float8 AS earnings,
            SUM(impressions)::bigint AS impressions,
            SUM(clicks)::bigint AS clicks,
            SUM(page_views)::bigint AS page_views
     FROM adsense_dim_daily
     WHERE client_id = $1
       AND report_date BETWEEN $2::date AND $3::date
       AND dim_kind = 'site'
       ${extra}
     GROUP BY 1, 2`,
    params
  );
  return rows.map((r) => ({
    date: ymd(r.report_date),
    site: r.site,
    earnings: Number(r.earnings) || 0,
    impressions: Number(r.impressions) || 0,
    clicks: Number(r.clicks) || 0,
    pageViews: Number(r.page_views) || 0,
  }));
}

/** Per-day multiplier from AdSense currency into the Ads spend display currency. */
async function buildFxFactors(fromCurrency, toCurrency, dates) {
  const from = normalizeCurrency(fromCurrency);
  const to = normalizeCurrency(toCurrency);
  const factors = new Map();
  if (from === to) return { factor: () => 1 };
  for (const d of dates) {
    const [fromPerUsd, toPerUsd] = await Promise.all([getUnitsPerUsd(from, d), getUnitsPerUsd(to, d)]);
    factors.set(d, fromPerUsd > 0 && toPerUsd > 0 ? toPerUsd / fromPerUsd : 1);
  }
  return { factor: (d) => factors.get(d) ?? 1 };
}

function emptySiteRow(name) {
  return {
    name,
    earnings: 0,
    impressions: 0,
    clicks: 0,
    pageViews: 0,
    adsSpend: 0,
    adsClicks: 0,
    adsImpressions: 0,
    conversions: 0,
    days: new Map(),
  };
}

function siteDay(row, date) {
  if (!row.days.has(date)) {
    row.days.set(date, {
      date, earnings: 0, adsSpend: 0, adsClicks: 0, adsImpressions: 0, conversions: 0,
    });
  }
  return row.days.get(date);
}

async function getAdSenseRoi({
  clientId,
  account,
  start,
  end,
  sites = null,
  adsAccountIds = null,
}) {
  const linkedAdsAccountIds = await listLinkedAdsAccountIds(clientId, account?.id);
  const effectiveAdsAccountIds = adsAccountIds?.length
    ? adsAccountIds
    : (linkedAdsAccountIds.length ? linkedAdsAccountIds : null);
  const [earnRows, spendRows] = await Promise.all([
    loadSiteEarningsDaily(clientId, { accountId: account?.id || null, start, end, sites }),
    loadMappedSpendDaily(clientId, start, end, { accountIds: effectiveAdsAccountIds }),
  ]);

  const currency = adsSpendDisplayCurrency();
  const earningsCurrency = account?.currencyCode || 'USD';
  const dates = [...new Set(earnRows.map((r) => r.date))];
  const fx = await buildFxFactors(earningsCurrency, currency, dates);

  const siteRows = new Map();
  const daily = new Map();
  const dayRow = (d) => {
    if (!daily.has(d)) daily.set(d, { date: d, earnings: 0, linkedEarnings: 0, adsSpend: 0 });
    return daily.get(d);
  };

  for (const r of earnRows) {
    if (!siteRows.has(r.site)) siteRows.set(r.site, emptySiteRow(r.site));
    const row = siteRows.get(r.site);
    const earn = r.earnings * fx.factor(r.date);
    row.earnings += earn;
    row.impressions += r.impressions;
    row.clicks += r.clicks;
    row.pageViews += r.pageViews;
    siteDay(row, r.date).earnings += earn;
    dayRow(r.date).earnings += earn;
  }

  const siteByKey = new Map();
  for (const row of siteRows.values()) {
    const key = normSite(row.name);
    if (key && !siteByKey.has(key)) siteByKey.set(key, row);
  }

  let unmatchedSiteSpend = 0;
  for (const s of spendRows) {
    if (s.targetType !== 'site') continue;
    const row = siteByKey.get(normSite(s.targetKey));
    if (!row) {
      unmatchedSiteSpend += s.cost;
      continue;
    }
    row.adsSpend += s.cost;
    row.adsClicks += s.clicks;
    row.adsImpressions += s.impressions;
    row.conversions += s.conversions;
    const d = siteDay(row, s.date);
    d.adsSpend += s.cost;
    d.adsClicks += s.clicks;
    d.adsImpressions += s.impressions;
    d.conversions += s.conversions;
    dayRow(s.date).adsSpend += s.cost;
  }

  const linkedSites = new Set([...siteRows.values()].filter((r) => r.adsSpend > 0).map((r) => r.name));
  for (const r of earnRows) {
    if (!linkedSites.has(r.site)) continue;
    dayRow(r.date).linkedEarnings += r.earnings * fx.factor(r.date);
  }

  const siteList = [...siteRows.values()].map((r) => {
    const profit = r.earnings - r.adsSpend;
    return {
      ...r,
      earnings: round2(r.earnings),
      adsSpend: round2(r.adsSpend),
      conversions: round2(r.conversions),
      profit: round2(profit),
      roiPercent: roiPercent(r.earnings, r.adsSpend),
      costPerConversion: r.conversions > 0 ? round2(r.adsSpend / r.conversions) : null,
      linked: r.adsSpend > 0,
      days: [...r.days.values()]
        .sort((a, b) => b.date.localeCompare(a.date))
        .map((d) => ({
          date: d.date,
          earnings: round2(d.earnings),
          adsSpend: round2(d.adsSpend),
          adsClicks: d.adsClicks,
          adsImpressions: d.adsImpressions,
          conversions: round2(d.conversions),
          profit: round2(d.earnings - d.adsSpend),
          roiPercent: roiPercent(d.earnings, d.adsSpend),
        })),
    };
  }).sort((a, b) => (b.adsSpend - a.adsSpend) || (b.earnings - a.earnings));

  const totalEarnings = siteList.reduce((s, r) => s + r.earnings, 0);
  const linkedEarnings = siteList.filter((r) => r.linked).reduce((s, r) => s + r.earnings, 0);
  const adsSpend = siteList.reduce((s, r) => s + r.adsSpend, 0);
  const conversions = siteList.reduce((s, r) => s + r.conversions, 0);
  const adsImpressions = siteList.reduce((s, r) => s + r.adsImpressions, 0);
  const adsClicks = siteList.reduce((s, r) => s + r.adsClicks, 0);

  return {
    currency,
    earningsCurrency,
    range: { startDate: start, endDate: end },
    summary: {
      totalEarnings: round2(totalEarnings),
      linkedEarnings: round2(linkedEarnings),
      adsSpend: round2(adsSpend),
      profit: round2(linkedEarnings - adsSpend),
      roiPercent: roiPercent(linkedEarnings, adsSpend),
      conversions: round2(conversions),
      costPerConversion: conversions > 0 ? round2(adsSpend / conversions) : null,
      adsImpressions,
      adsClicks,
      linkedSiteCount: linkedSites.size,
      siteCount: siteList.length,
      unmatchedSiteSpend: round2(unmatchedSiteSpend),
    },
    daily: [...daily.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({
        date: d.date,
        earnings: round2(d.earnings),
        linkedEarnings: round2(d.linkedEarnings),
        adsSpend: round2(d.adsSpend),
        profit: round2(d.linkedEarnings - d.adsSpend),
      })),
    sites: siteList,
    adsAccounts: {
      linkedIds: linkedAdsAccountIds,
      appliedIds: effectiveAdsAccountIds,
      usingAllAccounts: !effectiveAdsAccountIds,
    },
  };
}

module.exports = {
  getAdSenseRoi,
  listAdsAccountsForAdSense,
  listLinkedAdsAccountIds,
  setLinkedAdsAccountIds,
};
