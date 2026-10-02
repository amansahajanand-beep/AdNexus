/**
 * Candidate sites and apps a campaign can be mapped to, per product, plus the campaigns that still need a map.
 */
const { query } = require('../../db');
const { callRouter } = require('../internalCall');
const { adsSpendSql } = require('../../utils/adsCurrency');
const logger = require('../../utils/logger');

const MAX_TARGETS = 500;
const LOOKBACK_DAYS = 90;
const MAX_CAMPAIGNS = 80;

const norm = (v) => String(v || '').trim().toLowerCase();

/** AdSense sites with earnings in the last 120 days, biggest first. */
async function adsenseSites(clientId) {
  const { rows } = await query(
    `SELECT dim_value AS host, SUM(earnings)::float8 AS earnings
     FROM adsense_dim_daily
     WHERE client_id = $1 AND dim_kind = 'site' AND dim_value <> ''
       AND report_date >= CURRENT_DATE - 120
     GROUP BY dim_value ORDER BY earnings DESC LIMIT ${MAX_TARGETS}`,
    [clientId]
  );
  return rows.map((r) => ({ type: 'site', key: norm(r.host), label: r.host, weight: r.earnings }));
}

/** AdMob apps with earnings; keyed by store id when the app list is available, else by name. */
async function admobApps(client) {
  const { rows } = await query(
    `SELECT dim_value AS name, SUM(earnings)::float8 AS earnings
     FROM admob_dim_daily
     WHERE client_id = $1 AND dim_kind = 'app' AND dim_value <> ''
       AND report_date >= CURRENT_DATE - 120
     GROUP BY dim_value ORDER BY earnings DESC LIMIT ${MAX_TARGETS}`,
    [client.id]
  );
  const storeIdByName = new Map();
  try {
    const { admobAccountStore } = require('../../models/publisherAccountStore');
    const { loadAppCatalog } = require('../../services/admobRoiService');
    for (const a of await admobAccountStore.listAccounts(client.id)) {
      const account = await admobAccountStore.getAccountById(a.id);
      const catalog = await loadAppCatalog(client, account);
      for (const app of catalog.apps || []) {
        for (const n of [app.name, app.storeName]) if (n && app.storeId) storeIdByName.set(norm(n), app.storeId);
      }
    }
  } catch (err) {
    logger.warn(`mapping targets: AdMob app list unavailable (${err.message})`);
  }
  return rows.map((r) => {
    const storeId = storeIdByName.get(norm(r.name));
    return {
      type: 'app',
      key: norm(storeId || r.name),
      label: storeId ? `${r.name} (${storeId})` : r.name,
      name: r.name,
      storeId: storeId || '',
      weight: r.earnings,
    };
  });
}

/** GAM site hosts and app packages from the network's inventory catalog. */
async function gamInventory({ authorization, headers }) {
  try {
    const router = require('../../routes/reports');
    const res = await callRouter(router, { path: '/filter-catalog', authorization, headers, timeoutMs: 15000 });
    if (res.status !== 200) return [];
    const sites = (res.body?.siteHosts || []).map((h) => ({ type: 'site', key: norm(h), label: String(h), weight: 0 }));
    const apps = (res.body?.appPackages || []).map((a) => ({ type: 'app', key: norm(a), label: String(a), weight: 0 }));
    return [...sites, ...apps].slice(0, MAX_TARGETS * 2);
  } catch (err) {
    logger.warn(`mapping targets: GAM catalog unavailable (${err.message})`);
    return [];
  }
}

async function loadTargets({ product, client, authorization, headers }) {
  if (product === 'adsense') return adsenseSites(client.id);
  if (product === 'admob') return admobApps(client);
  return gamInventory({ authorization, headers });
}

/**
 * Campaigns with spend and no map yet. Campaigns that carry an app id match their app through the
 * store id on their own, so only the rest need a map.
 */
async function loadUnmappedCampaigns(clientId, { adsAccountId = null } = {}) {
  const params = [clientId];
  let accountFilter = '';
  if (adsAccountId) {
    params.push(adsAccountId);
    accountFilter = ` AND s.ads_account_id = $${params.length}`;
  }
  const { rows } = await query(
    `SELECT s.ads_account_id, a.descriptive_name AS account_name, a.customer_id,
            s.campaign_id, MAX(s.campaign_name) AS campaign_name,
            COALESCE(SUM(${adsSpendSql('s')}), 0)::float8 AS spend
     FROM ads_spend_daily s
     JOIN ads_accounts a ON a.id = s.ads_account_id
     LEFT JOIN ads_campaign_map m
       ON m.client_id = s.client_id AND m.ads_account_id = s.ads_account_id AND m.campaign_id = s.campaign_id
     WHERE s.client_id = $1
       AND s.report_date >= CURRENT_DATE - ${LOOKBACK_DAYS}
       AND m.id IS NULL
       AND COALESCE(NULLIF(TRIM(s.app_id), ''), '') = ''
       ${accountFilter}
     GROUP BY s.ads_account_id, a.descriptive_name, a.customer_id, s.campaign_id
     HAVING SUM(${adsSpendSql('s')}) > 0
     ORDER BY spend DESC
     LIMIT ${MAX_CAMPAIGNS}`,
    params
  );
  return rows.map((r) => ({
    adsAccountId: r.ads_account_id,
    accountName: r.account_name || r.customer_id || '',
    campaignId: r.campaign_id,
    campaignName: r.campaign_name || r.campaign_id,
    spend: Math.round((Number(r.spend) || 0) * 100) / 100,
  }));
}

async function countMapped(clientId) {
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM ads_campaign_map WHERE client_id = $1', [clientId]);
  return rows[0]?.n || 0;
}

module.exports = { loadTargets, loadUnmappedCampaigns, countMapped, norm };
