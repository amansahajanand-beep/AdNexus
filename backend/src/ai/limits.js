/**
 * Per-user request rate and per-user / per-account daily token budgets.
 * Counters live in Redis when it is available (shared across API instances) and
 * fall back to process memory otherwise.
 */
const { redis } = require('../redisClient');
const { limits } = require('./config');
const { AiError, CODES } = require('./errors');
const logger = require('../utils/logger');

const mem = new Map(); // key -> { n, exp }

function memIncr(key, by, ttlSec) {
  const now = Date.now();
  const cur = mem.get(key);
  if (!cur || cur.exp <= now) {
    mem.set(key, { n: by, exp: now + ttlSec * 1000 });
    return by;
  }
  cur.n += by;
  return cur.n;
}

function memGet(key) {
  const cur = mem.get(key);
  return cur && cur.exp > Date.now() ? cur.n : 0;
}

// Keep the fallback map from growing without bound.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of mem) if (v.exp <= now) mem.delete(k);
}, 5 * 60_000).unref();

const redisUsable = () => redis && redis.status !== 'disabled' && typeof redis.incrby === 'function';

async function incr(key, by, ttlSec) {
  if (redisUsable()) {
    try {
      const n = await redis.incrby(key, by);
      if (n === by) await redis.expire(key, ttlSec);
      return n;
    } catch (err) {
      logger.warn(`ai limits redis incr failed, using memory: ${err.message}`);
    }
  }
  return memIncr(key, by, ttlSec);
}

async function read(key) {
  if (redisUsable()) {
    try {
      return parseInt(await redis.get(key), 10) || 0;
    } catch (err) {
      logger.warn(`ai limits redis get failed, using memory: ${err.message}`);
    }
  }
  return memGet(key);
}

const dayStamp = () => new Date().toISOString().slice(0, 10);

/** Count this request and refuse when the user is over their per-minute rate. */
async function checkRate(userId) {
  const { requestsPerMinute } = limits();
  const minute = Math.floor(Date.now() / 60_000);
  const n = await incr(`ai:rpm:${userId}:${minute}`, 1, 70);
  if (n > requestsPerMinute) {
    throw new AiError(CODES.RATE_LIMITED, 'Too many AI requests. Try again in a minute.', {
      status: 429,
      retryAfterSec: 60 - (Math.floor(Date.now() / 1000) % 60),
    });
  }
}

/** Refuse when the user or their account already spent today's token budget. */
async function checkBudget(userId, clientId) {
  const { tokensPerUserDay, tokensPerClientDay } = limits();
  const day = dayStamp();
  const [u, c] = await Promise.all([
    read(`ai:tok:u:${userId}:${day}`),
    clientId ? read(`ai:tok:c:${clientId}:${day}`) : 0,
  ]);
  if (u >= tokensPerUserDay || c >= tokensPerClientDay) {
    throw new AiError(CODES.BUDGET, 'Daily AI limit reached. It resets at midnight UTC.', { status: 429 });
  }
}

/** Add the tokens a finished call used (input + output; cache reads are not counted). */
async function recordTokens(userId, clientId, tokens) {
  if (!tokens) return;
  const day = dayStamp();
  await Promise.all([
    userId ? incr(`ai:tok:u:${userId}:${day}`, tokens, 26 * 3600) : null,
    clientId ? incr(`ai:tok:c:${clientId}:${day}`, tokens, 26 * 3600) : null,
  ]);
}

async function usageToday(userId, clientId) {
  const day = dayStamp();
  const [user, client] = await Promise.all([
    read(`ai:tok:u:${userId}:${day}`),
    clientId ? read(`ai:tok:c:${clientId}:${day}`) : 0,
  ]);
  const l = limits();
  return {
    userTokens: user,
    userLimit: l.tokensPerUserDay,
    clientTokens: client,
    clientLimit: l.tokensPerClientDay,
    requestsPerMinute: l.requestsPerMinute,
  };
}

module.exports = { checkRate, checkBudget, recordTokens, usageToday };
