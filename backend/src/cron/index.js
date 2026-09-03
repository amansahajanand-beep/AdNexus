/**
 * Cron schedules — enqueue BullMQ jobs.
 * Only runs when SYNC_DISABLED !== 'true'.
 * All times are in Asia/Singapore timezone.
 *
 * Tuned for Upstash command budget + heap safety:
 *   - Hourly: lean today only (GAM + Ads spend)
 *   - Every 6h: lean yesterday (GAM + Ads spend)
 *   - Hourly :30: reconcile yesterday + today (GAM + Ads)
 *   - 2AM: one job per calendar month until every day has KPI grain
 *   - Boot: today + yesterday + recent gaps + incomplete months
 */
const cron   = require('node-cron');
const logger = require('../utils/logger');
const { gamSyncQueue } = require('../queues/gamSync');
const { adsSyncQueue } = require('../queues/adsSync');
const { todayInTZ, historicalRangeForPresets, listCalendarMonthsNewestFirst, shiftYMD } = require('../utils/datetime');

async function eachActiveClient(fn) {
  const { listActiveClients } = require('../models/clientStore');
  const clients = await listActiveClients();
  if (!clients.length) {
    logger.info('Cron: no active GAM clients — skipping enqueue');
    return;
  }
  for (const client of clients) {
    await fn(client);
  }
}

async function enqueueLeanToday({ reason } = {}) {
  const today = todayInTZ();
  const hourSlot = Math.floor(Date.now() / (60 * 60 * 1000));
  const tag = reason ? ` (${reason})` : '';

  await eachActiveClient(async (client) => {
    const cid = client.id;
    try {
      await gamSyncQueue.add('sync-today', {
        date: today,
        includeFull: false,
        clientId: cid,
      }, {
        jobId: `sync-today-${cid.slice(0, 8)}-${today}-${hourSlot}`,
        priority: 1,
        attempts: 2,
        backoff: { type: 'exponential', delay: 20000 },
      });
      const { recordCronEnqueue } = require('../services/syncHealthStore');
      await recordCronEnqueue(reason || 'hourly');
      logger.info(
        `Cron: enqueued lean sync-today for ${today} client=${cid.slice(0, 8)}${tag}`
      );
    } catch (e) {
      logger.error('Cron: failed to enqueue sync-today:', e.message);
    }
  });
}

async function enqueueLeanYesterdayAndFullToday({ reason } = {}) {
  const today = todayInTZ();
  const hourSlot = Math.floor(Date.now() / (60 * 60 * 1000));
  const { yesterday } = historicalRangeForPresets();
  const tag = reason ? ` (${reason})` : '';

  await eachActiveClient(async (client) => {
    const cid = client.id;
    try {
      await gamSyncQueue.add('sync-day', {
        date: yesterday,
        includeFull: false,
        clientId: cid,
      }, {
        jobId: `sync-day-${cid.slice(0, 8)}-${yesterday}-${Math.floor(hourSlot / 6)}`,
        priority: 2,
        attempts: 2,
        backoff: { type: 'exponential', delay: 20000 },
      });
      logger.info(`Cron: enqueued lean sync-day for ${yesterday} client=${cid.slice(0, 8)}${tag}`);
    } catch (e) {
      logger.error('Cron: failed to enqueue sync-day:', e.message);
    }
  });
}

/** Fill missing days in a rolling window (default last 30 days). */
async function enqueueRecentGapFill({ reason, days = 30 } = {}) {
  const today = todayInTZ();
  const start = shiftYMD(today, -(Math.max(1, days) - 1));
  const tag = reason ? ` (${reason})` : '';
  await eachActiveClient(async (client) => {
    const cid = client.id;
    try {
      await gamSyncQueue.add('sync-fill-gaps', {
        startDate: start,
        endDate: today,
        clientId: cid,
      }, {
        jobId: `sync-fill-gaps-${cid.slice(0, 8)}-${today}`,
        priority: 2,
        attempts: 2,
        backoff: { type: 'exponential', delay: 30000 },
      });
      logger.info(
        `Cron: enqueued sync-fill-gaps ${start}..${today} client=${cid.slice(0, 8)}${tag}`
      );
    } catch (e) {
      logger.error('Cron: failed to enqueue sync-fill-gaps:', e.message);
    }
  });
}

