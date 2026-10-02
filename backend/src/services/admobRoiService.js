/**
 * AdMob ROI — AdMob app earnings vs Google Ads spend on the same apps.
 *
 * AdMob facts are keyed by app display name; Ads spend is keyed by store ID
 * (App Campaign app_id, or a manual campaign → app map). The AdMob apps list
 * links the two. Manual maps may also use the AdMob app name as target key.
 */
const { query, withTransaction } = require('../db');
const { listAdMobApps } = require('../admob/client');
const { loadMappedSpendDaily, roiPercent } = require('./roiService');
const {
  adsSpendDisplayCurrency,
  adsSpendSql,
  getUnitsPerUsd,
  normalizeCurrency,
} = require('../utils/adsCurrency');
const logger = require('../utils/logger');

const APP_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const appCatalogCache = new Map();

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function norm(v) {
  return String(v || '').trim().toLowerCase();
}

function ymd(d) {
  if (d instanceof Date && !Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return String(d || '').slice(0, 10);
}

async function listLinkedAdsAccountIds(clientId, admobAccountId) {
  if (!admobAccountId) return [];
  const { rows } = await query(
    `SELECT ads_account_id FROM admob_ads_account_links
     WHERE client_id = $1 AND admob_account_id = $2`,
    [clientId, admobAccountId]
  );
  return rows.map((r) => r.ads_account_id);
}

async function setLinkedAdsAccountIds(clientId, admobAccountId, adsAccountIds = []) {
  const ids = [...new Set((adsAccountIds || []).map(String).filter(Boolean))];
  await withTransaction(async (q) => {
    await q(
      'DELETE FROM admob_ads_account_links WHERE client_id = $1 AND admob_account_id = $2',
      [clientId, admobAccountId]
    );
    if (ids.length) {
      await q(
        `INSERT INTO admob_ads_account_links (client_id, admob_account_id, ads_account_id)
         SELECT $1, $2, a.id FROM ads_accounts a
         WHERE a.client_id = $1 AND a.id = ANY($3::uuid[])
         ON CONFLICT DO NOTHING`,
        [clientId, admobAccountId, ids]
      );
    }
  });
  return listLinkedAdsAccountIds(clientId, admobAccountId);
}

/** Google Ads client accounts with range spend, flagged when linked to this AdMob publisher. */
async function listAdsAccountsForAdMob(clientId, { admobAccountId, start, end }) {
  const [linked, { rows }] = await Promise.all([
    listLinkedAdsAccountIds(clientId, admobAccountId),
    query(
      `SELECT a.id, a.customer_id, a.descriptive_name, a.include_in_roi, a.last_sync_at, a.last_sync_error,
              a.parent_mcc_id,
              p.descriptive_name AS mcc_name,
              COALESCE(SUM(${adsSpendSql('s')}), 0)::float8 AS spend,
              COALESCE(SUM(${adsSpendSql('s')}) FILTER (WHERE NULLIF(TRIM(s.app_id), '') IS NOT NULL), 0)::float8 AS app_spend
       FROM ads_accounts a
       LEFT JOIN ads_accounts p ON p.id = a.parent_mcc_id
       LEFT JOIN ads_spend_daily s
         ON s.client_id = a.client_id AND s.ads_account_id = a.id
        AND s.report_date BETWEEN $2::date AND $3::date
       WHERE a.client_id = $1 AND a.account_type = 'client' AND a.is_active = true
       GROUP BY a.id, p.descriptive_name
       ORDER BY app_spend DESC, spend DESC, a.descriptive_name ASC`,
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
      appSpend: round2(r.app_spend),
      linked: linkedSet.has(r.id),
    })),
  };
}

async function loadAppCatalog(gamClient, account) {
  if (!account?.refreshToken || !account?.accountId) return { apps: [], error: 'AdMob account not connected' };
  const cached = appCatalogCache.get(account.id);
  if (cached && Date.now() - cached.at < APP_CATALOG_TTL_MS) return { apps: cached.apps, error: null };
  try {
    const apps = await listAdMobApps(gamClient, {
      accountId: account.accountId,
      refreshToken: account.refreshToken,
    });
    appCatalogCache.set(account.id, { at: Date.now(), apps });
    return { apps, error: null };
  } catch (err) {
    logger.warn(`[admob-roi] apps.list ${account.accountId}: ${err.message}`);
    return { apps: cached?.apps || [], error: err.message };
  }
}

async function loadAppEarningsDaily(clientId, { accountId, start, end, apps = null }) {
  const params = [clientId, start, end];
  let extra = '';
  if (accountId) {
    params.push(accountId);
    extra += ` AND account_id = $${params.length}`;
  }
  if (apps?.length) {
    params.push(apps);
    extra += ` AND dim_value = ANY($${params.length}::text[])`;
  }
  const { rows } = await query(
    `SELECT report_date, dim_value AS app,
            SUM(earnings)::float8 AS earnings,
            SUM(impressions)::bigint AS impressions,
            SUM(clicks)::bigint AS clicks
     FROM admob_dim_daily
     WHERE client_id = $1
       AND report_date BETWEEN $2::date AND $3::date
       AND dim_kind = 'app'
       ${extra}
     GROUP BY 1, 2`,
    params
  );
  return rows.map((r) => ({
    date: ymd(r.report_date),
    app: r.app,
    earnings: Number(r.earnings) || 0,
    impressions: Number(r.impressions) || 0,
    clicks: Number(r.clicks) || 0,
  }));
}

