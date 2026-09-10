/**
 * Google OAuth for Google Ads API (spend / ROI) — separate from GAM /auth/callback.
 * Connect with Google → list all manager accounts → user picks → fetch partners.
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const { getAdsOAuthClient, ADS_SCOPE, listAccessibleCustomerIds, fetchCustomerInfo, listMccChildAccounts } = require('../ads/client');
const { getAccountById, createAccount, updateAccount, upsertChildUnderMcc, getAccountByCustomerId } = require('../models/adsAccountStore');
const { getClientById } = require('../models/clientStore');
const { createPendingSession, getPendingSession, deletePendingSession } = require('../models/oauthPendingStore');
const { frontendBaseUrl } = require('../utils/frontendUrl');
const { collectGrantIds, grantAdsAccountsToUser } = require('../utils/adsUserAccess');
const { runWithClient } = require('../utils/clientContext');
const logger = require('../utils/logger');

const SECRET = () => process.env.JWT_SECRET || 'change_this_secret';

function signAdsState(payload) {
  return jwt.sign({ ...payload, purpose: 'ads-oauth' }, SECRET(), { expiresIn: '20m' });
}

function verifyAdsState(state) {
  const decoded = jwt.verify(state, SECRET());
  if (!decoded?.clientId || decoded.purpose !== 'ads-oauth') {
    throw new Error('Invalid Ads OAuth state');
  }
  return decoded;
}

/** returnTo: 'admin' (default) | 'my-ads' for domain-user Connect page. */
function adsOAuthRedirect(decoded, query = '') {
  const raw = String(query || '').replace(/^\?/, '');
  const params = new URLSearchParams(raw);
  if (decoded?.returnTo === 'my-ads') {
    params.delete('tab');
    const qs = params.toString();
    return `${frontendBaseUrl()}/my-ads${qs ? `?${qs}` : ''}`;
  }
  if (!params.has('tab')) params.set('tab', 'ads');
  return `${frontendBaseUrl()}/admin?${params.toString()}`;
}

function isAdsApiDisabledError(err) {
  const msg = String(err?.message || err || '');
  return /SERVICE_DISABLED|Google Ads API has not been used|googleads\.googleapis\.com/i.test(msg);
}

function adsOAuthErrorRedirect(err, decoded = null) {
  if (isAdsApiDisabledError(err)) {
    return adsOAuthRedirect(
      decoded,
      'ads_oauth=error&reason='
      + encodeURIComponent('Enable Google Ads API in Cloud project, wait a few minutes, then Connect again')
    );
  }
  return adsOAuthRedirect(
    decoded,
    `ads_oauth=error&reason=${encodeURIComponent(String(err.message || err).slice(0, 80))}`
  );
}

async function grantConnectedAccounts(decoded, gamClient, rootAccount) {
  if (decoded?.returnTo !== 'my-ads' || !decoded?.userId || !rootAccount) return;
  try {
    const ids = await collectGrantIds(gamClient.id, rootAccount);
    await grantAdsAccountsToUser(decoded.userId, ids);
  } catch (e) {
    logger.warn('Ads grant to domain user failed:', e.message);
  }
}

function buildAdsAuthUrl(gamClient, statePayload) {
  const oauth2Client = getAdsOAuthClient(gamClient);
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [ADS_SCOPE],
    prompt: 'consent',
    state: signAdsState(statePayload),
  });
}

/** Probe accessible customers; return all managers and non-managers. */
async function discoverAdsCandidates(gamClient, refreshToken) {
  const accessible = await listAccessibleCustomerIds(gamClient, refreshToken);
  const managers = [];
  const individuals = [];
  for (const cid of accessible) {
    try {
      const info = await fetchCustomerInfo(gamClient, { customerId: cid, refreshToken });
      const row = {
        customerId: info.customerId,
        descriptiveName: info.descriptiveName || info.customerId,
        isManager: !!info.isManager,
        currency: info.currency || null,
      };
      if (row.isManager) managers.push(row);
      else individuals.push(row);
    } catch (e) {
      logger.warn(`Ads probe customer ${cid}:`, e.message);
    }
  }
  return { managers, individuals, accessible };
}

