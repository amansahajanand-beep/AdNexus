/**
 * One-shot: compare Network vs Mediation totals, then sync with mediation (default).
 * Usage: node scripts/resync-admob-mediation.js
 */
require('dotenv').config();
const { initSchema, query } = require('../src/db');
const { admobAccountStore } = require('../src/models/publisherAccountStore');
const { getClientById } = require('../src/models/clientStore');
const { runWithClient } = require('../src/utils/clientContext');
const { generateAdMobReport } = require('../src/admob/client');
const { syncAdMobAccount } = require('../src/services/admobSyncService');
const { todayInTZ, shiftYMD } = require('../src/utils/datetime');

async function sumReport(gamClient, account, flavor, startDate, endDate) {
  const rows = await generateAdMobReport(gamClient, {
    accountId: account.accountId,
    refreshToken: account.refreshToken,
    startDate,
    endDate,
    currencyCode: account.currencyCode || 'USD',
    dimensions: ['DATE'],
    flavor,
  });
  const earnings = rows.reduce((s, r) => s + (Number(r.earnings) || 0), 0);
  const impressions = rows.reduce((s, r) => s + (Number(r.impressions) || 0), 0);
  return { days: rows.length, earnings, impressions };
}

(async () => {
  await initSchema();
  const ids = (await query(`SELECT id, client_id FROM admob_accounts LIMIT 5`)).rows;
  if (!ids.length) {
    console.error('No AdMob accounts');
    process.exit(1);
  }

  for (const row of ids) {
    const account = await admobAccountStore.getAccountById(row.id);
    if (!account?.refreshToken) {
      console.log('skip', row.id, 'no token');
      continue;
    }
    const client = await getClientById(account.clientId || row.client_id);
    if (!client) {
      console.log('skip', account.accountId, 'no client');
      continue;
    }

    await runWithClient(client, async () => {
      const today = todayInTZ();
      const yesterday = shiftYMD(today, -1);
      const weekStart = '2026-09-15';
      const weekEnd = '2026-09-21';

      console.log('account', account.accountId, 'today', today);

      for (const flavor of ['network', 'mediation']) {
        try {
          const week = await sumReport(client, account, flavor, weekStart, weekEnd);
          const day = await sumReport(client, account, flavor, today, today);
          const yday = await sumReport(client, account, flavor, yesterday, yesterday);
          console.log(JSON.stringify({
            flavor,
            week_sep15_21: { e: +week.earnings.toFixed(2), i: week.impressions, days: week.days },
            yesterday: { e: +yday.earnings.toFixed(2), i: yday.impressions },
            today: { e: +day.earnings.toFixed(2), i: day.impressions },
          }));
        } catch (e) {
          console.error(flavor, 'fetch failed:', e.message);
        }
      }

      const start = shiftYMD(today, -29);
      console.log('syncing mediation', start, '→', today);
      const result = await syncAdMobAccount(account, {
        startDate: start,
        endDate: today,
        gamClient: client,
      });
      console.log('sync result', result);
    });
  }

  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