/**
 * One sync-backfill job per calendar month in the historical window.
 * Worker uses syncCompleteDateRangeFromGAM — skips months already fully covered,
 * otherwise fills missing days oldest-first until 1..N are present.
 */
async function enqueueMonthCompleteBackfill({ reason } = {}) {
  const range = historicalRangeForPresets();
  const months = listCalendarMonthsNewestFirst(range.startDate, range.endDate);
  const tag = reason ? ` (${reason})` : '';
  const daySlot = todayInTZ();

  await eachActiveClient(async (client) => {
    const cid = client.id;
    for (let i = 0; i < months.length; i += 1) {
      const { startDate: ms, endDate: me } = months[i];
      try {
        await gamSyncQueue.add('sync-backfill', {
          startDate: ms,
          endDate: me,
          completeMonth: true,
          includeFull: false,
          clientId: cid,
        }, {
          // Include day so boot + 2AM can both enqueue without colliding forever.
          jobId: `sync-month-${cid.slice(0, 8)}-${ms}-${me}-${daySlot}`,
          priority: 3 + i,
          attempts: 2,
          backoff: { type: 'fixed', delay: 120000 },
        });
        logger.info(
          `Cron: enqueued complete-month ${ms} → ${me} client=${cid.slice(0, 8)}`
          + ` priority=${3 + i}${tag}`
        );
      } catch (e) {
        logger.error('Cron: failed to enqueue sync-month:', e.message);
      }
    }
  });
}

async function enqueueReconcileRecent({ reason } = {}) {
  const today = todayInTZ();
  const yesterday = shiftYMD(today, -1);
  const tag = reason ? ` (${reason})` : '';
  await eachActiveClient(async (client) => {
    const cid = client.id;
    try {
      await gamSyncQueue.add('reconcile-range', {
        startDate: yesterday,
        endDate: today,
        clientId: cid,
      }, {
        jobId: `reconcile-recent-${cid.slice(0, 8)}-${today}-${Math.floor(Date.now() / (30 * 60 * 1000))}`,
        priority: 2,
        attempts: 2,
        backoff: { type: 'exponential', delay: 30000 },
      });
      logger.info(`Cron: enqueued reconcile-recent ${yesterday}..${today} client=${cid.slice(0, 8)}${tag}`);
    } catch (e) {
      logger.error('Cron: failed to enqueue reconcile-recent:', e.message);
    }
  });
}

function isAdsCronEnabled() {
  return Boolean(String(process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '').trim());
}

/** Hourly: refresh Google Ads spend for today only (ROI present data). */
async function enqueueAdsSyncToday({ reason } = {}) {
  if (!isAdsCronEnabled()) return;
  const today = todayInTZ();
  const hourSlot = Math.floor(Date.now() / (60 * 60 * 1000));
  const tag = reason ? ` (${reason})` : '';
  const { enqueueAdsSyncAccounts } = require('../services/adsSyncService');
  await eachActiveClient(async (client) => {
    const cid = client.id;
    try {
      const { accounts } = await enqueueAdsSyncAccounts(client, adsSyncQueue, {
        startDate: today,
        endDate: today,
        jobIdPrefix: `ads-sync-today-${cid.slice(0, 8)}-${today}-${hourSlot}`,
        priority: 1,
      });
      logger.info(
        `Cron: enqueued ads-sync-today ${accounts} account(s) for ${today} client=${cid.slice(0, 8)}${tag}`
      );
    } catch (e) {
      logger.error('Cron: failed to enqueue ads-sync-today:', e.message);
    }
  });
}

