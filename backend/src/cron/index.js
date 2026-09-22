/**
 * Cron schedules — enqueue BullMQ jobs.
 * Only runs when SYNC_DISABLED !== 'true'.
 * All times are in Asia/Singapore timezone.
 *
 * Tuned so today stays healthy under multi-network load:
 *   - Hourly: lean today Totals only (GAM + 1 Ads job per client)
 *   - Boot: today + yesterday only (no month/gap stampede)
 *   - 2AM: drip complete-month (capped), not unlimited fan-out
 *   - Every ~90m: sync-extended (AdX + Ad Server + Active View → grain.metrics)
 *   - Every 6h: lean yesterday (GAM + Ads)
 *   - Hourly :30: GAM reconcile only (Ads reconcile opt-in via ADS_RECONCILE_CRON)
 *   - One in-flight sync-today per network (watchdog does not flood duplicates)
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

/** Max calendar months to enqueue per complete-month run (2AM / drip). */
function monthBackfillLimit() {
  const n = parseInt(process.env.SYNC_MONTH_BACKFILL_LIMIT || '2', 10);
  return Math.max(1, Math.min(12, Number.isFinite(n) ? n : 2));
}

/** Stable BullMQ job id — one per network per calendar day (no hour/minute suffixes). */
function syncTodayJobId(clientId, today = todayInTZ()) {
  return `sync-today-${String(clientId || '').slice(0, 8)}-${String(today || '').slice(0, 10)}`.slice(0, 120);
}

function isSyncTodayForClientDay(job, clientId, today) {
  if (!job || job.name !== 'sync-today') return false;
  const jobDay = job.data?.date ? String(job.data.date).slice(0, 10) : '';
  if (jobDay !== String(today || '').slice(0, 10)) return false;
  return String(job.data?.clientId || '') === String(clientId || '');
}

/**
 * True when this network already has a live sync-today for calendar today
 * (waiting / delayed / active / paused). Prevents watchdog/boot floods.
 */
async function hasLiveSyncTodayJob(clientId, today = todayInTZ()) {
  if (gamSyncQueue.disabled || typeof gamSyncQueue.getJobs !== 'function') return false;
  const cid = String(clientId || '');
  const day = String(today || '').slice(0, 10);
  if (!cid || !day) return false;
  try {
    const jobs = await gamSyncQueue.getJobs(['waiting', 'delayed', 'active', 'paused'], 0, 200);
    return jobs.some((job) => isSyncTodayForClientDay(job, cid, day));
  } catch (_) {
    return false;
  }
}

/**
 * Drop duplicate sync-today jobs for a network/day, keeping at most one live job.
 * Legacy hour/minute jobId suffixes left zombies that starved the large network.
 */
async function purgeDuplicateSyncTodayJobs(clientId, today = todayInTZ()) {
  if (gamSyncQueue.disabled || typeof gamSyncQueue.getJobs !== 'function') return 0;
  const cid = String(clientId || '');
  const day = String(today || '').slice(0, 10);
  if (!cid || !day) return 0;
  const keepId = syncTodayJobId(cid, day);
  let removed = 0;
  try {
    const jobs = await gamSyncQueue.getJobs(
      ['waiting', 'delayed', 'active', 'paused', 'completed', 'failed'],
      0,
      300
    );
    const matches = jobs.filter((job) => isSyncTodayForClientDay(job, cid, day));
    // Prefer keeping the stable id if live; else the newest live job.
    let keep = matches.find((j) => String(j.id) === keepId) || null;
    if (keep) {
      const st = await keep.getState().catch(() => null);
      if (!['waiting', 'delayed', 'active', 'paused'].includes(st)) keep = null;
    }
    if (!keep) {
      const live = [];
      for (const j of matches) {
        const st = await j.getState().catch(() => null);
        if (['waiting', 'delayed', 'active', 'paused'].includes(st)) live.push(j);
      }
      live.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      keep = live[0] || null;
    }
    for (const job of matches) {
      if (keep && String(job.id) === String(keep.id)) continue;
      try {
        const st = await job.getState().catch(() => null);
        if (st === 'active') {
          try {
            await job.moveToFailed(new Error('duplicate sync-today purged'), job.token || '0', true);
          } catch (_) { /* lock may belong to dead worker */ }
        }
        await job.remove();
        removed += 1;
      } catch (_) { /* ignore stubborn locks — restart clears them */ }
    }
    if (removed) {
      logger.info(
        `Cron: purged ${removed} duplicate sync-today for client=${cid.slice(0, 8)} day=${day}`
        + ` (kept=${keep ? keep.id : 'none'})`
      );
    }
  } catch (e) {
    logger.warn(`Cron: purge duplicate sync-today failed: ${e.message}`);
  }
  return removed;
}

