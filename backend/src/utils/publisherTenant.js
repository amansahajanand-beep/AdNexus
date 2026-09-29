/**
 * AdMob / AdSense are independent of GAM: every network under one account shares a
 * hidden publisher workspace tenant, which also owns its own Google Ads accounts.
 */
const { getAccountIdForClient, ensurePublisherWorkspace } = require('../models/clientStore');
const { runWithClient } = require('./clientContext');
const logger = require('./logger');

async function resolvePublisherClient(client) {
  if (!client?.id || client.publisherParentId) return client;
  try {
    const accountId = await getAccountIdForClient(client.id);
    if (!accountId) return client;
    return (await ensurePublisherWorkspace(accountId)) || client;
  } catch (err) {
    logger.warn(`[publisher-tenant] workspace lookup failed: ${err.message}`);
    return client;
  }
}

/** Express middleware — run after requireAuth. */
function usePublisherTenant(req, res, next) {
  resolvePublisherClient(req.client)
    .then((workspace) => {
      req.gamClient = req.client;
      req.client = workspace;
      runWithClient(workspace, () => next());
    })
    .catch(next);
}

module.exports = { resolvePublisherClient, usePublisherTenant };
