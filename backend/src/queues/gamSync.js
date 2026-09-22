const { Queue } = require('bullmq');
const { createBullmqConnection } = require('../redisClient');
const logger = require('../utils/logger');

function createDisabledQueue(name) {
  return {
    name,
    disabled: true,
    async add(jobName, data, opts) {
      logger.error(
        `[gam-sync] Queue disabled — job "${jobName}" was NOT enqueued`
        + ` (REDIS_URL missing, REDIS_DISABLED=true, or SYNC_DISABLED=true)`
      );
      return { id: `${name}:disabled`, name, rejected: true };
    },
    async getJob() { return null; },
    async close() { return undefined; },
  };
}

/** True when BullMQ can actually process sync jobs (Redis up + sync not disabled). */
function isSyncQueueEnabled() {
  return process.env.REDIS_DISABLED !== 'true'
    && process.env.SYNC_DISABLED !== 'true'
    && Boolean(process.env.REDIS_URL);
}

const queueEnabled = isSyncQueueEnabled();

/** Isolate local/dev from other machines sharing the same Upstash Redis. */
function bullmqPrefix() {
  const p = String(process.env.BULLMQ_PREFIX || '').trim();
  return p || undefined;
}

const bullOpts = {
  connection: createBullmqConnection('BullMQ gam-sync queue'),
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 20000 },
    removeOnComplete: { count: 20 },
    removeOnFail:     { count: 40 },
  },
};
const prefix = bullmqPrefix();
if (prefix) bullOpts.prefix = prefix;

// One queue for all background GAM sync jobs.
// Workers read from this same queue name.
const gamSyncQueue = queueEnabled
  ? new Queue('gam-sync', bullOpts)
  : createDisabledQueue('gam-sync');

const reportOpts = {
  connection: createBullmqConnection('BullMQ gam-report queue'),
  defaultJobOptions: {
    attempts: 1,
    backoff: { type: 'fixed', delay: 30000 },
    removeOnComplete: { count: 20 },
    removeOnFail:     { count: 40 },
  },
};
if (prefix) reportOpts.prefix = prefix;

// Separate queue for on-demand user report jobs (Reporting page custom queries).
// Lower concurrency — user is waiting for result.
const gamReportQueue = queueEnabled
  ? new Queue('gam-report', reportOpts)
  : createDisabledQueue('gam-report');

module.exports = { gamSyncQueue, gamReportQueue, isSyncQueueEnabled, bullmqPrefix };
