/**
 * Google Ads API quota circuit breaker.
 * When Google returns "Too many requests. Retry in N seconds", stop all Ads
 * sync work until that window ends — continuing only burns quota further.
 */
const logger = require('../utils/logger');
const { redisGet, redisSet, redisDel } = require('../redisClient');

const REDIS_KEY = 'ads:rate-limit-until';
const MAX_BACKOFF_SEC = 24 * 60 * 60;

/** In-process fallback when Redis is unavailable. */
let localUntilMs = 0;

function parseAdsRateLimitRetrySec(errOrMsg) {
  const msg = typeof errOrMsg === 'string'
    ? errOrMsg
    : (errOrMsg?.errors?.[0]?.message
      || errOrMsg?.message
      || errOrMsg?.details
      || String(errOrMsg || ''));
  const m = String(msg).match(/retry in\s+(\d+)\s*seconds?/i);
  if (m) {
    return Math.min(Math.max(parseInt(m[1], 10) || 0, 30), MAX_BACKOFF_SEC);
  }
  if (/too many requests|resource.?exhausted|rate.?limit|quota.?exceeded/i.test(msg)) {
    return Math.max(
      5 * 60,
      parseInt(process.env.ADS_RATE_LIMIT_DEFAULT_BACKOFF_SEC || String(15 * 60), 10) || 15 * 60
    );
  }
  return null;
}

function isAdsRateLimitError(errOrMsg) {
  return parseAdsRateLimitRetrySec(errOrMsg) != null;
}

async function beginAdsRateLimit(retrySec, { reason = 'quota' } = {}) {
  const sec = Math.min(Math.max(Number(retrySec) || 60, 30), MAX_BACKOFF_SEC);
  const untilMs = Date.now() + sec * 1000;
  localUntilMs = untilMs;
  try {
    await redisSet(REDIS_KEY, { untilMs, reason, setAt: Date.now() }, sec + 30);
  } catch (e) {
    logger.warn(`[ads-rate-limit] redis set failed (${e.message}) — using in-process gate`);
  }
  logger.warn(
    `[ads-rate-limit] ON — pause Ads sync for ${Math.round(sec / 60)}m `
    + `(retry≈${new Date(untilMs).toISOString()}) reason=${reason}`
  );
  return { untilMs, sec };
}

async function clearAdsRateLimit({ reason = 'manual' } = {}) {
  localUntilMs = 0;
  try {
    if (typeof redisDel === 'function') await redisDel(REDIS_KEY);
    else await redisSet(REDIS_KEY, { untilMs: 0 }, 5);
  } catch (_) { /* ignore */ }
  logger.info(`[ads-rate-limit] OFF reason=${reason}`);
}

async function getAdsRateLimitState() {
  if (localUntilMs && Date.now() < localUntilMs) {
    return { active: true, untilMs: localUntilMs, remainingMs: localUntilMs - Date.now() };
  }
  if (localUntilMs && Date.now() >= localUntilMs) localUntilMs = 0;
  try {
    const v = await redisGet(REDIS_KEY);
    const untilMs = Number(v?.untilMs) || 0;
    if (untilMs > Date.now()) {
      localUntilMs = untilMs;
      return { active: true, untilMs, remainingMs: untilMs - Date.now() };
    }
  } catch (_) { /* ignore */ }
  return { active: false, untilMs: 0, remainingMs: 0 };
}

async function isAdsRateLimited() {
  const state = await getAdsRateLimitState();
  return state.active;
}

/** Delay Ads jobs until the Google quota window ends. */
async function getAdsRateLimitDeferMs() {
  const state = await getAdsRateLimitState();
  if (!state.active) return 0;
  return Math.min(Math.max(state.remainingMs + 15_000, 60_000), MAX_BACKOFF_SEC * 1000);
}

module.exports = {
  parseAdsRateLimitRetrySec,
  isAdsRateLimitError,
  beginAdsRateLimit,
  clearAdsRateLimit,
  getAdsRateLimitState,
  isAdsRateLimited,
  getAdsRateLimitDeferMs,
};
