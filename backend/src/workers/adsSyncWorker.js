/**
 * BullMQ worker — Google Ads spend sync jobs.
 */
const { Worker, DelayedError } = require('bullmq');
const { createBullmqConnection, isTransientRedisError } = require('../redisClient');
const logger = require('../utils/logger');
const { runWithClient } = require('../utils/clientContext');
const { getClientById } = require('../models/clientStore');
const { syncAllAccountsForClient, syncAccountSpend } = require('../services/adsSyncService');
const { getAccountById } = require('../models/adsAccountStore');
const { todayInTZ, shiftYMD } = require('../utils/datetime');
const { isSyncQueueEnabled } = require('../queues/gamSync');
const {
  isTodayPriorityActive,
  isAdsJobAllowedDuringTodayPriority,
  getTodayPriorityDeferMs,
} = require('../services/syncPriorityGate');
const {
  isAdsRateLimited,
  getAdsRateLimitDeferMs,
  isAdsRateLimitError,
  parseAdsRateLimitRetrySec,
  beginAdsRateLimit,
} = require('../services/adsRateLimitGate');

async function deferJob(job, delayMs, reason) {
  logger.info(
    `[ads-sync] Deferring job ${job.id} for ${Math.round(delayMs / 1000)}s (${reason})`
  );
  if (job.token) {
    await job.moveToDelayed(Date.now() + delayMs, job.token);
    throw new DelayedError();
  }
  const err = new Error(`Deferred for ${reason}`);
  err.yieldToToday = reason === 'today-priority';
  throw err;
}

async function processJob(job) {
  const clientId = job.data?.clientId;
  if (!clientId) {
    logger.warn('[ads-sync] missing clientId');
    return;
  }

  if (await isAdsRateLimited()) {
    await deferJob(job, await getAdsRateLimitDeferMs(), 'ads-rate-limit');
  }

  if (await isTodayPriorityActive() && !isAdsJobAllowedDuringTodayPriority(job)) {
    await deferJob(job, await getTodayPriorityDeferMs(), 'today-priority');
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
    const roiOnly = job.data?.roiOnly !== false;

    if (job.name === 'ads-sync-account' && job.data?.adsAccountId) {
      if (await isAdsRateLimited()) {
        await deferJob(job, await getAdsRateLimitDeferMs(), 'ads-rate-limit');
      }
      const account = await getAccountById(job.data.adsAccountId);
      if (!account) return;
      try {
        const n = await syncAccountSpend(account, { startDate: start, endDate: end, gamClient: client });
        logger.info(`[ads-sync] account ${account.customerId} wrote ${n}`);
        return { rows: n };
      } catch (e) {
        const retrySec = parseAdsRateLimitRetrySec(e);
        if (retrySec != null || isAdsRateLimitError(e)) {
          await beginAdsRateLimit(retrySec || 15 * 60, { reason: `job-account=${account.customerId}` });
          await deferJob(job, await getAdsRateLimitDeferMs(), 'ads-rate-limit');
        }
        throw e;
      }
    }

    // Default: one job syncs all ROI-enabled client accounts for this GAM tenant.
    // Optional batch/stale flags from job data only (manual/debug) — not forced for today.
    const result = await syncAllAccountsForClient(client, {
      startDate: start,
      endDate: end,
      roiOnly,
      maxAccounts: job.data?.maxAccounts ?? null,
      preferStale: job.data?.preferStale === true,
      staleMinutes: job.data?.staleMinutes ?? null,
    });
    logger.info(
      `[ads-sync] client=${clientId.slice(0, 8)} accounts=${result.accounts} `
      + `total=${result.total} errors=${result.errors.length}`
      + `${result.rateLimited ? ' rateLimited=1' : ''}`
    );
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