/** Create/update MCC + upsert partner accounts (full tree under listMccChildAccounts). */
async function commitMccSelection(gamClient, {
  customerId,
  descriptiveName,
  refreshToken,
  includeChildrenInRoi = false,
}) {
  const cid = String(customerId || '').replace(/-/g, '');
  if (!/^\d{10}$/.test(cid)) throw new Error('Invalid MCC customer ID');

  let mccAccount;
  const existing = await getAccountByCustomerId(gamClient.id, cid);
  if (existing) {
    mccAccount = await updateAccount(existing.id, {
      refreshToken,
      descriptiveName: descriptiveName || existing.descriptiveName || 'MCC',
      customerId: cid,
    });
    const { query } = require('../db');
    await query(
      `UPDATE ads_accounts SET account_type = 'mcc', include_in_roi = false, updated_at = now() WHERE id = $1`,
      [existing.id]
    );
    mccAccount = await getAccountById(existing.id);
  } else {
    mccAccount = await createAccount({
      clientId: gamClient.id,
      accountType: 'mcc',
      customerId: cid,
      descriptiveName: descriptiveName || 'MCC',
      refreshToken,
      includeInRoi: false,
    });
  }

  let childrenCount = 0;
  try {
    const children = await listMccChildAccounts(gamClient, {
      mccCustomerId: cid,
      refreshToken,
    });
    for (const child of children) {
      await upsertChildUnderMcc(gamClient.id, mccAccount.id, {
        customerId: child.customerId,
        descriptiveName: child.descriptiveName,
        includeInRoi: !!includeChildrenInRoi,
      });
      childrenCount += 1;
    }
    if (includeChildrenInRoi && childrenCount > 0) {
      const { query } = require('../db');
      await query(
        `UPDATE ads_accounts
         SET include_in_roi = true, updated_at = now()
         WHERE parent_mcc_id = $1 AND account_type = 'client'`,
        [mccAccount.id]
      );
    }
    logger.info(`Ads MCC ${cid}: discovered ${childrenCount} child account(s)`);
  } catch (e) {
    logger.warn('Ads MCC child discovery failed:', e.message);
  }

  return { mccAccount, childrenCount };
}

async function commitIndividualSelection(gamClient, { customerId, descriptiveName, refreshToken }) {
  const cid = String(customerId || '').replace(/-/g, '');
  if (!/^\d{10}$/.test(cid)) throw new Error('Invalid customer ID');
  const existing = await getAccountByCustomerId(gamClient.id, cid);
  if (existing) {
    return updateAccount(existing.id, {
      refreshToken,
      descriptiveName: descriptiveName || existing.descriptiveName || cid,
      customerId: cid,
    });
  }
  return createAccount({
    clientId: gamClient.id,
    accountType: 'client',
    customerId: cid,
    descriptiveName: descriptiveName || cid,
    refreshToken,
    includeInRoi: true,
  });
}

/** Build OAuth URL for MCC connect or individual account (called from /api/ads). */
router.buildAdsAuthUrl = buildAdsAuthUrl;
router.signAdsState = signAdsState;
router.commitMccSelection = commitMccSelection;
router.commitIndividualSelection = commitIndividualSelection;
router.discoverAdsCandidates = discoverAdsCandidates;

