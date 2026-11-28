/**
 * Ad Insights — apps, creative assets and keywords for the Google Ads accounts a user may see.
 * Admins see every account of the active client; domain users only their granted accounts
 * (and only with the "My Google Ads" permission).
 */
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { listAccounts, getAccountById } = require('../models/adsAccountStore');
const { resolveRefreshForAccount } = require('../services/adsSyncService');
const { getAllowedAdsAccountIds, hasFlag, isAdmin } = require('../utils/permissions');
const insights = require('../ads/insights');
const logger = require('../utils/logger');
const { cache } = require('../gam/client');

const TTL = Math.max(30, parseInt(process.env.AD_INSIGHTS_CACHE_TTL || '300', 10) || 300);

router.use(requireAuth);

router.use((req, res, next) => {
  if (!isAdmin(req.user) && !hasFlag(req.user, 'canAccessMyAds')) {
    return res.status(403).json({ error: 'You do not have access to Ad Insights.' });
  }
  return next();
});

function clientIdOf(req) {
  return req.client?.id || req.user?.clientId;
}

/** Account the caller may read, with a usable refresh token. Sends the error response itself. */
async function resolveAccount(req, res) {
  const id = String(req.query.accountId || '').trim();
  if (!id) {
    res.status(400).json({ error: 'accountId is required' });
    return null;
  }
  const allowed = getAllowedAdsAccountIds(req.user);
  if (allowed !== null && !allowed.includes(id)) {
    res.status(404).json({ error: 'Account not found' });
    return null;
  }
  const account = await getAccountById(id);
  if (!account || account.clientId !== clientIdOf(req)) {
    res.status(404).json({ error: 'Account not found' });
    return null;
  }
  if (account.accountType === 'mcc') {
    res.status(400).json({ error: 'Pick a client account — manager (MCC) accounts have no ads of their own.' });
    return null;
  }
  const refreshToken = await resolveRefreshForAccount(account);
  if (!refreshToken) {
    res.status(400).json({ error: 'This account is not connected. Reconnect it from Google Ads.' });
    return null;
  }
  return { account, refreshToken };
}

async function cached(key, loader) {
  const hit = cache.get(key);
  if (hit) return hit;
  const value = await loader();
  cache.set(key, value, TTL);
  return value;
}

function fail(res, err, label) {
  const message = err?.errors?.[0]?.message || err?.message || 'Google Ads request failed';
  logger.error(`Ad Insights ${label}: ${message}`);
  return res.status(500).json({ error: message });
}

router.get('/accounts', async (req, res) => {
  try {
    const all = await listAccounts(clientIdOf(req));
    const allowed = getAllowedAdsAccountIds(req.user);
    const accounts = all
      .filter((a) => a.accountType !== 'mcc' && a.isActive)
      .filter((a) => allowed === null || allowed.includes(String(a.id)))
      .map((a) => ({
        id: a.id,
        customerId: a.customerId,
        name: a.descriptiveName || a.customerId,
        currency: a.currencyCode,
      }));
    res.json({ accounts });
  } catch (err) {
    fail(res, err, 'accounts');
  }
});

router.get('/apps', async (req, res) => {
  try {
    const r = await resolveAccount(req, res);
    if (!r) return;
    const days = req.query.days;
    const key = `adins_apps_${r.account.id}_${days}`;
    const data = await cached(key, async () => ({
      currency: await insights.fetchCurrency(req.client, r.account, r.refreshToken),
      apps: await insights.fetchApps(req.client, r.account, r.refreshToken, { days }),
    }));
    res.json(data);
  } catch (err) {
    fail(res, err, 'apps');
  }
});

router.get('/assets', async (req, res) => {
  try {
    const r = await resolveAccount(req, res);
    if (!r) return;
    const { days, campaignId } = req.query;
    const key = `adins_assets_${r.account.id}_${days}_${campaignId || ''}`;
    const assets = await cached(key, () => insights.fetchAssets(
      req.client, r.account, r.refreshToken, { days, campaignId },
    ));
    res.json({ assets });
  } catch (err) {
    fail(res, err, 'assets');
  }
});

router.get('/keywords', async (req, res) => {
  try {
    const r = await resolveAccount(req, res);
    if (!r) return;
    const { days, campaignId } = req.query;
    const key = `adins_kw_${r.account.id}_${days}_${campaignId || ''}`;
    const data = await cached(key, async () => {
      // Independent queries: a failure in one (e.g. no search campaigns) must not hide the other.
      const [kw, st] = await Promise.allSettled([
        insights.fetchKeywords(req.client, r.account, r.refreshToken, { days, campaignId }),
        insights.fetchSearchTerms(req.client, r.account, r.refreshToken, { days, campaignId }),
      ]);
      return {
        keywords: kw.status === 'fulfilled' ? kw.value : [],
        searchTerms: st.status === 'fulfilled' ? st.value : [],
        warnings: [kw, st]
          .filter((x) => x.status === 'rejected')
          .map((x) => x.reason?.errors?.[0]?.message || x.reason?.message || 'query failed'),
      };
    });
    res.json(data);
  } catch (err) {
    fail(res, err, 'keywords');
  }
});

module.exports = router;
