/**
 * Feature flag: AI is on only when the server switch is on, credentials exist,
 * and the user's account has not been turned off. The account setting lives on
 * gam_clients.ai_enabled and applies to every network under one account.
 */
const NodeCache = require('node-cache');
const { query } = require('../db');
const { globalEnabled, defaultEnabledForClients, hasCredentials } = require('./config');
const logger = require('../utils/logger');

const cache = new NodeCache({ stdTTL: 60, checkperiod: 120, useClones: false });

async function readClientSetting(clientId) {
  const key = `c:${clientId}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let value = null;
  try {
    const { rows } = await query(
      `SELECT COALESCE(ai_enabled, (SELECT p.ai_enabled FROM gam_clients p WHERE p.id = c.account_id)) AS ai_enabled
       FROM gam_clients c WHERE c.id::text = $1`,
      [String(clientId)]
    );
    value = rows[0]?.ai_enabled ?? null;
  } catch (err) {
    logger.warn(`ai flag lookup failed: ${err.message}`);
  }
  cache.set(key, value);
  return value;
}

/** { enabled, reason } — reason is set only when disabled, for the admin UI. */
async function resolveAiAccess(user) {
  if (!globalEnabled()) return { enabled: false, reason: 'server_off' };
  if (!hasCredentials()) return { enabled: false, reason: 'no_credentials' };
  // Domain (non-admin) users do not get AI features unless AI_ADMIN_ONLY=false.
  if (process.env.AI_ADMIN_ONLY !== 'false' && user?.role !== 'admin') return { enabled: false, reason: 'admin_only' };
  if (!user?.clientId) return { enabled: defaultEnabledForClients(), reason: defaultEnabledForClients() ? null : 'account_off' };
  const setting = await readClientSetting(user.clientId);
  const enabled = setting == null ? defaultEnabledForClients() : Boolean(setting);
  return { enabled, reason: enabled ? null : 'account_off' };
}

/** Turn AI on/off for the account that owns `clientId` (all of its networks). */
async function setAccountAiEnabled(clientId, enabled) {
  await query(
    `UPDATE gam_clients SET ai_enabled = $2
     WHERE id::text = $1
        OR account_id = (SELECT account_id FROM gam_clients WHERE id::text = $1 AND account_id IS NOT NULL)`,
    [String(clientId), Boolean(enabled)]
  );
  cache.flushAll();
}

/** The account's own setting: true, false, or null when it follows the server default. */
async function getAccountSetting(clientId) {
  return clientId ? readClientSetting(clientId) : null;
}

module.exports = { resolveAiAccess, setAccountAiEnabled, getAccountSetting };
