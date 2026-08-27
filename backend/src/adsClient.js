/**
 * Google Ads API client (advertiser spend) — separate from GAM SOAP.
 * Uses google-ads-api + OAuth refresh tokens stored on ads_accounts.
 */
const { google } = require('googleapis');
const { GoogleAdsApi, fromMicros } = require('google-ads-api');
const { Service } = require('google-ads-api/build/src/service');
const logger = require('./utils/logger');
const { getClient } = require('./utils/clientContext');

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
  const rows = await gaqlQuery(customer, `
    SELECT
      campaign.id,
      campaign.name,
      segments.date,
      metrics.cost_micros,
      metrics.clicks,
      metrics.impressions,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
  `);

  return (rows || []).map((r) => {
    const campaign = r.campaign || {};
    const segments = r.segments || {};
    const metrics = r.metrics || {};
    const costMicros = Number(metrics.cost_micros) || 0;
    return {
      campaignId: String(campaign.id || ''),
      campaignName: campaign.name || '',
      reportDate: segments.date,
      cost: typeof fromMicros === 'function' ? fromMicros(costMicros) : costMicros / 1e6,
      clicks: Number(metrics.clicks) || 0,
      impressions: Number(metrics.impressions) || 0,
      conversions: Number(metrics.conversions) || 0,
      conversionValue: Number(metrics.conversions_value) || 0,
      currency: 'USD',
    };
  }).filter((r) => r.campaignId && r.reportDate);
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
  listCampaigns,
  developerToken,
};