router.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) {
    return res.redirect(adsOAuthRedirect(null, 'ads_oauth=error&reason=missing_code'));
  }

  let decoded = null;
  try {
    decoded = verifyAdsState(String(state));
    const gamClient = await getClientById(decoded.clientId);
    if (!gamClient) {
      return res.redirect(adsOAuthRedirect(decoded, 'ads_oauth=error&reason=unknown_client'));
    }

    // FORCE RLS on ads_accounts requires app.client_id (= gamClient.id).
    // This callback is unauthenticated, so set tenant context explicitly.
    return await runWithClient(gamClient, async () => {
      const forDomainUser = decoded.returnTo === 'my-ads';
      const oauth2Client = getAdsOAuthClient(gamClient);
      const { tokens } = await oauth2Client.getToken(code);
      if (!tokens.refresh_token) {
        logger.warn('Ads OAuth callback missing refresh_token');
        return res.redirect(adsOAuthRedirect(decoded, 'ads_oauth=error&reason=no_refresh_token'));
      }

      const refreshToken = tokens.refresh_token;
      const mode = decoded.mode || 'mcc';

      // Persist token early when reconnecting a known account — Ads API may still be disabled.
      if (decoded.adsAccountId) {
        const early = await getAccountById(decoded.adsAccountId);
        if (early && early.clientId === gamClient.id) {
          await updateAccount(early.id, { refreshToken });
        }
      }

      if (mode === 'individual' && decoded.adsAccountId) {
        const account = await getAccountById(decoded.adsAccountId);
        if (!account || account.clientId !== gamClient.id) {
          return res.redirect(adsOAuthRedirect(decoded, 'ads_oauth=error&reason=account_mismatch'));
        }
        let info;
        try {
          info = await fetchCustomerInfo(gamClient, {
            customerId: account.customerId,
            refreshToken,
            loginCustomerId: account.loginCustomerId,
          });
        } catch (e) {
          logger.warn('Ads individual customer info:', e.message);
          if (isAdsApiDisabledError(e)) {
            return res.redirect(adsOAuthErrorRedirect(e, decoded));
          }
          info = { customerId: account.customerId, descriptiveName: account.descriptiveName };
        }
        const updated = await updateAccount(account.id, {
          refreshToken,
          customerId: info.customerId || account.customerId,
          descriptiveName: info.descriptiveName || account.descriptiveName,
        });
        await grantConnectedAccounts(decoded, gamClient, updated || account);
        return res.redirect(adsOAuthRedirect(decoded, 'ads_oauth=connected'));
      }

      // Discover all accessible accounts → pending session → picker (or auto-commit single)
      let discovered;
      try {
        discovered = await discoverAdsCandidates(gamClient, refreshToken);
      } catch (e) {
        logger.error('Ads listAccessibleCustomers failed:', e.message);
        return res.redirect(adsOAuthErrorRedirect(e, decoded));
      }

      const { managers, individuals } = discovered;
      const mccOpts = { includeChildrenInRoi: forDomainUser };

      // Reconnecting a known MCC: update token + refresh children, skip picker
      if (decoded.adsAccountId && mode === 'mcc') {
        const account = await getAccountById(decoded.adsAccountId);
        if (account && account.clientId === gamClient.id) {
          const { mccAccount } = await commitMccSelection(gamClient, {
            customerId: account.customerId,
            descriptiveName: account.descriptiveName,
            refreshToken,
            ...mccOpts,
          });
          await grantConnectedAccounts(decoded, gamClient, mccAccount);
          return res.redirect(adsOAuthRedirect(decoded, 'ads_oauth=connected'));
        }
      }

      if (managers.length === 1 && individuals.length === 0) {
        const { mccAccount } = await commitMccSelection(gamClient, {
          customerId: managers[0].customerId,
          descriptiveName: managers[0].descriptiveName,
          refreshToken,
          ...mccOpts,
        });
        await grantConnectedAccounts(decoded, gamClient, mccAccount);
        return res.redirect(adsOAuthRedirect(decoded, 'ads_oauth=connected'));
      }

      if (managers.length === 0 && individuals.length === 1) {
        const account = await commitIndividualSelection(gamClient, {
          customerId: individuals[0].customerId,
          descriptiveName: individuals[0].descriptiveName,
          refreshToken,
        });
        await grantConnectedAccounts(decoded, gamClient, account);
        return res.redirect(adsOAuthRedirect(decoded, 'ads_oauth=connected_individual'));
      }

      if (managers.length === 0 && individuals.length === 0) {
        return res.redirect(adsOAuthRedirect(decoded, 'ads_oauth=error&reason=no_accessible_accounts'));
      }

      const session = await createPendingSession({
        product: 'ads',
        mode: 'connect',
        clientId: gamClient.id,
        refreshToken,
        candidates: [
          ...managers.map((m) => ({ ...m, kind: 'mcc' })),
          ...individuals.map((i) => ({ ...i, kind: 'client' })),
        ],
        payload: {
          userId: decoded.userId || null,
          returnTo: forDomainUser ? 'my-ads' : 'admin',
          includeChildrenInRoi: forDomainUser,
        },
      });

      return res.redirect(
        adsOAuthRedirect(decoded, `ads_oauth=pick&session=${encodeURIComponent(session.id)}`)
      );
    });
  } catch (err) {
    logger.error('Ads OAuth callback error:', err.message);
    return res.redirect(adsOAuthErrorRedirect(err, decoded));
  }
});

module.exports = router;
module.exports.buildAdsAuthUrl = buildAdsAuthUrl;
module.exports.signAdsState = signAdsState;
module.exports.commitMccSelection = commitMccSelection;
module.exports.commitIndividualSelection = commitIndividualSelection;
module.exports.discoverAdsCandidates = discoverAdsCandidates;
module.exports.getPendingSession = getPendingSession;
module.exports.deletePendingSession = deletePendingSession;
module.exports.adsOAuthRedirect = adsOAuthRedirect;
