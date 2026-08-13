const Redis = require('ioredis');
const logger = require('./utils/logger');

// ============================================
// Redis Configuration (Upstash)
// ============================================

const redisDisabled = process.env.REDIS_DISABLED === 'true' || process.env.SYNC_DISABLED === 'true' || !process.env.REDIS_URL;

// Upstash free/pay-as-you-go max request size is 10MB. Stay under it so SET
// never kills the shared TLS socket (that surfaces as write ECONNRESET).
const MAX_REDIS_VALUE_BYTES = Math.max(
  256 * 1024,
  Number(process.env.REDIS_MAX_VALUE_BYTES) || (9 * 1024 * 1024)
);

/** Never cache unbounded grain arrays — they burn commands + heap on stringify. */
const MAX_REDIS_ARRAY_ITEMS = Math.max(
  100,
  parseInt(process.env.REDIS_MAX_ARRAY_ITEMS || '3000', 10) || 3000
);

/** Cap SCAN loops so one invalidation cannot burn tens of thousands of commands. */
const MAX_SCAN_ROUNDS = Math.max(
  1,
  parseInt(process.env.REDIS_MAX_SCAN_ROUNDS || '8', 10) || 8
);

/** When Upstash hits monthly/daily command quota, cool off instead of retry-storm. */
let redisQuotaBlockedUntil = 0;
const REDIS_QUOTA_COOLDOWN_MS = Math.max(
  30_000,
  parseInt(process.env.REDIS_QUOTA_COOLDOWN_MS || '120000', 10) || 120_000
);

function isTransientRedisError(err) {
  const msg = String(err?.message || err || '');
  return /ECONNRESET|ECONNABORTED|ETIMEDOUT|EPIPE|READONLY|Connection is closed|Socket closed/i.test(msg);
}

function isRedisQuotaError(err) {
  const msg = String(err?.message || err || '');
  return /max requests limit exceeded|max request size exceeded/i.test(msg);
}

function markRedisQuotaExhausted(err) {
  redisQuotaBlockedUntil = Date.now() + REDIS_QUOTA_COOLDOWN_MS;
  logger.error(
    `Redis quota exhausted — pausing Redis ops for ${Math.round(REDIS_QUOTA_COOLDOWN_MS / 1000)}s: ${err?.message || err}`
  );
}

function redisOpsAllowed() {
  if (redisDisabled) return false;
  if (Date.now() < redisQuotaBlockedUntil) return false;
  return true;
}

function createDisabledRedis() {
  const noop = async () => undefined;
  return {
    status: 'disabled',
    connect: noop,
    disconnect: noop,
    quit: noop,
    duplicate() { return createDisabledRedis(); },
    get: async () => null,
    set: async () => 'OK',
    del: async () => 1,
    incr: async () => 1,
    expire: async () => 1,
    scan: async () => ['0', []],
    on: () => {},
    once: () => {},
    off: () => {},
    removeListener: () => {},
    removeAllListeners: () => {},
    emit: () => false,
  };
}

function buildRedisOptions(overrides = {}) {
  return {
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: true,
    lazyConnect: true,
    // Keep TLS sockets warm; Upstash closes idle connections aggressively.
    keepAlive: 10000,
    connectTimeout: 20000,
    enableOfflineQueue: true,
    retryStrategy(times) {
      // When quota is exhausted, back off hard — retries only burn more commands.
      if (Date.now() < redisQuotaBlockedUntil) {
        return Math.min(times * 2000, 30000);
      }
      return Math.min(times * 200, 2000);
    },
    reconnectOnError(err) {
      if (isRedisQuotaError(err)) {
        markRedisQuotaExhausted(err);
        return false;
      }
      return isTransientRedisError(err);
    },
    ...overrides,
  };
}

function attachRedisEvents(client, label = 'Redis') {
  if (redisDisabled || !client?.on) return;
  client.on('connect', () => {
    logger.info(`✅ ${label} connected`);
  });
  client.on('ready', () => {
    logger.info(`✅ ${label} ready`);
  });
  client.on('error', (err) => {
    if (isRedisQuotaError(err)) {
      markRedisQuotaExhausted(err);
      return;
    }
    if (isTransientRedisError(err)) {
      logger.warn(`${label} transient: ${err.message}`);
      return;
    }
    logger.error(`❌ ${label} error:`, err.message);
  });
  client.on('close', () => {
    logger.warn(`${label} connection closed`);
  });
  client.on('reconnecting', () => {
    logger.warn(`${label} reconnecting...`);
  });
}

