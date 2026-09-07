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

function frontendAdminUrl(query = '') {
  const base = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  return `${base}/admin${query}`;
}

function isAdsApiDisabledError(err) {
  const msg = String(err?.message || err || '');
  return /SERVICE_DISABLED|Google Ads API has not been used|googleads\.googleapis\.com/i.test(msg);
}

function adsOAuthErrorRedirect(err) {
  if (isAdsApiDisabledError(err)) {
    return frontendAdminUrl(
      '?tab=ads&ads_oauth=error&reason='
      + encodeURIComponent('Enable Google Ads API in Cloud project, wait a few minutes, then Connect again')
    );
  }
  return frontendAdminUrl(`?tab=ads&ads_oauth=error&reason=${encodeURIComponent(String(err.message || err).slice(0, 80))}`);
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

/** Create/update MCC + upsert level-1 partner accounts. */
async function commitMccSelection(gamClient, { customerId, descriptiveName, refreshToken }) {
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
        includeInRoi: false,
      });
      childrenCount += 1;
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
    return res.redirect(frontendAdminUrl('?ads_oauth=error&reason=missing_code'));
  }

  try {
    const decoded = verifyAdsState(String(state));
    const gamClient = await getClientById(decoded.clientId);
    if (!gamClient) {
      return res.redirect(frontendAdminUrl('?ads_oauth=error&reason=unknown_client'));
    }

    const oauth2Client = getAdsOAuthClient(gamClient);
    const { tokens } = await oauth2Client.getToken(code);
    if (!tokens.refresh_token) {
      logger.warn('Ads OAuth callback missing refresh_token');
      return res.redirect(frontendAdminUrl('?ads_oauth=error&reason=no_refresh_token'));
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
        return res.redirect(frontendAdminUrl('?ads_oauth=error&reason=account_mismatch'));
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
          return res.redirect(adsOAuthErrorRedirect(e));
        }
        info = { customerId: account.customerId, descriptiveName: account.descriptiveName };
      }
      await updateAccount(account.id, {
        refreshToken,
        customerId: info.customerId || account.customerId,
        descriptiveName: info.descriptiveName || account.descriptiveName,
      });
      return res.redirect(frontendAdminUrl('?tab=ads&ads_oauth=connected'));
    }

    // Discover all accessible accounts → pending session → picker (or auto-commit single)
    let discovered;
    try {
      discovered = await discoverAdsCandidates(gamClient, refreshToken);
    } catch (e) {
      logger.error('Ads listAccessibleCustomers failed:', e.message);
      return res.redirect(adsOAuthErrorRedirect(e));
    }

    const { managers, individuals } = discovered;

    // Reconnecting a known MCC: update token + refresh children, skip picker
    if (decoded.adsAccountId && mode === 'mcc') {
      const account = await getAccountById(decoded.adsAccountId);
      if (account && account.clientId === gamClient.id) {
        await commitMccSelection(gamClient, {
          customerId: account.customerId,
          descriptiveName: account.descriptiveName,
          refreshToken,
        });
        return res.redirect(frontendAdminUrl('?tab=ads&ads_oauth=connected'));
      }
    }

    if (managers.length === 1 && individuals.length === 0) {
      await commitMccSelection(gamClient, {
        customerId: managers[0].customerId,
        descriptiveName: managers[0].descriptiveName,
        refreshToken,
      });
      return res.redirect(frontendAdminUrl('?tab=ads&ads_oauth=connected'));
    }

    if (managers.length === 0 && individuals.length === 1) {
      await commitIndividualSelection(gamClient, {
        customerId: individuals[0].customerId,
        descriptiveName: individuals[0].descriptiveName,
        refreshToken,
      });
      return res.redirect(frontendAdminUrl('?tab=ads&ads_oauth=connected_individual'));
    }

    if (managers.length === 0 && individuals.length === 0) {
      return res.redirect(frontendAdminUrl('?tab=ads&ads_oauth=error&reason=no_accessible_accounts'));
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
    });

    return res.redirect(
      frontendAdminUrl(`?tab=ads&ads_oauth=pick&session=${encodeURIComponent(session.id)}`)
    );
  } catch (err) {
    logger.error('Ads OAuth callback error:', err.message);
    return res.redirect(adsOAuthErrorRedirect(err));
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
