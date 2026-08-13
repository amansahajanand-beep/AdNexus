/**
 * Re-pull past days from GAM into report_daily and rebuild rollups.
 * Usage: node scripts/resync-history.js [startDate] [endDate]
 * Example: node scripts/resync-history.js 2026-07-01 2026-08-11
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { runWithClient } = require('../src/utils/clientContext');
const { ensureBootstrapFromEnv } = require('../src/models/clientStore');
const { historicalRangeForPresets, todayInTZ, shiftYMD } = require('../src/utils/datetime');

async function main() {
  const hist = historicalRangeForPresets();
  const today = todayInTZ();
  const endDate = process.argv[3] || process.argv[2] || hist.endDate;
  const startDate = process.argv[3] ? process.argv[2] : hist.startDate;

  if (endDate >= today) {
    console.error(`End date must be before today (${today}). Use resync-today.js for today.`);
    process.exit(1);
  }

  const client = await ensureBootstrapFromEnv();
  require('../src/routes/reports');

  const svc = require('../src/services/gamSyncService');
  console.log(`Re-syncing GAM history ${startDate} .. ${endDate} (excludes today)`);

  await runWithClient(client, async () => {
    const total = await svc.syncDateRangeFromGAM(startDate, endDate, 'manual-history-resync');
    console.log(`Done — ${total} row(s) upserted across report_daily.`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
