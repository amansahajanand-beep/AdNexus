/**
 * Factory: OAuth callback router for AdMob / AdSense.
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const { createPendingSession } = require('../models/oauthPendingStore');
const { getClientById } = require('../models/clientStore');
const { runWithClient } = require('../utils/clientContext');
const { frontendBaseUrl } = require('../utils/frontendUrl');
const logger = require('../utils/logger');

const SECRET = () => process.env.JWT_SECRET || 'change_this_secret';

function createPublisherAuthRouter({
  product,
  scope,
  getOAuthClient,
  listAccounts,
  accountStore,
  queryParam,
  adminTab,
}) {
  const router = express.Router();
  const purpose = `${product}-oauth`;

  function signState(payload) {
    return jwt.sign({ ...payload, purpose }, SECRET(), { expiresIn: '20m' });
  }

  function verifyState(state) {
    const decoded = jwt.verify(state, SECRET());
    if (!decoded?.clientId || decoded.purpose !== purpose) {
      throw new Error(`Invalid ${product} OAuth state`);
    }
    return decoded;
  }

  function oauthRedirect(decoded, query = '') {
    const raw = String(query || '').replace(/^\?/, '');
    const params = new URLSearchParams(raw);
    if (!params.has('tab')) params.set('tab', adminTab);
    return `${frontendBaseUrl()}/admin?${params.toString()}`;
  }

  function buildAuthUrl(gamClient, statePayload) {
    const oauth2Client = getOAuthClient(gamClient);
    return oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: [scope],
      // Force Google account chooser + consent so Connect always shows a picker.
      prompt: 'select_account consent',
      include_granted_scopes: true,
      state: signState(statePayload),
    });
  }

  async function commitSelection(gamClient, {
    accountId,
    descriptiveName,
    currencyCode,
    reportingTimeZone,
    refreshToken,
  }) {
    return accountStore.upsertAccount(gamClient.id, {
      accountId,
      descriptiveName,
      currencyCode,
      reportingTimeZone,
      refreshToken,
    });
  }

  router.get('/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.redirect(oauthRedirect(null, `${queryParam}=error&reason=missing_code`));
    }

    let decoded = null;
    try {
      decoded = verifyState(String(state));
      const gamClient = await getClientById(decoded.clientId);
      if (!gamClient) {
        return res.redirect(oauthRedirect(decoded, `${queryParam}=error&reason=unknown_client`));
      }

      return await runWithClient(gamClient, async () => {
        const oauth2Client = getOAuthClient(gamClient);
        const { tokens } = await oauth2Client.getToken(code);
        if (!tokens.refresh_token) {
          logger.warn(`${product} OAuth callback missing refresh_token`);
          return res.redirect(oauthRedirect(decoded, `${queryParam}=error&reason=no_refresh_token`));
        }
        const refreshToken = tokens.refresh_token;

        if (decoded.publisherAccountId) {
          const existing = await accountStore.getAccountById(decoded.publisherAccountId);
          if (existing && existing.clientId === gamClient.id) {
            await accountStore.updateAccount(existing.id, { refreshToken });
            return res.redirect(oauthRedirect(decoded, `${queryParam}=connected`));
          }
        }

        let candidates = [];
        try {
          candidates = await listAccounts(gamClient, refreshToken);
        } catch (e) {
          logger.error(`${product} list accounts failed:`, e.message);
          return res.redirect(
            oauthRedirect(decoded, `${queryParam}=error&reason=${encodeURIComponent(String(e.message).slice(0, 80))}`)
          );
        }

        if (!candidates.length) {
          return res.redirect(oauthRedirect(decoded, `${queryParam}=error&reason=no_accessible_accounts`));
        }

        if (candidates.length === 1) {
          await commitSelection(gamClient, {
            accountId: candidates[0].accountId,
            descriptiveName: candidates[0].descriptiveName,
            currencyCode: candidates[0].currencyCode,
            reportingTimeZone: candidates[0].reportingTimeZone || null,
            refreshToken,
          });
          return res.redirect(oauthRedirect(decoded, `${queryParam}=connected`));
        }

        const session = await createPendingSession({
          product,
          mode: 'connect',
          clientId: gamClient.id,
          refreshToken,
          candidates: candidates.map((c) => ({
            accountId: c.accountId,
            descriptiveName: c.descriptiveName,
            currencyCode: c.currencyCode || 'USD',
            reportingTimeZone: c.reportingTimeZone || null,
          })),
        });

        return res.redirect(
          oauthRedirect(decoded, `${queryParam}=pick&session=${encodeURIComponent(session.id)}`)
        );
      });
    } catch (err) {
      logger.error(`${product} OAuth callback error:`, err.message);
      return res.redirect(
        oauthRedirect(decoded, `${queryParam}=error&reason=${encodeURIComponent(String(err.message).slice(0, 80))}`)
      );
    }
  });

  router.buildAuthUrl = buildAuthUrl;
  router.signState = signState;
  router.commitSelection = commitSelection;
  router.oauthRedirect = oauthRedirect;
  return router;
}

module.exports = { createPublisherAuthRouter };
