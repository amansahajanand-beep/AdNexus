const express = require('express');
const router = express.Router();
const { cache } = require('../gam/client');
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const { getVersionStatus } = require('../utils/gamVersion');
const { classifyGoogleAuthError } = require('../utils/googleAuthErrors');
const { query } = require('../db');

const { isMockClient, getClient, getClientId, tenantKey } = require('../utils/clientContext');

router.use(requireAuth);

async function loadSyncFreshness() {
  const clientId = getClientId();
  if (!clientId) return { gamLastSyncedAt: null, adsLastSyncedAt: null };
  let gamLastSyncedAt = null;
  let adsLastSyncedAt = null;
  try {
    const { rows } = await query(
      `SELECT MAX(finished_at) AS t
       FROM sync_log
       WHERE client_id = $1
         AND finished_at IS NOT NULL
         AND COALESCE(status, '') NOT ILIKE '%fail%'
         AND COALESCE(status, '') NOT ILIKE '%error%'`,
      [clientId]
    );
    gamLastSyncedAt = rows[0]?.t || null;
  } catch (e) {
    logger.warn('sync_log freshness:', e.message);
  }
  if (!gamLastSyncedAt) {
    try {
      const { rows } = await query(
        `SELECT MAX(synced_at) AS t FROM report_grain WHERE client_id = $1`,
        [clientId]
      );
      gamLastSyncedAt = rows[0]?.t || null;
    } catch (e) {
      logger.warn('report_grain freshness:', e.message);
    }
  }
  try {
    const { rows } = await query(
      `SELECT MAX(last_sync_at) AS t FROM ads_accounts WHERE client_id = $1`,
      [clientId]
    );
    adsLastSyncedAt = rows[0]?.t || null;
  } catch (e) {
    logger.warn('ads_accounts freshness:', e.message);
  }
  return {
    gamLastSyncedAt: gamLastSyncedAt ? new Date(gamLastSyncedAt).toISOString() : null,
    adsLastSyncedAt: adsLastSyncedAt ? new Date(adsLastSyncedAt).toISOString() : null,
  };
}

router.get('/info', async (req, res) => {
  // Always surface the API-version deprecation status so the UI can warn early.
  const gamVersion = getVersionStatus();
  const freshness = await loadSyncFreshness();

  if (isMockClient()) {
    return res.json({
      networkCode: '123456789',
      displayName: 'Demo Network (Mock Mode)',
      currencyCode: 'INR',
      timeZone: 'Asia/Kolkata',
      isMock: true,
      gamVersion,
      ...freshness,
    });
  }

  const cached = cache.get(tenantKey('network_info'));
  if (cached) return res.json({ ...cached, isMock: false, gamVersion, ...freshness });

  try {
    const { getGAMClient } = require('../gam/client');
    const auth = await getGAMClient();
    const tokenObj = await auth.getAccessToken();
    const token = tokenObj.token;
    const axios = require('axios');
    const { GAM_API_VERSION: API_VER } = require('../utils/gamVersion');
    const NETWORK_CODE = getClient()?.networkCode || process.env.GAM_NETWORK_CODE;

    const envelope = body => `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:dfp="https://www.google.com/apis/ads/publisher/${API_VER}">
  <soapenv:Header>
    <dfp:RequestHeader>
      <dfp:networkCode>${NETWORK_CODE}</dfp:networkCode>
      <dfp:applicationName>AdNexus</dfp:applicationName>
    </dfp:RequestHeader>
  </soapenv:Header>
  <soapenv:Body><dfp:getCurrentNetwork>${body}</dfp:getCurrentNetwork></soapenv:Body>
</soapenv:Envelope>`;

    const xml = await axios.post(
      `https://ads.google.com/apis/ads/publisher/${API_VER}/NetworkService`,
      envelope(''),
      { headers: { 'Content-Type': 'text/xml; charset=UTF-8', Authorization: `Bearer ${token}` } }
    );

    const extract = tag => { const m = xml.data.match(new RegExp(`<${tag}[^>]*>([^<]+)<\/${tag}>`)); return m ? m[1].trim() : null; };
    const info = {
      networkCode: extract('networkCode'),
      displayName: extract('displayName'),
      currencyCode: extract('currencyCode'),
      timeZone: extract('timeZone'),
      isMock: false,
    };
    cache.set(tenantKey('network_info'), info, 3600);
    res.json({ ...info, gamVersion, ...freshness });
  } catch (err) {
    logger.error('Network info error:', err.message);
    const classified = classifyGoogleAuthError(err);
    if (classified) {
      return res.status(classified.status).json({ ...classified, gamVersion, ...freshness });
    }
    res.status(500).json({ error: err.message, isMock: false, gamVersion, ...freshness });
  }
});

module.exports = router;
