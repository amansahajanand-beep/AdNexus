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
const { admobAccountStore } = require('../models/publisherAccountStore');
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

module.exports = createPublisherApiRouter({
  product: 'admob',
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
});
