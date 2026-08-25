/**
 * Cron schedules — enqueue BullMQ jobs.
 * Only runs when SYNC_DISABLED !== 'true'.
 * All times are in Asia/Singapore timezone.
 *
 * Tuned for Upstash command budget + heap safety:
 *   - Hourly: lean today only
 *   - Every 6h: lean yesterday
 *   - 2AM: one job per calendar month until every day has KPI grain
 *   - Boot: today + yesterday + recent gaps + incomplete months
 */
const cron   = require('node-cron');
const logger = require('../utils/logger');
const { gamSyncQueue } = require('../queues/gamSync');
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

async function enqueueHourlyLeanSync({ reason } = {}) {
  await enqueueLeanToday({ reason });
  // On boot, also refresh yesterday + recent gaps + full historical months.
  if (reason === 'boot') {
    await enqueueLeanYesterdayAndFullToday({ reason: 'boot' });
    await enqueueRecentGapFill({ reason: 'boot', days: 30 });
    await enqueueMonthCompleteBackfill({ reason: 'boot' });
  }
}

function startCron() {
  if (process.env.SYNC_DISABLED === 'true') {
    logger.info('Cron: SYNC_DISABLED=true — all cron jobs skipped');
    return;
  }

  // ── Every hour: lean today only (dashboard present) ──────────────────────
  cron.schedule('0 * * * *', async () => {
    await enqueueLeanToday({ reason: 'hourly' });
  }, { timezone: 'Asia/Singapore' });

  // ── Every 6 hours: yesterday lean ────────────────────────────────────────
  cron.schedule('15 */6 * * *', async () => {
    await enqueueLeanYesterdayAndFullToday({ reason: '6h' });
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

  logger.info(
    'Cron jobs started: hourly today, 6h yesterday, 2AM complete-month backfill, 3AM archive, boot kickoff'
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
  enqueueRecentGapFill,
  enqueueMonthCompleteBackfill,
};
