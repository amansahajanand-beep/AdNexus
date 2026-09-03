require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { schemaQuery } = require('../src/db');
const { fetchCampaignSpend } = require('../src/ads/client');
const { getAccountByCustomerId } = require('../src/models/adsAccountStore');
const { resolveRefreshForAccount } = require('../src/services/adsSyncService');
const { createAdsApi, customerClient, gaqlQuery } = require('../src/ads/client');

async function fetchAccountDaily(gamClient, { customerId, refreshToken, loginCustomerId, startDate, endDate }) {
  const api = createAdsApi(gamClient);
  const customer = customerClient(api, { customerId, refreshToken, loginCustomerId });
  const rows = await gaqlQuery(customer, `
    SELECT segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions
    FROM customer
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
  `);
  return (rows || []).map((r) => {
    const m = r.metrics || {};
    const costMicros = Number(m.cost_micros) || 0;
    return {
      date: r.segments?.date,
      costNative: costMicros / 1e6,
      clicks: Number(m.clicks) || 0,
      impressions: Number(m.impressions) || 0,
      conversions: Number(m.conversions) || 0,
    };
  });
}

(async () => {
  const date = process.argv[2] || '2026-09-01';
  const customerId = process.argv[3] || '5628422125';
  const clients = await schemaQuery('SELECT id, name FROM clients LIMIT 1');
  const gamClient = clients.rows[0];
  const account = await getAccountByCustomerId(gamClient.id, customerId);
  if (!account) throw new Error('Account not found');
  const refreshToken = await resolveRefreshForAccount(account);

  const [campaignRows, accountRows] = await Promise.all([
    fetchCampaignSpend(gamClient, {
      customerId,
      refreshToken,
      loginCustomerId: account.loginCustomerId,
      startDate: date,
      endDate: date,
    }),
    fetchAccountDaily(gamClient, {
      customerId,
      refreshToken,
      loginCustomerId: account.loginCustomerId,
      startDate: date,
      endDate: date,
    }),
  ]);

  const campSum = campaignRows.reduce((s, r) => s + (Number(r.costNative) || 0), 0);
  const campUsd = campaignRows.reduce((s, r) => s + (Number(r.cost) || 0), 0);
  const acct = accountRows.find((r) => r.date === date) || accountRows[0];

  console.log('account', account.descriptiveName, customerId);
  console.log('account-level (customer resource):', acct);
  console.log('campaign rows', campaignRows.length, 'native sum', campSum, 'usd sum', campUsd);
  console.log('currency', campaignRows[0]?.nativeCurrency, 'fx sample', campaignRows[0]?.cost, campaignRows[0]?.costNative);

  const db = await schemaQuery(
    `SELECT COALESCE(SUM(cost_native),0) native, COALESCE(SUM(cost),0) usd, COALESCE(SUM(clicks),0) clicks
     FROM ads_spend_daily WHERE ads_account_id=$1 AND report_date=$2`,
    [account.id, date]
  );
  console.log('db stored', db.rows[0]);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
