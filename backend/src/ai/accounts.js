/**
 * Server-side jobs act as a signed-in admin of each account, because the data endpoints only answer to a
 * signed-in user. This walks one such admin per account (most recently active first).
 */
const { query } = require('../db');
const { getUserById } = require('../models/userStore');
const { getAccountIdForClient } = require('../models/clientStore');
const { mintInternalToken } = require('../middleware/auth');
const { resolveAiAccess } = require('./flags');

const ACTIVE_WITHIN_DAYS = 14;

async function accountIdFor(user) {
  if (!user?.clientId) return null;
  return (await getAccountIdForClient(user.clientId)) || user.clientId;
}

/**
 * Call fn({ user, accountId, authorization }) once per account whose admin is signed in and has AI on.
 * @returns {Promise<{accounts: number, skipped: number}>}
 */
async function forEachAccountAdmin(fn) {
  const { rows } = await query(
    `SELECT id FROM users
     WHERE role = 'admin' AND is_active = true AND active_session_id IS NOT NULL
       AND last_login > now() - ($1 || ' days')::interval
     ORDER BY last_login DESC`,
    [String(ACTIVE_WITHIN_DAYS)]
  );
  const done = new Set();
  const stats = { accounts: 0, skipped: 0 };
  for (const row of rows) {
    const user = await getUserById(row.id).catch(() => null);
    if (!user) continue;
    const accountId = await accountIdFor(user);
    if (!accountId || done.has(accountId)) continue;
    done.add(accountId);
    const access = await resolveAiAccess(user);
    const token = mintInternalToken(user);
    if (!access.enabled || !token) { stats.skipped += 1; continue; }
    await fn({ user, accountId, authorization: `Bearer ${token}` });
    stats.accounts += 1;
  }
  return stats;
}

module.exports = { forEachAccountAdmin, accountIdFor };
