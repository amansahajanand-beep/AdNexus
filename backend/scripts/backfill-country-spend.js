/**
 * Backfill country spend for accounts that already have campaign spend.
 * Usage: node scripts/backfill-country-spend.js [lookbackDays]
 */
require('dotenv').config();
const { query } = require('../src/db');
const { listActiveClients } = require('../src/models/clientStore');
const { listSyncableClientAccounts } = require('../src/models/adsAccountStore');
const { runWithClient } = require('../src/utils/clientContext');
const { syncAccountSpend } = require('../src/services/adsSyncService');
const { todayInTZ, shiftYMD } = require('../src/utils/datetime');

async function main() {
  const lookback = parseInt(process.argv[2] || process.env.GOOGLE_ADS_SYNC_LOOKBACK_DAYS || '30', 10) || 30;
  const end = todayInTZ();
  const start = shiftYMD(end, -(lookback - 1));

  const before = await query('SELECT COUNT(*)::int AS n FROM ads_spend_country_daily');
  console.log(`Country rows before: ${before.rows[0].n}`);
  console.log(`Backfilling ${start} → ${end} (lookback ${lookback} days)`);

  const clients = await listActiveClients();
  let totalAccounts = 0;
  let errors = 0;

  for (const client of clients) {
    await runWithClient(client, async () => {
      const accounts = await listSyncableClientAccounts(client.id);
      for (const acc of accounts) {
        totalAccounts += 1;
        try {
          const n = await syncAccountSpend(acc, { startDate: start, endDate: end, gamClient: client });
          console.log(`OK ${acc.customerId} (${acc.descriptiveName || acc.id}) campaign rows=${n}`);
        } catch (e) {
          errors += 1;
          console.error(`FAIL ${acc.customerId}: ${e.message}`);
        }
      }
    });
  }

  const after = await query('SELECT COUNT(*)::int AS n FROM ads_spend_country_daily');
  console.log(`Country rows after: ${after.rows[0].n} (accounts=${totalAccounts}, errors=${errors})`);
  process.exit(errors ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
