/**
 * Today-priority gate — pause/yield historical backfill while hourly today sync runs.
 *
 * Redis flag (+ in-process fallback) so workers across restarts honor the window.
 * Backfill jobs defer via BullMQ DelayedError; long fill loops yield between windows.
 */
const logger = require('../utils/logger');
const { redisGet, redisSet, redisDel } = require('../redisClient');
const { todayInTZ, shiftYMD } = require('../utils/datetime');

const REDIS_KEY = 'sync:today-priority';
const DEFAULT_TTL_SEC = Math.max(
  5 * 60,
  parseInt(process.env.SYNC_TODAY_PRIORITY_TTL_SEC || String(25 * 60), 10) || 25 * 60
);
const DEFAULT_WAIT_MS = Math.max(
  60_000,
  parseInt(process.env.SYNC_TODAY_PRIORITY_WAIT_MS || String(20 * 60 * 1000), 10) || 20 * 60 * 1000
);
const DEFER_MS = Math.max(
  15_000,
  parseInt(process.env.SYNC_TODAY_PRIORITY_DEFER_MS || '60000', 10) || 60_000
);

/** In-process fallback when Redis quota/ops are blocked. */
let localPriority = null; // { until: number, reason: string, startedAt: number }

class TodayPriorityYieldError extends Error {
  constructor(message = 'Yielding historical sync for today-priority window') {
    super(message);
    this.name = 'TodayPriorityYieldError';
    this.yieldToToday = true;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function beginTodayPriority({ reason = 'hourly', ttlSec = DEFAULT_TTL_SEC } = {}) {
  const startedAt = Date.now();
  const until = startedAt + ttlSec * 1000;
  localPriority = { until, reason, startedAt };
  const payload = { active: true, reason, startedAt, until };
  try {
    await redisSet(REDIS_KEY, payload, ttlSec);
  } catch (e) {
    logger.warn(`[today-priority] redis set failed (${e.message}) — using in-process flag`);
  }
  logger.info(`[today-priority] ON reason=${reason} ttl=${ttlSec}s`);
  return payload;
}

async function endTodayPriority({ reason = 'done' } = {}) {
  localPriority = null;
  try {
    if (typeof redisDel === 'function') await redisDel(REDIS_KEY);
    else await redisSet(REDIS_KEY, { active: false }, 5);
  } catch (e) {
    logger.warn(`[today-priority] redis clear failed: ${e.message}`);
  }
  logger.info(`[today-priority] OFF reason=${reason}`);
}

async function isTodayPriorityActive() {
  if (localPriority && Date.now() < localPriority.until) return true;
  if (localPriority && Date.now() >= localPriority.until) localPriority = null;
  try {
    const v = await redisGet(REDIS_KEY);
    if (v && v.active && (!v.until || Date.now() < Number(v.until))) return true;
  } catch (_) { /* ignore */ }
  return false;
}

async function assertNotTodayPriority(context = 'backfill') {
  if (await isTodayPriorityActive()) {
    throw new TodayPriorityYieldError(`Yielding ${context} for today-priority window`);
  }
}

/** GAM jobs allowed while today-priority is active. */
function isGamJobAllowedDuringTodayPriority(job) {
  const name = String(job?.name || '');
  const today = todayInTZ();
  const yesterday = shiftYMD(today, -1);
  const date = job?.data?.date ? String(job.data.date).slice(0, 10) : null;
  const start = job?.data?.startDate ? String(job.data.startDate).slice(0, 10) : null;
  const end = job?.data?.endDate ? String(job.data.endDate).slice(0, 10) : null;

  if (name === 'sync-today') return true;
  if (name === 'sync-network-kpi' && (date === today || date === yesterday)) return true;
  if (name === 'reconcile-day' && (date === today || date === yesterday)) return true;
  if (name === 'sync-day' && date === today) return true;
  // Single-day range that is today only
  if (start === today && end === today && (name === 'sync-day' || name === 'sync-today')) return true;
  return false;
}

/** Ads jobs allowed while today-priority is active (today-only spend). */
function isAdsJobAllowedDuringTodayPriority(job) {
  const today = todayInTZ();
  const end = job?.data?.endDate ? String(job.data.endDate).slice(0, 10) : today;
  const start = job?.data?.startDate ? String(job.data.startDate).slice(0, 10) : end;
  return start === today && end === today;
}

async function waitForSyncTodaySuccess(clientId, date, {
  timeoutMs = DEFAULT_WAIT_MS,
  pollMs = 5000,
  sinceMs = null,
} = {}) {
  const { query } = require('../db');
  const since = sinceMs != null ? new Date(sinceMs) : new Date(Date.now() - 10_000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { rows } = await query(
        `SELECT finished_at FROM sync_log
         WHERE client_id = $1::uuid
           AND sync_type = 'sync-today'
           AND status = 'success'
           AND finished_at >= $2::timestamptz
         ORDER BY finished_at DESC
         LIMIT 1`,
        [clientId, since.toISOString()]
      );
      if (rows[0]?.finished_at) {
        logger.info(
          `[today-priority] sync-today success client=${String(clientId).slice(0, 8)}`
          + ` at ${rows[0].finished_at}`
        );
        return true;
      }
    } catch (e) {
      logger.warn(`[today-priority] wait poll failed: ${e.message}`);
    }
    await sleep(pollMs);
  }
  logger.warn(
    `[today-priority] timed out waiting for sync-today client=${String(clientId).slice(0, 8)}`
    + ` date=${date} after ${Math.round(timeoutMs / 1000)}s`
  );
  return false;
}

/**
 * Run hourly today sync under the priority gate, then always clear the flag
 * so historical backfill can resume (missing days are re-detected from DB).
 */
async function runWithTodayPriority(workFn, {
  reason = 'hourly',
  ttlSec = DEFAULT_TTL_SEC,
  waitMs = DEFAULT_WAIT_MS,
} = {}) {
  // Nested cron (e.g. watchdog during hourly wait): do not clear the outer window.
  if (await isTodayPriorityActive()) {
    logger.info(`[today-priority] already ON — nest work reason=${reason}`);
    await workFn({
      startedAt: localPriority?.startedAt || Date.now(),
      waitMs,
      reason,
      nested: true,
    });
    return;
  }

  const startedAt = Date.now();
  await beginTodayPriority({ reason, ttlSec });
  try {
    await workFn({ startedAt, waitMs, reason, nested: false });
  } finally {
    await endTodayPriority({ reason: `${reason}:done` });
  }
}

module.exports = {
  TodayPriorityYieldError,
  beginTodayPriority,
  endTodayPriority,
  isTodayPriorityActive,
  assertNotTodayPriority,
  isGamJobAllowedDuringTodayPriority,
  isAdsJobAllowedDuringTodayPriority,
  waitForSyncTodaySuccess,
  runWithTodayPriority,
  DEFER_MS,
  DEFAULT_WAIT_MS,
};
