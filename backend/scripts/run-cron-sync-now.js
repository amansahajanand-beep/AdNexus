/**
 * Run present + past sync now (lean dashboard tables + full Reporting tables).
 * Same work as hourly cron + 2AM backfill.
 *
 * Usage: node scripts/run-cron-sync-now.js
 */
require('dotenv').config();
const { initSchema, query } = require('../src/db');
const {
  syncDateRangeFromGAM,
  syncFullDateRangeFromGAM,
  fetchFromGAM,
  fetchFullFromGAM,
  normalizeGAMRows,
  replacePresentRows,
  replaceHistoricalRows,
  replaceFullPresentRows,
  replaceFullHistoricalRows,
} = require('../src/services/gamSyncService');
const { historicalRangeForPresets, todayInTZ } = require('../src/utils/datetime');
const logger = require('../src/utils/logger');

(async () => {
  await initSchema();
  require('../src/routes/reports'); // registers __gamHelpers

  const hist = historicalRangeForPresets();
  const today = todayInTZ();
  const currency = process.env.GAM_CURRENCY || 'USD';

  logger.info('=== Manual cron sync starting ===');
  logger.info(`Present (today): ${today} → report_present + report_full_present`);
  logger.info(
    `Past window: ${hist.startDate} → ${hist.endDate}`
    + ` (yesterday / 7d / 30d / this month / last month)`
    + ' → report_daily + report_full_daily'
  );

  // ── 1. Present (lean) ────────────────────────────────────────────────────
  logger.info(`[1/4] Lean present ${today}…`);
  const presentRaw = await fetchFromGAM(today, today);
  const presentNorm = normalizeGAMRows(presentRaw, currency);
  const presentCount = await replacePresentRows(presentNorm, 'manual-sync-today');
  logger.info(`[1/4] Lean present done — ${presentCount} rows → report_present`);

  // ── 2. Past (lean) ───────────────────────────────────────────────────────
  logger.info(`[2/4] Lean past ${hist.startDate} → ${hist.endDate}…`);
  const pastLean = await syncDateRangeFromGAM(hist.startDate, hist.endDate, 'manual-sync-backfill');
  logger.info(`[2/4] Lean past done — ${pastLean} rows → report_daily`);

  // ── 3. Present (full Reporting slices) ───────────────────────────────────
  if (process.env.FULL_SYNC_DISABLED === 'true') {
    logger.info('[3/4] Full sync skipped (FULL_SYNC_DISABLED=true)');
  } else {
    logger.info(`[3/4] Full present ${today} (multi-slice)…`);
    const fullPresent = await fetchFullFromGAM(today, today);
    const fullPresentCount = await replaceFullPresentRows(fullPresent, 'manual-sync-today-full');
    logger.info(`[3/4] Full present done — ${fullPresentCount} rows → report_full_present`);

    // ── 4. Past (full) ─────────────────────────────────────────────────────
    logger.info(`[4/4] Full past ${hist.startDate} → ${hist.endDate} (multi-slice, may take a while)…`);
    const fullPast = await syncFullDateRangeFromGAM(hist.startDate, hist.endDate, 'manual-sync-full-backfill');
    logger.info(`[4/4] Full past done — ${fullPast} rows → report_full_daily`);
  }

  const counts = await query(`
    SELECT 'report_present' AS tbl, COUNT(*)::int AS n FROM report_present
    UNION ALL SELECT 'report_daily', COUNT(*)::int FROM report_daily
    UNION ALL SELECT 'report_full_present', COUNT(*)::int FROM report_full_present
    UNION ALL SELECT 'report_full_daily', COUNT(*)::int FROM report_full_daily
  `);
  logger.info('=== Table counts ===');
  counts.rows.forEach((r) => logger.info(`  ${r.tbl}: ${r.n}`));
  logger.info('=== Manual cron sync complete ===');
  logger.info('Recurring cron is enabled (SYNC_DISABLED=false) — restart backend to pick it up.');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
