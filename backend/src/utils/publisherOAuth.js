/**
 * Shared OAuth helpers for AdMob / AdSense publisher products.
 */
const { google } = require('googleapis');
const { getClient } = require('../utils/clientContext');

function productRedirectUri(product) {
  const envKey = product === 'admob'
    ? 'GOOGLE_ADMOB_REDIRECT_URI'
    : 'GOOGLE_ADSENSE_REDIRECT_URI';
  if (process.env[envKey]) {
    return String(process.env[envKey]).trim();
  }
  const gamRedirect = String(process.env.GOOGLE_REDIRECT_URI || '').trim();
  if (gamRedirect) {
    return gamRedirect.replace(/\/auth\/callback\/?$/, `/auth/${product}/callback`);
  }
  const port = process.env.PORT || 3001;
  return `http://localhost:${port}/auth/${product}/callback`;
}

function resolvePublisherOAuthApp(product, gamClient = getClient()) {
  const prefix = product === 'admob' ? 'GOOGLE_ADMOB' : 'GOOGLE_ADSENSE';
  const productClientId = String(process.env[`${prefix}_CLIENT_ID`] || '').trim();
  const productClientSecret = String(process.env[`${prefix}_CLIENT_SECRET`] || '').trim();
  if (productClientId && productClientSecret) {
    return {
      clientId: productClientId,
      clientSecret: productClientSecret,
      redirectUri: productRedirectUri(product),
      source: `${product}-env`,
    };
  }
  // Fall back to shared Google OAuth app (same Cloud project as GAM).
  return {
    clientId: gamClient?.googleClientId || process.env.GOOGLE_CLIENT_ID,
    clientSecret: gamClient?.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: productRedirectUri(product),
    source: 'gam',
  };
}

function isPublisherOAuthConfigured(product, gamClient = getClient()) {
  const app = resolvePublisherOAuthApp(product, gamClient);
  return Boolean(String(app.clientId || '').trim() && String(app.clientSecret || '').trim());
}

function getPublisherOAuthClient(product, gamClient) {
  const { clientId, clientSecret, redirectUri } = resolvePublisherOAuthApp(product, gamClient);
  if (!clientId || !clientSecret) {
    throw new Error(
      `${product === 'admob' ? 'AdMob' : 'AdSense'} OAuth client ID/secret missing. `
      + `Set GOOGLE_${product === 'admob' ? 'ADMOB' : 'ADSENSE'}_CLIENT_ID/SECRET `
      + 'or configure GAM Google OAuth as fallback.'
    );
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function authClientFromRefresh(product, gamClient, refreshToken) {
  const oauth2 = getPublisherOAuthClient(product, gamClient);
  oauth2.setCredentials({ refresh_token: refreshToken });
  return oauth2;
}

module.exports = {
  productRedirectUri,
  resolvePublisherOAuthApp,
  isPublisherOAuthConfigured,
  getPublisherOAuthClient,
  authClientFromRefresh,
};
