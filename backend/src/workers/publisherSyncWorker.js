const { Worker } = require('bullmq');
const { createBullmqConnection } = require('../redisClient');
const logger = require('../utils/logger');
const { runWithClient } = require('../utils/clientContext');
const { getClientById } = require('../models/clientStore');
const {
  syncAdMobAccount,
  syncAdMobAccountToday,
  syncAdMobAccountYesterday,
} = require('../services/admobSyncService');
const {
  syncAdSenseAccount,
  syncAdSenseAccountToday,
  syncAdSenseAccountYesterday,
} = require('../services/adsenseSyncService');
const { admobAccountStore, adsenseAccountStore } = require('../models/publisherAccountStore');
const { todayInTZ, shiftYMD } = require('../utils/datetime');
const { isSyncQueueEnabled, bullmqPrefix } = require('../queues/gamSync');

function workerOpts(label) {
  const opts = {
    connection: createBullmqConnection(label),
    concurrency: 1,
  };
  const prefix = bullmqPrefix();
  if (prefix) opts.prefix = prefix;
  return opts;
}

function rowCount(result) {
  if (result == null) return 0;
  if (typeof result === 'number') return result;
  return Number(result.rows) || 0;
}

function startAdMobWorker() {
  if (!isSyncQueueEnabled()) {
    logger.info('[admob-sync] queue disabled — worker not started');
    return null;
  }
  const worker = new Worker('admob-sync', async (job) => {
    const clientId = job.data?.clientId;
    if (!clientId) return;
    const client = await getClientById(clientId);
    if (!client) return;
    return runWithClient(client, async () => {
      const end = job.data?.endDate || todayInTZ();
      const lookback = parseInt(process.env.ADMOB_SYNC_LOOKBACK_DAYS || '30', 10) || 30;
      const start = job.data?.startDate || shiftYMD(end, -(lookback - 1));
      const accountId = job.data?.admobAccountId;
      if (!accountId) {
        const { syncAllAdMobForClient } = require('../services/admobSyncService');
        return syncAllAdMobForClient(client, { startDate: start, endDate: end });
      }
      const account = await admobAccountStore.getAccountById(accountId);
      if (!account) return;

      let result;
      if (job.name === 'admob-sync-today') {
        result = await syncAdMobAccountToday(account, { gamClient: client });
      } else if (job.name === 'admob-sync-yesterday') {
        result = await syncAdMobAccountYesterday(account, { gamClient: client });
      } else {
        result = await syncAdMobAccount(account, { startDate: start, endDate: end, gamClient: client });
      }
      const n = rowCount(result);
      logger.info(`[admob-sync] ${job.name} ${account.accountId} wrote ${n}`);
      return { rows: n };
    });
  }, workerOpts('BullMQ admob-sync worker'));

  worker.on('failed', (job, err) => {
    logger.error(`[admob-sync] job ${job?.id} failed:`, err.message);
  });
  logger.info('[admob-sync] worker started');
  return worker;
}

function startAdSenseWorker() {
  if (!isSyncQueueEnabled()) {
    logger.info('[adsense-sync] queue disabled — worker not started');
    return null;
  }
  const worker = new Worker('adsense-sync', async (job) => {
    const clientId = job.data?.clientId;
    if (!clientId) return;
    const client = await getClientById(clientId);
    if (!client) return;
    return runWithClient(client, async () => {
      const end = job.data?.endDate || todayInTZ();
      const lookback = parseInt(process.env.ADSENSE_SYNC_LOOKBACK_DAYS || '30', 10) || 30;
      const start = job.data?.startDate || shiftYMD(end, -(lookback - 1));
      const accountId = job.data?.adsenseAccountId;
      if (!accountId) {
        const { syncAllAdSenseForClient } = require('../services/adsenseSyncService');
        return syncAllAdSenseForClient(client, { startDate: start, endDate: end });
      }
      const account = await adsenseAccountStore.getAccountById(accountId);
      if (!account) return;

      let result;
      if (job.name === 'adsense-sync-today') {
        result = await syncAdSenseAccountToday(account, { gamClient: client });
      } else if (job.name === 'adsense-sync-yesterday') {
        result = await syncAdSenseAccountYesterday(account, { gamClient: client });
      } else {
        result = await syncAdSenseAccount(account, { startDate: start, endDate: end, gamClient: client });
      }
      const n = rowCount(result);
      logger.info(`[adsense-sync] ${job.name} ${account.accountId} wrote ${n}`);
      return { rows: n };
    });
  }, workerOpts('BullMQ adsense-sync worker'));

  worker.on('failed', (job, err) => {
    logger.error(`[adsense-sync] job ${job?.id} failed:`, err.message);
  });
  logger.info('[adsense-sync] worker started');
  return worker;
}

module.exports = { startAdMobWorker, startAdSenseWorker };
