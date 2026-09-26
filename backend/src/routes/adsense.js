const { sumAdSenseRange, trendAdSense } = require('../models/publisherReportStore');
const { sumAdSenseRollup, trendAdSenseRollup } = require('../models/publisherRollupStore');
const {
  listAdSenseFilterOptions,
  breakdownAdSense,
  tableAdSense,
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
  buildOverviewKpis: buildAdSenseKpis,
  listFilterOptions: listAdSenseFilterOptions,
  breakdownFn: breakdownAdSense,
  tableFn: tableAdSense,
  defaultBreakdownDim: 'site',
  defaultTableDim: 'ad_unit',
  queryParam: 'adsense_oauth',
});
