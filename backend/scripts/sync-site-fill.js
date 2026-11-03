/**
 * Pull site-wise total fill rate + total targeted impressions from GAM into the warehouse
 * (see src/services/siteFillSync.js for how the tables are derived).
 * Usage: node scripts/sync-site-fill.js [startYYYY-MM-DD] [endYYYY-MM-DD]   (default: last 90 days)
 */
require('dotenv').config();
const { listActiveClients } = require('../src/models/clientStore');
const { runWithClient } = require('../src/utils/clientContext');
const { syncSiteFill, ymd, addDays } = require('../src/services/siteFillSync');

(async () => {
  const end = process.argv[3] || ymd(new Date());
  const start = process.argv[2] || addDays(end, -89);
  for (const client of await listActiveClients()) {
    await runWithClient(client, async () => {
      console.log(`${client.name}: ${start}..${end}`);
      try {
        console.log('  ', await syncSiteFill(start, end));
      } catch (e) {
        console.warn(`   skipped: ${e.message}`);
      }
    });
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
