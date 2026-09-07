const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { createClient, getClientByNetworkCode } = require('../models/clientStore');
const { createUser, getUserByUsername } = require('../models/userStore');
const { getGAMClient } = require('../gam/client');
const { validatePassword } = require('../utils/passwordPolicy');
const { validateUsername, validateSavedName } = require('../utils/namePolicy');
const { createPendingSession, getPendingSession, deletePendingSession } = require('../models/oauthPendingStore');
const { buildAuthUrl, commitGamNetwork } = require('./auth');
const { isGamOAuthConfigured } = require('../services/gamNetworkDiscovery');
const { encryptSecret, decryptSecret } = require('../utils/credentialsCrypto');
const logger = require('../utils/logger');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many onboard attempts. Try again later.' },
});

router.use(limiter);

async function verifyGamCredentials(creds) {
  const auth = await getGAMClient({
    googleClientId: creds.googleClientId,
    googleClientSecret: creds.googleClientSecret,
    refreshToken: creds.refreshToken,
    networkCode: creds.networkCode,
    redirectUri: creds.redirectUri || process.env.GOOGLE_REDIRECT_URI,
  });
  const token = await auth.getAccessToken();
  if (!token?.token) throw new Error('Google did not return an access token');
}

function validateOnboardAdminFields(body) {
  const { name, username, email, password } = body || {};
  if (!name || !username || !password) {
    return { error: 'Publisher name, admin username, and password are required.' };
  }
  const publisherCheck = validateSavedName(name, { maxLength: 80, label: 'Publisher name' });
  if (!publisherCheck.valid) return { error: publisherCheck.errors[0] };
  const nameCheck = validateUsername(username);
  if (!nameCheck.valid) return { error: nameCheck.errors[0] };
  const pwCheck = validatePassword(password, { username: String(username).trim() });
  if (!pwCheck.valid) return { error: pwCheck.errors[0] };
  return {
    name: String(name).trim(),
    username: String(username).trim(),
    email: email ? String(email).trim() : `${String(username).trim()}@local`,
    password: String(password),
  };
}

/**
 * Start Connect with Google onboarding — no GAM credentials required.
 * Creates a short-lived pending session with admin form fields, returns Google OAuth URL.
 */
router.post('/oauth-start', async (req, res) => {
  try {
    if (!isGamOAuthConfigured()) {
      return res.status(400).json({
        error: 'GAM OAuth not configured on the server. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in backend .env.',
      });
    }
    const fields = validateOnboardAdminFields(req.body);
    if (fields.error) return res.status(400).json({ error: fields.error });

    const dupUser = await getUserByUsername(fields.username);
    if (dupUser) {
      return res.status(400).json({ error: 'Username already exists.' });
    }

    const session = await createPendingSession({
      product: 'gam',
      mode: 'onboard',
      clientId: null,
      refreshToken: null,
      candidates: [],
      payload: {
        name: fields.name,
        username: fields.username,
        email: fields.email,
        passwordEnc: encryptSecret(fields.password),
      },
    });

    const url = buildAuthUrl(null, {
      mode: 'onboard',
      pendingSessionId: session.id,
    });
    res.json({ url, sessionId: session.id });
  } catch (err) {
    logger.error('Onboard oauth-start failed:', err.message);
    res.status(400).json({ error: err.message || 'Could not start Google OAuth' });
  }
});

