const express = require('express');
const router = express.Router();
const { cache } = require('../gamClient');
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const { getVersionStatus } = require('../utils/gamVersion');

const { isMockClient, getClient, tenantKey } = require('../utils/clientContext');

router.use(requireAuth);

router.get('/info', async (req, res) => {
  // Always surface the API-version deprecation status so the UI can warn early.
  const gamVersion = getVersionStatus();

  if (isMockClient()) {
    return res.json({
      networkCode: '123456789',
      displayName: 'Demo Network (Mock Mode)',
      currencyCode: 'INR',
      timeZone: 'Asia/Kolkata',
      isMock: true,
      gamVersion
    });
  }

  const cached = cache.get(tenantKey('network_info'));
  if (cached) return res.json({ ...cached, gamVersion });

  try {
    const { getGAMClient } = require('../gamClient');
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
      { headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'Authorization': `Bearer ${token}` } }
    );

    const extract = tag => { const m = xml.data.match(new RegExp(`<${tag}[^>]*>([^<]+)<\/${tag}>`)); return m ? m[1].trim() : null; };
    const info = {
      networkCode: extract('networkCode'),
      displayName: extract('displayName'),
      currencyCode: extract('currencyCode'),
      timeZone: extract('timeZone')
    };
    cache.set(tenantKey('network_info'), info, 3600);
    res.json({ ...info, gamVersion });
  } catch (err) {
    logger.error('Network info error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
