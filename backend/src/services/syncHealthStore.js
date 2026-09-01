/**
 * Cron / sync health persisted in app_kv_cache (tenant-scoped via key prefix).
 */
const { query } = require('../db');
const logger = require('../utils/logger');

function tenantPrefix() {
  try {
    const { tenantKey } = require('../utils/clientContext');
    return tenantKey('sync_health:');
  } catch (_) {
    return 'sync_health:';
  }
}

async function setHealth(field, value) {
  const key = `${tenantPrefix()}${field}`;
  try {
    await query(
      `INSERT INTO app_kv_cache (cache_key, payload, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (cache_key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
      [key, JSON.stringify({ value, at: new Date().toISOString() })]
    );
  } catch (e) {
    logger.warn(`syncHealth set ${field}:`, e.message);
  }
}

async function getHealth(field) {
  const key = `${tenantPrefix()}${field}`;
  try {
    const { rows } = await query(
      `SELECT payload FROM app_kv_cache WHERE cache_key = $1`,
      [key]
    );
    return rows[0]?.payload?.value ?? null;
  } catch (_) {
    return null;
  }
}

async function recordCronEnqueue(reason) {
  await setHealth('lastCronEnqueueAt', { reason, ts: new Date().toISOString() });
}

async function getSyncHealthPublic() {
  const lastCronEnqueueAt = await getHealth('lastCronEnqueueAt');
  const queueEnabled = process.env.REDIS_DISABLED !== 'true'
    && process.env.SYNC_DISABLED !== 'true'
    && Boolean(process.env.REDIS_URL);
  return {
    lastCronEnqueueAt: lastCronEnqueueAt?.ts || null,
    lastCronReason: lastCronEnqueueAt?.reason || null,
    queueEnabled,
  };
}

module.exports = {
  setHealth,
  getHealth,
  recordCronEnqueue,
  getSyncHealthPublic,
};
