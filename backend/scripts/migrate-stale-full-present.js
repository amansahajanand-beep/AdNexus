/**
 * One-shot: move any non-today rows from report_full_present → report_full_daily.
 * Usage: node scripts/migrate-stale-full-present.js
 */
require('dotenv').config();
const { initSchema, query } = require('../src/db');
const { migrateStaleFullPresentToDaily } = require('../src/services/gamSyncService');
const logger = require('../src/utils/logger');

(async () => {
  await initSchema();
  const before = await query(`
    SELECT 'present' AS t, COUNT(*)::int AS n, MIN(report_date)::text AS mn, MAX(report_date)::text AS mx
    FROM report_full_present
    UNION ALL
    SELECT 'daily', COUNT(*)::int, MIN(report_date)::text, MAX(report_date)::text
    FROM report_full_daily
  `);
  logger.info('Before:', JSON.stringify(before.rows));

  const n = await migrateStaleFullPresentToDaily('manual-migrate');
  logger.info(`Migrated ${n} row(s)`);

  const after = await query(`
    SELECT 'present' AS t, COUNT(*)::int AS n, MIN(report_date)::text AS mn, MAX(report_date)::text AS mx
    FROM report_full_present
    UNION ALL
    SELECT 'daily', COUNT(*)::int, MIN(report_date)::text, MAX(report_date)::text
    FROM report_full_daily
  `);
  logger.info('After:', JSON.stringify(after.rows));
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
