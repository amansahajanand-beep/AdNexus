/**
 * BullMQ worker — Google Ads spend sync jobs.
 */
const { Worker } = require('bullmq');
const { createBullmqConnection, isTransientRedisError } = require('../redisClient');
const logger = require('../utils/logger');
const { runWithClient } = require('../utils/clientContext');
const { getClientById } = require('../models/clientStore');
const { syncAllAccountsForClient, syncAccountSpend } = require('../services/adsSyncService');
const { getAccountById } = require('../models/adsAccountStore');
const { todayInTZ, shiftYMD } = require('../utils/datetime');
const { isSyncQueueEnabled } = require('../queues/gamSync');

async function processJob(job) {
  const clientId = job.data?.clientId;
  if (!clientId) {
    logger.warn('[ads-sync] missing clientId');
    return;
  }
  const client = await getClientById(clientId);
  if (!client) {
    logger.warn(`[ads-sync] unknown client ${clientId}`);
    return;
  }

  return runWithClient(client, async () => {
    const lookback = parseInt(process.env.GOOGLE_ADS_SYNC_LOOKBACK_DAYS || '30', 10) || 30;
    const end = job.data?.endDate || todayInTZ();
    const start = job.data?.startDate || shiftYMD(end, -(lookback - 1));

    if (job.name === 'ads-sync-account' && job.data?.adsAccountId) {
      const account = await getAccountById(job.data.adsAccountId);
      if (!account) return;
      const n = await syncAccountSpend(account, { startDate: start, endDate: end, gamClient: client });
      logger.info(`[ads-sync] account ${account.customerId} wrote ${n}`);
      return { rows: n };
    }

    const result = await syncAllAccountsForClient(client, { startDate: start, endDate: end });
    logger.info(`[ads-sync] client=${clientId.slice(0, 8)} total=${result.total} errors=${result.errors.length}`);
    return result;
  });
}

function startAdsWorker() {
  if (!isSyncQueueEnabled()) {
    logger.info('[ads-sync] worker skipped (sync/redis disabled)');
    return null;
  }

  const worker = new Worker('ads-sync', processJob, {
    connection: createBullmqConnection('BullMQ ads-sync worker'),
    concurrency: 1,
  });

  worker.on('failed', (job, err) => {
    if (isTransientRedisError(err)) {
      logger.warn(`[ads-sync] job ${job?.id} transient fail: ${err.message}`);
      return;
    }
    logger.error(`[ads-sync] job ${job?.id} failed:`, err.message);
  });

  logger.info('[ads-sync] worker started');
  return worker;
}

module.exports = { startAdsWorker, processJob };
