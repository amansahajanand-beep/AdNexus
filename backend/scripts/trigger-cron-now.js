/**
 * Enqueue cron sync jobs immediately (same as boot + hourly cron).
 * Usage: node scripts/trigger-cron-now.js
 */
require('dotenv').config();
const { enqueueHourlyLeanSync } = require('../src/cron');
const logger = require('../src/utils/logger');

enqueueHourlyLeanSync({ reason: 'manual' })
  .then(() => {
    logger.info('Cron sync enqueued — watch logs for [gam-sync] Processing job "sync-today"');
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
