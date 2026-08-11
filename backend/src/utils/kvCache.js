/**
 * Durable key/value JSON cache in Postgres.
 * Survives restarts when Redis is disabled — used for filter-catalog, etc.
 */
const { query } = require('../db');
const logger = require('./logger');
const { tenantKey } = require('./clientContext');

async function kvGet(key) {
  try {
    const { rows } = await query(
      `SELECT payload, updated_at
       FROM app_kv_cache
       WHERE cache_key = $1`,
      [tenantKey(key)]
    );
    if (!rows[0]) return null;
    return { payload: rows[0].payload, updatedAt: rows[0].updated_at };
  } catch (err) {
    logger.warn(`kvGet(${key}) failed:`, err.message);
    return null;
  }
}

async function kvSet(key, payload) {
  try {
    await query(
      `INSERT INTO app_kv_cache (cache_key, payload, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (cache_key)
       DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
      [tenantKey(key), JSON.stringify(payload)]
    );
    return true;
  } catch (err) {
    logger.warn(`kvSet(${key}) failed:`, err.message);
    return false;
  }
}

module.exports = { kvGet, kvSet };
