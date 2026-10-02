/**
 * Result cache for AI output. Entries are keyed by a hash of the inputs plus a data
 * version, so a new data sync produces a new key and old results age out on their own.
 * Concurrent requests for the same key share one computation.
 */
const crypto = require('crypto');
const NodeCache = require('node-cache');
const { redisGet, redisSet } = require('../redisClient');
const { singleflight } = require('../utils/singleflight');
const { logUsage } = require('./telemetry');

const local = new NodeCache({ stdTTL: 600, checkperiod: 120, maxKeys: 500, useClones: false });

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, k) => {
      if (value[k] !== undefined) acc[k] = canonical(value[k]);
      return acc;
    }, {});
  }
  return value;
}

/** Same inputs in any key order give the same key. */
function stableKey(prefix, parts) {
  const hash = crypto.createHash('sha256').update(JSON.stringify(canonical(parts))).digest('hex').slice(0, 32);
  return `ai:${prefix}:${hash}`;
}

/**
 * Return a cached value or compute and store it.
 * `compute` must return JSON-serializable data. Pass `force` to skip the read (Regenerate).
 * Resolves to { value, cached }.
 */
async function getOrCompute({ key, ttlSec = 3600, feature, ctx = {}, compute, force = false }) {
  if (!force) {
    let hit = local.get(key);
    if (hit === undefined) {
      hit = await redisGet(key);
      if (hit != null) local.set(key, hit, Math.min(ttlSec, 600));
    }
    if (hit != null) {
      logUsage({ userId: ctx.userId, clientId: ctx.clientId, feature, status: 'cache_hit' });
      return { value: hit, cached: true };
    }
  }
  const value = await singleflight(`${key}:${force ? 'f' : 'r'}`, compute);
  local.set(key, value, Math.min(ttlSec, 600));
  await redisSet(key, value, ttlSec);
  return { value, cached: false };
}

/** Read a stored value without computing anything. */
async function cacheGet(key) {
  const hit = local.get(key);
  if (hit !== undefined) return hit;
  const remote = await redisGet(key);
  if (remote != null) local.set(key, remote, 120);
  return remote ?? null;
}

async function cacheSet(key, value, ttlSec = 120) {
  local.set(key, value, Math.min(ttlSec, 600));
  await redisSet(key, value, ttlSec);
}

module.exports = { stableKey, getOrCompute, cacheGet, cacheSet };
