/**
 * Cron schedules — enqueue BullMQ jobs.
 * Only runs when SYNC_DISABLED !== 'true'.
 * All times are in Asia/Singapore timezone.
 *
 * Tuned for Upstash command budget + heap safety:
 *   - Hourly: lean today only
 *   - Every 6h: lean yesterday + full-today (not every hour)
 *   - 2AM: lean backfill only (full backfill weekly unless FULL_BACKFILL_DAILY=true)
 */
const cron   = require('node-cron');
const logger = require('../utils/logger');
const { gamSyncQueue } = require('../queues/gamSync');
const { todayInTZ, isLastHourOfDay, historicalRangeForPresets, listCalendarMonthsNewestFirst } = require('../utils/datetime');

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
  const promoteToDaily = isLastHourOfDay();
  const tag = reason ? ` (${reason})` : '';

  await eachActiveClient(async (client) => {
    const cid = client.id;
    try {
      await gamSyncQueue.add('sync-today', {
        date: today,
        promoteToDaily,
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
        + (promoteToDaily ? ' (last-of-day → copy into report_daily)' : '')
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

/** Back-compat for server boot kickoff. */
async function enqueueHourlyLeanSync({ reason } = {}) {
  await enqueueLeanToday({ reason });
  // On boot, also refresh yesterday + full-today once (not every hour).
  if (reason === 'boot') {
    await enqueueLeanYesterdayAndFullToday({ reason: 'boot' });
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

  // ── Every 6 hours: yesterday lean + full-today ───────────────────────────
  cron.schedule('15 */6 * * *', async () => {
    await enqueueLeanYesterdayAndFullToday({ reason: '6h' });
  }, { timezone: 'Asia/Singapore' });

  // ── 2 AM daily: grain past window, one job per calendar month (newest first) ─
  cron.schedule('0 2 * * *', async () => {
    const range = historicalRangeForPresets();
    const months = listCalendarMonthsNewestFirst(range.startDate, range.endDate);
    await eachActiveClient(async (client) => {
      const cid = client.id;
      for (let i = 0; i < months.length; i += 1) {
        const { startDate: ms, endDate: me } = months[i];
        try {
          await gamSyncQueue.add('sync-backfill', {
            startDate: ms,
            endDate: me,
            includeFull: false,
            clientId: cid,
          }, {
            jobId: `sync-month-${cid.slice(0, 8)}-${ms}-${me}`,
            priority: 3 + i,
            attempts: 1,
            backoff: { type: 'fixed', delay: 120000 },
          });
          logger.info(
            `Cron: enqueued sync-month ${ms} → ${me} client=${cid.slice(0, 8)} priority=${3 + i}`
          );
        } catch (e) {
          logger.error('Cron: failed to enqueue sync-month:', e.message);
        }
      }
    });
  }, { timezone: 'Asia/Singapore' });

  // Weekly full warehouse retired — grain months are filled at 2 AM.


  // ── 23:05: copy today's present snapshot into report_daily (keep present) ─
  cron.schedule('5 23 * * *', async () => {
    const today = todayInTZ();
    await eachActiveClient(async (client) => {
      const cid = client.id;
      try {
        await gamSyncQueue.add('promote-present', {
          date: today,
          clientId: cid,
        }, {
          jobId: `promote-present-${cid.slice(0, 8)}-${today}`,
          priority: 1,
          attempts: 2,
          backoff: { type: 'fixed', delay: 30000 },
        });
        logger.info(`Cron: enqueued promote-present for ${today} client=${cid.slice(0, 8)}`);
      } catch (e) {
        logger.error('Cron: failed to enqueue promote-present:', e.message);
      }
    });
  }, { timezone: 'Asia/Singapore' });

  // ── 00:05: after the day rolls, move leftover present → daily and delete ─
  cron.schedule('5 0 * * *', async () => {
    const today = todayInTZ();
    await eachActiveClient(async (client) => {
      const cid = client.id;
      try {
        await gamSyncQueue.add('promote-present', {
          date: today,
          clientId: cid,
        }, {
          jobId: `migrate-present-${cid.slice(0, 8)}-${today}`,
          priority: 1,
          attempts: 2,
          backoff: { type: 'fixed', delay: 30000 },
        });
        logger.info(`Cron: enqueued migrate leftover present → daily client=${cid.slice(0, 8)}`);
      } catch (e) {
        logger.error('Cron: failed to enqueue present migrate:', e.message);
      }
    });
  }, { timezone: 'Asia/Singapore' });

  logger.info(
    'Cron jobs started: hourly today, 6h yesterday, 2AM month-chunk backfill, 23:05 promote, 00:05 migrate, boot kickoff'
  );

  // Don't wait until the next clock hour — fill today's present now.
  setImmediate(() => {
    enqueueHourlyLeanSync({ reason: 'boot' }).catch((e) => {
      logger.warn('Cron: boot sync-today enqueue failed:', e.message);
    });
  });
}

module.exports = { startCron, enqueueHourlyLeanSync };
