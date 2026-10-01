const { sumAdMobRange, trendAdMob } = require('../models/publisherReportStore');
const { sumAdMobRollup, trendAdMobRollup } = require('../models/publisherRollupStore');
const {
  listAdMobFilterOptions,
  breakdownAdMob,
  tableAdMob,
  sumAdMobFiltered,
  trendAdMobFiltered,
} = require('../models/publisherDimStore');
const {
  isAdMobOAuthConfigured,
  resolveAdMobOAuthApp,
  admobRedirectUri,
} = require('../admob/client');
const { buildAdMobAuthUrl, commitAdMobSelection } = require('./authAdmob');
const {
  syncAllAdMobForClient,
  syncAdMobAccount,
  enqueueAdMobSync,
} = require('../services/admobSyncService');
const { admobSyncQueue } = require('../queues/publisherSync');
const {
  getAdMobRoi,
  listAdsAccountsForAdMob,
  setLinkedAdsAccountIds,
} = require('../services/admobRoiService');
const logger = require('../utils/logger');
const { admobAccountStore } = require('../models/publisherAccountStore');
const {
  scopedTotals,
  scopedTrend,
  scopedBreakdown,
  scopedFilterOptions,
  grainScopeCatalog,
} = require('../models/admobGrainStore');
const { ADMOB_SCOPE_FILTERS, getAdmobScope, hasAdmobAccess } = require('../utils/permissions');
const { createPublisherApiRouter, sparkFromTrend, pctChange } = require('./publisherApiFactory');

function buildAdMobKpis(curr, prev, trend) {
  const earnings = Number(curr.earnings) || 0;
  const impressions = Number(curr.impressions) || 0;
  const clicks = Number(curr.clicks) || 0;
  const adRequests = Number(curr.ad_requests) || 0;
  const matched = Number(curr.matched_requests) || 0;
  const ctr = curr.ctr != null ? Number(curr.ctr) : (impressions ? (clicks / impressions) * 100 : 0);
  const ecpm = curr.ecpm != null ? Number(curr.ecpm) : (impressions ? (earnings / impressions) * 1000 : 0);
  const matchRate = curr.match_rate != null
    ? Number(curr.match_rate)
    : (adRequests ? (matched / adRequests) * 100 : 0);

  const prevEarn = Number(prev.earnings) || 0;
  const prevImp = Number(prev.impressions) || 0;
  const prevClk = Number(prev.clicks) || 0;
  const prevReq = Number(prev.ad_requests) || 0;
  const prevMatched = Number(prev.matched_requests) || 0;
  const prevCtr = prev.ctr != null ? Number(prev.ctr) : (prevImp ? (prevClk / prevImp) * 100 : 0);
  const prevEcpm = prev.ecpm != null ? Number(prev.ecpm) : (prevImp ? (prevEarn / prevImp) * 1000 : 0);
  const prevMatch = prev.match_rate != null
    ? Number(prev.match_rate)
    : (prevReq ? (prevMatched / prevReq) * 100 : 0);

  return [
    { key: 'earnings', label: 'Estimated earnings', value: earnings, format: 'money', change: pctChange(earnings, prevEarn), spark: sparkFromTrend(trend, 'earnings') },
    { key: 'impressions', label: 'Impressions', value: impressions, format: 'number', change: pctChange(impressions, prevImp), spark: sparkFromTrend(trend, 'impressions') },
    { key: 'clicks', label: 'Clicks', value: clicks, format: 'number', change: pctChange(clicks, prevClk), spark: sparkFromTrend(trend, 'clicks') },
    { key: 'ctr', label: 'CTR', value: ctr, format: 'percent', change: pctChange(ctr, prevCtr), spark: sparkFromTrend(trend, 'ctr') },
    { key: 'ecpm', label: 'eCPM', value: ecpm, format: 'money', change: pctChange(ecpm, prevEcpm), spark: sparkFromTrend(trend, 'ecpm') },
    { key: 'matchRate', label: 'Match rate', value: matchRate, format: 'percent', change: pctChange(matchRate, prevMatch), spark: sparkFromTrend(trend, 'match_rate') },
  ];
}

