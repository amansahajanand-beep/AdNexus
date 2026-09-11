const logger = require('../utils/logger');
const { fetchCampaignSpend, fetchCampaignSpendByCountry, fetchCampaignAppIds } = require('../ads/client');
const {
  listSyncableClientAccounts,
  getAccountById,
  getAccountByCustomerId,
  setSyncStatus,
  upsertSpendRows,
  upsertCountrySpendRows,
  applyCampaignAppIds,
  updateAccount,
} = require('../models/adsAccountStore');
const { todayInTZ, shiftYMD } = require('../utils/datetime');
const { getClient } = require('../utils/clientContext');
const { normalizeCurrency } = require('../utils/adsCurrency');
const {
  parseAdsRateLimitRetrySec,
  isAdsRateLimitError,
  beginAdsRateLimit,
  isAdsRateLimited,
} = require('./adsRateLimitGate');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function adsAccountDelayMs() {
  return Math.max(0, parseInt(process.env.ADS_SYNC_ACCOUNT_DELAY_MS || '500', 10) || 500);
}

function adsTodayAccountBatch() {
  return Math.max(5, parseInt(process.env.ADS_SYNC_ACCOUNT_BATCH || '40', 10) || 40);
}

function formatAdsSyncError(err) {
  if (!err) return 'Unknown Ads sync error';
  if (typeof err === 'string') return err.slice(0, 500);

  const first = err.errors?.[0];
  const authCode = first?.error_code?.authorization_error;
  const msg = first?.message || err.details || err.message;

  if (
    /only approved for use with test accounts|Basic or Standard access/i.test(String(msg || ''))
    || authCode === 10
    || authCode === 'DEVELOPER_TOKEN_NOT_APPROVED'
  ) {
    return 'Developer token is Test-only. Apply for Basic/Standard access in Google Ads → API Center, then Sync again.';
  }
  if (
    /not allowed with project|DEVELOPER_TOKEN_PROHIBITED/i.test(String(msg || ''))
    || authCode === 9
    || authCode === 'DEVELOPER_TOKEN_PROHIBITED'
  ) {
    return 'Developer token and OAuth Cloud project are mismatched. Google pairs one token to one Cloud project forever — use the original token for this project, or create a new Cloud project + OAuth client and update GOOGLE_ADS_CLIENT_ID/SECRET in .env.';
  }
  if (
    /SERVICE_DISABLED|has not been used in project|googleads\.googleapis\.com/i.test(String(msg || ''))
    || err.reason === 'SERVICE_DISABLED'
  ) {
    const projectMatch = String(msg || '').match(/project\s+(\d{6,})/i);
    const project = projectMatch?.[1] || 'your Cloud project';
    return `Google Ads API is disabled on Cloud project ${project}. Enable it at https://console.developers.google.com/apis/api/googleads.googleapis.com/overview?project=${projectMatch?.[1] || ''} then wait a few minutes and retry.`;
  }
  if (msg === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' || err.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') {
    return 'Google Ads OAuth scope missing. Use Connect MCC / Connect Google in Admin (do not paste a GAM-only refresh token).';
  }
  if (typeof msg === 'string' && msg.trim()) return msg.slice(0, 500);
  if (err.reason) return String(err.reason).slice(0, 500);
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

  const accountCurrency = normalizeCurrency(rows[0]?.accountCurrency || adsAccount.currencyCode || 'USD');
  if (accountCurrency && accountCurrency !== adsAccount.currencyCode) {
    try {
      await updateAccount(adsAccount.id, { currencyCode: accountCurrency });
    } catch (e) {
      logger.warn(`Could not save currency_code for ${adsAccount.customerId}: ${e.message}`);
    }
  }

  const n = await upsertSpendRows(client.id, adsAccount.id, rows);

  let campaignApps = [];
  try {
    campaignApps = await fetchCampaignAppIds(client, {
      customerId: adsAccount.customerId,
      refreshToken,
      loginCustomerId: adsAccount.loginCustomerId,
    });
  } catch (e) {
    logger.warn(`Ads app_id fetch failed for ${adsAccount.customerId}: ${e.message}`);
  }

  try {
    const countryRows = await fetchCampaignSpendByCountry(client, {
      customerId: adsAccount.customerId,
      refreshToken,
      loginCustomerId: adsAccount.loginCustomerId,
      startDate: start,
      endDate: end,
      campaignAppIds: campaignApps,
    });
    const countryRowsWritten = await upsertCountrySpendRows(client.id, adsAccount.id, countryRows);
    if (countryRowsWritten) {
      logger.info(
        `Ads country sync account=${adsAccount.customerId} ${start}→${end} wrote ${countryRowsWritten} row(s)`
      );
    }
  } catch (e) {
    logger.warn(`Ads country spend fetch failed for ${adsAccount.customerId}: ${e.message}`);
  }

  // Ensure app_id is filled even when the metrics query omitted it for some rows.
  try {
    if (campaignApps.length) {
      const updated = await applyCampaignAppIds(client.id, adsAccount.id, campaignApps);
      if (updated) {
        logger.info(`Ads app_id backfill account=${adsAccount.customerId} updated ${updated} spend row(s)`);
      }
    }
  } catch (e) {
    logger.warn(`Ads app_id backfill failed for ${adsAccount.customerId}: ${e.message}`);
  }

  await setSyncStatus(adsAccount.id, { error: null });
  const sampleNative = rows.find((r) => Number(r.costNative) > 0);
  if (sampleNative && sampleNative.nativeCurrency && sampleNative.nativeCurrency !== 'USD') {
    logger.info(
      `Ads FX account=${adsAccount.customerId} ${sampleNative.nativeCurrency}→USD `
      + `(example native=${sampleNative.costNative} → usd=${sampleNative.cost})`
    );
  }
  logger.info(
    `Ads sync account=${adsAccount.customerId} ${start}→${end} wrote ${n} row(s) currency=${accountCurrency}`
  );
  return n;
}

