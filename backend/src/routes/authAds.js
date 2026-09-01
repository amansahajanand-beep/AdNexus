/**
 * Google OAuth for Google Ads API (spend / ROI) — separate from GAM /auth/callback.
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const { getAdsOAuthClient, ADS_SCOPE, listAccessibleCustomerIds, fetchCustomerInfo, listMccChildAccounts } = require('../ads/client');
const { getAccountById, createAccount, updateAccount, upsertChildUnderMcc } = require('../models/adsAccountStore');
const { getClientById } = require('../models/clientStore');
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

/** Build OAuth URL for MCC connect or individual account (called from /api/ads). */
router.buildAdsAuthUrl = buildAdsAuthUrl;
router.signAdsState = signAdsState;

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

    // MCC (or discover manager among accessible customers)
    let accessible;
    try {
      accessible = await listAccessibleCustomerIds(gamClient, refreshToken);
    } catch (e) {
      logger.error('Ads listAccessibleCustomers failed:', e.message);
      return res.redirect(adsOAuthErrorRedirect(e));
    }
    let mccInfo = null;
    for (const cid of accessible) {
      try {
        const info = await fetchCustomerInfo(gamClient, { customerId: cid, refreshToken });
        if (info.isManager) {
          mccInfo = info;
          break;
        }
      } catch (e) {
        logger.warn(`Ads probe customer ${cid}:`, e.message);
      }
    }

    if (!mccInfo && accessible[0]) {
      // Fallback: treat first accessible as the connected account (may be individual)
      const info = await fetchCustomerInfo(gamClient, {
        customerId: accessible[0],
        refreshToken,
      }).catch(() => ({
        customerId: accessible[0],
        descriptiveName: accessible[0],
        isManager: false,
      }));
      if (!info.isManager) {
        const { getAccountByCustomerId } = require('../models/adsAccountStore');
        const existingInd = await getAccountByCustomerId(gamClient.id, info.customerId);
        if (existingInd) {
          await updateAccount(existingInd.id, {
            refreshToken,
            descriptiveName: info.descriptiveName || existingInd.descriptiveName,
          });
        } else {
          await createAccount({
            clientId: gamClient.id,
            accountType: 'client',
            customerId: info.customerId,
            descriptiveName: info.descriptiveName || info.customerId,
            refreshToken,
            includeInRoi: true,
          });
        }
        return res.redirect(frontendAdminUrl('?tab=ads&ads_oauth=connected_individual'));
      }
      mccInfo = info;
    }

    if (!mccInfo) {
      return res.redirect(frontendAdminUrl('?ads_oauth=error&reason=no_accessible_accounts'));
    }

    let mccAccount = null;
    const { getAccountByCustomerId } = require('../models/adsAccountStore');
    const existing = await getAccountByCustomerId(gamClient.id, mccInfo.customerId);
    if (existing) {
      mccAccount = await updateAccount(existing.id, {
        refreshToken,
        descriptiveName: mccInfo.descriptiveName || existing.descriptiveName,
        customerId: mccInfo.customerId,
      });
      // Ensure type is mcc
      const { query } = require('../db');
      await query(
        `UPDATE ads_accounts SET account_type = 'mcc', updated_at = now() WHERE id = $1`,
        [existing.id]
      );
      mccAccount = await getAccountById(existing.id).then((a) => ({
        id: a.id,
        customerId: a.customerId,
        descriptiveName: a.descriptiveName,
      }));
    } else {
      mccAccount = await createAccount({
        clientId: gamClient.id,
        accountType: 'mcc',
        customerId: mccInfo.customerId,
        descriptiveName: mccInfo.descriptiveName || 'MCC',
        refreshToken,
        includeInRoi: false,
      });
    }

    try {
      const children = await listMccChildAccounts(gamClient, {
        mccCustomerId: mccInfo.customerId,
        refreshToken,
      });
      for (const child of children) {
        await upsertChildUnderMcc(gamClient.id, mccAccount.id, {
          customerId: child.customerId,
          descriptiveName: child.descriptiveName,
          includeInRoi: false,
        });
      }
      logger.info(`Ads MCC ${mccInfo.customerId}: discovered ${children.length} child account(s)`);
    } catch (e) {
      logger.warn('Ads MCC child discovery failed:', e.message);
    }

    return res.redirect(frontendAdminUrl('?tab=ads&ads_oauth=connected'));
  } catch (err) {
    logger.error('Ads OAuth callback error:', err.message);
    return res.redirect(adsOAuthErrorRedirect(err));
  }
});

module.exports = router;
module.exports.buildAdsAuthUrl = buildAdsAuthUrl;
module.exports.signAdsState = signAdsState;
