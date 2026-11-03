const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getRoiSummary } = require('../services/roiService');
const { todayInTZ } = require('../utils/datetime');
const { resolveAdsAccountIdsForUser, getAllowedClientIds } = require('../utils/permissions');
const { mergeRoiParts, applyEarnOnly } = require('../services/roiMerge');
const { roiInventoryScope, limitKeys, appsOfAccounts } = require('../services/roiScope');
const logger = require('../utils/logger');

/**
 * Options for the networks other than the active one, for an admin: only the apps and sites the filters name (or the
 * Ads account's apps), with the Ads accounts switched off so a network adds revenue but never spend. A network with
 * nothing to look up is left out.
 */
async function adminOtherNetworkOpts(clientId, baseOpts, { requestedAccountIds, accountIds, start, end }) {
  if (!baseOpts.appKeys && !baseOpts.siteKeys && !requestedAccountIds.length) return [];
  const { listActiveClients } = require('../models/clientStore');
  const { NO_ADS_ACCOUNT_SCOPE_ID } = require('../utils/permissions');
  const others = (await listActiveClients()).filter((c) => String(c.id) !== String(clientId));
  if (!others.length) return [];
  let appKeys = baseOpts.appKeys;
  if (!appKeys && requestedAccountIds.length && accountIds?.length) {
    const own = await appsOfAccounts(accountIds, start, end).catch(() => null);
    appKeys = own && own.size ? [...own] : null;
  }
  if (!appKeys && !baseOpts.siteKeys) return [];
  return others.map((runtime) => ({
    runtime,
    opts: { ...baseOpts, appKeys, accountIds: [NO_ADS_ACCOUNT_SCOPE_ID], campaignIds: null },
  }));
}

router.use(requireAuth);

