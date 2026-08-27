const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { buildAdsAuthUrl } = require('./authAds');
const {
  listAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
  getAccountById,
  normalizeCustomerId,
  listCampaignMaps,
  upsertCampaignMap,
  deleteCampaignMap,
  listOtherExpenses,
  createOtherExpense,
  deleteOtherExpense,
} = require('../models/adsAccountStore');
const { listCampaigns, isAdsOAuthConfigured, resolveOAuthApp, adsRedirectUri } = require('../adsClient');
const { resolveRefreshForAccount, syncAllAccountsForClient, syncAccountSpend } = require('../services/adsSyncService');
const { todayInTZ, shiftYMD } = require('../utils/datetime');
const logger = require('../utils/logger');

router.use(requireAuth);

/** Lightweight check that Ads ROI routes are mounted (admin). */
router.get('/health', requireAdmin, (req, res) => {
  const oauth = resolveOAuthApp(req.client);
  res.json({
    ok: true,
    ads: true,
    developerTokenConfigured: Boolean(String(process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '').trim()),
    adsOAuthConfigured: isAdsOAuthConfigured(req.client),
    oauthSource: oauth.source,
    oauthClientId: oauth.clientId || null,
    redirectUri: adsRedirectUri(),
  });
});

// ─── Accounts (admin) ─────────────────────────────────────────────────────────
router.get('/accounts', requireAdmin, async (req, res) => {
  try {
    const clientId = req.client?.id || req.user.clientId;
    const accounts = await listAccounts(clientId);
    res.json({ accounts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/accounts/mcc/oauth-url', requireAdmin, async (req, res) => {
  try {
    if (!isAdsOAuthConfigured(req.client)) {
      return res.status(400).json({
        error: 'Google Ads OAuth not configured. Set GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET in backend .env (from your Ads Google Cloud project).',
      });
    }
    const url = buildAdsAuthUrl(req.client, {
      clientId: req.client.id,
      mode: 'mcc',
    });
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/accounts/individual', requireAdmin, async (req, res) => {
  try {
    const clientId = req.client?.id || req.user.clientId;
    if (!clientId) {
      return res.status(400).json({ error: 'No GAM client linked to this admin account.' });
    }

    const {
      customerId,
      descriptiveName,
      loginCustomerId,
      refreshToken,
      startOAuth = false,
    } = req.body || {};
    const cid = normalizeCustomerId(customerId);
    if (!cid) return res.status(400).json({ error: 'Customer ID is required (e.g. 123-456-7890).' });
    if (!/^\d{10}$/.test(cid)) {
      return res.status(400).json({
        error: 'Google Ads customer ID must be 10 digits (dashes allowed).',
      });
    }

    const { getAccountByCustomerId } = require('../models/adsAccountStore');
    const token = refreshToken ? String(refreshToken).trim() : null;
    let account = await getAccountByCustomerId(clientId, cid);
    if (account) {
      account = await updateAccount(account.id, {
        descriptiveName: descriptiveName || account.descriptiveName || cid,
        loginCustomerId: loginCustomerId != null ? loginCustomerId : account.loginCustomerId,
        includeInRoi: true,
        isActive: true,
        ...(token ? { refreshToken: token } : {}),
      });
    } else {
      account = await createAccount({
        clientId,
        accountType: 'client',
        customerId: cid,
        descriptiveName: descriptiveName || cid,
        loginCustomerId: loginCustomerId || null,
        includeInRoi: true,
        refreshToken: token || null,
      });
    }

    // Default: save from the form only — do not force Google OAuth redirect.
    if (!startOAuth) {
      return res.status(201).json({
        account,
        url: null,
        saved: true,
        message: token
          ? 'Account saved with refresh token.'
          : 'Account saved. Use Connect Google Ads later, or paste a refresh token.',
      });
    }

    if (!isAdsOAuthConfigured(req.client)) {
      return res.status(201).json({
        account,
        url: null,
        warning: 'Saved account but Ads OAuth missing — set GOOGLE_ADS_CLIENT_ID/SECRET in .env then Connect.',
      });
    }

    let url;
    try {
      url = buildAdsAuthUrl(req.client, {
        clientId: req.client.id,
        mode: 'individual',
        adsAccountId: account.id,
      });
    } catch (oauthErr) {
      logger.error('Ads OAuth URL build failed:', oauthErr.message);
      return res.status(400).json({
        account,
        url: null,
        error: oauthErr.message || 'Could not start Google Ads OAuth. Check OAuth client credentials.',
      });
    }

    res.status(201).json({ account, url });
  } catch (err) {
    if (/unique|duplicate/i.test(err.message)) {
      return res.status(400).json({ error: 'This Ads customer ID is already linked.' });
    }
    if (/ads_accounts|does not exist|relation/i.test(err.message)) {
      logger.error('Create individual Ads account (schema):', err.message);
      return res.status(500).json({
        error: 'Google Ads tables are missing. Restart the backend so schema init can create them.',
      });
    }
    logger.error('Create individual Ads account:', err.message);
    res.status(500).json({ error: err.message || 'Could not add Google Ads account' });
  }
});

/** Save MCC from the form (customer ID + optional refresh token) without OAuth redirect. */
router.post('/accounts/mcc', requireAdmin, async (req, res) => {
  try {
    const clientId = req.client?.id || req.user.clientId;
    if (!clientId) {
      return res.status(400).json({ error: 'No GAM client linked to this admin account.' });
    }
    const { customerId, descriptiveName, refreshToken, startOAuth = false } = req.body || {};
    const cid = normalizeCustomerId(customerId);
    if (!cid || !/^\d{10}$/.test(cid)) {
      return res.status(400).json({ error: 'MCC customer ID must be 10 digits (dashes allowed).' });
    }
    const { getAccountByCustomerId } = require('../models/adsAccountStore');
    const { query } = require('../db');
    const token = refreshToken ? String(refreshToken).trim() : null;
    let account = await getAccountByCustomerId(clientId, cid);
    if (account) {
      account = await updateAccount(account.id, {
        descriptiveName: descriptiveName || account.descriptiveName || 'MCC',
        ...(token ? { refreshToken: token } : {}),
      });
      await query(
        `UPDATE ads_accounts SET account_type = 'mcc', include_in_roi = false, updated_at = now() WHERE id = $1`,
        [account.id]
      );
      account = { ...account, accountType: 'mcc', includeInRoi: false };
    } else {
      account = await createAccount({
        clientId,
        accountType: 'mcc',
        customerId: cid,
        descriptiveName: descriptiveName || 'MCC',
        includeInRoi: false,
        refreshToken: token || null,
      });
    }

    if (!startOAuth) {
      return res.status(201).json({
        account,
        url: null,
        saved: true,
        message: token
          ? 'MCC saved with refresh token.'
          : 'MCC saved. Use Connect MCC (OAuth) later, or paste a refresh token.',
      });
    }

    if (!isAdsOAuthConfigured(req.client)) {
      return res.status(400).json({
        error: 'Google Ads OAuth not configured. Set GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET in backend .env.',
      });
    }
    const url = buildAdsAuthUrl(req.client, {
      clientId: req.client.id,
      mode: 'mcc',
      adsAccountId: account.id,
    });
    res.status(201).json({ account, url });
  } catch (err) {
    logger.error('Save MCC account:', err.message);
    res.status(500).json({ error: err.message || 'Could not save MCC' });
  }
});

router.get('/accounts/:id/oauth-url', requireAdmin, async (req, res) => {
  try {
    const account = await getAccountById(req.params.id);
    if (!account || account.clientId !== req.client.id) {
      return res.status(404).json({ error: 'Account not found' });
    }
    const url = buildAdsAuthUrl(req.client, {
      clientId: req.client.id,
      mode: account.accountType === 'mcc' ? 'mcc' : 'individual',
      adsAccountId: account.id,
    });
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/accounts/:id', requireAdmin, async (req, res) => {
  try {
    const account = await getAccountById(req.params.id);
    if (!account || account.clientId !== req.client.id) {
      return res.status(404).json({ error: 'Account not found' });
    }
    const { descriptiveName, includeInRoi, isActive, loginCustomerId, refreshToken } = req.body || {};
    const updated = await updateAccount(account.id, {
      descriptiveName,
      includeInRoi,
      isActive,
      loginCustomerId,
      ...(refreshToken ? { refreshToken: String(refreshToken).trim() } : {}),
    });
    res.json({ account: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/accounts/:id', requireAdmin, async (req, res) => {
  try {
    const account = await getAccountById(req.params.id);
    if (!account || account.clientId !== req.client.id) {
      return res.status(404).json({ error: 'Account not found' });
    }
    await deleteAccount(account.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/accounts/:id/refresh-children', requireAdmin, async (req, res) => {
  try {
    const account = await getAccountById(req.params.id);
    if (!account || account.clientId !== req.client.id || account.accountType !== 'mcc') {
      return res.status(404).json({ error: 'MCC account not found' });
    }
    const refreshToken = account.refreshToken;
    if (!refreshToken) return res.status(400).json({ error: 'MCC not connected — run OAuth first' });
    const { listMccChildAccounts } = require('../adsClient');
    const { upsertChildUnderMcc } = require('../models/adsAccountStore');
    const children = await listMccChildAccounts(req.client, {
      mccCustomerId: account.customerId,
      refreshToken,
    });
    const out = [];
    for (const child of children) {
      out.push(await upsertChildUnderMcc(req.client.id, account.id, {
        customerId: child.customerId,
        descriptiveName: child.descriptiveName,
        includeInRoi: false,
      }));
    }
    res.json({ children: out });
  } catch (err) {
    logger.error('Refresh MCC children:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Campaigns + mapping ──────────────────────────────────────────────────────
router.get('/accounts/:id/campaigns', requireAdmin, async (req, res) => {
  try {
    const account = await getAccountById(req.params.id);
    if (!account || account.clientId !== req.client.id) {
      return res.status(404).json({ error: 'Account not found' });
    }
    const refreshToken = await resolveRefreshForAccount(account);
    if (!refreshToken) return res.status(400).json({ error: 'Account not connected' });
    const campaigns = await listCampaigns(req.client, {
      customerId: account.customerId,
      refreshToken,
      loginCustomerId: account.loginCustomerId,
    });
    res.json({ campaigns });
  } catch (err) {
    logger.error('List Ads campaigns:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/campaign-maps', requireAdmin, async (req, res) => {
  try {
    const maps = await listCampaignMaps(req.client.id);
    res.json({ maps });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/campaign-maps', requireAdmin, async (req, res) => {
  try {
    const { adsAccountId, campaignId, campaignName, targetType, targetKey } = req.body || {};
    if (!adsAccountId || !campaignId || !targetType || !targetKey) {
      return res.status(400).json({ error: 'adsAccountId, campaignId, targetType, targetKey required' });
    }
    const account = await getAccountById(adsAccountId);
    if (!account || account.clientId !== req.client.id) {
      return res.status(404).json({ error: 'Account not found' });
    }
    const row = await upsertCampaignMap({
      clientId: req.client.id,
      adsAccountId,
      campaignId,
      campaignName,
      targetType,
      targetKey,
    });
    res.json({
      map: {
        id: row.id,
        adsAccountId: row.ads_account_id,
        campaignId: row.campaign_id,
        campaignName: row.campaign_name,
        targetType: row.target_type,
        targetKey: row.target_key,
      },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/campaign-maps/:id', requireAdmin, async (req, res) => {
  try {
    await deleteCampaignMap(req.params.id, req.client.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Sync ─────────────────────────────────────────────────────────────────────
router.post('/sync', requireAdmin, async (req, res) => {
  try {
    if (!String(process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '').trim()) {
      return res.status(400).json({
        error: 'GOOGLE_ADS_DEVELOPER_TOKEN is not set in backend/.env. Add it and restart the backend.',
        total: 0,
        accounts: 0,
      });
    }
    const lookback = parseInt(process.env.GOOGLE_ADS_SYNC_LOOKBACK_DAYS || '30', 10) || 30;
    const end = req.body?.endDate || todayInTZ();
    const start = req.body?.startDate || shiftYMD(end, -(lookback - 1));
    const { listSyncableClientAccounts } = require('../models/adsAccountStore');
    const syncable = await listSyncableClientAccounts(req.client.id);
    if (!syncable.length) {
      return res.status(400).json({
        error: 'No syncable Google Ads client accounts. Save an individual account (or refresh MCC children) with a refresh token, and enable Include in ROI.',
        total: 0,
        accounts: 0,
        start,
        end,
      });
    }
    const result = await syncAllAccountsForClient(req.client, { startDate: start, endDate: end });
    res.json({ ok: true, ...result, start, end });
  } catch (err) {
    logger.error('Ads sync:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/accounts/:id/sync', requireAdmin, async (req, res) => {
  try {
    const account = await getAccountById(req.params.id);
    if (!account || account.clientId !== req.client.id) {
      return res.status(404).json({ error: 'Account not found' });
    }
    const lookback = parseInt(process.env.GOOGLE_ADS_SYNC_LOOKBACK_DAYS || '30', 10) || 30;
    const end = req.body?.endDate || todayInTZ();
    const start = req.body?.startDate || shiftYMD(end, -(lookback - 1));
    const n = await syncAccountSpend(account, { startDate: start, endDate: end, gamClient: req.client });
    res.json({ ok: true, rows: n, start, end });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Other expenses (admin + any authed user who can view ROI) ────────────────
router.get('/expenses', async (req, res) => {
  try {
    const clientId = req.client?.id || req.user.clientId;
    const { start, end } = req.query;
    const expenses = await listOtherExpenses(clientId, { start, end });
    res.json({ expenses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/expenses', async (req, res) => {
  try {
    const clientId = req.client?.id || req.user.clientId;
    const { expenseDate, amount, label, targetType, targetKey, notes } = req.body || {};
    if (!expenseDate || amount == null) {
      return res.status(400).json({ error: 'expenseDate and amount required' });
    }
    const expense = await createOtherExpense({
      clientId,
      expenseDate,
      amount,
      label,
      targetType: targetType || 'general',
      targetKey,
      notes,
      createdBy: req.user.id,
    });
    res.status(201).json({ expense });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/expenses/:id', async (req, res) => {
  try {
    const clientId = req.client?.id || req.user.clientId;
    await deleteOtherExpense(req.params.id, clientId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
