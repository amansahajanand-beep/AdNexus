/**
 * Google OAuth for GAM API access (not dashboard login).
 * Connect with Google → discover networks → save to gam_clients → kick inventory sync.
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const { getGAMClient } = require('../gam/client');
const {
  getClientById,
  ensureBootstrapFromEnv,
  updateClientCredentials,
  createClient,
  getClientByNetworkCode,
} = require('../models/clientStore');
const { createUser, getUserByUsername } = require('../models/userStore');
const { createPendingSession, getPendingSession, deletePendingSession } = require('../models/oauthPendingStore');
const {
  isGamOAuthConfigured,
  getConnectOAuthClient,
  envGamOAuthApp,
  listAccessibleNetworks,
  kickGamInventorySync,
} = require('../services/gamNetworkDiscovery');
const { encryptSecret } = require('../utils/credentialsCrypto');
const logger = require('../utils/logger');

const SCOPES = [
  'https://www.googleapis.com/auth/dfp',
  'https://www.googleapis.com/auth/admanager'
];

const SECRET = () => process.env.JWT_SECRET || 'change_this_secret';

function signOAuthState(payload) {
  return jwt.sign({ ...payload, purpose: 'gam-oauth' }, SECRET(), { expiresIn: '20m' });
}

function verifyOAuthState(state) {
  const decoded = jwt.verify(state, SECRET());
  if (decoded.purpose !== 'gam-oauth') {
    throw new Error('Invalid OAuth state');
  }
  return decoded;
}

function frontendAdminUrl(query = '') {
  const base = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  return `${base}/admin${query}`;
}

function frontendOnboardUrl(query = '') {
  const base = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  return `${base}/onboard${query}`;
}

function buildAuthUrl(client, statePayload = null) {
  const oauth2Client = getConnectOAuthClient(client);
  const state = statePayload
    ? signOAuthState(statePayload)
    : signOAuthState({ clientId: client?.id, mode: 'connect' });
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state,
  });
}

async function commitGamNetwork({
  clientId,
  networkCode,
  displayName,
  refreshToken,
  onboardPayload = null,
}) {
  const code = String(networkCode || '').trim();
  if (!code) throw new Error('networkCode is required');

  const envApp = envGamOAuthApp();
  const googleClientId = envApp.clientId;
  const googleClientSecret = envApp.clientSecret;
  if (!googleClientId || !googleClientSecret) {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET must be set in .env');
  }

  if (onboardPayload) {
    const dupNet = await getClientByNetworkCode(code);
    if (dupNet) throw new Error('A client with this network code already exists.');
    const dupUser = await getUserByUsername(String(onboardPayload.username).trim());
    if (dupUser) throw new Error('Username already exists.');

    const client = await createClient({
      name: String(onboardPayload.name || displayName || `Network ${code}`).trim(),
      networkCode: code,
      googleClientId,
      googleClientSecret,
      refreshToken,
      redirectUri: envApp.redirectUri || null,
    });

    const user = await createUser({
      username: String(onboardPayload.username).trim(),
      email: onboardPayload.email || `${String(onboardPayload.username).trim()}@local`,
      password: onboardPayload.password,
      role: 'admin',
      permissions: null,
      createdBy: 'self-onboard',
      clientId: client.id,
    });

    await kickGamInventorySync(client);
    return { client, user, created: true };
  }

  if (!clientId) throw new Error('clientId required');
  const other = await getClientByNetworkCode(code);
  if (other && other.id !== clientId) {
    throw new Error('Network code is already used by another client.');
  }

  const next = await updateClientCredentials(clientId, {
    networkCode: code,
    googleClientId,
    googleClientSecret,
    refreshToken,
    redirectUri: envApp.redirectUri || null,
  });
  await kickGamInventorySync(next);
  return { client: next, created: false };
}

// Legacy bookmark / helper: start Google consent for the bootstrap (env-migrated) client.
router.get('/login', async (req, res) => {
  try {
    let client = null;
    if (req.query.clientId) {
      client = await getClientById(String(req.query.clientId));
    }
    if (!client) client = await ensureBootstrapFromEnv();
    if (!isGamOAuthConfigured() && (!client?.googleClientId || !client?.googleClientSecret)) {
      return res.status(400).json({
        error: 'No Google OAuth app on file. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.',
      });
    }
    res.redirect(buildAuthUrl(client, { clientId: client?.id, mode: 'connect' }));
  } catch (err) {
    logger.error('OAuth login error:', err.message);
    res.status(500).json({ error: 'Could not start Google OAuth', details: err.message });
  }
});

router.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) {
    return res.status(400).json({ error: 'No code provided' });
  }

  try {
    let decoded = {};
    if (state) {
      decoded = verifyOAuthState(String(state));
    }
    const mode = decoded.mode || 'connect';
    const pendingId = decoded.pendingSessionId || null;

    let client = null;
    if (decoded.clientId) {
      client = await getClientById(decoded.clientId);
    }
    if (!client && mode !== 'onboard') {
      client = await ensureBootstrapFromEnv();
    }

    const oauth2Client = getConnectOAuthClient(client);
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      logger.warn('Google callback had no refresh_token (user may have already granted access)');
      if (mode === 'onboard') {
        return res.redirect(frontendOnboardUrl('?oauth=error&reason=no_refresh_token'));
      }
      return res.redirect(frontendAdminUrl('?oauth=error&reason=no_refresh_token'));
    }

    const refreshToken = tokens.refresh_token;
    let networks = [];
    try {
      networks = await listAccessibleNetworks({ refreshToken, oauthClient: oauth2Client });
    } catch (e) {
      logger.error('getAllNetworks failed:', e.message);
      if (mode === 'onboard') {
        return res.redirect(frontendOnboardUrl(`?oauth=error&reason=${encodeURIComponent(e.message.slice(0, 80))}`));
      }
      return res.redirect(frontendAdminUrl(`?oauth=error&reason=${encodeURIComponent(e.message.slice(0, 80))}`));
    }

    if (!networks.length) {
      if (mode === 'onboard') {
        return res.redirect(frontendOnboardUrl('?oauth=error&reason=no_networks'));
      }
      return res.redirect(frontendAdminUrl('?oauth=error&reason=no_networks'));
    }

    let onboardPayload = null;
    if (mode === 'onboard' && pendingId) {
      const pre = await getPendingSession(pendingId);
      if (!pre || pre.product !== 'gam' || pre.mode !== 'onboard') {
        return res.redirect(frontendOnboardUrl('?oauth=error&reason=session_expired'));
      }
      onboardPayload = pre.payload;
      await deletePendingSession(pendingId);
      if (onboardPayload?.passwordEnc) {
        const { decryptSecret } = require('../utils/credentialsCrypto');
        onboardPayload = {
          ...onboardPayload,
          password: decryptSecret(onboardPayload.passwordEnc),
        };
        delete onboardPayload.passwordEnc;
      }
    }

    const candidates = networks.map((n) => ({
      networkCode: n.networkCode,
      displayName: n.displayName,
      currencyCode: n.currencyCode,
      timeZone: n.timeZone,
    }));

    // Single network → auto-commit
    if (candidates.length === 1) {
      try {
        const result = await commitGamNetwork({
          clientId: client?.id || null,
          networkCode: candidates[0].networkCode,
          displayName: candidates[0].displayName,
          refreshToken,
          onboardPayload: mode === 'onboard' ? onboardPayload : null,
        });
        if (mode === 'onboard') {
          return res.redirect(frontendOnboardUrl('?oauth=connected'));
        }
        return res.redirect(frontendAdminUrl(
          `?tab=client&oauth=connected&network=${encodeURIComponent(result.client.networkCode)}`
        ));
      } catch (e) {
        logger.error('GAM auto-commit failed:', e.message);
        if (mode === 'onboard') {
          return res.redirect(frontendOnboardUrl(`?oauth=error&reason=${encodeURIComponent(e.message.slice(0, 80))}`));
        }
        return res.redirect(frontendAdminUrl(`?oauth=error&reason=${encodeURIComponent(e.message.slice(0, 80))}`));
      }
    }

    // Multiple networks → picker
    const session = await createPendingSession({
      product: 'gam',
      mode: mode === 'onboard' ? 'onboard' : 'connect',
      clientId: client?.id || null,
      refreshToken,
      candidates,
      payload: mode === 'onboard' && onboardPayload
        ? {
            name: onboardPayload.name,
            username: onboardPayload.username,
            email: onboardPayload.email,
            passwordEnc: encryptSecret(onboardPayload.password),
          }
        : null,
    });

    if (mode === 'onboard') {
      return res.redirect(frontendOnboardUrl(`?oauth=pick&session=${encodeURIComponent(session.id)}`));
    }
    return res.redirect(
      frontendAdminUrl(`?tab=client&oauth=pick&session=${encodeURIComponent(session.id)}`)
    );
  } catch (err) {
    logger.error('OAuth callback error:', err.message);
    if (req.accepts('html')) {
      return res.redirect(frontendAdminUrl('?oauth=error'));
    }
    res.status(500).json({
      error: 'Authentication failed',
      details: err.message
    });
  }
});

router.get('/status', async (req, res) => {
  try {
    const client = await ensureBootstrapFromEnv();
    if (!client?.refreshToken || !client?.networkCode) {
      return res.json({
        authenticated: false,
        missing: {
          refresh_token: !client?.refreshToken,
          network_code: !client?.networkCode,
          client_id: !client?.googleClientId,
          client_secret: !client?.googleClientSecret,
        }
      });
    }
    const auth = await getGAMClient(client);
    const token = await auth.getAccessToken();
    res.json({
      authenticated: true,
      network_code: client.networkCode,
      token_valid: !!token.token
    });
  } catch (err) {
    res.json({ authenticated: false, error: err.message });
  }
});

router.buildAuthUrl = buildAuthUrl;
router.signOAuthState = signOAuthState;
router.commitGamNetwork = commitGamNetwork;
router.SCOPES = SCOPES;
module.exports = router;
