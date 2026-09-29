const { createPublisherAuthRouter } = require('./publisherAuthFactory');
const { ADMOB_SCOPE, getAdMobOAuthClient, listAdMobAccounts } = require('../admob/client');
const { admobAccountStore } = require('../models/publisherAccountStore');

const router = createPublisherAuthRouter({
  product: 'admob',
  scope: ADMOB_SCOPE,
  getOAuthClient: getAdMobOAuthClient,
  listAccounts: listAdMobAccounts,
  accountStore: admobAccountStore,
  queryParam: 'admob_oauth',
  adminTab: 'admob',
});

module.exports = router;
module.exports.buildAdMobAuthUrl = router.buildAuthUrl;
module.exports.commitAdMobSelection = router.commitSelection;