/** ROI page: AdMob earnings vs spend from the Google Ads accounts linked to each publisher. */
function addAdMobRoiRoutes(router, { resolveAccountContext, resolveRange, parseCsvList, store }) {
  router.get('/roi', async (req, res) => {
    try {
      const ctx = await resolveAccountContext(req);
      if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
      const { start, end } = resolveRange(req);
      const account = ctx.storeAccountId ? await store.getAccountById(ctx.storeAccountId) : null;
      const apps = parseCsvList(req.query.apps);
      const adsAccountIds = parseCsvList(req.query.adsAccountIds);
      const data = await getAdMobRoi(req.client, {
        clientId: ctx.clientId,
        account,
        start,
        end,
        apps: apps.length ? apps : null,
        adsAccountIds: adsAccountIds.length ? adsAccountIds : null,
      });
      res.set('Cache-Control', 'no-store');
      res.json({ account: ctx.active, ...data });
    } catch (err) {
      logger.error('admob roi:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /** Admin → Users: publishers + their apps / ad units for domain-user AdMob scope. */
  router.get('/scope-catalog', async (req, res) => {
    try {
      const accounts = await store.listAccounts(req.client.id);
      const catalog = await grainScopeCatalog(req.client.id, accounts.map((a) => a.id));
      res.set('Cache-Control', 'no-store');
      res.json({
        accounts: accounts.map((a) => ({
          id: a.id,
          publisherId: a.accountId,
          name: a.descriptiveName || a.accountId,
          currencyCode: a.currencyCode,
        })),
        ...catalog,
        filters: ADMOB_SCOPE_FILTERS,
      });
    } catch (err) {
      logger.error('admob scope-catalog:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/roi/ads-accounts', async (req, res) => {
    try {
      const ctx = await resolveAccountContext(req);
      if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
      const { start, end } = resolveRange(req);
      const data = await listAdsAccountsForAdMob(ctx.clientId, {
        admobAccountId: ctx.storeAccountId,
        start,
        end,
      });
      res.set('Cache-Control', 'no-store');
      res.json({ account: ctx.active, publisherClientId: ctx.clientId, ...data });
    } catch (err) {
      logger.error('admob roi ads-accounts:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/roi/ads-accounts', async (req, res) => {
    try {
      const ctx = await resolveAccountContext(req);
      if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
      if (!ctx.storeAccountId) return res.status(400).json({ error: 'Connect an AdMob account first' });
      const ids = Array.isArray(req.body?.adsAccountIds) ? req.body.adsAccountIds : [];
      const linkedIds = await setLinkedAdsAccountIds(ctx.clientId, ctx.storeAccountId, ids);
      res.json({ ok: true, linkedIds });
    } catch (err) {
      logger.error('admob roi ads-accounts save:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = createPublisherApiRouter({
  product: 'admob',
  adminOnly: true,
  store: admobAccountStore,
  isOAuthConfigured: isAdMobOAuthConfigured,
  resolveOAuthApp: resolveAdMobOAuthApp,
  redirectUri: admobRedirectUri,
  buildAuthUrl: buildAdMobAuthUrl,
  commitSelection: commitAdMobSelection,
  syncAll: syncAllAdMobForClient,
  syncAccount: syncAdMobAccount,
  enqueueSync: enqueueAdMobSync,
  syncQueue: admobSyncQueue,
  sumRange: sumAdMobRange,
  trendRange: trendAdMob,
  sumRollup: sumAdMobRollup,
  trendRollup: trendAdMobRollup,
  sumFiltered: sumAdMobFiltered,
  trendFiltered: trendAdMobFiltered,
  buildOverviewKpis: buildAdMobKpis,
  listFilterOptions: listAdMobFilterOptions,
  breakdownFn: breakdownAdMob,
  tableFn: tableAdMob,
  defaultBreakdownDim: 'app',
  defaultTableDim: 'ad_unit',
  queryParam: 'admob_oauth',
  extendRouter: addAdMobRoiRoutes,
  scoped: {
    getScope: getAdmobScope,
    hasAccess: hasAdmobAccess,
    totals: scopedTotals,
    trend: scopedTrend,
    breakdown: scopedBreakdown,
    filterOptions: scopedFilterOptions,
  },
});
