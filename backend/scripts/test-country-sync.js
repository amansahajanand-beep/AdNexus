/**
 * One-off diag: test Google Ads country spend GAQL for one account.
 * Usage: node scripts/test-country-sync.js [customerId]
 */
require('dotenv').config();
const { query } = require('../src/db');
const { getClientById } = require('../src/models/clientStore');
const { getAccountById } = require('../src/models/adsAccountStore');
const { runWithClient } = require('../src/utils/clientContext');
const {
  fetchCampaignSpendByCountry,
  fetchCampaignAppIds,
} = require('../src/ads/client');
const { resolveRefreshForAccount } = require('../src/services/adsSyncService');
const { todayInTZ, shiftYMD } = require('../src/utils/datetime');

async function main() {
  const customerIdArg = process.argv[2];
  const end = todayInTZ();
  const start = shiftYMD(end, -7);

  let row;
  if (customerIdArg) {
    const { rows } = await query(
      `SELECT a.id FROM ads_accounts a
       WHERE a.customer_id = $1 AND a.is_active = true LIMIT 1`,
      [customerIdArg]
    );
    row = rows[0];
  } else {
    const { rows } = await query(
      `SELECT a.id, a.customer_id, SUM(s.cost) AS spend
       FROM ads_accounts a
       JOIN ads_spend_daily s ON s.ads_account_id = a.id
       WHERE a.is_active = true AND a.account_type = 'client'
       GROUP BY a.id
       ORDER BY spend DESC
       LIMIT 1`
    );
    row = rows[0];
    if (row) console.log('Using top-spend account', row.customer_id);
  }
  if (!row) {
    console.error('No active account found');
    process.exit(1);
  }

  const account = await getAccountById(row.id);
  if (!account) {
    console.error('Account not found');
    process.exit(1);
  }

  const client = await getClientById(account.clientId);

  await runWithClient(client, async () => {
    const refreshToken = await resolveRefreshForAccount(account);
    if (!refreshToken) {
      console.error('No refresh token for account', customerId);
      process.exit(1);
    }

    const accountCtx = {
      customerId: account.customerId,
      loginCustomerId: account.loginCustomerId,
      refreshToken,
    };

    console.log('Testing user_location_view query for', account.customerId, start, '→', end);

    try {
      const campaignApps = await fetchCampaignAppIds(client, {
        customerId: accountCtx.customerId,
        refreshToken,
        loginCustomerId: accountCtx.loginCustomerId,
      });
      console.log('App campaigns:', campaignApps.length);

      const countryRows = await fetchCampaignSpendByCountry(client, {
        customerId: accountCtx.customerId,
        refreshToken,
        loginCustomerId: accountCtx.loginCustomerId,
        startDate: start,
        endDate: end,
        campaignAppIds: campaignApps,
      });
      console.log('Country rows returned:', countryRows.length);
      if (countryRows.length) {
        console.log('Sample:', countryRows.slice(0, 3));
      }
    } catch (e) {
      console.error('GAQL error:', e.message);
      if (e.errors) console.error(JSON.stringify(e.errors, null, 2));
      process.exit(1);
    }
  });
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
