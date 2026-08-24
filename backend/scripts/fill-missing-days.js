/**
 * Fill warehouse gaps — sync any day in range missing KPI grain from GAM.
 * Usage: node scripts/fill-missing-days.js [days=30]
 */
require('dotenv').config();
const { runWithClient } = require('../src/utils/clientContext');
const { ensureBootstrapFromEnv } = require('../src/models/clientStore');
const { todayInTZ, shiftYMD } = require('../src/utils/datetime');
const {
  listMissingGrainDates,
  fillMissingGrainDates,
} = require('../src/services/gamSyncService');
const logger = require('../src/utils/logger');

async function main() {
  const days = Math.max(1, parseInt(process.argv[2] || '30', 10) || 30);
  const today = todayInTZ();
  const start = shiftYMD(today, -(days - 1));
  const client = await ensureBootstrapFromEnv();

  await runWithClient(client, async () => {
    const before = await listMissingGrainDates(start, today);
    logger.info(`Before: ${before.length} missing day(s) in ${start}..${today}`);
    if (before.length) logger.info(`  ${before.join(', ')}`);

    const total = await fillMissingGrainDates(start, today, 'fill-missing-script');

    const after = await listMissingGrainDates(start, today);
    logger.info(`After: ${after.length} missing day(s); grain rows upserted≈${total}`);
    if (after.length) logger.info(`  Still missing: ${after.join(', ')}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