/** Every 6h: refresh yesterday's Ads spend (finalize partial snapshots). */
async function enqueueAdsSyncYesterday({ reason } = {}) {
  if (!isAdsCronEnabled()) return;
  const { yesterday } = historicalRangeForPresets();
  const hourSlot = Math.floor(Date.now() / (60 * 60 * 1000));
  const tag = reason ? ` (${reason})` : '';
  const { enqueueAdsSyncAccounts } = require('../services/adsSyncService');
  await eachActiveClient(async (client) => {
    const cid = client.id;
    try {
      const { accounts } = await enqueueAdsSyncAccounts(client, adsSyncQueue, {
        startDate: yesterday,
        endDate: yesterday,
        jobIdPrefix: `ads-sync-yesterday-${cid.slice(0, 8)}-${yesterday}-${Math.floor(hourSlot / 6)}`,
        priority: 2,
      });
      logger.info(
        `Cron: enqueued ads-sync-yesterday ${accounts} account(s) for ${yesterday} client=${cid.slice(0, 8)}${tag}`
      );
    } catch (e) {
      logger.error('Cron: failed to enqueue ads-sync-yesterday:', e.message);
    }
  });
}

/** Hourly :30: reconcile Ads spend for yesterday + today vs live Google Ads. */
async function enqueueAdsReconcileRecent({ reason } = {}) {
  if (!isAdsCronEnabled()) return;
  const today = todayInTZ();
  const yesterday = shiftYMD(today, -1);
  const tag = reason ? ` (${reason})` : '';
  const { enqueueAdsSyncAccounts } = require('../services/adsSyncService');
  await eachActiveClient(async (client) => {
    const cid = client.id;
    try {
      const { accounts } = await enqueueAdsSyncAccounts(client, adsSyncQueue, {
        startDate: yesterday,
        endDate: today,
        jobIdPrefix: `ads-reconcile-recent-${cid.slice(0, 8)}-${today}-${Math.floor(Date.now() / (30 * 60 * 1000))}`,
        priority: 2,
      });
      logger.info(
        `Cron: enqueued ads-reconcile-recent ${accounts} account(s) ${yesterday}..${today} client=${cid.slice(0, 8)}${tag}`
      );
    } catch (e) {
      logger.error('Cron: failed to enqueue ads-reconcile-recent:', e.message);
    }
  });
}

async function enqueueReconcileHistorical({ reason } = {}) {
  const range = historicalRangeForPresets();
  const tag = reason ? ` (${reason})` : '';
  await eachActiveClient(async (client) => {
    const cid = client.id;
    try {
      await gamSyncQueue.add('reconcile-range', {
        startDate: range.startDate,
        endDate: range.yesterday,
        clientId: cid,
        historical: true,
      }, {
        jobId: `reconcile-historical-${cid.slice(0, 8)}-${range.yesterday}`,
        priority: 4,
        attempts: 2,
        backoff: { type: 'fixed', delay: 120000 },
      });
      logger.info(
        `Cron: enqueued reconcile-historical ${range.startDate}..${range.yesterday}`
        + ` client=${cid.slice(0, 8)}${tag}`
      );
    } catch (e) {
      logger.error('Cron: failed to enqueue reconcile-historical:', e.message);
    }
  });
}

/** Re-enqueue sync-today if stale; keep draining historical gaps. */
async function watchdogStaleSync() {
  const { query } = require('../db');
  const { listActiveClients } = require('../models/clientStore');
  const { runWithClient } = require('../utils/clientContext');
  const { drainIncompleteHistory } = require('../services/gamReconciliationService');
  const {
    runWithTodayPriority,
    waitForSyncTodaySuccess,
  } = require('../services/syncPriorityGate');
  const clients = await listActiveClients();
  const staleMs = 75 * 60 * 1000;
  for (const client of clients) {
    try {
      const { rows } = await query(
        `SELECT finished_at FROM sync_log
         WHERE client_id = $1::uuid AND sync_type = 'sync-today' AND status = 'success'
         ORDER BY finished_at DESC LIMIT 1`,
        [client.id]
      );
      const last = rows[0]?.finished_at ? new Date(rows[0].finished_at).getTime() : 0;
      if (Date.now() - last > staleMs) {
        logger.warn(
          `Cron watchdog: sync-today stale for client=${client.id.slice(0, 8)}`
          + ` (last=${rows[0]?.finished_at || 'never'}) — re-enqueue with today-priority`
        );
        await runWithTodayPriority(async ({ startedAt, waitMs }) => {
          await enqueueLeanToday({ reason: 'watchdog' });
          await waitForSyncTodaySuccess(client.id, todayInTZ(), {
            timeoutMs: waitMs,
            sinceMs: startedAt - 5_000,
          });
        }, { reason: 'watchdog' });
      }
      await runWithClient(client, () => drainIncompleteHistory());
    } catch (e) {
      logger.warn('Cron watchdog check failed:', e.message);
    }
  }
}

