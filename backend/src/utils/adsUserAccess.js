/**
 * Grant / revoke Ads account IDs on a domain user's permissions.allowedAdsAccountIds.
 * Accounts remain client-scoped in ads_accounts; this only controls ROI visibility.
 */
const { getUserById, updateUser } = require('../models/userStore');
const { listAccounts } = require('../models/adsAccountStore');
const logger = require('./logger');

function normalizeIdList(ids) {
  return [...new Set((Array.isArray(ids) ? ids : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean))];
}

/**
 * Collect account IDs a domain user should unlock after connecting an MCC or client.
 * MCC → MCC id + all current child client ids under that MCC.
 */
async function collectGrantIds(clientId, rootAccount) {
  if (!rootAccount?.id) return [];
  const all = await listAccounts(clientId);
  const ids = [rootAccount.id];
  if (rootAccount.accountType === 'mcc') {
    all
      .filter((a) => a.parentMccId === rootAccount.id && a.accountType === 'client')
      .forEach((a) => ids.push(a.id));
  }
  return normalizeIdList(ids);
}

async function grantAdsAccountsToUser(userId, accountIds) {
  const ids = normalizeIdList(accountIds);
  if (!userId || !ids.length) return null;
  const user = await getUserById(userId);
  if (!user || user.role === 'admin') return null;

  const perms = { ...(user.permissions || {}) };
  const existing = Array.isArray(perms.allowedAdsAccountIds)
    ? normalizeIdList(perms.allowedAdsAccountIds)
    : [];
  const merged = normalizeIdList([...existing, ...ids]);
  perms.allowedAdsAccountIds = merged;
  const updated = await updateUser(userId, { permissions: perms });
  logger.info(`Granted ${ids.length} Ads account(s) to user ${userId} (total ${merged.length})`);
  return updated;
}

async function revokeAdsAccountsFromUser(userId, accountIds) {
  const remove = new Set(normalizeIdList(accountIds));
  if (!userId || !remove.size) return null;
  const user = await getUserById(userId);
  if (!user || user.role === 'admin') return null;

  const perms = { ...(user.permissions || {}) };
  const existing = Array.isArray(perms.allowedAdsAccountIds)
    ? normalizeIdList(perms.allowedAdsAccountIds)
    : [];
  perms.allowedAdsAccountIds = existing.filter((id) => !remove.has(id));
  const updated = await updateUser(userId, { permissions: perms });
  logger.info(`Revoked ${remove.size} Ads account(s) from user ${userId}`);
  return updated;
}

module.exports = {
  collectGrantIds,
  grantAdsAccountsToUser,
  revokeAdsAccountsFromUser,
  normalizeIdList,
};