function adsSyncRoiOnly() {
  const raw = String(process.env.ADS_SYNC_ROI_ONLY || 'true').trim().toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'no';
}

async function syncAllAccountsForClient(gamClient, {
  startDate,
  endDate,
  roiOnly = adsSyncRoiOnly(),
  maxAccounts = null,
  preferStale = false,
  staleMinutes = null,
} = {}) {
  if (await isAdsRateLimited()) {
    const { getAdsRateLimitState } = require('./adsRateLimitGate');
    const state = await getAdsRateLimitState();
    logger.warn(
      `Ads sync skipped (rate-limited) client=${gamClient.id.slice(0, 8)} `
      + `remaining≈${Math.round((state.remainingMs || 0) / 60000)}m`
    );
    return {
      total: 0,
      accounts: 0,
      errors: [{ error: 'rate_limited' }],
      rateLimited: true,
    };
  }

  const limit = maxAccounts != null && maxAccounts > 0
    ? maxAccounts
    : null;
  const staleBefore = preferStale && staleMinutes != null && staleMinutes > 0
    ? new Date(Date.now() - staleMinutes * 60 * 1000)
    : null;

  const accounts = await listSyncableClientAccounts(gamClient.id, {
    roiOnly,
    staleBefore,
    limit,
    orderByStale: Boolean(preferStale || limit),
  });
  let total = 0;
  const errors = [];
  // Warm FX once for the whole client batch (avoid per-account live FX HTTP spam).
  try {
    const { refreshFxRates } = require('../utils/adsCurrency');
    await refreshFxRates();
  } catch (_) { /* ignore */ }

  const delayMs = adsAccountDelayMs();
  for (let i = 0; i < accounts.length; i += 1) {
    if (await isAdsRateLimited()) {
      logger.warn(
        `Ads sync abort mid-batch (rate-limited) client=${gamClient.id.slice(0, 8)} `
        + `done=${i}/${accounts.length}`
      );
      return {
        total,
        accounts: accounts.length,
        errors,
        rateLimited: true,
        abortedAt: i,
      };
    }
    const acc = accounts[i];
    try {
      total += await syncAccountSpend(acc, { startDate, endDate, gamClient });
    } catch (e) {
      const message = formatAdsSyncError(e);
      logger.error(`Ads sync failed for ${acc.customerId}:`, message);
      await setSyncStatus(acc.id, { error: message });
      errors.push({ accountId: acc.id, customerId: acc.customerId, error: message });

      const retrySec = parseAdsRateLimitRetrySec(e) || parseAdsRateLimitRetrySec(message);
      if (retrySec != null || isAdsRateLimitError(message)) {
        await beginAdsRateLimit(retrySec || 15 * 60, {
          reason: `account=${acc.customerId}`,
        });
        logger.warn(
          `Ads sync abort — Google quota hit after ${i + 1}/${accounts.length} accounts; `
          + `pausing remaining syncs`
        );
        return {
          total,
          accounts: accounts.length,
          errors,
          rateLimited: true,
          abortedAt: i + 1,
        };
      }
    }
    if (delayMs > 0 && i < accounts.length - 1) {
      await sleep(delayMs);
    }
  }
  return { total, accounts: accounts.length, errors };
}

/**
 * Enqueue Ads sync — one BullMQ job per GAM client (GAM-lean style).
 * Avoids N× Redis commands from per-account Queue.add fan-out.
 * Set fanOutAccounts=true only for debugging a single bad account path.
 */
