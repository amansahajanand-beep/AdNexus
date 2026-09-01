/**
 * Dashboard user session routes (separate from GAM OAuth in routes/auth.js).
 * Mounted at /api/auth
 *   POST /api/auth/login  → { token, user }
 *   POST /api/auth/logout → invalidate server session
 *   GET  /api/auth/me     → current user (requires Bearer token)
 */
const express = require('express');
const router = express.Router();
const { verifyPassword, getUserById, getUserByUsername, updateUser, checkPasswordForUser } = require('../models/userStore');
const { resolveClientForUser } = require('../models/clientStore');
const { generateTokens, requireAuth } = require('../middleware/auth');
const { rotateUserSession, clearUserSession, stripSessionFields } = require('../utils/sessionManager');
const { validatePassword } = require('../utils/passwordPolicy');
const { validateUsername } = require('../utils/namePolicy');
const logger = require('../utils/logger');

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  try {
    const user = await Promise.resolve(verifyPassword(username.trim(), password));
    if (!user) {
      return res.status(400).json({ error: 'Invalid username or password.' });
    }

    if (user.role !== 'admin' && user.permissions && user.permissions.canLogin === false) {
      return res.status(403).json({
        error: 'Your login access has been disabled. Please contact your administrator.',
      });
    }

    // Block login before creating a session if there is no usable GAM client.
    // Avoids "signed in → immediate dashboard 403" when credentials are missing.
    const client = await resolveClientForUser(user);
    if (!client) {
      logger.warn(`Login blocked (no GAM client): ${user.username}`);
      return res.status(403).json({
        error:
          'No GAM client is linked to this account. Connect Google Ad Manager credentials (Admin → Client settings or /onboard) before signing in.',
        code: 'NO_GAM_CLIENT',
      });
    }

    const sessionId = await Promise.resolve(rotateUserSession(user.id, req));
    const freshUser = await Promise.resolve(getUserById(user.id));
    const { accessToken } = generateTokens(freshUser, sessionId);
    logger.info(`User logged in: ${user.username} (${user.role}) — new session`);
    res.json({ token: accessToken, user: stripSessionFields(freshUser) });
  } catch (err) {
    logger.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.post('/logout', requireAuth, async (req, res) => {
  try {
    await Promise.resolve(clearUserSession(req.user.id, req.sessionId));
    logger.info(`User logged out: ${req.user.username}`);
    res.json({ ok: true });
  } catch (err) {
    logger.error('Logout error:', err.message);
    res.status(500).json({ error: 'Logout failed' });
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json(stripSessionFields(req.user));
});

async function handleUpdateProfile(req, res) {
  const { username, email, currentPassword, newPassword } = req.body || {};
  const existing = await Promise.resolve(getUserById(req.user.id));
  if (!existing) {
    return res.status(404).json({ error: 'User not found.' });
  }

  const updates = {};

  if (username != null && String(username).trim() !== existing.username) {
    const trimmed = String(username).trim();
    const nameCheck = validateUsername(trimmed);
    if (!nameCheck.valid) {
      return res.status(400).json({ error: nameCheck.errors[0] });
    }
    const taken = await Promise.resolve(getUserByUsername(trimmed));
    if (taken && taken.id !== existing.id) {
      return res.status(400).json({ error: 'Username already exists.' });
    }
    updates.username = trimmed;
  }

  if (email != null && String(email).trim() !== String(existing.email || '').trim()) {
    const trimmedEmail = String(email).trim();
    if (!trimmedEmail) {
      return res.status(400).json({ error: 'Email is required.' });
    }
    if (!/^[^\s@]+@[^\s@]+(\.[^\s@]+)?$/.test(trimmedEmail)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    updates.email = trimmedEmail;
  }

  if (newPassword) {
    if (!currentPassword) {
      return res.status(400).json({ error: 'Current password is required to set a new password.' });
    }
    if (!await Promise.resolve(checkPasswordForUser(existing, currentPassword))) {
      return res.status(400).json({ error: 'Current password is incorrect.' });
    }
    const nextName = updates.username || existing.username;
    const pwCheck = validatePassword(newPassword, { username: nextName });
    if (!pwCheck.valid) {
      return res.status(400).json({ error: pwCheck.errors[0] });
    }
    updates.password = newPassword;
  }

  if (!Object.keys(updates).length) {
    return res.json({ user: stripSessionFields(existing), updated: false });
  }

  try {
    const updated = await Promise.resolve(updateUser(existing.id, updates));
    logger.info(
      `Profile updated: ${updated.username} (${updated.role})`
      + ` fields=[${Object.keys(updates).filter((k) => k !== 'password').join(',')}${updates.password ? ',password' : ''}]`
    );
    res.json({ user: stripSessionFields(updated), updated: true });
  } catch (err) {
    logger.error('Profile update error:', err.message);
    res.status(400).json({ error: err.message || 'Profile update failed.' });
  }
}

router.patch('/me', requireAuth, handleUpdateProfile);
router.put('/me', requireAuth, handleUpdateProfile);

module.exports = router;
