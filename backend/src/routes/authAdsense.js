const { createPublisherAuthRouter } = require('./publisherAuthFactory');
const { ADSENSE_SCOPE, getAdSenseOAuthClient, listAdSenseAccounts } = require('../adsense/client');
const { adsenseAccountStore } = require('../models/publisherAccountStore');

const router = createPublisherAuthRouter({
  product: 'adsense',
  scope: ADSENSE_SCOPE,
  getOAuthClient: getAdSenseOAuthClient,
  listAccounts: listAdSenseAccounts,
  accountStore: adsenseAccountStore,
  queryParam: 'adsense_oauth',
  adminTab: 'adsense',
});

module.exports = router;
module.exports.buildAdSenseAuthUrl = router.buildAuthUrl;
module.exports.commitAdSenseSelection = router.commitSelection;
