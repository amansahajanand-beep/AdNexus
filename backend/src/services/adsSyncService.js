const logger = require('../utils/logger');
const { fetchCampaignSpend } = require('../adsClient');
const {
  listSyncableClientAccounts,
  getAccountById,
  getAccountByCustomerId,
  setSyncStatus,
  upsertSpendRows,
} = require('../models/adsAccountStore');
const { todayInTZ, shiftYMD } = require('../utils/datetime');
const { getClient } = require('../utils/clientContext');

function formatAdsSyncError(err) {
  if (!err) return 'Unknown Ads sync error';
  if (typeof err === 'string') return err.slice(0, 500);
  const reason = err.reason || err.errors?.[0]?.error_code?.authorization_error
    || err.errors?.[0]?.message
    || err.message;
  if (reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') {
    return 'Google Ads OAuth scope missing. Use Connect MCC / Connect Google in Admin (do not paste a GAM-only refresh token).';
  }
  if (reason) return String(reason).slice(0, 500);
  try {
    return JSON.stringify(err).slice(0, 500);
  } catch {
    return 'Ads sync failed';
  }
}

async function resolveRefreshForAccount(account) {
  const loginId = String(account.loginCustomerId || '').replace(/\D/g, '');
  const custId = String(account.customerId || '').replace(/\D/g, '');
  // Client under MCC: use the MCC refresh token + login_customer_id header.
  if (loginId && loginId !== custId && account.clientId) {
    const loginMcc = await getAccountByCustomerId(account.clientId, loginId);
    if (loginMcc?.refreshToken) return loginMcc.refreshToken;
  }
  if (account.refreshToken) return account.refreshToken;
  if (account.parentMccId) {
    const mcc = await getAccountById(account.parentMccId);
    return mcc?.refreshToken || null;
  }
  return null;
}

async function syncAccountSpend(adsAccount, { startDate, endDate, gamClient } = {}) {
  const client = gamClient || getClient();
  if (!client?.id) throw new Error('No GAM client context');
  const refreshToken = await resolveRefreshForAccount(adsAccount);
  if (!refreshToken) throw new Error(`No refresh token for Ads account ${adsAccount.customerId}`);

  const start = startDate || shiftYMD(todayInTZ(), -(parseInt(process.env.GOOGLE_ADS_SYNC_LOOKBACK_DAYS || '30', 10) || 30));
  const end = endDate || todayInTZ();

  const rows = await fetchCampaignSpend(client, {
    customerId: adsAccount.customerId,
    refreshToken,
    loginCustomerId: adsAccount.loginCustomerId,
    startDate: start,
    endDate: end,
  });

  const n = await upsertSpendRows(client.id, adsAccount.id, rows);
  await setSyncStatus(adsAccount.id, { error: null });
  logger.info(
    `Ads sync account=${adsAccount.customerId} ${start}→${end} wrote ${n} row(s)`
  );
  return n;
}

async function syncAllAccountsForClient(gamClient, { startDate, endDate } = {}) {
  const accounts = await listSyncableClientAccounts(gamClient.id);
  let total = 0;
  const errors = [];
  for (const acc of accounts) {
    try {
      total += await syncAccountSpend(acc, { startDate, endDate, gamClient });
    } catch (e) {
      const message = formatAdsSyncError(e);
      logger.error(`Ads sync failed for ${acc.customerId}:`, message);
      await setSyncStatus(acc.id, { error: message });
      errors.push({ accountId: acc.id, customerId: acc.customerId, error: message });
    }
  }
  return { total, accounts: accounts.length, errors };
}

module.exports = {
  syncAccountSpend,
  syncAllAccountsForClient,
  resolveRefreshForAccount,
  formatAdsSyncError,
};