/** Per-day multiplier from AdMob currency into the Ads spend display currency. */
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

function emptyAppRow(name) {
  return {
    name,
    storeId: '',
    platform: '',
    earnings: 0,
    impressions: 0,
    clicks: 0,
    adsSpend: 0,
    adsClicks: 0,
    adsImpressions: 0,
    conversions: 0,
    days: new Map(),
  };
}

function appDay(row, date) {
  if (!row.days.has(date)) {
    row.days.set(date, {
      date, earnings: 0, adsSpend: 0, adsClicks: 0, adsImpressions: 0, conversions: 0,
    });
  }
  return row.days.get(date);
}

async function getAdMobRoi(gamClient, {
  clientId,
  account,
  start,
  end,
  apps = null,
  adsAccountIds = null,
}) {
  const linkedAdsAccountIds = await listLinkedAdsAccountIds(clientId, account?.id);
  const effectiveAdsAccountIds = adsAccountIds?.length
    ? adsAccountIds
    : (linkedAdsAccountIds.length ? linkedAdsAccountIds : null);
  const [catalog, earnRows, spendRows] = await Promise.all([
    loadAppCatalog(gamClient, account),
    loadAppEarningsDaily(clientId, { accountId: account?.id || null, start, end, apps }),
    loadMappedSpendDaily(clientId, start, end, { accountIds: effectiveAdsAccountIds }),
  ]);

  const currency = adsSpendDisplayCurrency();
  const earningsCurrency = account?.currencyCode || 'USD';
  const dates = [...new Set(earnRows.map((r) => r.date))];
  const fx = await buildFxFactors(earningsCurrency, currency, dates);

  const catalogByName = new Map();
  for (const a of catalog.apps) {
    for (const n of [a.name, a.storeName]) {
      if (n && !catalogByName.has(norm(n))) catalogByName.set(norm(n), a);
    }
  }

  const appRows = new Map();
  const daily = new Map();
  const dayRow = (d) => {
    if (!daily.has(d)) daily.set(d, { date: d, earnings: 0, linkedEarnings: 0, adsSpend: 0 });
    return daily.get(d);
  };

  for (const r of earnRows) {
    if (!appRows.has(r.app)) {
      const row = emptyAppRow(r.app);
      const meta = catalogByName.get(norm(r.app));
      if (meta) {
        row.storeId = meta.storeId;
        row.platform = meta.platform;
      }
      appRows.set(r.app, row);
    }
    const row = appRows.get(r.app);
    const earn = r.earnings * fx.factor(r.date);
    row.earnings += earn;
    row.impressions += r.impressions;
    row.clicks += r.clicks;
    appDay(row, r.date).earnings += earn;
    dayRow(r.date).earnings += earn;
  }

  // Resolve each Ads spend key to one AdMob app (store ID first, then app name).
  const appByKey = new Map();
  for (const row of appRows.values()) {
    if (row.storeId) appByKey.set(norm(row.storeId), row);
  }
  for (const row of appRows.values()) {
    if (!appByKey.has(norm(row.name))) appByKey.set(norm(row.name), row);
  }

  let unmatchedAppSpend = 0;
  for (const s of spendRows) {
    if (s.targetType !== 'app') continue;
    const row = appByKey.get(norm(s.targetKey));
    if (!row) {
      unmatchedAppSpend += s.cost;
      continue;
    }
    row.adsSpend += s.cost;
    row.adsClicks += s.clicks;
    row.adsImpressions += s.impressions;
    row.conversions += s.conversions;
    const d = appDay(row, s.date);
    d.adsSpend += s.cost;
    d.adsClicks += s.clicks;
    d.adsImpressions += s.impressions;
    d.conversions += s.conversions;
    dayRow(s.date).adsSpend += s.cost;
  }

  const linkedApps = new Set([...appRows.values()].filter((r) => r.adsSpend > 0).map((r) => r.name));
  for (const r of earnRows) {
    if (!linkedApps.has(r.app)) continue;
    dayRow(r.date).linkedEarnings += r.earnings * fx.factor(r.date);
  }

  const appList = [...appRows.values()].map((r) => {
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

  const totalEarnings = appList.reduce((s, r) => s + r.earnings, 0);
  const linkedEarnings = appList.filter((r) => r.linked).reduce((s, r) => s + r.earnings, 0);
  const adsSpend = appList.reduce((s, r) => s + r.adsSpend, 0);
  const conversions = appList.reduce((s, r) => s + r.conversions, 0);
  const adsImpressions = appList.reduce((s, r) => s + r.adsImpressions, 0);
  const adsClicks = appList.reduce((s, r) => s + r.adsClicks, 0);

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
      linkedAppCount: linkedApps.size,
      appCount: appList.length,
      unmatchedAppSpend: round2(unmatchedAppSpend),
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
    apps: appList,
    catalogError: catalog.error,
    adsAccounts: {
      linkedIds: linkedAdsAccountIds,
      appliedIds: effectiveAdsAccountIds,
      usingAllAccounts: !effectiveAdsAccountIds,
    },
  };
}

module.exports = {
  loadAppCatalog,
  getAdMobRoi,
  listAdsAccountsForAdMob,
  listLinkedAdsAccountIds,
  setLinkedAdsAccountIds,
};
