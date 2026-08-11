/**
 * Cron schedules — enqueue BullMQ jobs.
 * Only runs when SYNC_DISABLED !== 'true'.
 * All times are in Asia/Singapore timezone.
 *
 * Dashboard lean tables (must not wait behind full-slice backfill):
 *   1. Hourly + on boot → sync-today (lean) → report_present
 *   2. Hourly → sync-day yesterday (lean) → report_daily
 *   3. Hourly + on boot → sync-full-today (low priority) → report_full_present
 *   4. 23:05 → copy present → report_daily (keep today in present)
 *   5. 00:05 → migrate leftover present (yesterday) → report_daily and delete it
 *   6. 2 AM  → sync-backfill for past presets window (lean + full)
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

async function enqueueHourlyLeanSync({ reason } = {}) {
  const today = todayInTZ();
  const hourSlot = Math.floor(Date.now() / (60 * 60 * 1000));
  const promoteToDaily = isLastHourOfDay();
  const { yesterday } = historicalRangeForPresets();
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
        attempts: 3,
        backoff: { type: 'exponential', delay: 10000 },
      });
      logger.info(
        `Cron: enqueued lean sync-today for ${today} client=${cid.slice(0, 8)}${tag}`
        + (promoteToDaily ? ' (last-of-day → copy into report_daily)' : '')
      );
    } catch (e) {
      logger.error('Cron: failed to enqueue sync-today:', e.message);
    }

    try {
      await gamSyncQueue.add('sync-day', {
        date: yesterday,
        includeFull: false,
        clientId: cid,
      }, {
        jobId: `sync-day-${cid.slice(0, 8)}-${yesterday}-${hourSlot}`,
        priority: 2,
        attempts: 3,
        backoff: { type: 'exponential', delay: 15000 },
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
        jobId: `sync-full-today-${cid.slice(0, 8)}-${today}-${hourSlot}`,
        priority: 8,
        attempts: 2,
        backoff: { type: 'fixed', delay: 20000 },
      });
      logger.info(
        `Cron: enqueued sync-full-today for ${today} client=${cid.slice(0, 8)}${tag} → report_full_present`
      );
    } catch (e) {
      logger.error('Cron: failed to enqueue sync-full-today:', e.message);
    }
  });
}

function startCron() {
  if (process.env.SYNC_DISABLED === 'true') {
    logger.info('Cron: SYNC_DISABLED=true — all cron jobs skipped');
    return;
  }

  // ── Every hour: today + yesterday (lean dashboard only) ──────────────────
  cron.schedule('0 * * * *', async () => {
    await enqueueHourlyLeanSync({ reason: 'hourly' });
  }, { timezone: 'Asia/Singapore' });

  // ── 2 AM daily: past window once (lean + full) ───────────────────────────
  cron.schedule('0 2 * * *', async () => {
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
          jobId: `sync-backfill-${cid.slice(0, 8)}-${range.today}`,
          priority: 10,
          attempts: 2,
          backoff: { type: 'fixed', delay: 60000 },
        });
        logger.info(
          `Cron: enqueued sync-backfill ${range.startDate} → ${range.endDate} client=${cid.slice(0, 8)}`
        );
      } catch (e) {
        logger.error('Cron: failed to enqueue sync-backfill:', e.message);
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
      try {
        await gamSyncQueue.add('promote-full-present', {
          date: today,
          clientId: cid,
        }, {
          jobId: `promote-full-present-${cid.slice(0, 8)}-${today}`,
          attempts: 2,
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
    'Cron jobs started: hourly lean today+yesterday, low-priority sync-full-today, '
    + 'boot kickoff, 23:05 promote, 00:05 migrate-present, 2AM past-window backfill'
  );

  // Don't wait until the next clock hour — fill today's present now.
  setImmediate(() => {
    enqueueHourlyLeanSync({ reason: 'boot' }).catch((e) => {
      logger.warn('Cron: boot sync-today enqueue failed:', e.message);
    });
  });
}

module.exports = { startCron };
