/**
 * Enqueue full-only sync jobs (report_full_present + report_full_daily).
 * Does not rewrite lean report_present / report_daily.
 * Usage: node scripts/enqueue-full-sync.js
 */
require('dotenv').config();
const { gamSyncQueue } = require('../src/queues/gamSync');
const { todayInTZ, historicalRangeForPresets } = require('../src/utils/datetime');
const logger = require('../src/utils/logger');

(async () => {
  const today = todayInTZ();
  const hist = historicalRangeForPresets();
  const slot = Math.floor(Date.now() / (60 * 60 * 1000));

  const todayJob = await gamSyncQueue.add('sync-full-today', {
    startDate: today,
    endDate: today,
  }, {
    jobId: `sync-full-today-${today}-${slot}`,
    attempts: 2,
    backoff: { type: 'fixed', delay: 30000 },
  });
  logger.info(`Enqueued ${todayJob.name} id=${todayJob.id} → report_full_present (${today})`);

  const pastJob = await gamSyncQueue.add('sync-full-backfill', {
    startDate: hist.startDate,
    endDate: hist.endDate,
  }, {
    jobId: `sync-full-backfill-${hist.startDate}-${hist.endDate}`,
    attempts: 2,
    backoff: { type: 'fixed', delay: 60000 },
  });
  logger.info(
    `Enqueued ${pastJob.name} id=${pastJob.id}`
    + ` → report_full_daily (${hist.startDate} → ${hist.endDate})`
  );

  logger.info('Restart backend if needed so the worker picks up sync-full-* job types, then watch logs.');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
