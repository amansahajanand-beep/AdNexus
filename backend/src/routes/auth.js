/**
 * Google OAuth for GAM API access (not dashboard login).
 * Refresh tokens are stored on gam_clients — never written to .env.
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const { getOAuthClient, getGAMClient } = require('../gam/client');
const { getClientById, ensureBootstrapFromEnv, updateClientCredentials } = require('../models/clientStore');
const logger = require('../utils/logger');

const SCOPES = [
  'https://www.googleapis.com/auth/dfp',
  'https://www.googleapis.com/auth/admanager'
];

const SECRET = () => process.env.JWT_SECRET || 'change_this_secret';

function signOAuthState(clientId) {
  return jwt.sign({ clientId, purpose: 'gam-oauth' }, SECRET(), { expiresIn: '15m' });
}

function verifyOAuthState(state) {
  const decoded = jwt.verify(state, SECRET());
  if (!decoded?.clientId || decoded.purpose !== 'gam-oauth') {
    throw new Error('Invalid OAuth state');
  }
  return decoded;
}

function frontendAdminUrl(query = '') {
  const base = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  return `${base}/admin${query}`;
}

function buildAuthUrl(client) {
  const oauth2Client = getOAuthClient(client);
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state: signOAuthState(client.id),
  });
}

// Legacy bookmark / helper: start Google consent for the bootstrap (env-migrated) client.
router.get('/login', async (req, res) => {
  try {
    let client = null;
    if (req.query.clientId) {
      client = await getClientById(String(req.query.clientId));
    }
    if (!client) client = await ensureBootstrapFromEnv();
    if (!client?.googleClientId || !client?.googleClientSecret) {
      return res.status(400).json({
        error: 'No Google OAuth app on file. Register at /onboard or save client ID and secret in GAM credentials.',
      });
    }
    res.redirect(buildAuthUrl(client));
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
    let clientId = null;
    if (state) {
      const decoded = verifyOAuthState(String(state));
      clientId = decoded.clientId;
    }
    const client = clientId
      ? await getClientById(clientId)
      : await ensureBootstrapFromEnv();
    if (!client) {
      return res.status(400).json({ error: 'Unknown client for this OAuth callback' });
    }

    const oauth2Client = getOAuthClient(client);
    const { tokens } = await oauth2Client.getToken(code);

    if (tokens.refresh_token) {
      await updateClientCredentials(client.id, { refreshToken: tokens.refresh_token });
      logger.info(`Google refresh token saved for client ${client.id}`);
    } else {
      logger.warn('Google callback had no refresh_token (user may have already granted access)');
    }

    if (req.accepts('html')) {
      return res.redirect(frontendAdminUrl('?oauth=connected'));
    }
    res.json({
      success: true,
      message: 'Authentication successful. Refresh token stored for this client.',
      refresh_token_saved: !!tokens.refresh_token,
    });
  } catch (err) {
    logger.error('OAuth callback error:', err.message);
    if (req.accepts('html')) {
      return res.redirect(frontendAdminUrl(`?oauth=error`));
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
module.exports = router;