/**
 * Hourly / boot: pause historical work, refresh today, then resume backfill.
 * Backfill jobs defer while the flag is on; fill loops yield between windows.
 */
async function runHourlyTodayPrioritySync({ reason = 'hourly' } = {}) {
  const {
    runWithTodayPriority,
    waitForSyncTodaySuccess,
  } = require('../services/syncPriorityGate');
  const { listActiveClients } = require('../models/clientStore');
  const today = todayInTZ();

  await runWithTodayPriority(async ({ startedAt, waitMs }) => {
    await enqueueLeanToday({ reason });
    const clients = await listActiveClients();
    for (const client of clients) {
      await waitForSyncTodaySuccess(client.id, today, {
        timeoutMs: waitMs,
        sinceMs: startedAt - 5_000,
      });
    }
    // Ads today while still in priority window (historical ads jobs stay deferred).
    await enqueueAdsSyncToday({ reason });
  }, { reason });
}

async function enqueueHourlyLeanSync({ reason } = {}) {
  if (reason === 'boot') {
    // Today first under priority gate, then historical drain.
    await runHourlyTodayPrioritySync({ reason: 'boot' });
    await enqueueLeanYesterdayAndFullToday({ reason: 'boot' });
    await enqueueAdsSyncYesterday({ reason: 'boot' });
    await enqueueAdsReconcileRecent({ reason: 'boot' });
    await enqueueRecentGapFill({ reason: 'boot', days: 30 });
    await enqueueMonthCompleteBackfill({ reason: 'boot' });
    return;
  }
  await runHourlyTodayPrioritySync({ reason: reason || 'hourly' });
}

