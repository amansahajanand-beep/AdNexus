const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { getClientPublicById, updateClientCredentials, getClientByNetworkCode } = require('../models/clientStore');
const { getGAMClient } = require('../gamClient');
const { isMockClient } = require('../utils/clientContext');
const { buildAuthUrl } = require('./auth');
const logger = require('../utils/logger');

router.use(requireAdmin);

router.get('/me/oauth-url', (req, res) => {
  try {
    if (!req.client?.googleClientId || !req.client?.googleClientSecret) {
      return res.status(400).json({
        error: 'Save Google client ID and client secret first, then connect Google.',
      });
    }
    res.json({ url: buildAuthUrl(req.client) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/me', async (req, res) => {
  try {
    const pub = await getClientPublicById(req.user.clientId || req.client?.id);
    if (!pub) return res.status(404).json({ error: 'Client not found' });
    res.json({ ...pub, isMock: isMockClient(req.client) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/me', async (req, res) => {
  const {
    name,
    networkCode,
    googleClientId,
    googleClientSecret,
    refreshToken,
    redirectUri,
  } = req.body || {};

  const clientId = req.user.clientId || req.client?.id;
  if (!clientId) return res.status(400).json({ error: 'No client linked to this account' });

  try {
    if (networkCode) {
      const other = await getClientByNetworkCode(String(networkCode).trim());
      if (other && other.id !== clientId) {
        return res.status(400).json({ error: 'Network code is already used by another client.' });
      }
    }

    const next = await updateClientCredentials(clientId, {
      name,
      networkCode,
      googleClientId,
      googleClientSecret,
      refreshToken,
      redirectUri,
    });

    if (googleClientSecret || refreshToken || googleClientId || networkCode) {
      await getGAMClient(next).then((auth) => auth.getAccessToken());
    }

    const pub = await getClientPublicById(clientId);
    logger.info(`Client credentials updated: ${pub.name} by ${req.user.username}`);
    res.json({ ...pub, isMock: isMockClient(next) });
  } catch (err) {
    logger.error('Update client failed:', err.message);
    res.status(400).json({ error: err.message || 'Could not update credentials' });
  }
});

module.exports = router;
