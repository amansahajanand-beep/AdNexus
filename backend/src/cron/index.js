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
const { todayInTZ, isLastHourOfDay, historicalRangeForPresets } = require('../utils/datetime');

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

    if (process.env.FULL_SYNC_DISABLED === 'true') return;
    try {
      await gamSyncQueue.add('sync-full-today', {
        startDate: today,
        endDate: today,
        clientId: cid,
      }, {
        jobId: `sync-full-today-${cid.slice(0, 8)}-${today}-${Math.floor(hourSlot / 6)}`,
        priority: 8,
        attempts: 1,
        backoff: { type: 'fixed', delay: 60000 },
      });
      logger.info(
        `Cron: enqueued sync-full-today for ${today} client=${cid.slice(0, 8)}${tag} → report_full_present`
      );
    } catch (e) {
      logger.error('Cron: failed to enqueue sync-full-today:', e.message);
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

  // ── 2 AM daily: lean past window (full backfill only if opted in) ────────
  cron.schedule('0 2 * * *', async () => {
    const range = historicalRangeForPresets();
    const includeFull = process.env.FULL_BACKFILL_DAILY === 'true'
      && process.env.FULL_SYNC_DISABLED !== 'true';
    await eachActiveClient(async (client) => {
      const cid = client.id;
      try {
        await gamSyncQueue.add('sync-backfill', {
          startDate: range.startDate,
          endDate: range.endDate,
          includeFull,
          clientId: cid,
        }, {
          jobId: `sync-backfill-${cid.slice(0, 8)}-${range.today}`,
          priority: 10,
          attempts: 1,
          backoff: { type: 'fixed', delay: 120000 },
        });
        logger.info(
          `Cron: enqueued sync-backfill ${range.startDate} → ${range.endDate}`
          + ` client=${cid.slice(0, 8)} includeFull=${includeFull}`
        );
      } catch (e) {
        logger.error('Cron: failed to enqueue sync-backfill:', e.message);
      }
    });
  }, { timezone: 'Asia/Singapore' });

  // ── Weekly Sunday 3 AM: full warehouse backfill (optional heavy job) ─────
  cron.schedule('0 3 * * 0', async () => {
    if (process.env.FULL_SYNC_DISABLED === 'true') return;
    if (process.env.FULL_BACKFILL_WEEKLY === 'false') return;
    const range = historicalRangeForPresets();
    await eachActiveClient(async (client) => {
      const cid = client.id;
      try {
        await gamSyncQueue.add('sync-backfill', {
          startDate: range.startDate,
          endDate: range.endDate,
          includeFull: true,
          clientId: cid,
        }, {
          jobId: `sync-full-backfill-weekly-${cid.slice(0, 8)}-${range.today}`,
          priority: 15,
          attempts: 1,
          backoff: { type: 'fixed', delay: 180000 },
        });
        logger.info(
          `Cron: enqueued weekly FULL backfill ${range.startDate} → ${range.endDate} client=${cid.slice(0, 8)}`
        );
      } catch (e) {
        logger.error('Cron: failed to enqueue weekly full backfill:', e.message);
      }
    });
  }, { timezone: 'Asia/Singapore' });

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
      if (process.env.FULL_SYNC_DISABLED === 'true') return;
      try {
        await gamSyncQueue.add('promote-full-present', {
          date: today,
          clientId: cid,
        }, {
          jobId: `promote-full-present-${cid.slice(0, 8)}-${today}`,
          attempts: 1,
          backoff: { type: 'fixed', delay: 30000 },
        });
        logger.info(`Cron: enqueued promote-full-present for ${today} client=${cid.slice(0, 8)}`);
      } catch (e) {
        logger.error('Cron: failed to enqueue promote-full-present:', e.message);
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
    'Cron jobs started: hourly lean-today, 6h yesterday+full-today, '
    + '2AM lean backfill, weekly full backfill, 23:05 promote, 00:05 migrate, boot kickoff'
  );

  // Don't wait until the next clock hour — fill today's present now.
  setImmediate(() => {
    enqueueHourlyLeanSync({ reason: 'boot' }).catch((e) => {
      logger.warn('Cron: boot sync-today enqueue failed:', e.message);
    });
  });
}

module.exports = { startCron, enqueueHourlyLeanSync };
