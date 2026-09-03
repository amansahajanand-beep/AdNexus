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
  upsertCampaignMapsBulk,
  deleteCampaignMap,
  listOtherExpenses,
  createOtherExpense,
  deleteOtherExpense,
} = require('../models/adsAccountStore');
const { listCampaigns, isAdsOAuthConfigured, resolveOAuthApp, adsRedirectUri } = require('../ads/client');
const { resolveRefreshForAccount, syncAllAccountsForClient, syncAccountSpend, enqueueAdsSyncAccounts } = require('../services/adsSyncService');
const { todayInTZ, shiftYMD } = require('../utils/datetime');
const { resolveAdsAccountIdsForUser, getAllowedAdsAccountIds } = require('../utils/permissions');
const logger = require('../utils/logger');
const { cache } = require('../gam/client');

function parseAccountIdsQuery(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Apply domain-user Ads account scope; always returns an array usable with ANY(uuid[]). */
function scopedAccountIds(req, requested = []) {
  const resolved = resolveAdsAccountIdsForUser(req.user, requested);
  return resolved && resolved.length ? resolved : null;
}

const ROI_FILTER_CACHE_TTL = Math.max(
  15,
  parseInt(process.env.ROI_FILTER_CACHE_TTL || '60', 10) || 60
);

function roiFilterCacheKey(route, clientId, payload) {
  return `roi_filter_v1_${route}_${clientId}_${JSON.stringify(payload)}`;
}

function sendCachedJson(res, cacheKey, payload, ttl = ROI_FILTER_CACHE_TTL) {
  cache.set(cacheKey, payload, ttl);
  res.json(payload);
}

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
    const { listMccChildAccounts } = require('../ads/client');
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
    const { formatAdsSyncError } = require('../services/adsSyncService');
    const message = formatAdsSyncError(err);
    logger.error('Refresh MCC children:', message);
    res.status(500).json({ error: message });
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

router.put('/campaign-maps/bulk', requireAdmin, async (req, res) => {
  try {
    const { adsAccountId, targetType, targetKey, campaigns } = req.body || {};
    if (!adsAccountId || !targetType || !targetKey || !Array.isArray(campaigns) || !campaigns.length) {
      return res.status(400).json({
        error: 'adsAccountId, targetType, targetKey, and non-empty campaigns[] required',
      });
    }
    const account = await getAccountById(adsAccountId);
    if (!account || account.clientId !== req.client.id) {
      return res.status(404).json({ error: 'Account not found' });
    }
    const rows = await upsertCampaignMapsBulk({
      clientId: req.client.id,
      adsAccountId,
      targetType,
      targetKey,
      campaigns,
    });
    res.json({
      ok: true,
      saved: rows.length,
      maps: rows.map((row) => ({
        id: row.id,
        adsAccountId: row.ads_account_id,
        campaignId: row.campaign_id,
        campaignName: row.campaign_name,
        targetType: row.target_type,
        targetKey: row.target_key,
      })),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Distinct campaigns for ROI filters (synced spend; falls back to last 30 days when range is empty). */
router.get('/roi-campaigns', async (req, res) => {
  try {
    const clientId = req.client?.id || req.user?.clientId;
    if (!clientId) return res.status(400).json({ error: 'No client context' });
    const end = req.query.end || todayInTZ();
    const start = req.query.start || end;
    const accountIds = scopedAccountIds(req, parseAccountIdsQuery(req.query.accountIds)) || [];

    const { query } = require('../db');
    const { shiftYMD } = require('../utils/datetime');

    async function loadCampaigns(rangeStart, rangeEnd) {
      const params = [clientId, rangeStart, rangeEnd];
      let accountClause = '';
      if (accountIds.length) {
        params.push(accountIds);
        accountClause = ` AND s.ads_account_id = ANY($${params.length}::uuid[])`;
      }
      const { rows } = await query(
        `SELECT s.campaign_id,
                s.ads_account_id,
                MAX(COALESCE(NULLIF(TRIM(s.campaign_name), ''), s.campaign_id)) AS campaign_name,
                MAX(a.descriptive_name) AS account_name,
                SUM(s.cost)::float8 AS spend
         FROM ads_spend_daily s
         JOIN ads_accounts a ON a.id = s.ads_account_id
         WHERE s.client_id = $1
           AND s.report_date BETWEEN $2::date AND $3::date
           ${accountClause}
         GROUP BY s.campaign_id, s.ads_account_id
         ORDER BY spend DESC, campaign_name ASC`,
        params
      );
      return rows || [];
    }

    let rows = await loadCampaigns(start, end);
    let fallbackUsed = false;
    if (!rows.length) {
      const fallbackStart = shiftYMD(end, -30);
      rows = await loadCampaigns(fallbackStart, end);
      fallbackUsed = rows.length > 0;
    }

    const campaigns = rows.map((r) => ({
      campaignId: String(r.campaign_id),
      campaignName: r.campaign_name || String(r.campaign_id),
      adsAccountId: r.ads_account_id,
      accountName: r.account_name || '',
      spend: Number(r.spend) || 0,
    }));
    const payload = { start, end, campaigns, fallbackUsed };
    const cacheKey = roiFilterCacheKey('campaigns', clientId, { start, end, accountIds });
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);
    return sendCachedJson(res, cacheKey, payload);
  } catch (err) {
    logger.error('ROI campaigns list:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** Ads client accounts for ROI filter — only accounts with spend in the selected range. */
router.get('/roi-accounts', async (req, res) => {
  try {
    const clientId = req.client?.id || req.user?.clientId;
    if (!clientId) return res.status(400).json({ error: 'No client context' });
    const end = req.query.end || todayInTZ();
    const start = req.query.start || end;
    const allowed = getAllowedAdsAccountIds(req.user);
    // Domain user with no Ads accounts assigned → empty list (same idea as empty inventory).
    if (allowed !== null && allowed.length === 0) {
      return res.json({ start, end, accounts: [] });
    }
    const { query } = require('../db');
    const params = [clientId, start, end];
    let scopeClause = '';
    if (allowed !== null) {
      params.push(allowed);
      scopeClause = ` AND a.id = ANY($${params.length}::uuid[])`;
    }
    const { rows } = await query(
      `SELECT a.id, a.customer_id, a.descriptive_name,
              COALESCE(SUM(s.cost), 0)::float8 AS spend
       FROM ads_accounts a
       INNER JOIN ads_spend_daily s
         ON s.ads_account_id = a.id
        AND s.client_id = a.client_id
        AND s.report_date BETWEEN $2::date AND $3::date
       WHERE a.client_id = $1
         AND a.account_type = 'client'
         AND a.is_active = true
         ${scopeClause}
       GROUP BY a.id
       HAVING COALESCE(SUM(s.cost), 0) > 0
       ORDER BY spend DESC, a.descriptive_name ASC`,
      params
    );
    const payload = {
      start,
      end,
      accounts: (rows || []).map((r) => ({
        id: r.id,
        customerId: r.customer_id || '',
        descriptiveName: r.descriptive_name || r.customer_id || r.id,
        spend: Number(r.spend) || 0,
      })),
    };
    const scopeKey = allowed === null ? 'all' : [...allowed].sort().join(',');
    const cacheKey = roiFilterCacheKey('accounts', clientId, { start, end, spendOnly: true, scope: scopeKey });
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);
    return sendCachedJson(res, cacheKey, payload);
  } catch (err) {
    logger.error('ROI accounts list:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** GAM site hosts for ROI filter — manual inventory pick, not tied to Ads accounts. */
router.get('/roi-sites', async (req, res) => {
  try {
    const clientId = req.client?.id || req.user?.clientId;
    if (!clientId) return res.status(400).json({ error: 'No client context' });
    const { query } = require('../db');
    const { rows } = await query(
      `SELECT LOWER(TRIM(ds.name)) AS site_key,
              MAX(ds.name) AS site_name
       FROM dim_site ds
       WHERE ds.client_id = $1::uuid
         AND ds.id > 0
         AND NULLIF(TRIM(ds.name), '') IS NOT NULL
       GROUP BY 1
       ORDER BY site_name ASC`,
      [clientId]
    );
    const payload = {
      sites: (rows || []).map((r) => ({
        id: String(r.site_key || '').toLowerCase(),
        label: String(r.site_name || r.site_key || '').trim(),
      })).filter((s) => s.id),
    };
    const cacheKey = roiFilterCacheKey('sites', clientId, {});
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);
    return sendCachedJson(res, cacheKey, payload, 300);
  } catch (err) {
    logger.error('ROI sites list:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** Countries with Ads spend in range (for ROI country filter). */
router.get('/roi-countries', async (req, res) => {
  try {
    const clientId = req.client?.id || req.user?.clientId;
    if (!clientId) return res.status(400).json({ error: 'No client context' });
    const end = req.query.end || todayInTZ();
    const start = req.query.start || end;
    const accountIds = scopedAccountIds(req, parseAccountIdsQuery(req.query.accountIds)) || [];
    const campaignIds = String(req.query.campaignIds || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const { query } = require('../db');
    const { shiftYMD } = require('../utils/datetime');

    async function loadCountries(rangeStart, rangeEnd) {
      const params = [clientId, rangeStart, rangeEnd];
      let extra = '';
      if (accountIds.length) {
        params.push(accountIds);
        extra += ` AND s.ads_account_id = ANY($${params.length}::uuid[])`;
      }
      if (campaignIds.length) {
        params.push(campaignIds);
        extra += ` AND s.campaign_id = ANY($${params.length}::text[])`;
      }
      const { rows } = await query(
        `SELECT UPPER(TRIM(s.country_code)) AS country_code,
                MAX(s.country_name) AS country_name,
                COALESCE(SUM(s.cost), 0)::float8 AS spend
         FROM ads_spend_country_daily s
         WHERE s.client_id = $1
           AND s.report_date BETWEEN $2::date AND $3::date
           ${extra}
         GROUP BY 1
         ORDER BY spend DESC, country_name ASC`,
        params
      );
      return rows || [];
    }

    let rows = await loadCountries(start, end);
    let fallbackUsed = false;
    if (!rows.length) {
      const fbEnd = end;
      const fbStart = shiftYMD(end, -30);
      rows = await loadCountries(fbStart, fbEnd);
      fallbackUsed = rows.length > 0;
    }

    const payload = {
      start,
      end,
      fallbackUsed,
      countries: rows.map((r) => ({
        code: String(r.country_code || '').toUpperCase(),
        name: String(r.country_name || r.country_code || '').trim(),
        spend: Number(r.spend) || 0,
      })),
    };
    const cacheKey = roiFilterCacheKey('countries', clientId, { start, end, accountIds, campaignIds });
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);
    return sendCachedJson(res, cacheKey, payload);
  } catch (err) {
    logger.error('ROI countries list:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** App IDs linked to selected Ads accounts/campaigns (from Google Ads App Campaign settings). */
router.get('/roi-related-targets', async (req, res) => {
  try {
    const clientId = req.client?.id || req.user?.clientId;
    if (!clientId) return res.status(400).json({ error: 'No client context' });
    const end = req.query.end || todayInTZ();
    const start = req.query.start || end;
    const accountIds = scopedAccountIds(req, parseAccountIdsQuery(req.query.accountIds)) || [];
    const campaignIds = String(req.query.campaignIds || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const { query } = require('../db');

    async function loadAppsFromSpend() {
      const params = [clientId, start, end];
      let extra = '';
      if (accountIds.length) {
        params.push(accountIds);
        extra += ` AND s.ads_account_id = ANY($${params.length}::uuid[])`;
      }
      if (campaignIds.length) {
        params.push(campaignIds);
        extra += ` AND s.campaign_id = ANY($${params.length}::text[])`;
      }
      const { rows } = await query(
        `SELECT LOWER(TRIM(s.app_id)) AS app_id,
                COUNT(DISTINCT s.campaign_id)::int AS campaign_count,
                COALESCE(SUM(s.cost), 0)::float8 AS spend
         FROM ads_spend_daily s
         WHERE s.client_id = $1
           AND s.report_date BETWEEN $2::date AND $3::date
           AND NULLIF(TRIM(s.app_id), '') IS NOT NULL
           ${extra}
         GROUP BY LOWER(TRIM(s.app_id))
         ORDER BY spend DESC, app_id ASC`,
        params
      );
      return (rows || []).map((r) => ({
        id: r.app_id,
        label: r.app_id,
        campaignCount: r.campaign_count,
        spend: Number(r.spend) || 0,
      }));
    }

    let apps = await loadAppsFromSpend();

    // App ID backfill runs during Ads sync — never block filter dropdowns on live API calls.
    const mapParams = [clientId];
    let mapExtra = '';
    if (accountIds.length) {
      mapParams.push(accountIds);
      mapExtra += ` AND m.ads_account_id = ANY($${mapParams.length}::uuid[])`;
    }
    if (campaignIds.length) {
      mapParams.push(campaignIds);
      mapExtra += ` AND m.campaign_id = ANY($${mapParams.length}::text[])`;
    }
    const { rows: mapRows } = await query(
      `SELECT m.target_type, LOWER(TRIM(m.target_key)) AS target_key,
              COUNT(*)::int AS map_count
       FROM ads_campaign_map m
       WHERE m.client_id = $1
         AND NULLIF(TRIM(m.target_key), '') IS NOT NULL
         ${mapExtra}
       GROUP BY m.target_type, LOWER(TRIM(m.target_key))
       ORDER BY map_count DESC, target_key ASC`,
      mapParams
    );

    const appById = new Map(apps.map((a) => [a.id, a]));
    (mapRows || []).forEach((r) => {
      const key = r.target_key;
      if (!key) return;
      if (r.target_type === 'app' && !appById.has(key)) {
        appById.set(key, { id: key, label: key, campaignCount: r.map_count, spend: 0 });
      }
    });

    const payload = { start, end, apps: [...appById.values()], sites: [] };
    const cacheKey = roiFilterCacheKey('related-targets', clientId, { start, end, accountIds, campaignIds });
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);
    return sendCachedJson(res, cacheKey, payload);
  } catch (err) {
    logger.error('ROI related targets:', err.message);
    res.status(500).json({ error: err.message });
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

    // Large account sets: queue per-account jobs so one failure does not block the rest.
    const QUEUE_THRESHOLD = 5;
    if (syncable.length >= QUEUE_THRESHOLD) {
      const { adsSyncQueue } = require('../queues/adsSync');
      const { accounts: queued } = await enqueueAdsSyncAccounts(req.client, adsSyncQueue, {
        startDate: start,
        endDate: end,
        jobIdPrefix: `ads-sync-manual-${req.client.id.slice(0, 8)}-${Date.now()}`,
      });
      logger.info(`Ads sync queued ${queued} account job(s) ${start}→${end}`);
      return res.json({
        ok: true,
        queued: true,
        accounts: queued,
        total: 0,
        start,
        end,
        message: `Spend sync started in the background for ${queued} account(s). Check back in a few minutes, then map campaigns.`,
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
    const { formatAdsSyncError } = require('../services/adsSyncService');
    const message = formatAdsSyncError(err);
    logger.error('Ads account sync:', message);
    res.status(500).json({ error: message });
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