/** Public: list networks for an onboard pending session (after OAuth callback). */
router.get('/oauth/pending/:id', async (req, res) => {
  try {
    const session = await getPendingSession(req.params.id);
    if (!session || session.product !== 'gam') {
      return res.status(404).json({ error: 'OAuth session expired or not found.' });
    }
    if (!session.refreshToken) {
      return res.status(400).json({ error: 'Finish Google sign-in first.' });
    }
    res.json({
      sessionId: session.id,
      networks: session.candidates || [],
      expiresAt: session.expiresAt,
      publisherName: session.payload?.name || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Public: select a GAM network during onboard and create client + admin user. */
router.post('/oauth/select', async (req, res) => {
  try {
    const sessionId = req.body?.sessionId;
    const networkCode = String(req.body?.networkCode || '').trim();
    const session = await getPendingSession(sessionId);
    if (!session || session.product !== 'gam' || session.mode !== 'onboard') {
      return res.status(404).json({ error: 'OAuth session expired or not found.' });
    }
    if (!session.refreshToken) {
      return res.status(400).json({ error: 'Finish Google sign-in first.' });
    }
    const candidate = (session.candidates || []).find(
      (c) => String(c.networkCode || '').trim() === networkCode
    );
    if (!candidate) {
      return res.status(400).json({ error: 'Selected network is not in this OAuth session.' });
    }

    const payload = { ...(session.payload || {}) };
    if (payload.passwordEnc) {
      payload.password = decryptSecret(payload.passwordEnc);
      delete payload.passwordEnc;
    }
    if (!payload.username || !payload.password) {
      return res.status(400).json({ error: 'Onboard session is missing admin credentials.' });
    }

    const result = await commitGamNetwork({
      clientId: null,
      networkCode: candidate.networkCode,
      displayName: candidate.displayName,
      refreshToken: session.refreshToken,
      onboardPayload: payload,
    });
    await deletePendingSession(session.id);

    res.status(201).json({
      ok: true,
      client: { id: result.client.id, name: result.client.name, networkCode: result.client.networkCode },
      user: { id: result.user.id, username: result.user.username, role: result.user.role },
    });
  } catch (err) {
    logger.error('Onboard oauth select failed:', err.message);
    res.status(400).json({ error: err.message || 'Could not complete onboarding' });
  }
});

/** Legacy manual credential onboard (advanced fallback). */
router.post('/', async (req, res) => {
  const {
    name,
    networkCode,
    googleClientId,
    googleClientSecret,
    refreshToken,
    redirectUri,
    username,
    email,
    password,
  } = req.body || {};

  if (!name || !networkCode || !googleClientId || !googleClientSecret || !refreshToken) {
    return res.status(400).json({
      error: 'name, networkCode, googleClientId, googleClientSecret, and refreshToken are required.',
    });
  }
  if (!username || !password) {
    return res.status(400).json({ error: 'Admin username and password are required.' });
  }

  const publisherCheck = validateSavedName(name, { maxLength: 80, label: 'Publisher name' });
  if (!publisherCheck.valid) {
    return res.status(400).json({ error: publisherCheck.errors[0] });
  }

  const nameCheck = validateUsername(username);
  if (!nameCheck.valid) {
    return res.status(400).json({ error: nameCheck.errors[0] });
  }

  const pwCheck = validatePassword(password, { username: String(username).trim() });
  if (!pwCheck.valid) {
    return res.status(400).json({ error: pwCheck.errors[0] });
  }

  try {
    const dupNet = await getClientByNetworkCode(String(networkCode).trim());
    if (dupNet) {
      return res.status(400).json({ error: 'A client with this network code already exists.' });
    }
    const dupUser = await getUserByUsername(String(username).trim());
    if (dupUser) {
      return res.status(400).json({ error: 'Username already exists.' });
    }

    await verifyGamCredentials({
      googleClientId: String(googleClientId).trim(),
      googleClientSecret: String(googleClientSecret).trim(),
      refreshToken: String(refreshToken).trim(),
      networkCode: String(networkCode).trim(),
      redirectUri,
    });

    const client = await createClient({
      name: String(name).trim(),
      networkCode: String(networkCode).trim(),
      googleClientId: String(googleClientId).trim(),
      googleClientSecret: String(googleClientSecret).trim(),
      refreshToken: String(refreshToken).trim(),
      redirectUri: redirectUri || null,
    });

    const user = await createUser({
      username: String(username).trim(),
      email: email || `${String(username).trim()}@local`,
      password,
      role: 'admin',
      permissions: null,
      createdBy: 'self-onboard',
      clientId: client.id,
    });

    logger.info(`Client onboarded: ${client.name} network=${client.networkCode} admin=${user.username}`);
    res.status(201).json({
      ok: true,
      client: { id: client.id, name: client.name, networkCode: client.networkCode },
      user: { id: user.id, username: user.username, role: user.role },
    });
  } catch (err) {
    logger.error('Onboard failed:', err.message);
    res.status(400).json({ error: err.message || 'Onboarding failed' });
  }
});

module.exports = router;
