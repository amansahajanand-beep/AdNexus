require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { schemaQuery } = require('../src/db');
const { fetchCampaignSpend } = require('../src/ads/client');
const { getAccountByCustomerId } = require('../src/models/adsAccountStore');
const { resolveRefreshForAccount, syncAccountSpend } = require('../src/services/adsSyncService');

(async () => {
  const date = process.argv[2] || '2026-09-01';
  const customerId = process.argv[3] || '5628422125';
  const accRow = await schemaQuery(
    `SELECT client_id FROM ads_accounts WHERE customer_id = $1 LIMIT 1`,
    [customerId]
  );
  const clientId = accRow.rows[0]?.client_id;
  if (!clientId) throw new Error('Account client not found');
  const clients = await schemaQuery('SELECT id, name, network_code FROM gam_clients WHERE id = $1', [clientId]);
  const gamClient = clients.rows[0];
  const account = await getAccountByCustomerId(gamClient.id, customerId);
  if (!account) throw new Error('Account not found');
  const refreshToken = await resolveRefreshForAccount(account);

  const before = await schemaQuery(
    `SELECT COALESCE(SUM(cost_native),0) native, COALESCE(SUM(cost),0) usd, COALESCE(SUM(clicks),0) clicks
     FROM ads_spend_daily WHERE ads_account_id=$1 AND report_date=$2`,
    [account.id, date]
  );
  console.log('DB before', before.rows[0]);

  const campaignRows = await fetchCampaignSpend(gamClient, {
    customerId,
    refreshToken,
    loginCustomerId: account.loginCustomerId,
    startDate: date,
    endDate: date,
  });
  const campNative = campaignRows.reduce((s, r) => s + (Number(r.costNative) || 0), 0);
  const campUsd = campaignRows.reduce((s, r) => s + (Number(r.cost) || 0), 0);
  const campClicks = campaignRows.reduce((s, r) => s + (Number(r.clicks) || 0), 0);
  console.log('API campaign sum', { rows: campaignRows.length, campNative, campUsd, campClicks, currency: campaignRows[0]?.nativeCurrency });

  console.log('Running sync...');
  const n = await syncAccountSpend(account, { startDate: date, endDate: date, gamClient });
  console.log('sync wrote', n, 'rows');

  const after = await schemaQuery(
    `SELECT COALESCE(SUM(cost_native),0) native, COALESCE(SUM(cost),0) usd, COALESCE(SUM(clicks),0) clicks
     FROM ads_spend_daily WHERE ads_account_id=$1 AND report_date=$2`,
    [account.id, date]
  );
  console.log('DB after', after.rows[0]);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