/**
 * Drop leftover sync-today jobs whose payload date is no longer calendar today.
 * Incomplete past days are requeued as sync-day (reconcile / fill-gaps still cover the rest).
 */
async function purgeStaleSyncTodayJobs() {
  if (gamSyncQueue.disabled || typeof gamSyncQueue.getJobs !== 'function') return 0;
  const today = todayInTZ();
  let removed = 0;
  let demoted = 0;
  try {
    const jobs = await gamSyncQueue.getJobs(['waiting', 'delayed', 'paused', 'failed'], 0, 400);
    for (const job of jobs) {
      if (!job || job.name !== 'sync-today') continue;
      const day = job.data?.date ? String(job.data.date).slice(0, 10) : '';
      if (!day || day === today) continue;
      const cid = job.data?.clientId;
      if (cid) {
        try {
          await gamSyncQueue.add('sync-day', {
            date: day,
            includeFull: false,
            clientId: cid,
          }, {
            jobId: `sync-day-${String(cid).slice(0, 8)}-${day}-from-stale-today`,
            priority: 3,
            attempts: 2,
            backoff: { type: 'exponential', delay: 20000 },
          });
          demoted += 1;
        } catch (e) {
          if (!/JobId|already exists|duplicat/i.test(e.message || '')) {
            logger.warn(`Cron: demote stale sync-today ${job.id} failed: ${e.message}`);
          }
        }
      }
      try {
        await job.remove();
        removed += 1;
      } catch (e) {
        logger.warn(`Cron: could not remove stale sync-today ${job.id}: ${e.message}`);
      }
    }
    if (removed) {
      logger.info(
        `Cron: purged ${removed} stale sync-today job(s) (today=${today}, demoted=${demoted})`
      );
    }
  } catch (e) {
    logger.warn(`Cron: purge stale sync-today failed: ${e.message}`);
  }
  return removed;
}

/**
 * Enqueue lean sync-today. Optional clientIds limits to specific networks
 * (watchdog must not re-queue every network when one is stale).
 */
