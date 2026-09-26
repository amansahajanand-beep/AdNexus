const { admobAccountStore } = require('../models/publisherAccountStore');
const { upsertAdMobDailyRows } = require('../models/publisherReportStore');
const { rebuildAdMobRollups } = require('../models/publisherRollupStore');
const { upsertAdMobDimRows } = require('../models/publisherDimStore');
const { fetchAdMobNetworkReport, fetchAdMobDimReport } = require('../admob/client');
const { todayInTZ, shiftYMD } = require('../utils/datetime');
const { addPublisherJob } = require('../queues/publisherSync');
const logger = require('../utils/logger');

// Mediation report dimension is FORMAT (Network used AD_TYPE).
// AD_SOURCE / AD_SOURCE_INSTANCE / MEDIATION_GROUP are mediation-only.
const ADMOB_SYNC_DIMS = [
  'APP',
  'FORMAT',
  'COUNTRY',
  'PLATFORM',
  'AD_UNIT',
  'AD_SOURCE',
  'AD_SOURCE_INSTANCE',
  'MEDIATION_GROUP',
];

function resolveWindow({ startDate, endDate, lookbackDays, timeZone } = {}) {
  const end = endDate || todayInTZ(timeZone || undefined);
  const lookback = lookbackDays
    || parseInt(process.env.ADMOB_SYNC_LOOKBACK_DAYS || '30', 10)
    || 30;
  const start = startDate || shiftYMD(end, -(lookback - 1));
  return { start, end };
}

function dimLookbackWindow(end) {
  const days = parseInt(process.env.ADMOB_DIM_SYNC_DAYS || '14', 10) || 14;
  return {
    start: shiftYMD(end, -(Math.max(1, days) - 1)),
    end,
  };
}

async function syncAdMobDims(account, gamClient, { startDate, endDate } = {}) {
  let total = 0;
  for (const dimension of ADMOB_SYNC_DIMS) {
    try {
      const rows = await fetchAdMobDimReport(gamClient, {
        accountId: account.accountId,
        refreshToken: account.refreshToken,
        startDate,
        endDate,
        currencyCode: account.currencyCode || 'USD',
        dimension,
      });
      total += await upsertAdMobDimRows(account.clientId, account.id, rows);
    } catch (e) {
      logger.warn(`[admob-sync] dim ${dimension} ${account.accountId}:`, e.message);
    }
  }
  return total;
}

async function syncAdMobAccount(account, { startDate, endDate, gamClient, lookbackDays, skipDims = false } = {}) {
  if (!account?.refreshToken || !account?.accountId) {
    throw new Error('AdMob account missing refresh token or account id');
  }
  const { start, end } = resolveWindow({
    startDate,
    endDate,
    lookbackDays,
    timeZone: account.reportingTimeZone,
  });
  try {
    // Keep reporting TZ fresh from Google when we can (non-fatal).
    if (!account.reportingTimeZone && account.refreshToken) {
      try {
        const { listAdMobAccounts } = require('../admob/client');
        const listed = await listAdMobAccounts(gamClient, account.refreshToken);
        const match = (listed || []).find((a) => a.accountId === account.accountId);
        if (match?.reportingTimeZone) {
          await admobAccountStore.updateAccount(account.id, {
            reportingTimeZone: match.reportingTimeZone,
            currencyCode: match.currencyCode || account.currencyCode,
          });
          account.reportingTimeZone = match.reportingTimeZone;
        }
      } catch {
        /* ignore */
      }
    }
    const rows = await fetchAdMobNetworkReport(gamClient, {
      accountId: account.accountId,
      refreshToken: account.refreshToken,
      startDate: start,
      endDate: end,
      currencyCode: account.currencyCode || 'USD',
    });
    const n = await upsertAdMobDailyRows(account.clientId, account.id, rows);
    await rebuildAdMobRollups(account.clientId, {
      accountId: account.id,
      startDate: start,
      endDate: end,
    });

    let dimRows = 0;
    if (!skipDims) {
      const dimWin = dimLookbackWindow(end);
      const dimStart = dimWin.start < start ? start : dimWin.start;
      dimRows = await syncAdMobDims(account, gamClient, { startDate: dimStart, endDate: end });
    }

    await admobAccountStore.setSyncStatus(account.id, { error: null });
    logger.info(`[admob-sync] ${account.accountId} ${start}→${end}: ${n} fact, ${dimRows} dim`);
    return { rows: n, dimRows, startDate: start, endDate: end };
  } catch (err) {
    const msg = String(err.message || err).slice(0, 400);
    await admobAccountStore.setSyncStatus(account.id, { error: msg });
    throw err;
  }
}

async function syncAdMobAccountToday(account, opts = {}) {
  const today = todayInTZ(account.reportingTimeZone || undefined);
  return syncAdMobAccount(account, {
    ...opts, startDate: today, endDate: today, lookbackDays: 1,
  });
}

async function syncAdMobAccountYesterday(account, opts = {}) {
  const tz = account.reportingTimeZone || undefined;
  const yesterday = shiftYMD(todayInTZ(tz), -1);
  return syncAdMobAccount(account, {
    ...opts,
    startDate: yesterday,
    endDate: yesterday,
    lookbackDays: 1,
  });
}

async function syncAllAdMobForClient(gamClient, opts = {}) {
  const accounts = await admobAccountStore.listSyncableAccounts(gamClient.id);
  const errors = [];
  let total = 0;
  for (const account of accounts) {
    try {
      const result = await syncAdMobAccount(account, { ...opts, gamClient });
      total += result.rows || result || 0;
    } catch (e) {
      logger.warn(`[admob-sync] ${account.accountId}:`, e.message);
      errors.push({ accountId: account.accountId, error: e.message });
    }
  }
  return { accounts: accounts.length, rows: total, errors };
}

async function enqueueAdMobSync(gamClient, queue, {
  startDate,
  endDate,
  jobIdPrefix = 'admob-sync',
  priority = 5,
  jobName = 'admob-sync-account',
} = {}) {
  if (!queue || queue.disabled) {
    const result = await syncAllAdMobForClient(gamClient, { startDate, endDate });
    return { accounts: result.accounts, jobs: 0, ranInline: true, errors: result.errors };
  }
  const accounts = await admobAccountStore.listSyncableAccounts(gamClient.id);
  let jobs = 0;
  let skipped = 0;
  const unique = /manual|connect/i.test(String(jobIdPrefix));
  for (const account of accounts) {
    const jobId = unique
      ? `${jobIdPrefix}-${account.id.slice(0, 8)}-${Date.now()}`
      : `${jobIdPrefix}-${account.id.slice(0, 8)}`;
    try {
      await addPublisherJob(
        queue,
        jobName,
        {
          clientId: gamClient.id,
          admobAccountId: account.id,
          startDate,
          endDate,
        },
        {
          jobId,
          priority,
        }
      );
      jobs += 1;
    } catch (e) {
      if (!/already exists|JobId/i.test(String(e.message || ''))) throw e;
      skipped += 1;
    }
  }
  return { accounts: accounts.length, jobs, skipped };
}

module.exports = {
  syncAdMobAccount,
  syncAdMobAccountToday,
  syncAdMobAccountYesterday,
  syncAllAdMobForClient,
  enqueueAdMobSync,
  resolveWindow,
};
