/**
 * Push daily data to every user's connected Google Sheet now (same job as the 06:30 cron).
 *
 * Usage:
 *   node scripts/export-daily-sheets.js                       # last 7 days through yesterday
 *   node scripts/export-daily-sheets.js --days 30
 *   node scripts/export-daily-sheets.js --start 2026-11-01 --end 2026-11-20
 *   node scripts/export-daily-sheets.js --user <user-id>      # one user only
 */
require('dotenv').config();
const { initSchema } = require('../src/db');
const { todayInTZ, shiftYMD } = require('../src/utils/datetime');
const { runAllConnections, runConnection } = require('../src/services/sheetsExportService');
const { getConnection } = require('../src/models/sheetExportStore');
const logger = require('../src/utils/logger');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

(async () => {
  await initSchema();
  const endDate = arg('end') || shiftYMD(todayInTZ(), -1);
  const days = parseInt(arg('days') || process.env.SHEETS_EXPORT_LOOKBACK_DAYS || '7', 10);
  const startDate = arg('start') || shiftYMD(endDate, -(days - 1));
  logger.info(`Sheets export: ${startDate} → ${endDate}`);

  let results;
  if (arg('user')) {
    const conn = await getConnection(arg('user'));
    if (!conn) throw new Error('That user has no connected sheet');
    results = [{ userId: conn.user_id, ...(await runConnection(conn, { startDate, endDate })) }];
  } else {
    results = await runAllConnections({ startDate, endDate });
  }
  console.log(JSON.stringify(results, null, 2));
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
})().catch((err) => {
  logger.error(`Sheets export failed: ${err.message}`);
  process.exit(1);
});
