/**
 * Google Ads API client (advertiser spend) — separate from GAM SOAP.
 * Uses google-ads-api + OAuth refresh tokens stored on ads_accounts.
 */
const { google } = require('googleapis');
const { GoogleAdsApi, fromMicros } = require('google-ads-api');
const { Service } = require('google-ads-api/build/src/service');
const logger = require('../utils/logger');
const { getClient } = require('../utils/clientContext');
const { normalizeCurrency, getUnitsPerUsd, refreshFxRates } = require('../utils/adsCurrency');

// google-ads-api v24: getGoogleAdsError throws when metadata.internalRepr is missing.
const origGetGoogleAdsError = Service.prototype.getGoogleAdsError;
Service.prototype.getGoogleAdsError = function patchedGetGoogleAdsError(error) {
  if (!error?.metadata?.internalRepr?.get) return error;
  return origGetGoogleAdsError.call(this, error);
};

const ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';

function adsRedirectUri() {
  if (process.env.GOOGLE_ADS_REDIRECT_URI) {
    return String(process.env.GOOGLE_ADS_REDIRECT_URI).trim();
  }
  const gamRedirect = String(process.env.GOOGLE_REDIRECT_URI || '').trim();
  if (gamRedirect) {
    return gamRedirect.replace(/\/auth\/callback\/?$/, '/auth/ads/callback');
  }
  const port = process.env.PORT || 3001;
  return `http://localhost:${port}/auth/ads/callback`;
}

function resolveOAuthApp(gamClient = getClient()) {
  const adsClientId = String(process.env.GOOGLE_ADS_CLIENT_ID || '').trim();
  const adsClientSecret = String(process.env.GOOGLE_ADS_CLIENT_SECRET || '').trim();
  if (adsClientId && adsClientSecret) {
    return {
      clientId: adsClientId,
      clientSecret: adsClientSecret,
      redirectUri: adsRedirectUri(),
      source: 'ads-env',
    };
  }
  return {
    clientId: gamClient?.googleClientId || process.env.GOOGLE_CLIENT_ID,
    clientSecret: gamClient?.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: adsRedirectUri(),
    source: 'gam',
  };
}

function isAdsOAuthConfigured(gamClient = getClient()) {
  const adsClientId = String(process.env.GOOGLE_ADS_CLIENT_ID || '').trim();
  const adsClientSecret = String(process.env.GOOGLE_ADS_CLIENT_SECRET || '').trim();
  if (adsClientId && adsClientSecret) return true;
  const client = gamClient || getClient();
  return Boolean(
    String(client?.googleClientId || process.env.GOOGLE_CLIENT_ID || '').trim()
    && String(client?.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET || '').trim()
  );
}

