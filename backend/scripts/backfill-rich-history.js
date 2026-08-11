/**
 * Verify past-data extraction from GAM API, then backfill report_daily.
 * Window: start of last month → yesterday (covers yesterday/7d/30d/this month/last month).
 *
 * Usage: node scripts/backfill-rich-history.js
 */
require('dotenv').config();
const { initSchema, query } = require('../src/db');
const {
  listDatesMissingRichDims,
  presentHasCountryAndDevice,
  syncDateRangeFromGAM,
  fetchFromGAM,
  normalizeGAMRows,
} = require('../src/services/gamSyncService');
const { historicalRangeForPresets } = require('../src/utils/datetime');
const logger = require('../src/utils/logger');

(async () => {
  await initSchema();
  require('../src/routes/reports'); // registers __gamHelpers

  const hist = historicalRangeForPresets();
  logger.info('=== Past data source check ===');
  logger.info('Source: GAM API via fetchFromGAM() → runReportAndDownload()');
  logger.info(
    `Window → report_daily: ${hist.startDate} → ${hist.endDate}`
    + ` (yesterday=${hist.yesterday}, 7d=${hist.last7Start}, 30d=${hist.last30Start},`
    + ` thisMonth=${hist.thisMonthStart}, lastMonth=${hist.lastMonthStart}..${hist.lastMonthEnd})`
  );

  // Prove one past day is extracted from the live GAM API before full backfill.
  const probeDay = hist.yesterday;
  logger.info(`API probe: fetching ${probeDay} from GAM…`);
  const raw = await fetchFromGAM(probeDay, probeDay);
  const normalized = normalizeGAMRows(raw, process.env.GAM_CURRENCY || 'USD');
  const sample = normalized[0] || null;
  logger.info(`API probe OK: ${normalized.length} rows from GAM for ${probeDay}`);
  if (sample) {
    logger.info(
      `API sample dimensions keys: ${Object.keys(sample.dimensions || {}).join(', ')}`
    );
    logger.info(
      `API sample metrics keys: ${Object.keys(sample.metrics || {}).join(', ')}`
    );
  }

  const { rows: before } = await query('SELECT COUNT(*)::int AS n FROM report_daily');
  logger.info(`report_daily before backfill: ${before[0].n} rows`);

  if (!(await presentHasCountryAndDevice())) {
    logger.info(`Backfill: syncing present ${hist.today} → report_present`);
    await syncDateRangeFromGAM(hist.today, hist.today, 'sync-today');
  } else {
    logger.info('Backfill: report_present already rich');
  }

  const missing = await listDatesMissingRichDims(hist.startDate, hist.endDate);
  if (!missing.length) {
    logger.info(`Backfill: report_daily already complete for ${hist.startDate} → ${hist.endDate}`);
  } else {
    logger.info(`Backfill: ${missing.length} day(s) → ${missing[0]} … ${missing[missing.length - 1]} (from GAM API)`);
    await syncDateRangeFromGAM(missing[0], missing[missing.length - 1], 'sync-backfill-cli');
  }

  const { rows: after } = await query(
    `SELECT COUNT(*)::int AS n,
            MIN(report_date)::text AS min_d,
            MAX(report_date)::text AS max_d,
            COUNT(DISTINCT report_date)::int AS days
     FROM report_daily`
  );
  logger.info(`report_daily after backfill: ${JSON.stringify(after[0])}`);
  logger.info('Done — past data extracted from GAM API into report_daily');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
