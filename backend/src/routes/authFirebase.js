/**
 * Google OAuth for Firebase Remote Config (ROI page) — separate from GAM / Ads callbacks.
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const { getClientById } = require('../models/clientStore');
const { saveConnectionFromCode } = require('../services/firebaseRemoteConfigService');
const { frontendBaseUrl } = require('../utils/frontendUrl');
const { runWithClient } = require('../utils/clientContext');
const logger = require('../utils/logger');

const SECRET = () => process.env.JWT_SECRET || 'change_this_secret';

function signFirebaseState(payload) {
  return jwt.sign({ ...payload, purpose: 'firebase-oauth' }, SECRET(), { expiresIn: '20m' });
}

function adminRedirect(query) {
  return `${frontendBaseUrl()}/admin?tab=firebase&${query}`;
}

router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code || !state) {
    return res.redirect(adminRedirect(`firebase_oauth=error&reason=${encodeURIComponent(String(error || 'missing_code'))}`));
  }
  try {
    const decoded = jwt.verify(String(state), SECRET());
    if (!decoded?.clientId || decoded.purpose !== 'firebase-oauth') throw new Error('invalid_state');
    const gamClient = await getClientById(decoded.clientId);
    if (!gamClient) return res.redirect(adminRedirect('firebase_oauth=error&reason=unknown_client'));
    await runWithClient(gamClient, () => saveConnectionFromCode(gamClient, String(code)));
    return res.redirect(adminRedirect('firebase_oauth=success'));
  } catch (err) {
    logger.error('Firebase OAuth callback:', err.message);
    return res.redirect(adminRedirect(`firebase_oauth=error&reason=${encodeURIComponent(String(err.message).slice(0, 80))}`));
  }
});

module.exports = router;
module.exports.signFirebaseState = signFirebaseState;