function getAdsOAuthClient(gamClient) {
  const { clientId, clientSecret, redirectUri } = resolveOAuthApp(gamClient);
  if (!clientId || !clientSecret) {
    throw new Error(
      'Google Ads OAuth client ID/secret missing. Set GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET in .env '
      + '(from your Google Ads Cloud project), or configure GAM OAuth as fallback.'
    );
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function developerToken() {
  const t = String(process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '').trim();
  if (!t) throw new Error('GOOGLE_ADS_DEVELOPER_TOKEN is not set');
  return t;
}

function createAdsApi(gamClient) {
  const { clientId, clientSecret } = resolveOAuthApp(gamClient);
  return new GoogleAdsApi({
    client_id: clientId,
    client_secret: clientSecret,
    developer_token: developerToken(),
  });
}

function customerClient(adsApi, { customerId, refreshToken, loginCustomerId }) {
  const opts = {
    customer_id: String(customerId).replace(/-/g, ''),
    refresh_token: refreshToken,
  };
  if (loginCustomerId) {
    opts.login_customer_id = String(loginCustomerId).replace(/-/g, '');
  }
  return adsApi.Customer(opts);
}

/** google-ads-api v24: surface Google Ads failures instead of masking them. */
async function gaqlQuery(customer, gaql) {
  return customer.query(gaql);
}

async function listAccessibleCustomerIds(gamClient, refreshToken) {
  const api = createAdsApi(gamClient);
  const response = await api.listAccessibleCustomers(refreshToken);
  const resourceNames = Array.isArray(response)
    ? response
    : (response?.resource_names || response?.resourceNames || []);
  return (resourceNames || [])
    .map((rn) => String(rn).replace(/^customers\//, '').replace(/-/g, ''))
    .filter(Boolean);
}

async function fetchCustomerInfo(gamClient, { customerId, refreshToken, loginCustomerId }) {
  const api = createAdsApi(gamClient);
  const customer = customerClient(api, { customerId, refreshToken, loginCustomerId });
  const rows = await gaqlQuery(customer, `
    SELECT customer.id, customer.descriptive_name, customer.manager, customer.currency_code
    FROM customer
    LIMIT 1
  `);
  const row = rows?.[0]?.customer || rows?.[0] || {};
  return {
    customerId: String(row.id || customerId).replace(/-/g, ''),
    descriptiveName: row.descriptive_name || String(customerId),
    isManager: !!row.manager,
    currency: row.currency_code || 'USD',
  };
}

/** List client accounts under an MCC (one level). */
async function listMccChildAccounts(gamClient, { mccCustomerId, refreshToken }) {
  const api = createAdsApi(gamClient);
  const customer = customerClient(api, {
    customerId: mccCustomerId,
    refreshToken,
    loginCustomerId: mccCustomerId,
  });
  const rows = await gaqlQuery(customer, `
    SELECT
      customer_client.client_customer,
      customer_client.descriptive_name,
      customer_client.id,
      customer_client.manager,
      customer_client.status
    FROM customer_client
    WHERE customer_client.level = 1
  `);
  return (rows || []).map((r) => {
    const cc = r.customer_client || r;
    const id = String(cc.id || '').replace(/-/g, '');
    return {
      customerId: id,
      descriptiveName: cc.descriptive_name || id,
      isManager: !!cc.manager,
      status: cc.status,
    };
  }).filter((a) => a.customerId && !a.isManager);
}

async function fetchCampaignSpend(gamClient, {
  customerId,
  refreshToken,
  loginCustomerId,
  startDate,
  endDate,
}) {
  const api = createAdsApi(gamClient);
  const customer = customerClient(api, { customerId, refreshToken, loginCustomerId });

  let accountCurrency = 'USD';
  const forced = String(process.env.ADS_FORCE_CURRENCY || '').trim().toUpperCase();
  if (forced.length === 3) {
    accountCurrency = normalizeCurrency(forced);
  } else {
    try {
      const info = await fetchCustomerInfo(gamClient, { customerId, refreshToken, loginCustomerId });
      accountCurrency = normalizeCurrency(info.currency || 'USD');
    } catch (e) {
      logger.warn(`Ads currency lookup failed for ${customerId}: ${e.message}`);
    }
  }

  let unitsPerUsd = 1;
  if (accountCurrency !== 'USD') {
    await refreshFxRates().catch(() => null);
    unitsPerUsd = await getUnitsPerUsd(accountCurrency);
  }
  const toUsdSync = (native) => {
    const n = Number(native) || 0;
    if (accountCurrency === 'USD' || !n || !(unitsPerUsd > 0)) {
      return { usd: n, native: n, nativeCurrency: accountCurrency };
    }
    return {
      usd: Math.round((n / unitsPerUsd) * 1e6) / 1e6,
      native: n,
      nativeCurrency: accountCurrency,
    };
  };

  const rows = await gaqlQuery(customer, `
    SELECT
      campaign.id,
      campaign.name,
      campaign.app_campaign_setting.app_id,
      campaign.app_campaign_setting.app_store,
      segments.date,
      metrics.cost_micros,
      metrics.clicks,
      metrics.impressions,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
  `);

  const out = [];
  for (const r of rows || []) {
    const campaign = r.campaign || {};
    const segments = r.segments || {};
    const metrics = r.metrics || {};
    const appSetting = campaign.app_campaign_setting || campaign.appCampaignSetting || {};
    const costMicros = Number(metrics.cost_micros) || 0;
    const nativeCost = typeof fromMicros === 'function' ? fromMicros(costMicros) : costMicros / 1e6;
    const nativeConvVal = Number(metrics.conversions_value) || 0;
    const costFx = toUsdSync(nativeCost);
    const convFx = toUsdSync(nativeConvVal);
    const campaignId = String(campaign.id || '');
    const reportDate = segments.date;
    if (!campaignId || !reportDate) continue;
    const rawAppId = String(appSetting.app_id || appSetting.appId || '').trim();
    out.push({
      campaignId,
      campaignName: campaign.name || '',
      appId: rawAppId,
      reportDate,
      cost: costFx.usd,
      costNative: costFx.native,
      nativeCurrency: costFx.nativeCurrency,
      clicks: Number(metrics.clicks) || 0,
      impressions: Number(metrics.impressions) || 0,
      conversions: Number(metrics.conversions) || 0,
      conversionValue: convFx.usd,
      currency: 'USD',
      accountCurrency,
    });
  }
  if (accountCurrency !== 'USD') {
    logger.info(
      `Ads spend FX ${customerId}: ${accountCurrency}→USD at ${unitsPerUsd} ${accountCurrency}/USD`
    );
  }
  return out;
}

/** Resolve geo target criterion IDs → country code + display name. */
async function fetchGeoTargetCountries(customer, criterionIds = []) {
  const ids = [...new Set((criterionIds || []).map((id) => Number(id)).filter((n) => n > 0))];
  const map = new Map();
  if (!ids.length) return map;

  const chunkSize = 200;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const inList = chunk.join(', ');
    const rows = await gaqlQuery(customer, `
      SELECT
        geo_target_constant.id,
        geo_target_constant.name,
        geo_target_constant.country_code,
        geo_target_constant.canonical_name
      FROM geo_target_constant
      WHERE geo_target_constant.id IN (${inList})
    `);
    for (const r of rows || []) {
      const g = r.geo_target_constant || r.geoTargetConstant || r;
      const id = Number(g.id);
      if (!id) continue;
      const code = String(g.country_code || g.countryCode || '').trim().toUpperCase();
      const name = String(g.canonical_name || g.canonicalName || g.name || '').trim()
        || String(g.name || '').trim();
      map.set(id, {
        countryCode: code || String(id),
        countryName: name || code || String(id),
      });
    }
  }
  return map;
}

/** Campaign spend broken down by user country (from user_location_view). */
async function fetchCampaignSpendByCountry(gamClient, {
  customerId,
  refreshToken,
  loginCustomerId,
  startDate,
  endDate,
  campaignAppIds = [],
}) {
  const api = createAdsApi(gamClient);
  const customer = customerClient(api, { customerId, refreshToken, loginCustomerId });

  let accountCurrency = 'USD';
  const forced = String(process.env.ADS_FORCE_CURRENCY || '').trim().toUpperCase();
  if (forced.length === 3) {
    accountCurrency = normalizeCurrency(forced);
  } else {
    try {
      const info = await fetchCustomerInfo(gamClient, { customerId, refreshToken, loginCustomerId });
      accountCurrency = normalizeCurrency(info.currency || 'USD');
    } catch (e) {
      logger.warn(`Ads currency lookup failed for ${customerId}: ${e.message}`);
    }
  }

  let unitsPerUsd = 1;
  if (accountCurrency !== 'USD') {
    await refreshFxRates().catch(() => null);
    unitsPerUsd = await getUnitsPerUsd(accountCurrency);
  }
  const toUsdSync = (native) => {
    const n = Number(native) || 0;
    if (accountCurrency === 'USD' || !n || !(unitsPerUsd > 0)) {
      return { usd: n, native: n, nativeCurrency: accountCurrency };
    }
    return {
      usd: Math.round((n / unitsPerUsd) * 1e6) / 1e6,
      native: n,
      nativeCurrency: accountCurrency,
    };
  };

  const appByCampaign = new Map(
    (campaignAppIds || []).map((c) => [String(c.campaignId || ''), String(c.appId || '').trim()])
  );

  const rows = await gaqlQuery(customer, `
    SELECT
      campaign.id,
      campaign.name,
      user_location_view.country_criterion_id,
      segments.date,
      metrics.cost_micros,
      metrics.clicks,
      metrics.impressions,
      metrics.conversions,
      metrics.conversions_value
    FROM user_location_view
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
  `);

  const criterionIds = (rows || []).map((r) => {
    const ulv = r.user_location_view || r.userLocationView || {};
    return Number(ulv.country_criterion_id || ulv.countryCriterionId);
  }).filter((n) => n > 0);
  const geoMap = await fetchGeoTargetCountries(customer, criterionIds);

  const out = [];
  for (const r of rows || []) {
    const campaign = r.campaign || {};
    const ulv = r.user_location_view || r.userLocationView || {};
    const segments = r.segments || {};
    const metrics = r.metrics || {};
    const criterionId = Number(ulv.country_criterion_id || ulv.countryCriterionId) || 0;
    const geo = geoMap.get(criterionId) || {
      countryCode: criterionId ? String(criterionId) : '',
      countryName: criterionId ? `Country ${criterionId}` : '',
    };
    const costMicros = Number(metrics.cost_micros) || 0;
    const nativeCost = typeof fromMicros === 'function' ? fromMicros(costMicros) : costMicros / 1e6;
    const nativeConvVal = Number(metrics.conversions_value) || 0;
    const costFx = toUsdSync(nativeCost);
    const convFx = toUsdSync(nativeConvVal);
    const campaignId = String(campaign.id || '');
    const reportDate = segments.date;
    if (!campaignId || !reportDate || !geo.countryCode) continue;
    out.push({
      campaignId,
      campaignName: campaign.name || '',
      appId: appByCampaign.get(campaignId) || '',
      countryCode: geo.countryCode,
      countryName: geo.countryName,
      reportDate,
      cost: costFx.usd,
      costNative: costFx.native,
      nativeCurrency: costFx.nativeCurrency,
      clicks: Number(metrics.clicks) || 0,
      impressions: Number(metrics.impressions) || 0,
      conversions: Number(metrics.conversions) || 0,
      conversionValue: convFx.usd,
      currency: 'USD',
      accountCurrency,
    });
  }
  if (accountCurrency !== 'USD' && out.length) {
    logger.info(
      `Ads country spend FX ${customerId}: ${accountCurrency}→USD at ${unitsPerUsd} ${accountCurrency}/USD`
    );
  }
  return out;
}

/** Campaign → app package / store id for App campaigns (no date segments). */
async function fetchCampaignAppIds(gamClient, { customerId, refreshToken, loginCustomerId }) {
  const api = createAdsApi(gamClient);
  const customer = customerClient(api, { customerId, refreshToken, loginCustomerId });
  const rows = await gaqlQuery(customer, `
    SELECT
      campaign.id,
      campaign.name,
      campaign.app_campaign_setting.app_id,
      campaign.app_campaign_setting.app_store
    FROM campaign
    WHERE campaign.app_campaign_setting.app_id IS NOT NULL
  `);
  const out = [];
  for (const r of rows || []) {
    const campaign = r.campaign || r;
    const appSetting = campaign.app_campaign_setting || campaign.appCampaignSetting || {};
    const campaignId = String(campaign.id || '');
    const appId = String(appSetting.app_id || appSetting.appId || '').trim();
    if (!campaignId || !appId) continue;
    out.push({
      campaignId,
      campaignName: campaign.name || '',
      appId,
      appStore: appSetting.app_store || appSetting.appStore || null,
    });
  }
  return out;
}

async function listCampaigns(gamClient, { customerId, refreshToken, loginCustomerId }) {
  const api = createAdsApi(gamClient);
  const customer = customerClient(api, { customerId, refreshToken, loginCustomerId });
  const rows = await gaqlQuery(customer, `
    SELECT campaign.id, campaign.name, campaign.status
    FROM campaign
    ORDER BY campaign.name
  `);
  return (rows || []).map((r) => {
    const c = r.campaign || r;
    return {
      campaignId: String(c.id || ''),
      campaignName: c.name || '',
      status: c.status,
    };
  }).filter((c) => c.campaignId);
}

module.exports = {
  ADS_SCOPE,
  adsRedirectUri,
  isAdsOAuthConfigured,
  getAdsOAuthClient,
  resolveOAuthApp,
  createAdsApi,
  listAccessibleCustomerIds,
  fetchCustomerInfo,
  listMccChildAccounts,
  fetchCampaignSpend,
  fetchCampaignSpendByCountry,
  fetchCampaignAppIds,
  listCampaigns,
  developerToken,
};
