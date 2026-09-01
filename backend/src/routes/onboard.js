const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { createClient, getClientByNetworkCode } = require('../models/clientStore');
const { createUser, getUserByUsername } = require('../models/userStore');
const { getGAMClient } = require('../gam/client');
const { validatePassword } = require('../utils/passwordPolicy');
const { validateUsername, validateSavedName } = require('../utils/namePolicy');
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
