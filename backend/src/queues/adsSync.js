const { Queue } = require('bullmq');
const { createBullmqConnection } = require('../redisClient');
const { isSyncQueueEnabled } = require('./gamSync');

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

const adsSyncQueue = queueEnabled
  ? new Queue('ads-sync', {
      connection: createBullmqConnection('BullMQ ads-sync queue'),
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 30000 },
        removeOnComplete: { count: 20 },
        removeOnFail: { count: 40 },
      },
    })
  : createDisabledQueue('ads-sync');

module.exports = { adsSyncQueue };
