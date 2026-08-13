const { Queue } = require('bullmq');
const { createBullmqConnection } = require('../redisClient');

function createDisabledQueue(name) {
  return {
    name,
    async add() { return { id: `${name}:disabled`, name }; },
    async getJob() { return null; },
    async close() { return undefined; },
  };
}

const useQueue = process.env.REDIS_DISABLED === 'true' || process.env.SYNC_DISABLED === 'true' || !process.env.REDIS_URL;

// One queue for all background GAM sync jobs.
// Workers read from this same queue name.
const gamSyncQueue = useQueue
  ? createDisabledQueue('gam-sync')
  : new Queue('gam-sync', {
      connection: createBullmqConnection('BullMQ gam-sync queue'),
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 20000 },
        removeOnComplete: { count: 20 },
        removeOnFail:     { count: 40 },
      },
    });

// Separate queue for on-demand user report jobs (Reporting page custom queries).
// Lower concurrency — user is waiting for result.
const gamReportQueue = useQueue
  ? createDisabledQueue('gam-report')
  : new Queue('gam-report', {
      connection: createBullmqConnection('BullMQ gam-report queue'),
      defaultJobOptions: {
        attempts: 1,
        backoff: { type: 'fixed', delay: 30000 },
        removeOnComplete: { count: 20 },
        removeOnFail:     { count: 40 },
      },
    });

module.exports = { gamSyncQueue, gamReportQueue };
