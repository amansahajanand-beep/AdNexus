const { Queue } = require('bullmq');
const { createBullmqConnection } = require('../redisClient');
const { isSyncQueueEnabled, bullmqPrefix } = require('./gamSync');

function createDisabledQueue(name) {
  return {
    name,
    disabled: true,
    async add() { return { id: `${name}:disabled`, name }; },
    async getJob() { return null; },
    async close() { return undefined; },
  };
}

const queueEnabled = isSyncQueueEnabled();
const prefix = bullmqPrefix();

function makeOpts() {
  const opts = {
    connection: createBullmqConnection('BullMQ publisher-sync queue'),
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'exponential', delay: 30000 },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 40 },
    },
  };
  if (prefix) opts.prefix = prefix;
  return opts;
}

const admobSyncQueue = queueEnabled
  ? new Queue('admob-sync', makeOpts())
  : createDisabledQueue('admob-sync');

const adsenseSyncQueue = queueEnabled
  ? new Queue('adsense-sync', makeOpts())
  : createDisabledQueue('adsense-sync');

/** Re-queue after a failed/completed job with the same id (Sync now was a no-op). */
async function addPublisherJob(queue, name, data, opts = {}) {
  const jobId = opts.jobId;
  if (jobId && queue && typeof queue.getJob === 'function') {
    try {
      const existing = await queue.getJob(jobId);
      if (existing && typeof existing.getState === 'function') {
        const state = await existing.getState();
        if (state === 'completed' || state === 'failed' || state === 'unknown') {
          await existing.remove();
        }
      }
    } catch {
      /* ignore */
    }
  }
  return queue.add(name, data, opts);
}

module.exports = { admobSyncQueue, adsenseSyncQueue, addPublisherJob };
