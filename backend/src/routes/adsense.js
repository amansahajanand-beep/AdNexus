const { sumAdSenseRange, trendAdSense } = require('../models/publisherReportStore');
const { sumAdSenseRollup, trendAdSenseRollup } = require('../models/publisherRollupStore');
const {
  listAdSenseFilterOptions,
  breakdownAdSense,
  tableAdSense,
  sumAdSenseFiltered,
  trendAdSenseFiltered,
} = require('../models/publisherDimStore');
const {
  isAdSenseOAuthConfigured,
  resolveAdSenseOAuthApp,
  adsenseRedirectUri,
} = require('../adsense/client');
const { buildAdSenseAuthUrl, commitAdSenseSelection } = require('./authAdsense');
const {
  syncAllAdSenseForClient,
  syncAdSenseAccount,
  enqueueAdSenseSync,
} = require('../services/adsenseSyncService');
const { adsenseSyncQueue } = require('../queues/publisherSync');
const { adsenseAccountStore } = require('../models/publisherAccountStore');
const {
  getAdSenseRoi,
  listAdsAccountsForAdSense,
  setLinkedAdsAccountIds,
} = require('../services/adsenseRoiService');
const logger = require('../utils/logger');
const {
  scopedTotals,
  scopedTrend,
  scopedBreakdown,
  scopedFilterOptions,
  grainScopeCatalog,
} = require('../models/adsenseGrainStore');
const { ADSENSE_SCOPE_FILTERS, getAdsenseScope, hasAdsenseAccess } = require('../utils/permissions');
const { createPublisherApiRouter, sparkFromTrend, pctChange } = require('./publisherApiFactory');

function buildAdSenseKpis(curr, prev, trend) {
  const earnings = Number(curr.earnings) || 0;
  const pageViews = Number(curr.page_views) || 0;
  const impressions = Number(curr.impressions) || 0;
  const clicks = Number(curr.clicks) || 0;
  const rpm = curr.rpm != null ? Number(curr.rpm) : (pageViews ? (earnings / pageViews) * 1000 : 0);
  const ctr = curr.ctr != null ? Number(curr.ctr) : (impressions ? (clicks / impressions) * 100 : 0);

  const prevEarn = Number(prev.earnings) || 0;
  const prevPv = Number(prev.page_views) || 0;
  const prevImp = Number(prev.impressions) || 0;
  const prevClk = Number(prev.clicks) || 0;
  const prevRpm = prev.rpm != null ? Number(prev.rpm) : (prevPv ? (prevEarn / prevPv) * 1000 : 0);
  const prevCtr = prev.ctr != null ? Number(prev.ctr) : (prevImp ? (prevClk / prevImp) * 100 : 0);

  return [
    { key: 'earnings', label: 'Estimated earnings', value: earnings, format: 'money', change: pctChange(earnings, prevEarn), spark: sparkFromTrend(trend, 'earnings') },
    { key: 'pageViews', label: 'Page views', value: pageViews, format: 'number', change: pctChange(pageViews, prevPv), spark: sparkFromTrend(trend, 'page_views') },
    { key: 'impressions', label: 'Impressions', value: impressions, format: 'number', change: pctChange(impressions, prevImp), spark: sparkFromTrend(trend, 'impressions') },
    { key: 'clicks', label: 'Clicks', value: clicks, format: 'number', change: pctChange(clicks, prevClk), spark: sparkFromTrend(trend, 'clicks') },
    { key: 'rpm', label: 'RPM', value: rpm, format: 'money', change: pctChange(rpm, prevRpm), spark: sparkFromTrend(trend, 'rpm') },
    { key: 'ctr', label: 'CTR', value: ctr, format: 'percent', change: pctChange(ctr, prevCtr), spark: sparkFromTrend(trend, 'ctr') },
  ];
}

