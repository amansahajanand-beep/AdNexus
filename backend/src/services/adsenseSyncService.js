const { adsenseAccountStore } = require('../models/publisherAccountStore');
const { upsertAdSenseDailyRows } = require('../models/publisherReportStore');
const { rebuildAdSenseRollups } = require('../models/publisherRollupStore');
const { upsertAdSenseDimRows } = require('../models/publisherDimStore');
const { fetchAdSenseReport, fetchAdSenseDimReport } = require('../adsense/client');
const { todayInTZ, shiftYMD } = require('../utils/datetime');
const { addPublisherJob } = require('../queues/publisherSync');
const logger = require('../utils/logger');

const ADSENSE_SYNC_DIMS = ['DOMAIN_NAME', 'COUNTRY_CODE', 'PLATFORM_TYPE_CODE', 'AD_UNIT_NAME'];

function resolveWindow({ startDate, endDate, lookbackDays } = {}) {
  const end = endDate || todayInTZ();
  const lookback = lookbackDays
    || parseInt(process.env.ADSENSE_SYNC_LOOKBACK_DAYS || '30', 10)
    || 30;
  const start = startDate || shiftYMD(end, -(lookback - 1));
  return { start, end };
}

function dimLookbackWindow(end) {
  const days = parseInt(process.env.ADSENSE_DIM_SYNC_DAYS || '14', 10) || 14;
  return {
    start: shiftYMD(end, -(Math.max(1, days) - 1)),
    end,
  };
}

async function syncAdSenseDims(account, gamClient, { startDate, endDate } = {}) {
  let total = 0;
  for (const dimension of ADSENSE_SYNC_DIMS) {
    try {
      const rows = await fetchAdSenseDimReport(gamClient, {
        accountId: account.accountId,
        refreshToken: account.refreshToken,
        startDate,
        endDate,
        dimension,
      });
      total += await upsertAdSenseDimRows(account.clientId, account.id, rows);
    } catch (e) {
      logger.warn(`[adsense-sync] dim ${dimension} ${account.accountId}:`, e.message);
    }
  }
  return total;
}

async function syncAdSenseAccount(account, { startDate, endDate, gamClient, lookbackDays, skipDims = false } = {}) {
  if (!account?.refreshToken || !account?.accountId) {
    throw new Error('AdSense account missing refresh token or account id');
  }
  const { start, end } = resolveWindow({ startDate, endDate, lookbackDays });
  try {
    const rows = await fetchAdSenseReport(gamClient, {
      accountId: account.accountId,
      refreshToken: account.refreshToken,
      startDate: start,
      endDate: end,
    });
    const n = await upsertAdSenseDailyRows(account.clientId, account.id, rows);
    await rebuildAdSenseRollups(account.clientId, {
      accountId: account.id,
      startDate: start,
      endDate: end,
    });

    let dimRows = 0;
    if (!skipDims) {
      const dimWin = dimLookbackWindow(end);
      const dimStart = dimWin.start < start ? start : dimWin.start;
      dimRows = await syncAdSenseDims(account, gamClient, { startDate: dimStart, endDate: end });
    }

    await adsenseAccountStore.setSyncStatus(account.id, { error: null });
    logger.info(`[adsense-sync] ${account.accountId} ${start}→${end}: ${n} fact, ${dimRows} dim`);
    return { rows: n, dimRows, startDate: start, endDate: end };
  } catch (err) {
    const msg = String(err.message || err).slice(0, 400);
    await adsenseAccountStore.setSyncStatus(account.id, { error: msg });
    throw err;
  }
}

async function syncAdSenseAccountToday(account, opts = {}) {
  const today = todayInTZ();
  return syncAdSenseAccount(account, {
    ...opts, startDate: today, endDate: today, lookbackDays: 1,
  });
}

async function syncAdSenseAccountYesterday(account, opts = {}) {
  const yesterday = shiftYMD(todayInTZ(), -1);
  return syncAdSenseAccount(account, {
    ...opts,
    startDate: yesterday,
    endDate: yesterday,
    lookbackDays: 1,
  });
}

async function syncAllAdSenseForClient(gamClient, opts = {}) {
  const accounts = await adsenseAccountStore.listSyncableAccounts(gamClient.id);
  const errors = [];
  let total = 0;
  for (const account of accounts) {
    try {
      const result = await syncAdSenseAccount(account, { ...opts, gamClient });
      total += result.rows || result || 0;
    } catch (e) {
      logger.warn(`[adsense-sync] ${account.accountId}:`, e.message);
      errors.push({ accountId: account.accountId, error: e.message });
    }
  }
  return { accounts: accounts.length, rows: total, errors };
}

async function enqueueAdSenseSync(gamClient, queue, {
  startDate,
  endDate,
  jobIdPrefix = 'adsense-sync',
  priority = 5,
  jobName = 'adsense-sync-account',
} = {}) {
  if (!queue || queue.disabled) {
    const result = await syncAllAdSenseForClient(gamClient, { startDate, endDate });
    return { accounts: result.accounts, jobs: 0, ranInline: true, errors: result.errors };
  }
  const accounts = await adsenseAccountStore.listSyncableAccounts(gamClient.id);
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
          adsenseAccountId: account.id,
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
  syncAdSenseAccount,
  syncAdSenseAccountToday,
  syncAdSenseAccountYesterday,
  syncAllAdSenseForClient,
  enqueueAdSenseSync,
  resolveWindow,
};
