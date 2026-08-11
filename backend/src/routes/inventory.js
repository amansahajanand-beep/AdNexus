const express = require('express');
const router = express.Router();
const { cache } = require('../gamClient');
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const { hasFlag } = require('../utils/permissions');

const { isMockClient, getClient } = require('../utils/clientContext');

router.use(requireAuth);

function mockAdUnits() {
  return [
    { id: '21001', name: 'Homepage – Leaderboard', code: 'hp_leaderboard_728x90', status: 'ACTIVE', description: 'Top banner on homepage' },
    { id: '21002', name: 'Homepage – Billboard', code: 'hp_billboard_970x250', status: 'ACTIVE', description: 'Billboard below fold' },
    { id: '21003', name: 'Article – MPU Right', code: 'art_mpu_right_300x250', status: 'ACTIVE', description: 'Mid-page unit, article right rail' },
    { id: '21004', name: 'Article – MPU Mid', code: 'art_mpu_mid_300x250', status: 'ACTIVE', description: 'Inline mid-article unit' },
    { id: '21005', name: 'Mobile – Sticky Footer', code: 'mob_sticky_footer_320x50', status: 'ACTIVE', description: 'Persistent mobile footer' },
    { id: '21006', name: 'Mobile – Interstitial', code: 'mob_interstitial_320x480', status: 'ACTIVE', description: 'Full-screen mobile interstitial' },
    { id: '21007', name: 'Video – Pre-Roll', code: 'vid_preroll_640x480', status: 'ACTIVE', description: 'In-stream pre-roll video' },
    { id: '21008', name: 'Native – Feed Unit', code: 'nat_feed_300x250', status: 'ACTIVE', description: 'Native ad in content feed' },
    { id: '21009', name: 'Sidebar – Skyscraper', code: 'sb_sky_160x600', status: 'INACTIVE', description: 'Sidebar skyscraper (deprecated)' },
    { id: '21010', name: 'App – Banner', code: 'app_banner_320x50', status: 'ACTIVE', description: 'In-app top banner' },
  ];
}

router.get('/ad-units', async (req, res) => {
  if (!hasFlag(req.user, 'canSeeInventory')) {
    return res.status(403).json({ error: 'You do not have permission to view ad inventory.' });
  }
  if (isMockClient()) {
    logger.info('Mock mode: returning mock ad units');
    return res.json(mockAdUnits());
  }

  const cached = cache.get('ad_units');
  if (cached) return res.json(cached);

  try {
    const { getGAMClient } = require('../gamClient');
    const auth = await getGAMClient();
    const tokenObj = await auth.getAccessToken();
    const token = tokenObj.token;
    const axios = require('axios');
    const { GAM_API_VERSION: API_VER } = require('../utils/gamVersion');
    const NETWORK_CODE = getClient()?.networkCode || process.env.GAM_NETWORK_CODE;

    const envelope = (method, body) => `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:dfp="https://www.google.com/apis/ads/publisher/${API_VER}">
  <soapenv:Header>
    <dfp:RequestHeader>
      <dfp:networkCode>${NETWORK_CODE}</dfp:networkCode>
      <dfp:applicationName>AdNexus</dfp:applicationName>
    </dfp:RequestHeader>
  </soapenv:Header>
  <soapenv:Body><${method} xmlns="https://www.google.com/apis/ads/publisher/${API_VER}">${body}</${method}></soapenv:Body>
</soapenv:Envelope>`;

    const { fetchAdUnitHierarchy } = require('../utils/gamInventoryServices');
    const { units } = await fetchAdUnitHierarchy(token);
    cache.set('ad_units', units, 600);
    res.json(units);
  } catch (err) {
    logger.error('Ad units error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
