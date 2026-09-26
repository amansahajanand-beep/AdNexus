/**
 * Dedicated GAM worker process — run separately from the API:
 *   node src/worker.js
 *
 * Set RUN_IN_PROCESS_WORKERS=false on the API so jobs are not processed twice.
 */
require('dotenv').config();
const logger = require('./utils/logger');

async function main() {
  try {
    const { initSchema } = require('./db');
    await initSchema();
  } catch (e) {
    logger.warn('Worker schema init failed (continuing):', e.message);
  }

  const { startWorker, startReportWorker } = require('./workers/gamSyncWorker');
  const { startAdsWorker } = require('./workers/adsSyncWorker');
  const { startAdMobWorker, startAdSenseWorker } = require('./workers/publisherSyncWorker');
  startWorker();
  startReportWorker();
  startAdsWorker();
  startAdMobWorker();
  startAdSenseWorker();
  logger.info('gam-worker process ready (GAM + Ads + AdMob + AdSense)');
}

main().catch((err) => {
  logger.error('gam-worker failed to start:', err.message);
  process.exit(1);
});
