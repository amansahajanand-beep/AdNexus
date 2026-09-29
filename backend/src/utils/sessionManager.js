/**
 * Single active session per user — session id stored on user record + embedded in JWT (sid).
 */
const crypto = require('crypto');
const { getUserById, updateUser } = require('../models/userStore');
const sessionStore = process.env.USE_PG_USERS === 'true' ? require('../models/userStorePg') : null;

function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

/** Create a new session and invalidate any previous one for this user. */
async function rotateUserSession(userId, req = {}) {
  const sessionId = generateSessionId();
  if (sessionStore) {
    await sessionStore.expireSessionsForUser(userId);
    await sessionStore.createSession({
      sessionId,
      userId,
      userAgent: req.headers?.['user-agent'] || null,
      ipAddress: req.ip || req.connection?.remoteAddress || null,
    });
  }
  await Promise.resolve(updateUser(userId, { activeSessionId: sessionId }));
  return sessionId;
}

/** Clear active session (logout). */
async function clearUserSession(userId, sessionId) {
  if (sessionStore && sessionId) {
    await sessionStore.expireSession(sessionId);
  }
  await Promise.resolve(updateUser(userId, { activeSessionId: null }));
}

/** True when JWT sid matches the user's current active session. */
function isActiveSession(user, sessionId) {
  if (!user?.activeSessionId) return false;
  if (!sessionId || typeof sessionId !== 'string') return false;
  return user.activeSessionId === sessionId;
}

function stripSessionFields(user) {
  if (!user) return user;
  const { passwordHash, activeSessionId, ...safe } = user;
  const scope = safe.permissions?.admobScope;
  if (safe.role !== 'admin' && scope) {
    // App / ad unit ids embed the AdMob publisher id — domain users only learn counts + filters.
    safe.permissions = {
      ...safe.permissions,
      admobScope: {
        accountCount: Array.isArray(scope.accountIds) ? scope.accountIds.length : 0,
        filters: Array.isArray(scope.filters) ? scope.filters : [],
      },
    };
  }
  return safe;
}

module.exports = {
  generateSessionId,
  rotateUserSession,
  clearUserSession,
  isActiveSession,
  stripSessionFields,
};
