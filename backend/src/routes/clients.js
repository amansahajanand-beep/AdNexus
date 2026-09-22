const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const {
  getClientPublicById,
  updateClientCredentials,
  getClientByNetworkCode,
  listClientsByAccountId,
  getAccountIdForClient,
  getClientById,
  isUsableGamClient,
} = require('../models/clientStore');
const { updateUser, getUserById } = require('../models/userStore');
const { getGAMClient } = require('../gam/client');
const { isMockClient } = require('../utils/clientContext');
const { buildAuthUrl, commitGamNetwork } = require('./auth');
const { generateTokens } = require('../middleware/auth');
const { stripSessionFields } = require('../utils/sessionManager');
const { isGamOAuthConfigured } = require('../services/gamNetworkDiscovery');
const { getPendingSessionPublic, getPendingSession, deletePendingSession } = require('../models/oauthPendingStore');
const { decryptSecret } = require('../utils/credentialsCrypto');
const logger = require('../utils/logger');

router.use(requireAdmin);

async function assertSessionSameAccount(req, session) {
  if (!session.clientId) return true;
  const userAccount = await getAccountIdForClient(req.client.id);
  const sessionAccount = await getAccountIdForClient(session.clientId);
  return userAccount && sessionAccount && String(userAccount) === String(sessionAccount);
}

async function issueTokenForUser(req, userId) {
  const freshUser = await getUserById(userId);
  if (!freshUser) return null;
  const { accessToken } = generateTokens(freshUser, req.sessionId);
  return { token: accessToken, user: stripSessionFields(freshUser) };
}

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
    if (!(await assertSessionSameAccount(req, session))) {
      return res.status(403).json({ error: 'OAuth session belongs to another account.' });
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
    if (!(await assertSessionSameAccount(req, session))) {
      return res.status(403).json({ error: 'OAuth session belongs to another account.' });
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
      switchUserId: session.mode === 'onboard' ? null : req.user.id,
    });
    await deletePendingSession(session.id);
    const pub = await getClientPublicById(result.client.id);
    const accountId = await getAccountIdForClient(result.client.id);
    const networks = await listClientsByAccountId(accountId);
    const sessionPayload = session.mode === 'onboard'
      ? null
      : await issueTokenForUser(req, req.user.id);
    res.json({
      ok: true,
      client: pub,
      networks,
      activeClientId: result.client.id,
      syncStarted: true,
      ...(sessionPayload || {}),
    });
  } catch (err) {
    logger.error('GAM OAuth select failed:', err.message);
    res.status(400).json({ error: err.message || 'Could not select network' });
  }
});

/** Networks under this admin's account (1 UUID per network_code). */
router.get('/me/networks', async (req, res) => {
  try {
    const accountId = await getAccountIdForClient(req.client.id);
    const networks = await listClientsByAccountId(accountId);
    res.json({
      accountId,
      activeClientId: req.user.clientId || req.client.id,
      networks,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Switch admin's active network (users.client_id).
 * Domain users stay locked (1B) — only the calling admin moves.
 */
router.post('/me/active-network', async (req, res) => {
  try {
    const targetId = String(req.body?.clientId || '').trim();
    if (!targetId) return res.status(400).json({ error: 'clientId is required' });

    const accountId = await getAccountIdForClient(req.client.id);
    const networks = await listClientsByAccountId(accountId);
    const target = networks.find((n) => n.id === targetId);
    if (!target) {
      return res.status(404).json({ error: 'Network is not part of your account.' });
    }
    if (target.isPending) {
      return res.status(400).json({ error: 'Connect this network with Google before activating it.' });
    }

    await updateUser(req.user.id, { clientId: targetId });
    const runtime = await getClientById(targetId);
    const pub = await getClientPublicById(targetId);
    // Drop response caches for BOTH networks so UI cannot show the previous network's table.
    try {
      const { runWithClient } = require('../utils/clientContext');
      const { bumpCacheGeneration } = require('../redisClient');
      const { tenantKey } = require('../utils/clientContext');
      const { cache } = require('../gam/client');
      if (typeof cache?.flushAll === 'function') cache.flushAll();
      const prev = req.client;
      if (prev) {
        await runWithClient(prev, async () => {
          await bumpCacheGeneration(tenantKey(''));
        });
      }
      if (runtime) {
        await runWithClient(runtime, async () => {
          await bumpCacheGeneration(tenantKey(''));
        });
      }
    } catch (e) {
      logger.warn(`active-network cache bump failed: ${e.message}`);
    }
    const sessionPayload = await issueTokenForUser(req, req.user.id);
    res.json({
      ok: true,
      client: { ...pub, isMock: isMockClient(runtime) },
      activeClientId: targetId,
      networks,
      ...(sessionPayload || {}),
    });
  } catch (err) {
    logger.error('Switch active network failed:', err.message);
    res.status(400).json({ error: err.message || 'Could not switch network' });
  }
});

router.get('/me', async (req, res) => {
  try {
    const pub = await getClientPublicById(req.user.clientId || req.client?.id);
    if (!pub) return res.status(404).json({ error: 'Client not found' });
    const accountId = await getAccountIdForClient(pub.id);
    const networks = await listClientsByAccountId(accountId);
    res.json({
      ...pub,
      isMock: isMockClient(req.client),
      accountId,
      networks,
      activeClientId: req.user.clientId || req.client?.id,
      gamConnected: isUsableGamClient(req.client),
    });
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
