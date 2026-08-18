/**
 * BullMQ worker — processes all gam-sync jobs.
 * Runs in the same Node process (imported from server.js).
 *
 * Job types:
 *   sync-today    → report_present (unified grain)
 *   sync-day      → one historical day in report_daily
 *   sync-backfill → one calendar month (newest first) into report_daily
 */
const { Worker } = require('bullmq');
const { redisSet, TTL, createBullmqConnection, isTransientRedisError } = require('../redisClient');
const logger     = require('../utils/logger');
const {
  replacePresentRows,
  replaceHistoricalRows,
  promotePresentToDaily,
  migrateStalePresentToDaily,
  fetchFromGAM,
  normalizeGAMRows,
  syncDateRangeFromGAM,
  invalidateCacheForDate,
  logSync,
} = require('../services/gamSyncService');
const { todayInTZ, isLastHourOfDay, shiftYMD } = require('../utils/datetime');
const { runWithClient } = require('../utils/clientContext');
const { getClientById, ensureBootstrapFromEnv } = require('../models/clientStore');

function getGAMHelpers() {
  const { getHelpers, helpersReady } = require('../services/gamHelpers');
  return helpersReady() ? getHelpers() : null;
}

function buildTargetDates(jobData = {}) {
  const { date, dates, days, startDate, endDate } = jobData;
  if (Array.isArray(dates) && dates.length) return [...dates].sort();
  if (startDate && endDate) {
    const out = [];
    let cursor = startDate;
    while (cursor <= endDate) {
      out.push(cursor);
      cursor = shiftYMD(cursor, 1);
    }
    return out;
  }
  if (date) return [date];
  if (days) {
    const today = todayInTZ();
    const out = [];
    for (let i = 0; i < days; i++) out.push(shiftYMD(today, -i));
    return out.sort();
  }
  return [];
}

async function processJob(job) {
  let client = null;
  try {
    if (job.data?.clientId) client = await getClientById(job.data.clientId);
    if (!client) client = await ensureBootstrapFromEnv();
  } catch (e) {
    logger.warn(`[gam-sync] client load failed: ${e.message}`);
  }
  if (!client) {
    logger.warn(`[gam-sync] Job "${job.name}" skipped — no GAM client`);
    return;
  }
  return runWithClient(client, () => processJobInner(job));
}

async function processJobInner(job) {
  const currency = process.env.GAM_CURRENCY || 'USD';
  logger.info(`[gam-sync] Processing job "${job.name}" id=${job.id}`);

  if (job.name === 'promote-present') {
    try {
      const promoted = await promotePresentToDaily(job.name);
      await invalidateCacheForDate(todayInTZ());
      await logSync(job.name, 'success', promoted);
      logger.info(`[gam-sync] Job "${job.name}" done — ${promoted} rows promoted`);
    } catch (err) {
      logger.error(`[gam-sync] Job "${job.name}" failed:`, err.message);
      await logSync(job.name, 'failed', 0, err.message);
      throw err;
    }
    return;
  }

  const targetDates = buildTargetDates(job.data || {});
  if (!targetDates.length) {
    logger.warn(`[gam-sync] Job "${job.name}" has no target dates, skipping`);
    return;
  }

  const startDate = targetDates[0];
  const endDate = targetDates[targetDates.length - 1];
  let totalUpserted = 0;

  try {
    if (!getGAMHelpers()) {
      logger.warn('[gam-sync] GAM helpers not available — skipping GAM call');
      await logSync(job.name, 'skipped', 0, 'helpers not ready');
      return;
    }

    if (job.name === 'sync-today') {
      const day = targetDates[targetDates.length - 1];
      // Move yesterday (or older) out of present before writing today's snapshot.
      try {
        await migrateStalePresentToDaily(job.name);
      } catch (e) {
        logger.warn(`[gam-sync] stale present migrate skipped: ${e.message}`);
      }
      const rawRows = await fetchFromGAM(day, day);
      const normalized = normalizeGAMRows(rawRows, currency);
      totalUpserted = await replacePresentRows(normalized, job.name);

      const shouldPromote = job.data?.promoteToDaily === true || isLastHourOfDay();
      if (shouldPromote) {
        const promoted = await promotePresentToDaily('promote-present');
        logger.info(`[gam-sync] Last-of-day promote: ${promoted} rows copied into report_daily`);
        await logSync('promote-present', 'success', promoted);
      }
      await invalidateCacheForDate(day);
    } else if (job.name === 'sync-day') {
      const day = targetDates[0];
      const rawRows = await fetchFromGAM(day, day);
      const normalized = normalizeGAMRows(rawRows, currency);
      totalUpserted = await replaceHistoricalRows(normalized, job.name);
      await invalidateCacheForDate(day);
    } else if (job.name === 'sync-full-range' || job.name === 'sync-full-today' || job.name === 'sync-full-backfill' || job.name === 'promote-full-present') {
      logger.info(`[gam-sync] ${job.name} skipped — report_full_* warehouse retired`);
      return;
    } else {
      totalUpserted = await syncDateRangeFromGAM(startDate, endDate, job.name);
    }

    await logSync(job.name, 'success', totalUpserted);
    logger.info(`[gam-sync] Job "${job.name}" done — ${totalUpserted} rows written (${startDate} → ${endDate})`);
  } catch (err) {
    logger.error(`[gam-sync] Job "${job.name}" failed:`, err.message);
    await logSync(job.name, 'failed', totalUpserted, err.message);
    throw err;
  }
}