async function enqueueLeanToday({ reason, clientIds = null } = {}) {
  const today = todayInTZ();
  await purgeStaleSyncTodayJobs();
  const tag = reason ? ` (${reason})` : '';
  const only = Array.isArray(clientIds) && clientIds.length
    ? new Set(clientIds.map((id) => String(id)))
    : null;

  await eachActiveClient(async (client) => {
    const cid = client.id;
    if (only && !only.has(String(cid))) return;

    await purgeDuplicateSyncTodayJobs(cid, today);

    if (await hasLiveSyncTodayJob(cid, today)) {
      logger.info(
        `Cron: sync-today already live for ${today} client=${cid.slice(0, 8)} — skip enqueue${tag}`
      );
      return;
    }

    const jobId = syncTodayJobId(cid, today);
    try {
      // Drop completed/failed leftover with the stable id so re-add is reliable.
      try {
        const existing = await gamSyncQueue.getJob(jobId);
        if (existing) {
          const state = await existing.getState();
          if (state === 'completed' || state === 'failed') {
            await existing.remove();
          } else {
            logger.info(
              `Cron: sync-today jobId=${jobId} still ${state} — skip enqueue${tag}`
            );
            return;
          }
        }
      } catch (_) { /* ignore */ }

      await gamSyncQueue.add('sync-today', {
        date: today,
        includeFull: false,
        clientId: cid,
      }, {
        jobId,
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
      if (/JobId|already exists|duplicat/i.test(e.message || '')) {
        logger.info(
          `Cron: sync-today already queued for ${today} client=${cid.slice(0, 8)}${tag}`
        );
        return;
      }
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

/**
 * Ad Exchange + Ad Server + Active View → merge into report_grain.metrics.
 * Lower priority than sync-today; skipped/deferred while today-priority is active.
 * Today is enqueued first; yesterday is delayed so they never stampede the PG pool.
 */
async function enqueueExtendedMetricsSync({ reason } = {}) {
  const tag = reason ? ` (${reason})` : '';
  try {
    const { isTodayPriorityActive } = require('../services/syncPriorityGate');
    if (await isTodayPriorityActive()) {
      logger.info(`Cron: sync-extended skipped — today-priority active${tag}`);
      return;
    }
  } catch (_) { /* gate optional at boot */ }

  const today = todayInTZ();
  const yesterday = shiftYMD(today, -1);
  const slot = Math.floor(Date.now() / (90 * 60 * 1000));

  await eachActiveClient(async (client) => {
    const cid = client.id;
    const days = [
      { day: today, delay: 0 },
      // Stagger yesterday so only one extended day hits the pool at a time.
      { day: yesterday, delay: Math.max(0, parseInt(process.env.SYNC_EXTENDED_YDAY_DELAY_MS || String(15 * 60_000), 10) || 15 * 60_000) },
    ];
    for (const { day, delay } of days) {
      try {
        await gamSyncQueue.add('sync-extended', {
          date: day,
          clientId: cid,
          extendedOnly: true,
        }, {
          jobId: `sync-extended-${cid.slice(0, 8)}-${day}-${slot}`,
          priority: 5,
          attempts: 2,
          backoff: { type: 'fixed', delay: 120000 },
          delay,
        });
        logger.info(
          `Cron: enqueued sync-extended for ${day} client=${cid.slice(0, 8)}`
          + `${delay ? ` delay=${Math.round(delay / 1000)}s` : ''}${tag}`
        );
      } catch (e) {
        if (/already exists/i.test(String(e.message || ''))) {
          logger.info(
            `Cron: sync-extended already queued ${day} client=${cid.slice(0, 8)}${tag}`
          );
          continue;
        }
        logger.error('Cron: failed to enqueue sync-extended:', e.message);
      }
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
 * One sync-backfill job per calendar month (newest first), capped so we never
 * stampede the worker with a full year of months on every boot.
 */
async function enqueueMonthCompleteBackfill({ reason, maxMonths = null } = {}) {
  const range = historicalRangeForPresets();
  const months = listCalendarMonthsNewestFirst(range.startDate, range.endDate);
  const limit = maxMonths != null ? maxMonths : monthBackfillLimit();
  const slice = months.slice(0, limit);
  const tag = reason ? ` (${reason})` : '';
  const daySlot = todayInTZ();

  await eachActiveClient(async (client) => {
    const cid = client.id;
    for (let i = 0; i < slice.length; i += 1) {
      const { startDate: ms, endDate: me } = slice[i];
      try {
        await gamSyncQueue.add('sync-backfill', {
          startDate: ms,
          endDate: me,
          completeMonth: true,
          includeFull: false,
          clientId: cid,
        }, {
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
        if (/JobId|already exists|duplicat/i.test(e.message || '')) continue;
        logger.error('Cron: failed to enqueue sync-month:', e.message);
      }
    }
    if (months.length > slice.length) {
      logger.info(
        `Cron: complete-month capped at ${slice.length}/${months.length}`
        + ` for client=${cid.slice(0, 8)}${tag} (rest drip via later 2AM runs)`
      );
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
  try {
    const { isAdsRateLimited, getAdsRateLimitState } = require('../services/adsRateLimitGate');
    if (await isAdsRateLimited()) {
      const state = await getAdsRateLimitState();
      logger.warn(
        `Cron: ads-sync-today skipped (rate-limited) remaining≈${Math.round((state.remainingMs || 0) / 60000)}m`
      );
      return;
    }
  } catch (_) { /* gate optional */ }

  const today = todayInTZ();
  const hourSlot = Math.floor(Date.now() / (60 * 60 * 1000));
  const tag = reason ? ` (${reason})` : '';
  const { enqueueAdsSyncAccounts } = require('../services/adsSyncService');
  await eachActiveClient(async (client) => {
    const cid = client.id;
    try {
      const { accounts, jobs, skipped, rateLimited } = await enqueueAdsSyncAccounts(client, adsSyncQueue, {
        startDate: today,
        endDate: today,
        jobIdPrefix: `ads-sync-today-${cid.slice(0, 8)}-${today}-${hourSlot}`,
        priority: 1,
      });
      if (skipped || rateLimited) return;
      logger.info(
        `Cron: enqueued ads-sync-today jobs=${jobs} accounts=${accounts} for ${today} `
        + `client=${cid.slice(0, 8)}${tag}`
      );
    } catch (e) {
      if (/JobId|already exists|duplicate/i.test(e.message || '')) {
        logger.info(
          `Cron: ads-sync-today already queued client=${cid.slice(0, 8)}${tag}`
        );
        return;
      }
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
      const { accounts, jobs, skipped } = await enqueueAdsSyncAccounts(client, adsSyncQueue, {
        startDate: yesterday,
        endDate: yesterday,
        jobIdPrefix: `ads-sync-yesterday-${cid.slice(0, 8)}-${yesterday}-${Math.floor(hourSlot / 6)}`,
        priority: 2,
        skipIfTodayPriority: true,
      });
      if (skipped) return;
      logger.info(
        `Cron: enqueued ads-sync-yesterday jobs=${jobs} accounts=${accounts} for ${yesterday} `
        + `client=${cid.slice(0, 8)}${tag}`
      );
    } catch (e) {
      logger.error('Cron: failed to enqueue ads-sync-yesterday:', e.message);
    }
  });
}

/**
 * Optional Ads reconcile (yesterday+today). Disabled by default — overlaps hourly today + 6h yesterday
 * and burned Upstash via per-account job fan-out. Set ADS_RECONCILE_CRON=true to enable.
 */
async function enqueueAdsReconcileRecent({ reason } = {}) {
  if (!isAdsCronEnabled()) return;
  const enabled = String(process.env.ADS_RECONCILE_CRON || '').trim().toLowerCase();
  if (enabled !== 'true' && enabled !== '1' && enabled !== 'yes') {
    return;
  }
  const today = todayInTZ();
  const yesterday = shiftYMD(today, -1);
  const tag = reason ? ` (${reason})` : '';
  const { enqueueAdsSyncAccounts } = require('../services/adsSyncService');
  await eachActiveClient(async (client) => {
    const cid = client.id;
    try {
      const { accounts, jobs, skipped } = await enqueueAdsSyncAccounts(client, adsSyncQueue, {
        startDate: yesterday,
        endDate: today,
        jobIdPrefix: `ads-reconcile-recent-${cid.slice(0, 8)}-${today}-${Math.floor(Date.now() / (6 * 60 * 60 * 1000))}`,
        priority: 2,
        skipIfTodayPriority: true,
      });
      if (skipped) return;
      logger.info(
        `Cron: enqueued ads-reconcile-recent jobs=${jobs} accounts=${accounts} `
        + `${yesterday}..${today} client=${cid.slice(0, 8)}${tag}`
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

/** Re-enqueue sync-today if stale; keep draining historical gaps (only when today is healthy). */
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
  const today = todayInTZ();
  for (const client of clients) {
    try {
      const { rows } = await query(
        `SELECT finished_at FROM sync_log
         WHERE client_id = $1::uuid AND sync_type = 'sync-today' AND status = 'success'
         ORDER BY finished_at DESC LIMIT 1`,
        [client.id]
      );
      const last = rows[0]?.finished_at ? new Date(rows[0].finished_at).getTime() : 0;
      const stale = Date.now() - last > staleMs;
      if (stale) {
        if (await hasLiveSyncTodayJob(client.id, today)) {
          logger.info(
            `Cron watchdog: sync-today already live for client=${client.id.slice(0, 8)} — skip re-enqueue`
          );
        } else {
          logger.warn(
            `Cron watchdog: sync-today stale for client=${client.id.slice(0, 8)}`
            + ` (last=${rows[0]?.finished_at || 'never'}) — re-enqueue with today-priority`
          );
          await runWithTodayPriority(async ({ startedAt, waitMs }) => {
            // Only this network — do not flood siblings.
            await enqueueLeanToday({ reason: 'watchdog', clientIds: [client.id] });
            await waitForSyncTodaySuccess(client.id, today, {
              timeoutMs: Math.min(waitMs, 60_000),
              sinceMs: startedAt - 5_000,
            });
          }, { reason: 'watchdog' });
        }
      } else {
        // History drip only when today is fresh for this network.
        await runWithClient(client, () => drainIncompleteHistory());
      }
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

  await runWithTodayPriority(async ({ startedAt, waitMs, nested }) => {
    await enqueueLeanToday({ reason });
    // Nested (watchdog while hourly already waiting): enqueue only — do not stack another 20m wait.
    if (nested) {
      logger.info(`[today-priority] nested ${reason} — skipped wait/ads (outer window owns them)`);
      return;
    }
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
    // Today + yesterday only. History drips via 2AM complete-month + watchdog drain —
    // never dump every incomplete month on restart (that starved sync-today).
    await runHourlyTodayPrioritySync({ reason: 'boot' });
    await enqueueLeanYesterdayAndFullToday({ reason: 'boot' });
    await enqueueAdsSyncYesterday({ reason: 'boot' });
    logger.info('Cron: boot kickoff done (today+yesterday only; history deferred to 2AM/drip)');
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

  // ── Every ~90 minutes: AdX + Ad Server + Active View (merge into grain.metrics)
  // Never at :00 (hourly Totals) — use :45 / :15 on alternating hours.
  cron.schedule('45 0,3,6,9,12,15,18,21 * * *', async () => {
    await enqueueExtendedMetricsSync({ reason: 'extended-90m' });
  }, { timezone: 'Asia/Singapore' });
  cron.schedule('15 1,4,7,10,13,16,19,22 * * *', async () => {
    await enqueueExtendedMetricsSync({ reason: 'extended-90m' });
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

  // ── 4 AM daily: Google Ads spend sync (lookback window) — 1 job per client ──
  cron.schedule('0 4 * * *', async () => {
    if (!isAdsCronEnabled()) return;
    const lookback = parseInt(process.env.GOOGLE_ADS_SYNC_LOOKBACK_DAYS || '30', 10) || 30;
    const end = todayInTZ();
    const start = shiftYMD(end, -(lookback - 1));
    const { enqueueAdsSyncAccounts } = require('../services/adsSyncService');
    await eachActiveClient(async (client) => {
      const cid = client.id;
      try {
        const { accounts, jobs, skipped } = await enqueueAdsSyncAccounts(client, adsSyncQueue, {
          startDate: start,
          endDate: end,
          jobIdPrefix: `ads-sync-daily-${cid.slice(0, 8)}-${end}`,
          priority: 4,
          skipIfTodayPriority: true,
        });
        if (skipped) return;
        logger.info(
          `Cron: enqueued ads-sync-daily jobs=${jobs} accounts=${accounts} `
          + `client=${cid.slice(0, 8)} ${start}→${end}`
        );
      } catch (e) {
        logger.error('Cron: failed to enqueue ads-sync:', e.message);
      }
    });
  }, { timezone: 'Asia/Singapore' });

  // ── Optional every-3h Ads recent catch-up (off by default — overlaps hourly/6h/4AM) ──
  // Set ADS_RECENT_CRON=true to enable.
  cron.schedule('45 */3 * * *', async () => {
    if (!isAdsCronEnabled()) return;
    const enabled = String(process.env.ADS_RECENT_CRON || '').trim().toLowerCase();
    if (enabled !== 'true' && enabled !== '1' && enabled !== 'yes') return;
    const recentDays = parseInt(process.env.GOOGLE_ADS_RECENT_SYNC_DAYS || '3', 10) || 3;
    const end = todayInTZ();
    const start = shiftYMD(end, -(Math.max(1, recentDays) - 1));
    const slot = Math.floor(Date.now() / (3 * 60 * 60 * 1000));
    const { enqueueAdsSyncAccounts } = require('../services/adsSyncService');
    await eachActiveClient(async (client) => {
      const cid = client.id;
      try {
        const { accounts, jobs, skipped } = await enqueueAdsSyncAccounts(client, adsSyncQueue, {
          startDate: start,
          endDate: end,
          jobIdPrefix: `ads-sync-recent-${cid.slice(0, 8)}-${end}-${slot}`,
          priority: 3,
          skipIfTodayPriority: true,
        });
        if (skipped) return;
        logger.info(
          `Cron: enqueued ads-sync-recent jobs=${jobs} accounts=${accounts} `
          + `client=${cid.slice(0, 8)} ${start}→${end}`
        );
      } catch (e) {
        logger.error('Cron: failed to enqueue ads-sync-recent:', e.message);
      }
    });
  }, { timezone: 'Asia/Singapore' });

  logger.info(
    'Cron jobs started: hourly today-priority (+ads 1 job/client), ~90m sync-extended '
    + '(AdX/AdServer/ActiveView), :30 GAM reconcile '
    + '(Ads reconcile off unless ADS_RECONCILE_CRON=true), 1AM reconcile-historical,'
    + ' 6h yesterday (+ads), 2AM complete-month (capped), 3AM archive, 4AM ads-full, '
    + '3h ads-recent off unless ADS_RECENT_CRON=true, 15m watchdog (no flood), '
    + 'boot=today+yesterday only'
  );

  // Don't wait until the next clock hour — fill today's present now.
  setImmediate(() => {
    enqueueHourlyLeanSync({ reason: 'boot' }).catch((e) => {
      logger.warn('Cron: boot sync-today enqueue failed:', e.message);
    });
    // Extended metrics only after Totals have room — avoid PG pool stampede with sync-today.
    const bootExtendedDelayMs = Math.max(
      5 * 60_000,
      parseInt(process.env.SYNC_EXTENDED_BOOT_DELAY_MS || String(20 * 60_000), 10) || 20 * 60_000
    );
    setTimeout(() => {
      enqueueExtendedMetricsSync({ reason: 'boot' }).catch((e) => {
        logger.warn('Cron: boot sync-extended enqueue failed:', e.message);
      });
    }, bootExtendedDelayMs);
  });
}

module.exports = {
  startCron,
  enqueueHourlyLeanSync,
  purgeStaleSyncTodayJobs,
  purgeDuplicateSyncTodayJobs,
  hasLiveSyncTodayJob,
  syncTodayJobId,
  enqueueExtendedMetricsSync,
  runHourlyTodayPrioritySync,
  enqueueRecentGapFill,
  enqueueMonthCompleteBackfill,
  enqueueReconcileRecent,
  enqueueReconcileHistorical,
  enqueueAdsSyncToday,
  enqueueAdsSyncYesterday,
  enqueueAdsReconcileRecent,
};
