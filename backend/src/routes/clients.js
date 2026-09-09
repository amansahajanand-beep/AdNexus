const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { getClientPublicById, updateClientCredentials, getClientByNetworkCode } = require('../models/clientStore');
const { getGAMClient } = require('../gam/client');
const { isMockClient } = require('../utils/clientContext');
const { buildAuthUrl, commitGamNetwork } = require('./auth');
const { isGamOAuthConfigured } = require('../services/gamNetworkDiscovery');
const { getPendingSessionPublic, getPendingSession, deletePendingSession } = require('../models/oauthPendingStore');
const { decryptSecret } = require('../utils/credentialsCrypto');
const logger = require('../utils/logger');

router.use(requireAdmin);

router.get('/me/oauth-url', (req, res) => {
  try {
    if (!isGamOAuthConfigured() && (!req.client?.googleClientId || !req.client?.googleClientSecret)) {
      return res.status(400).json({
        error: 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in backend .env, then Connect with Google.',
      });
    }
    res.json({
      url: buildAuthUrl(req.client, { clientId: req.client.id, mode: 'connect' }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/oauth/pending/:id', async (req, res) => {
  try {
    const session = await getPendingSessionPublic(req.params.id);
    if (!session || session.product !== 'gam') {
      return res.status(404).json({ error: 'OAuth session expired or not found. Connect with Google again.' });
    }
    if (session.clientId && session.clientId !== req.client.id) {
      return res.status(403).json({ error: 'OAuth session belongs to another client.' });
    }
    res.json({
      sessionId: session.id,
      networks: session.candidates || [],
      expiresAt: session.expiresAt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/oauth/pending/:id/select', async (req, res) => {
  try {
    const session = await getPendingSession(req.params.id);
    if (!session || session.product !== 'gam') {
      return res.status(404).json({ error: 'OAuth session expired or not found. Connect with Google again.' });
    }
    if (session.clientId && session.clientId !== req.client.id) {
      return res.status(403).json({ error: 'OAuth session belongs to another client.' });
    }
    if (!session.refreshToken) {
      return res.status(400).json({ error: 'OAuth session is incomplete. Connect with Google again.' });
    }
    const networkCode = String(req.body?.networkCode || '').trim();
    const candidate = (session.candidates || []).find(
      (c) => String(c.networkCode || '').trim() === networkCode
    );
    if (!candidate) {
      return res.status(400).json({ error: 'Selected network is not in this OAuth session.' });
    }

    let onboardPayload = null;
    if (session.mode === 'onboard' && session.payload) {
      onboardPayload = { ...session.payload };
      if (onboardPayload.passwordEnc) {
        onboardPayload.password = decryptSecret(onboardPayload.passwordEnc);
        delete onboardPayload.passwordEnc;
      }
    }

    const result = await commitGamNetwork({
      clientId: session.clientId || req.client.id,
      networkCode: candidate.networkCode,
      displayName: candidate.displayName,
      refreshToken: session.refreshToken,
      onboardPayload: session.mode === 'onboard' ? onboardPayload : null,
    });
    await deletePendingSession(session.id);
    const pub = await getClientPublicById(result.client.id);
    res.json({
      ok: true,
      client: pub,
      syncStarted: true,
    });
  } catch (err) {
    logger.error('GAM OAuth select failed:', err.message);
    res.status(400).json({ error: err.message || 'Could not select network' });
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
    const { classifyGoogleAuthError } = require('../utils/googleAuthErrors');
    const classified = classifyGoogleAuthError(err);
    if (classified) return res.status(classified.status).json(classified);
    res.status(400).json({ error: err.message || 'Could not update credentials' });
  }
});

module.exports = router;
