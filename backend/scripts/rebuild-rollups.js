#!/usr/bin/env node
/**
 * Force-rebuild dashboard rollups from existing report_present / report_daily.
 * Usage: cd backend && node scripts/rebuild-rollups.js
 */
require('dotenv').config();
const { initSchema } = require('../src/db');
const { rebuildRollupsForDates, backfillAllRollups } = require('../src/services/gamSyncService');
const { query } = require('../src/db');
const logger = require('../src/utils/logger');

async function main() {
  await initSchema();
  const force = process.argv.includes('--force');
  if (force) {
    const { rows } = await query(`
      SELECT DISTINCT to_char(report_date, 'YYYY-MM-DD') AS d FROM (
        SELECT report_date FROM report_daily
        UNION
        SELECT report_date FROM report_present
      ) x ORDER BY 1
    `);
    const dates = rows.map((r) => r.d).filter(Boolean);
    logger.info(`Force rebuilding rollups for ${dates.length} day(s)…`);
    const n = await rebuildRollupsForDates(dates, 'rebuild-rollups');
    logger.info(`Done. kpi rows≈${n}`);
  } else {
    const n = await backfillAllRollups('rebuild-rollups');
    logger.info(`Done. kpi rows≈${n}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