function startWorker() {
  if (process.env.REDIS_DISABLED === 'true' || process.env.SYNC_DISABLED === 'true' || !process.env.REDIS_URL) {
    logger.info('BullMQ worker disabled; skipping Redis-backed worker startup');
    return null;
  }

  const syncConcurrency = Math.min(5, Math.max(1, parseInt(process.env.GAM_SYNC_CONCURRENCY || '4', 10) || 4));
  const worker = new Worker('gam-sync', processJob, {
    connection: createBullmqConnection('BullMQ gam-sync worker'),
    concurrency: syncConcurrency,
    lockDuration: 45 * 60 * 1000,
    stalledInterval: 5 * 60 * 1000,
    maxStalledCount: 1,
  });

  worker.on('completed', (job) => {
    const ms = job.finishedOn - job.processedOn;
    logger.info(`[gam-sync] Job "${job.name}" completed in ${ms}ms`);
  });

  worker.on('failed', (job, err) => {
    if (job.attemptsMade < job.opts.attempts) {
      logger.warn(`[gam-sync] Job "${job.name}" attempt ${job.attemptsMade} failed, will retry: ${err.message}`);
    } else {
      logger.error(`[gam-sync] Job "${job.name}" permanently failed after ${job.attemptsMade} attempts: ${err.message}`);
    }
  });

  worker.on('error', (err) => {
    if (isTransientRedisError(err) || /max requests limit exceeded/i.test(err.message || '')) {
      logger.warn(`[gam-sync] Worker Redis issue: ${err.message}`);
      return;
    }
    logger.error('[gam-sync] Worker error:', err.message);
  });

  logger.info(`BullMQ gam-sync worker started (concurrency=${syncConcurrency}, stalledInterval=5m)`);
  return worker;
}

function startReportWorker() {
  if (process.env.REDIS_DISABLED === 'true' || process.env.SYNC_DISABLED === 'true' || !process.env.REDIS_URL) {
    logger.info('BullMQ report worker disabled; skipping gam-report worker startup');
    return null;
  }

  const reportWorker = new Worker('gam-report', async (job) => {
    let client = null;
    try {
      if (job.data?.clientId) client = await getClientById(job.data.clientId);
    if (!client) client = await ensureBootstrapFromEnv();
    } catch (e) {
      logger.warn(`[gam-report] client load failed: ${e.message}`);
    }
    if (!client) {
      logger.warn('[gam-report] skipped — no GAM client');
      return;
    }
    return runWithClient(client, () => processReportJob(job));
  }, {
    connection: createBullmqConnection('BullMQ gam-report worker'),
    concurrency: 1,
    lockDuration: 15 * 60 * 1000,
    stalledInterval: 5 * 60 * 1000,
    maxStalledCount: 1,
  });

  reportWorker.on('completed', (job) => logger.info(`[gam-report] Job ${job.id} completed`));
  reportWorker.on('failed', (job, err) => logger.error(`[gam-report] Job ${job.id} failed: ${err.message}`));
  reportWorker.on('error', (err) => {
    if (isTransientRedisError(err) || /max requests limit exceeded/i.test(err.message || '')) {
      logger.warn(`[gam-report] Worker Redis issue: ${err.message}`);
      return;
    }
    logger.error('[gam-report] Worker error:', err.message);
  });

  logger.info('BullMQ gam-report worker started (concurrency=1)');
  return reportWorker;
}