const redis = redisDisabled
  ? createDisabledRedis()
  : new Redis(process.env.REDIS_URL, buildRedisOptions());

if (!redisDisabled) {
  attachRedisEvents(redis, 'Redis');
} else {
  logger.info('Redis disabled; skipping external Redis connection');
}

/**
 * Dedicated ioredis instance for BullMQ Queue/Worker.
 * Sharing one connection with large cache SETs causes ECONNRESET storms on Upstash.
 */
function createBullmqConnection(label = 'BullMQ Redis') {
  if (redisDisabled) return createDisabledRedis();
  const conn = redis.duplicate(buildRedisOptions());
  attachRedisEvents(conn, label);
  return conn;
}

function shouldSkipLargeCacheValue(value) {
  if (Array.isArray(value) && value.length > MAX_REDIS_ARRAY_ITEMS) return true;
  if (value && typeof value === 'object') {
    if (Array.isArray(value.rows) && value.rows.length > MAX_REDIS_ARRAY_ITEMS) return true;
  }
  return false;
}

// ============================================
// Get JSON
// ============================================

async function redisGet(key) {
  try {
    if (!redisOpsAllowed()) return null;
    if (Buffer.byteLength(String(key || ''), 'utf8') > 30000) {
      logger.warn(`Redis GET skipped: key too large (${Buffer.byteLength(String(key), 'utf8')} bytes)`);
      return null;
    }
    const value = await redis.get(key);

    if (!value) {
      return null;
    }

    return JSON.parse(value);
  } catch (err) {
    if (isRedisQuotaError(err)) {
      markRedisQuotaExhausted(err);
    } else if (isTransientRedisError(err)) {
      logger.warn(`Redis GET skipped (reconnect) for ${key}: ${err.message}`);
    } else if (/max key size/i.test(err.message || '')) {
      logger.warn(`Redis GET skipped (key too large): ${err.message}`);
    } else {
      logger.warn(`Redis GET failed for ${key}: ${err.message}`);
    }
    return null;
  }
}

// ============================================
// Set JSON
// ============================================

async function redisSet(key, value, ttlSeconds) {
  try {
    if (!redisOpsAllowed()) return false;
    if (Buffer.byteLength(String(key || ''), 'utf8') > 30000) {
      logger.warn(`Redis SET skipped: key too large (${Buffer.byteLength(String(key), 'utf8')} bytes)`);
      return false;
    }
    if (shouldSkipLargeCacheValue(value)) {
      const n = Array.isArray(value) ? value.length : (value?.rows?.length || '?');
      logger.warn(
        `Redis SET skipped for ${key}: ${n} rows > ${MAX_REDIS_ARRAY_ITEMS} cap`
        + ' (Postgres remains source of truth)'
      );
      return false;
    }
    const payload = JSON.stringify(value);
    const bytes = Buffer.byteLength(payload, 'utf8');
    if (bytes > MAX_REDIS_VALUE_BYTES) {
      logger.warn(
        `Redis SET skipped for ${key}: ${bytes} bytes > ${MAX_REDIS_VALUE_BYTES} limit`
        + ' (Postgres remains source of truth)'
      );
      return false;
    }

    await redis.set(
      key,
      payload,
      'EX',
      ttlSeconds
    );

    return true;
  } catch (err) {
    if (isRedisQuotaError(err)) {
      markRedisQuotaExhausted(err);
    } else if (isTransientRedisError(err)) {
      logger.warn(`Redis SET skipped (reconnect) for ${key}: ${err.message}`);
    } else if (/max key size/i.test(err.message || '')) {
      logger.warn(`Redis SET skipped (key too large): ${err.message}`);
    } else {
      logger.warn(`Redis SET failed for ${key}: ${err.message}`);
    }
    return false;
  }
}

// ============================================
// Delete Keys
// ============================================

