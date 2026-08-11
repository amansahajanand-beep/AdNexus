/**
 * Fill report_full_present + report_full_daily only (lean tables unchanged).
 * Usage: node scripts/run-full-sync-now.js
 */
require('dotenv').config();
const { initSchema, query } = require('../src/db');
const { syncFullDateRangeFromGAM } = require('../src/services/gamSyncService');
const { historicalRangeForPresets, todayInTZ } = require('../src/utils/datetime');
const logger = require('../src/utils/logger');

(async () => {
  await initSchema();
  require('../src/routes/reports');

  const today = todayInTZ();
  const hist = historicalRangeForPresets();

  logger.info(`Full present: ${today} → report_full_present`);
  const presentN = await syncFullDateRangeFromGAM(today, today, 'manual-full-present');
  logger.info(`Full present done — ${presentN} rows`);

  logger.info(`Full past: ${hist.startDate} → ${hist.endDate} → report_full_daily`);
  const pastN = await syncFullDateRangeFromGAM(hist.startDate, hist.endDate, 'manual-full-past');
  logger.info(`Full past done — ${pastN} rows`);

  const { rows } = await query(`
    SELECT 'report_full_present' AS tbl, COUNT(*)::int AS n FROM report_full_present
    UNION ALL SELECT 'report_full_daily', COUNT(*)::int FROM report_full_daily
  `);
  rows.forEach((r) => logger.info(`  ${r.tbl}: ${r.n}`));
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