async function processReportJob(job) {
    const data = job.data || {};
    const { startDate, endDate } = data;
    if (!startDate || !endDate) {
      logger.warn('[gam-report] Job missing dates, skipping');
      return;
    }

    // Custom Reporting query → report_adhoc (async, no HTTP wait)
    if (job.name === 'adhoc-report') {
      logger.info(`[gam-report] Processing adhoc-report ${startDate} → ${endDate} id=${job.id}`);
      try {
        const helpers = getGAMHelpers();
        const token = helpers?.getToken ? await helpers.getToken() : null;
        if (!token || !helpers?.runDetailedReport) {
          throw new Error('GAM helpers unavailable for adhoc-report');
        }
        const gamFilters = {
          startDate,
          endDate,
          country: data.country,
          reportDimensions: data.reportDimensions,
          reportMetrics: data.reportMetrics,
        };
        const result = await helpers.runDetailedReport(gamFilters, token, {
          fastMode: true,
          compatOnly: true,
        });
        const { persistAdhocRows, buildAdhocQueryHash } = require('../services/gamSyncService');
        const queryHash = data.queryHash || buildAdhocQueryHash(gamFilters);
        if (Array.isArray(result?.rows) && result.rows.length) {
          await persistAdhocRows(result.rows, {
            queryHash,
            startDate,
            endDate,
            dimKeys: Array.isArray(data.reportDimensions) ? data.reportDimensions : [],
            metricKeys: Array.isArray(data.reportMetrics) ? data.reportMetrics : [],
            syncType: 'adhoc-report',
          });
          const cacheKey = data.cacheKey;
          if (cacheKey) {
            try {
              await redisSet(cacheKey, {
                rows: result.rows,
                reportWarning: result.reportWarning || null,
              }, TTL.REPORT);
            } catch (_) { /* ignore */ }
          }
        }
        logger.info(`[gam-report] adhoc-report done (${result?.rows?.length || 0} rows)`);
      } catch (e) {
        logger.error('[gam-report] adhoc-report failed:', e.message);
        throw e;
      }
      return;
    }

    // Programmatic channel report — fill Redis so /programmatic can serve without blocking.
    if (job.name === 'programmatic-report') {
      logger.info(`[gam-report] Processing programmatic-report ${startDate} → ${endDate} id=${job.id}`);
      try {
        const helpers = getGAMHelpers();
        const token = helpers?.getToken ? await helpers.getToken() : null;
        if (!token || !helpers?.runProgrammaticReport) {
          throw new Error('GAM helpers unavailable for programmatic-report');
        }
        const { rows } = await helpers.runProgrammaticReport({
          startDate,
          endDate,
          country: data.country,
        }, token);
        const payload = {
          rows: rows || [],
          startDate,
          endDate,
          isMock: false,
        };
        const cacheKey = data.cacheKey
          || `report_programmatic_resp_v1_${startDate}_${endDate}_all`;
        await redisSet(cacheKey, payload, TTL.REPORT);
        logger.info(`[gam-report] programmatic-report done (${payload.rows.length} rows)`);
      } catch (e) {
        logger.error('[gam-report] programmatic-report failed:', e.message);
        throw e;
      }
      return;
    }

    logger.info(`[gam-report] Processing user-report ${startDate} → ${endDate} id=${job.id}`);
    try {
      const count = await syncDateRangeFromGAM(startDate, endDate, job.name || 'user-report');
      // Do not reload+cache full grain into Redis after sync (OOM + quota).
      logger.info(`[gam-report] user-report job completed (${count} rows written)`);
    } catch (e) {
      logger.error('[gam-report] user-report failed:', e.message);
      throw e;
    }
}

module.exports = { startWorker, startReportWorker, processJob };