async function redisDel(...keys) {
  try {
    if (!redisOpsAllowed()) return false;
    if (!keys.length) return;

    await redis.del(...keys);

    return true;
  } catch (err) {
    if (isRedisQuotaError(err)) markRedisQuotaExhausted(err);
    else logger.warn(`Redis DEL failed: ${err.message}`);
    return false;
  }
}

/**
 * Delete keys matching a glob pattern via SCAN (capped).
 * Never walk the whole keyspace — that burned Upstash's 500k command budget.
 */
async function redisDelByPattern(pattern, { maxRounds = MAX_SCAN_ROUNDS } = {}) {
  if (!redisOpsAllowed() || !pattern) return 0;
  let cursor = '0';
  let deleted = 0;
  let rounds = 0;
  try {
    do {
      rounds += 1;
      if (rounds > maxRounds) {
        logger.warn(
          `Redis SCAN capped at ${maxRounds} rounds for ${pattern} (deleted=${deleted})`
        );
        break;
      }
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      if (keys?.length) {
        await redis.del(...keys);
        deleted += keys.length;
      }
    } while (cursor !== '0');
  } catch (err) {
    if (isRedisQuotaError(err)) markRedisQuotaExhausted(err);
    else logger.warn(`Redis SCAN/DEL failed for ${pattern}: ${err.message}`);
  }
  return deleted;
}

/**
 * Bump a per-tenant cache generation. Response caches include this in their key
 * so a sync can invalidate without SCANning the whole namespace.
 */
async function bumpCacheGeneration(tenantPrefix = '') {
  const key = `${tenantPrefix}cache:gen`;
  try {
    if (!redisOpsAllowed()) return Date.now();
    const n = await redis.incr(key);
    await redis.expire(key, 7 * 24 * 60 * 60);
    return Number(n) || Date.now();
  } catch (err) {
    if (isRedisQuotaError(err)) markRedisQuotaExhausted(err);
    return Date.now();
  }
}

async function getCacheGeneration(tenantPrefix = '') {
  const key = `${tenantPrefix}cache:gen`;
  try {
    if (!redisOpsAllowed()) return 0;
    const v = await redis.get(key);
    return parseInt(v, 10) || 0;
  } catch (err) {
    if (isRedisQuotaError(err)) markRedisQuotaExhausted(err);
    return 0;
  }
}

// ============================================
// Acquire Distributed Lock
// ============================================

async function acquireLock(key, ttlSeconds = 120) {
  try {
    if (!redisOpsAllowed()) return false;
    const result = await redis.set(
      `lock:${key}`,
      '1',
      'NX',
      'EX',
      ttlSeconds
    );

    return result === 'OK';
  } catch (err) {
    if (isRedisQuotaError(err)) markRedisQuotaExhausted(err);
    else logger.warn(`Redis lock acquire failed for ${key}: ${err.message}`);
    return false;
  }
}

// ============================================
// Release Distributed Lock
// ============================================

async function releaseLock(key) {
  try {
    if (!redisOpsAllowed()) return false;
    await redis.del(`lock:${key}`);
    return true;
  } catch (err) {
    if (isRedisQuotaError(err)) markRedisQuotaExhausted(err);
    else logger.warn(`Redis lock release failed for ${key}: ${err.message}`);
    return false;
  }
}

// ============================================
// TTL Constants
// ============================================

// Shorter response TTLs = less need for aggressive SCAN invalidation.
const TTL = {
  TODAY: 30 * 60,          // 30 min (present-day data)
  REPORT: 30 * 60,         // 30 min — Postgres is source of truth
  ORDERS: 60 * 60,         // 1 hour
  INVENTORY: 60 * 60,      // 1 hour
  COUNTRIES: 24 * 60 * 60, // 24 hours
  NETWORK: 24 * 60 * 60,   // 24 hours
};

// ============================================
// Export
// ============================================

module.exports = {
  redis,
  redisGet,
  redisSet,
  redisDel,
  redisDelByPattern,
  bumpCacheGeneration,
  getCacheGeneration,
  acquireLock,
  releaseLock,
  createBullmqConnection,
  isTransientRedisError,
  isRedisQuotaError,
  redisOpsAllowed,
  MAX_REDIS_VALUE_BYTES,
  MAX_REDIS_ARRAY_ITEMS,
  TTL,
};