/** ROI page: AdSense site earnings vs spend from the Google Ads accounts linked to each publisher. */
function addAdSenseRoiRoutes(router, { resolveAccountContext, resolveRange, parseCsvList, store }) {
  // Spend data is admin-only; domain users keep the earnings-only dashboards.
  const adminOnly = (req, res, next) => (
    req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })
  );

  router.get('/roi', adminOnly, async (req, res) => {
    try {
      const ctx = await resolveAccountContext(req);
      if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
      const { start, end } = resolveRange(req);
      const account = ctx.storeAccountId ? await store.getAccountById(ctx.storeAccountId) : null;
      const sites = parseCsvList(req.query.sites);
      const data = await getAdSenseRoi({
        clientId: ctx.clientId,
        account,
        start,
        end,
        sites: sites.length ? sites : null,
        adsAccountIds: parseCsvList(req.query.adsAccountIds),
      });
      res.set('Cache-Control', 'no-store');
      res.json({ account: ctx.active, ...data });
    } catch (err) {
      logger.error('adsense roi:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /** Admin → Users: publishers + their sites / ad units for domain-user AdSense scope. */
  router.get('/scope-catalog', adminOnly, async (req, res) => {
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
        filters: ADSENSE_SCOPE_FILTERS,
      });
    } catch (err) {
      logger.error('adsense scope-catalog:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/roi/ads-accounts', adminOnly, async (req, res) => {
    try {
      const ctx = await resolveAccountContext(req);
      if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
      const { start, end } = resolveRange(req);
      const data = await listAdsAccountsForAdSense(ctx.clientId, {
        adsenseAccountId: ctx.storeAccountId,
        start,
        end,
      });
      res.set('Cache-Control', 'no-store');
      res.json({ account: ctx.active, publisherClientId: ctx.clientId, ...data });
    } catch (err) {
      logger.error('adsense roi ads-accounts:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/roi/ads-accounts', adminOnly, async (req, res) => {
    try {
      const ctx = await resolveAccountContext(req);
      if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
      if (!ctx.storeAccountId) return res.status(400).json({ error: 'Connect an AdSense account first' });
      const ids = Array.isArray(req.body?.adsAccountIds) ? req.body.adsAccountIds : [];
      const linkedIds = await setLinkedAdsAccountIds(ctx.clientId, ctx.storeAccountId, ids);
      res.json({ ok: true, linkedIds });
    } catch (err) {
      logger.error('adsense roi ads-accounts save:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = createPublisherApiRouter({
  product: 'adsense',
  store: adsenseAccountStore,
  isOAuthConfigured: isAdSenseOAuthConfigured,
  resolveOAuthApp: resolveAdSenseOAuthApp,
  redirectUri: adsenseRedirectUri,
  buildAuthUrl: buildAdSenseAuthUrl,
  commitSelection: commitAdSenseSelection,
  syncAll: syncAllAdSenseForClient,
  syncAccount: syncAdSenseAccount,
  enqueueSync: enqueueAdSenseSync,
  syncQueue: adsenseSyncQueue,
  sumRange: sumAdSenseRange,
  trendRange: trendAdSense,
  sumRollup: sumAdSenseRollup,
  trendRollup: trendAdSenseRollup,
  sumFiltered: sumAdSenseFiltered,
  trendFiltered: trendAdSenseFiltered,
  buildOverviewKpis: buildAdSenseKpis,
  listFilterOptions: listAdSenseFilterOptions,
  breakdownFn: breakdownAdSense,
  tableFn: tableAdSense,
  defaultBreakdownDim: 'site',
  defaultTableDim: 'ad_unit',
  queryParam: 'adsense_oauth',
  extendRouter: addAdSenseRoiRoutes,
  adminOnly: true,
  scoped: {
    getScope: getAdsenseScope,
    hasAccess: hasAdsenseAccess,
    totals: scopedTotals,
    trend: scopedTrend,
    breakdown: scopedBreakdown,
    filterOptions: scopedFilterOptions,
  },
});