async function enqueueAdsSyncAccounts(gamClient, adsSyncQueue, {
  startDate,
  endDate,
  jobName = 'ads-sync-client',
  jobIdPrefix = null,
  priority = 3,
  fanOutAccounts = false,
  roiOnly = adsSyncRoiOnly(),
  skipIfTodayPriority = false,
  maxAccounts = null,
  preferStale = false,
  staleMinutes = null,
} = {}) {
  if (!gamClient?.id || !adsSyncQueue) {
    throw new Error('enqueueAdsSyncAccounts requires client and adsSyncQueue');
  }

  if (await isAdsRateLimited()) {
    const { getAdsRateLimitState } = require('./adsRateLimitGate');
    const state = await getAdsRateLimitState();
    logger.warn(
      `Ads sync enqueue skipped (rate-limited) client=${gamClient.id.slice(0, 8)} `
      + `remaining≈${Math.round((state.remainingMs || 0) / 60000)}m`
    );
    return {
      accounts: 0,
      jobs: 0,
      skipped: true,
      rateLimited: true,
      start: startDate,
      end: endDate,
    };
  }

  if (skipIfTodayPriority) {
    try {
      const { isTodayPriorityActive } = require('./syncPriorityGate');
      if (await isTodayPriorityActive()) {
        logger.info(
          `Ads sync enqueue skipped (today-priority) client=${gamClient.id.slice(0, 8)}`
        );
        return { accounts: 0, jobs: 0, skipped: true, start: startDate, end: endDate };
      }
    } catch (_) { /* gate optional */ }
  }

  const accounts = await listSyncableClientAccounts(gamClient.id, { roiOnly });
  const end = endDate || todayInTZ();
  const lookback = parseInt(process.env.GOOGLE_ADS_SYNC_LOOKBACK_DAYS || '30', 10) || 30;
  const start = startDate || shiftYMD(end, -(lookback - 1));
  const prefix = jobIdPrefix || `ads-sync-${gamClient.id.slice(0, 8)}-${end}`;

  if (!accounts.length) {
    logger.info(`Ads sync: no syncable accounts client=${gamClient.id.slice(0, 8)} roiOnly=${roiOnly}`);
    return { accounts: 0, jobs: 0, start, end };
  }

  if (fanOutAccounts) {
    let queued = 0;
    const bulk = accounts.map((acc) => ({
      name: 'ads-sync-account',
      data: {
        clientId: gamClient.id,
        adsAccountId: acc.id,
        startDate: start,
        endDate: end,
      },
      opts: {
        jobId: `${prefix}-${acc.id.slice(0, 8)}`,
        priority,
        attempts: 2,
        backoff: { type: 'exponential', delay: 30000 },
        removeOnComplete: { count: 20 },
        removeOnFail: { count: 30 },
      },
    }));
    if (typeof adsSyncQueue.addBulk === 'function') {
      await adsSyncQueue.addBulk(bulk);
      queued = bulk.length;
    } else {
      for (const item of bulk) {
        await adsSyncQueue.add(item.name, item.data, item.opts);
        queued += 1;
      }
    }
    logger.info(
      `Ads sync enqueued ${queued} account job(s) client=${gamClient.id.slice(0, 8)} ${start}→${end}`
    );
    return { accounts: queued, jobs: queued, start, end };
  }

  // One job per client — syncs all ROI accounts inside the worker.
  await adsSyncQueue.add(
    jobName,
    {
      clientId: gamClient.id,
      startDate: start,
      endDate: end,
      roiOnly,
      maxAccounts,
      preferStale,
      staleMinutes,
    },
    {
      jobId: prefix,
      priority,
      attempts: 2,
      backoff: { type: 'exponential', delay: 30000 },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 30 },
    }
  );
  logger.info(
    `Ads sync enqueued 1 client job (${accounts.length} account(s)`
    + `${maxAccounts ? `, batch≤${maxAccounts}` : ''}) `
    + `client=${gamClient.id.slice(0, 8)} ${start}→${end}`
  );
  return { accounts: accounts.length, jobs: 1, start, end };
}

/** Fetch App Campaign package IDs from Google Ads and stamp onto spend rows. */
async function backfillAccountAppIds(adsAccount, { gamClient } = {}) {
  const client = gamClient || getClient();
  if (!client?.id) throw new Error('No GAM client context');
  const refreshToken = await resolveRefreshForAccount(adsAccount);
  if (!refreshToken) throw new Error(`No refresh token for Ads account ${adsAccount.customerId}`);
  const campaignApps = await fetchCampaignAppIds(client, {
    customerId: adsAccount.customerId,
    refreshToken,
    loginCustomerId: adsAccount.loginCustomerId,
  });
  const updated = await applyCampaignAppIds(client.id, adsAccount.id, campaignApps);
  return { apps: campaignApps, updated };
}

module.exports = {
  syncAccountSpend,
  syncAllAccountsForClient,
  enqueueAdsSyncAccounts,
  backfillAccountAppIds,
  resolveRefreshForAccount,
  formatAdsSyncError,
  adsSyncRoiOnly,
  adsTodayAccountBatch,
};