function startCron() {
  if (process.env.SYNC_DISABLED === 'true') {
    logger.info('Cron: SYNC_DISABLED=true — all cron jobs skipped');
    return;
  }

  // ── Every hour: today-priority window (pause backfill → sync today → resume) ──
  cron.schedule('0 * * * *', async () => {
    await runHourlyTodayPrioritySync({ reason: 'hourly' });
  }, { timezone: 'Asia/Singapore' });

  // ── Every 6 hours: yesterday lean + Ads spend yesterday ─────────────────
  cron.schedule('15 */6 * * *', async () => {
    await enqueueLeanYesterdayAndFullToday({ reason: '6h' });
    await enqueueAdsSyncYesterday({ reason: '6h' });
  }, { timezone: 'Asia/Singapore' });

  // ── Every hour :30 SGT: reconcile today + yesterday vs live GAM + Ads ───
  cron.schedule('30 * * * *', async () => {
    await enqueueReconcileRecent({ reason: 'hourly-reconcile' });
    await enqueueAdsReconcileRecent({ reason: 'hourly-reconcile' });
  }, { timezone: 'Asia/Singapore' });

  // ── 1 AM daily: full historical reconciliation walk ─────────────────────
  cron.schedule('0 1 * * *', async () => {
    await enqueueReconcileHistorical({ reason: '1am-reconcile' });
  }, { timezone: 'Asia/Singapore' });

  // ── Every 15 min: watchdog if hourly sync stalled ───────────────────────
  cron.schedule('*/15 * * * *', async () => {
    await watchdogStaleSync();
  }, { timezone: 'Asia/Singapore' });

  // ── 2 AM daily: complete each calendar month (all days 1..end) ───────────
  cron.schedule('0 2 * * *', async () => {
    await enqueueMonthCompleteBackfill({ reason: '2am' });
  }, { timezone: 'Asia/Singapore' });

  // ── 3 AM daily: archive grain + rollups older than HISTORICAL_DAYS to S3 ──
  cron.schedule('0 3 * * *', async () => {
    if (process.env.ARCHIVE_ENABLED !== 'true') return;
    await eachActiveClient(async (client) => {
      const cid = client.id;
      try {
        await gamSyncQueue.add('archive-cold-data', { clientId: cid }, {
          jobId: `archive-cold-${cid.slice(0, 8)}-${todayInTZ()}`,
          priority: 4,
          attempts: 2,
          backoff: { type: 'fixed', delay: 60000 },
        });
        logger.info(`Cron: enqueued archive-cold-data client=${cid.slice(0, 8)}`);
      } catch (e) {
        logger.error('Cron: failed to enqueue archive-cold-data:', e.message);
      }
    });
  }, { timezone: 'Asia/Singapore' });

  // ── 4 AM daily: Google Ads spend sync (lookback window) ──
  cron.schedule('0 4 * * *', async () => {
    const lookback = parseInt(process.env.GOOGLE_ADS_SYNC_LOOKBACK_DAYS || '30', 10) || 30;
    const end = todayInTZ();
    const start = shiftYMD(end, -(lookback - 1));
    const { enqueueAdsSyncAccounts } = require('../services/adsSyncService');
    await eachActiveClient(async (client) => {
      const cid = client.id;
      try {
        const { accounts } = await enqueueAdsSyncAccounts(client, adsSyncQueue, {
          startDate: start,
          endDate: end,
          jobIdPrefix: `ads-sync-daily-${cid.slice(0, 8)}-${end}`,
        });
        logger.info(`Cron: enqueued ads-sync ${accounts} account(s) client=${cid.slice(0, 8)} ${start}→${end}`);
      } catch (e) {
        logger.error('Cron: failed to enqueue ads-sync:', e.message);
      }
    });
  }, { timezone: 'Asia/Singapore' });

  // ── Every 3 hours: re-pull recent Ads days (fallback if hourly jobs backlog) ──
  cron.schedule('45 */3 * * *', async () => {
    if (!isAdsCronEnabled()) return;
    const recentDays = parseInt(process.env.GOOGLE_ADS_RECENT_SYNC_DAYS || '3', 10) || 3;
    const end = todayInTZ();
    const start = shiftYMD(end, -(Math.max(1, recentDays) - 1));
    const slot = Math.floor(Date.now() / (3 * 60 * 60 * 1000));
    const { enqueueAdsSyncAccounts } = require('../services/adsSyncService');
    await eachActiveClient(async (client) => {
      const cid = client.id;
      try {
        const { accounts } = await enqueueAdsSyncAccounts(client, adsSyncQueue, {
          startDate: start,
          endDate: end,
          jobIdPrefix: `ads-sync-recent-${cid.slice(0, 8)}-${end}-${slot}`,
          priority: 3,
        });
        logger.info(
          `Cron: enqueued ads-sync-recent ${accounts} account(s) client=${cid.slice(0, 8)} ${start}→${end}`
        );
      } catch (e) {
        logger.error('Cron: failed to enqueue ads-sync-recent:', e.message);
      }
    });
  }, { timezone: 'Asia/Singapore' });

  logger.info(
    'Cron jobs started: hourly today-priority (+ads), :30 reconcile-recent (+ads), 1AM reconcile-historical,'
    + ' 6h yesterday (+ads), 2AM complete-month backfill, 3AM archive, 4AM ads-full, 3h ads-recent, 15m watchdog, boot kickoff'
  );

  // Don't wait until the next clock hour — fill today's present now.
  setImmediate(() => {
    enqueueHourlyLeanSync({ reason: 'boot' }).catch((e) => {
      logger.warn('Cron: boot sync-today enqueue failed:', e.message);
    });
  });
}

module.exports = {
  startCron,
  enqueueHourlyLeanSync,
  runHourlyTodayPrioritySync,
  enqueueRecentGapFill,
  enqueueMonthCompleteBackfill,
  enqueueReconcileRecent,
  enqueueReconcileHistorical,
  enqueueAdsSyncToday,
  enqueueAdsSyncYesterday,
  enqueueAdsReconcileRecent,
};