/** Units of each currency per 1 USD (latest rates), for the ROI page's display-currency switch. */
const FX_CODES = ['USD', 'INR', 'EUR', 'GBP', 'JPY', 'CNY', 'AUD', 'CAD', 'CHF', 'SGD', 'HKD', 'NZD', 'AED', 'SAR', 'QAR', 'KWD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON', 'TRY', 'RUB', 'UAH', 'ILS', 'ZAR', 'NGN', 'KES', 'EGP', 'MAD', 'BRL', 'MXN', 'ARS', 'CLP', 'COP', 'PEN', 'KRW', 'THB', 'VND', 'IDR', 'MYR', 'PHP', 'TWD', 'PKR', 'BDT', 'LKR', 'NPR'];
router.get('/fx-rates', async (req, res) => {
  try {
    const { getUnitsPerUsd } = require('../utils/adsCurrency');
    const rates = {};
    for (const c of FX_CODES) rates[c] = await getUnitsPerUsd(c);
    res.set('Cache-Control', 'private, max-age=3600');
    res.json({ base: 'USD', rates });
  } catch (err) {
    logger.error('ROI fx-rates:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/summary', async (req, res) => {
  try {
    // Always recompute — metrics (impressions/clicks/eCPM) change with Ads sync.
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');

    const clientId = req.client?.id || req.user.clientId;
    if (!clientId) return res.status(400).json({ error: 'No client context' });

    const end = req.query.end || todayInTZ();
    const start = req.query.start || end;
    const targetType = ['site', 'app', 'all'].includes(req.query.targetType)
      ? req.query.targetType
      : 'all';

    const parseCsv = (v) => String(v || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const requestedAccountIds = parseCsv(req.query.accountIds);
    const accountIds = resolveAdsAccountIdsForUser(req.user, requestedAccountIds);
    const campaignIds = parseCsv(req.query.campaignIds);
    const appKeys = parseCsv(req.query.appKeys);
    const siteKeys = parseCsv(req.query.siteKeys);
    const countryCodes = parseCsv(req.query.countryCodes);

    const includeRows = req.query.includeRows === '1' || req.query.includeRows === 'true';
    const summaryOnly = req.query.summaryOnly === '1' || req.query.summaryOnly === 'true';
    const breakdownOnly = req.query.breakdownOnly === '1' || req.query.breakdownOnly === 'true';
    const includeDaily = req.query.includeDaily === '0' || req.query.includeDaily === 'false'
      ? false
      : (req.query.includeDaily === '1' || req.query.includeDaily === 'true' ? true : null);

    // The zone the user is viewing (same header the Dashboard and Reporting send): earnings follow it.
    const viewTz = String(req.headers['x-report-tz'] || req.query.tz || '').trim() || null;
    const baseOpts = {
      viewTz,
      start,
      end,
      targetType,
      accountIds: accountIds && accountIds.length ? accountIds : null,
      campaignIds: campaignIds.length ? campaignIds : null,
      appKeys: appKeys.length ? appKeys : null,
      siteKeys: siteKeys.length ? siteKeys : null,
      countryCodes: countryCodes.length ? countryCodes : null,
      includeRows,
      summaryOnly,
      breakdownOnly,
      includeDaily,
    };
    // A domain user only ever sees their assigned sites and apps (assigned domains count for every site under them),
    // whatever the page asks for. Each network resolves the assignment against its own site list.
    const optsFor = async (id) => {
      const scope = await roiInventoryScope(req.user, id);
      if (!scope) return baseOpts;
      const host = (v) => String(v || '').trim().toLowerCase().replace(/^www\./, '');
      // Sites are listed when picked in the Subdomains filter. With no pick the assigned sites are the default, unless
      // the user narrowed the page to an account, campaign or app: then site earn would swamp that selection, so no
      // site rows ('__none__') are added.
      const narrowed = requestedAccountIds.length || campaignIds.length || appKeys.length;
      const siteKeysOut = !siteKeys.length && scope.apps.length && narrowed ? limitKeys([], [], host) : limitKeys(siteKeys, scope.sites, host);
      // An Ads account picked and no app picked: the user's apps are narrowed to that account's apps, so the cards
      // show the account's own spend and earn rather than every assigned app's.
      let scopeApps = scope.apps;
      if (!appKeys.length && requestedAccountIds.length && accountIds?.length && scopeApps.length) {
        const own = await appsOfAccounts(accountIds, start, end).catch(() => null);
        if (own) scopeApps = scopeApps.filter((a) => own.has(a));
      }
      return {
        ...baseOpts,
        siteKeys: siteKeysOut,
        appKeys: limitKeys(appKeys, scopeApps, (v) => String(v).trim().toLowerCase()),
      };
    };

    // A domain user with several networks sees them together (the Dashboard does the same): each network's ROI is
    // worked out on its own and the results are added up. An explicit network (X-Gam-Client-Id / ?clientId=) still
    // shows just that one.
    let data;
    const pinned = req.headers['x-gam-client-id'] || req.query.clientId;
    const networkIds = req.user.role === 'admin' || pinned ? [] : (getAllowedClientIds(req.user) || []);
    if (networkIds.length > 1) {
      const { getClientById } = require('../models/clientStore');
      const { runWithClient } = require('../utils/clientContext');
      const results = await Promise.allSettled(networkIds.map(async (id) => {
        const runtime = id === String(clientId) ? (req.client || await getClientById(id)) : await getClientById(id);
        if (!runtime) return null;
        // Some loaders read the active network from the request context, so each runs inside its own.
        // crossNetworkEarn: also report earn this network has no spend row for (merged in mergeRoiParts).
        const opts = { ...(await optsFor(id)), crossNetworkEarn: true };
        return runWithClient(runtime, () => getRoiSummary(id, opts));
      }));
      const parts = results.filter((r) => r.status === 'fulfilled').map((r) => r.value).filter(Boolean);
      if (!parts.length) {
        const failed = results.find((r) => r.status === 'rejected');
        throw failed ? failed.reason : new Error('No network data');
      }
      results.filter((r) => r.status === 'rejected').forEach((r) => logger.warn(`ROI network skipped: ${r.reason?.message}`));
      data = { ...mergeRoiParts(parts), networks: networkIds.length, networksLoaded: parts.length };
      const metas = parts.map((p) => p.earnTimezone).filter(Boolean);
      // One note for the combined view: the first network whose earnings could not follow the zone, else the zone.
      if (metas.length) data.earnTimezone = metas.find((m) => m.applied === false) || metas[0];
    } else {
      // An admin on one network also sees the revenue of apps and sites that live in another network: the ones picked
      // in the filters, plus the apps of a picked Ads account. The other networks add revenue only (no Ads spend).
      const extra = req.user.role === 'admin'
        ? await adminOtherNetworkOpts(clientId, baseOpts, { requestedAccountIds, accountIds, start, end })
        : [];
      if (extra.length) {
        const { runWithClient } = require('../utils/clientContext');
        const own = getRoiSummary(clientId, { ...baseOpts, crossNetworkEarn: true });
        const others = extra.map(({ runtime, opts }) => runWithClient(runtime, () => getRoiSummary(runtime.id, { ...opts, crossNetworkEarn: true })));
        const results = await Promise.allSettled([own, ...others]);
        if (results[0].status === 'rejected') throw results[0].reason;
        results.slice(1).filter((r) => r.status === 'rejected').forEach((r) => logger.warn(`ROI other network skipped: ${r.reason?.message}`));
        data = mergeRoiParts(results.filter((r) => r.status === 'fulfilled').map((r) => r.value).filter(Boolean));
        // A single remaining part is returned as is by the merge: fold its earn-only rows itself.
        applyEarnOnly(data);
      } else {
        data = await getRoiSummary(clientId, await optsFor(clientId));
      }
    }
    res.json({
      start,
      end,
      targetType,
      accountIds: accountIds && accountIds.length ? accountIds : null,
      campaignIds: campaignIds.length ? campaignIds : null,
      appKeys: appKeys.length ? appKeys : null,
      siteKeys: siteKeys.length ? siteKeys : null,
      countryCodes: countryCodes.length ? countryCodes : null,
      ...data,
    });
  } catch (err) {
    logger.error('ROI summary:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
