/**
 * Discover GAM networks for a Google account (no network code required).
 * Uses NetworkService.getAllNetworks — RequestHeader.networkCode is optional for this call.
 */
const axios = require('axios');
const { google } = require('googleapis');
const { GAM_API_VERSION } = require('../utils/gamVersion');
const logger = require('../utils/logger');

function envGamOAuthApp() {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || '').trim();
  const redirectUri = String(process.env.GOOGLE_REDIRECT_URI || '').trim()
    || `http://localhost:${process.env.PORT || 3001}/auth/callback`;
  return { clientId, clientSecret, redirectUri };
}

function isGamOAuthConfigured() {
  const { clientId, clientSecret } = envGamOAuthApp();
  return Boolean(clientId && clientSecret);
}

function getEnvOAuthClient() {
  const { clientId, clientSecret, redirectUri } = envGamOAuthApp();
  if (!clientId || !clientSecret) {
    throw new Error(
      'GAM OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in backend .env.'
    );
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/** OAuth2 client preferring env app credentials, falling back to gam_clients row. */
function getConnectOAuthClient(client) {
  if (isGamOAuthConfigured()) return getEnvOAuthClient();
  if (client?.googleClientId && client?.googleClientSecret) {
    const { getOAuthClient } = require('../gam/client');
    return getOAuthClient(client);
  }
  throw new Error(
    'GAM OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in backend .env.'
  );
}

function extractAllTag(xml, tag) {
  const out = [];
  const re = new RegExp(`<(?:[^:>]+:)?${tag}[^>]*>([^<]*)<\\/(?:[^:>]+:)?${tag}>`, 'gi');
  let m;
  while ((m = re.exec(String(xml || ''))) !== null) {
    const v = (m[1] || '').trim();
    if (v) out.push(v);
  }
  return out;
}

/**
 * List all Ad Manager networks the refresh token can access.
 * @returns {Promise<Array<{ networkCode: string, displayName: string, currencyCode?: string, timeZone?: string }>>}
 */
async function listAccessibleNetworks({ refreshToken, oauthClient }) {
  if (!refreshToken) throw new Error('refreshToken required');
  const auth = oauthClient || getEnvOAuthClient();
  auth.setCredentials({ refresh_token: refreshToken });
  const tokenObj = await auth.getAccessToken();
  const token = tokenObj?.token || tokenObj;
  if (!token) throw new Error('Could not obtain Google access token');

  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:dfp="https://www.google.com/apis/ads/publisher/${GAM_API_VERSION}">
  <soapenv:Header>
    <dfp:RequestHeader>
      <dfp:applicationName>AdNexus</dfp:applicationName>
    </dfp:RequestHeader>
  </soapenv:Header>
  <soapenv:Body><dfp:getAllNetworks></dfp:getAllNetworks></soapenv:Body>
</soapenv:Envelope>`;

  const res = await axios.post(
    `https://ads.google.com/apis/ads/publisher/${GAM_API_VERSION}/NetworkService`,
    envelope,
    {
      headers: {
        'Content-Type': 'text/xml; charset=UTF-8',
        Authorization: `Bearer ${token}`,
      },
      timeout: 60000,
    }
  );

  const xml = String(res.data || '');
  // Each network is typically a <rval> / <results> block; parse by pairing codes with names.
  const blocks = [];
  const blockRe = /<(?:[^:>]+:)?(?:rval|results|Network)[^>]*>([\s\S]*?)<\/(?:[^:>]+:)?(?:rval|results|Network)>/gi;
  let bm;
  while ((bm = blockRe.exec(xml)) !== null) {
    blocks.push(bm[1]);
  }

  const networks = [];
  const seen = new Set();
  const pushNet = (code, name, currency, tz) => {
    const networkCode = String(code || '').trim();
    if (!networkCode || seen.has(networkCode)) return;
    seen.add(networkCode);
    networks.push({
      networkCode,
      displayName: String(name || networkCode).trim() || networkCode,
      currencyCode: currency || null,
      timeZone: tz || null,
    });
  };

  if (blocks.length) {
    for (const block of blocks) {
      const code = extractAllTag(block, 'networkCode')[0];
      if (!code) continue;
      pushNet(
        code,
        extractAllTag(block, 'displayName')[0],
        extractAllTag(block, 'currencyCode')[0],
        extractAllTag(block, 'timeZone')[0]
      );
    }
  } else {
    // Flat response fallback: zip parallel tag lists
    const codes = extractAllTag(xml, 'networkCode');
    const names = extractAllTag(xml, 'displayName');
    const currencies = extractAllTag(xml, 'currencyCode');
    const zones = extractAllTag(xml, 'timeZone');
    codes.forEach((code, i) => pushNet(code, names[i], currencies[i], zones[i]));
  }

  if (!networks.length) {
    logger.warn('getAllNetworks returned no networks');
  }
  return networks;
}

async function kickGamInventorySync(client) {
  if (!client?.id) return false;
  try {
    const { gamSyncQueue, isSyncQueueEnabled } = require('../queues/gamSync');
    const { todayInTZ, shiftYMD, listCalendarMonthsNewestFirst } = require('../utils/datetime');
    if (!isSyncQueueEnabled()) {
      logger.info('GAM inventory sync kick skipped — sync queue disabled');
      return false;
    }
    const end = todayInTZ();
    const start = shiftYMD(end, -30);
    const cid = String(client.id).slice(0, 8);
    await gamSyncQueue.add('sync-today', {
      date: end,
      includeFull: false,
      clientId: client.id,
    }, {
      jobId: `sync-today-${cid}-${end}`.slice(0, 120),
      priority: 1,
    });
    const pastEnd = shiftYMD(end, -1);
    if (start <= pastEnd) {
      const months = listCalendarMonthsNewestFirst
        ? listCalendarMonthsNewestFirst(start, pastEnd)
        : [{ startDate: start, endDate: pastEnd }];
      for (let i = 0; i < months.length; i += 1) {
        const { startDate: ms, endDate: me } = months[i];
        await gamSyncQueue.add('sync-backfill', {
          startDate: ms,
          endDate: me,
          includeFull: false,
          clientId: client.id,
        }, {
          jobId: `sync-month-${cid}-${ms}-${me}`.slice(0, 120),
          priority: 3 + i,
        });
      }
    }
    logger.info(`GAM inventory sync enqueued after OAuth for client ${client.id}`);
    return true;
  } catch (e) {
    logger.warn(`GAM inventory sync kick failed: ${e.message}`);
    return false;
  }
}

module.exports = {
  envGamOAuthApp,
  isGamOAuthConfigured,
  getEnvOAuthClient,
  getConnectOAuthClient,
  listAccessibleNetworks,
  kickGamInventorySync,
};
