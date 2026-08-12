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

function isTransientRedisError(err) {
  const msg = String(err?.message || err || '');
  return /ECONNRESET|ECONNABORTED|ETIMEDOUT|EPIPE|READONLY|Connection is closed|Socket closed/i.test(msg);
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
      return Math.min(times * 200, 2000);
    },
    reconnectOnError(err) {
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

// ============================================
// Get JSON
// ============================================

async function redisGet(key) {
  try {
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
    if (isTransientRedisError(err)) {
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
    if (Buffer.byteLength(String(key || ''), 'utf8') > 30000) {
      logger.warn(`Redis SET skipped: key too large (${Buffer.byteLength(String(key), 'utf8')} bytes)`);
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
    if (isTransientRedisError(err)) {
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
    if (!keys.length) return;

    await redis.del(...keys);

    return true;
  } catch (err) {
    logger.warn(`Redis DEL failed: ${err.message}`);
    return false;
  }
}

/** Delete keys matching a glob pattern via SCAN (safe for production). */
async function redisDelByPattern(pattern) {
  if (redisDisabled || !pattern) return 0;
  let cursor = '0';
  let deleted = 0;
  try {
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      if (keys?.length) {
        await redis.del(...keys);
        deleted += keys.length;
      }
    } while (cursor !== '0');
  } catch (err) {
    logger.warn(`Redis SCAN/DEL failed for ${pattern}: ${err.message}`);
  }
  return deleted;
}

// ============================================
// Acquire Distributed Lock
// ============================================

async function acquireLock(key, ttlSeconds = 120) {
  try {
    const result = await redis.set(
      `lock:${key}`,
      '1',
      'NX',
      'EX',
      ttlSeconds
    );

    return result === 'OK';
  } catch (err) {
    logger.warn(`Redis lock acquire failed for ${key}: ${err.message}`);
    return false;
  }
}

// ============================================
// Release Distributed Lock
// ============================================

async function releaseLock(key) {
  try {
    await redis.del(`lock:${key}`);
    return true;
  } catch (err) {
    logger.warn(`Redis lock release failed for ${key}: ${err.message}`);
    return false;
  }
}

// ============================================
// TTL Constants
// ============================================

// REPORT TTL matches hourly cron so Redis stays warm between syncs,
// then gets cleared/refreshed after the next DB upsert.
const TTL = {
  TODAY: 60 * 60,          // 1 hour (present-day data)
  REPORT: 60 * 60,         // 1 hour — first API hit caches until next cron
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
  acquireLock,
  releaseLock,
  createBullmqConnection,
  isTransientRedisError,
  MAX_REDIS_VALUE_BYTES,
  TTL,
};
