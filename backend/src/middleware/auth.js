const jwt = require('jsonwebtoken');
const { getUserById } = require('../models/userStore');
const { getClientById, ensureBootstrapFromEnv } = require('../models/clientStore');
const { isActiveSession } = require('../utils/sessionManager');
const { runWithClient } = require('../utils/clientContext');

const SECRET = () => process.env.JWT_SECRET || 'change_this_secret';

/** Dashboard login session length (JWT access token). */
const SESSION_EXPIRES_IN = process.env.SESSION_EXPIRES_IN || '7d';

const AUTH_CODES = {
  NOT_AUTHENTICATED: 'NOT_AUTHENTICATED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  SESSION_INVALID: 'SESSION_INVALID',
  SESSION_REPLACED: 'SESSION_REPLACED',
  USER_INACTIVE: 'USER_INACTIVE',
};

function sendAuthError(res, status, message, code) {
  return res.status(status).json({ error: message, code });
}

// ─── Generate tokens ──────────────────────────────────────────────────────────
function generateTokens(user, sessionId) {
  const payload = {
    id: user.id,
    role: user.role,
    username: user.username,
    clientId: user.clientId || null,
    sid: sessionId,
  };

  const accessToken = jwt.sign(payload, SECRET(), { expiresIn: SESSION_EXPIRES_IN });
  const refreshToken = jwt.sign({ id: user.id, sid: sessionId }, SECRET(), { expiresIn: '30d' });

  return { accessToken, refreshToken };
}

// ─── Middleware: require login ─────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return sendAuthError(res, 401, 'Not authenticated', AUTH_CODES.NOT_AUTHENTICATED);
  }

  const token = header.slice(7);
  let decoded;
  try {
    decoded = jwt.verify(token, SECRET());
  } catch (err) {
    const code = err.name === 'TokenExpiredError'
      ? AUTH_CODES.SESSION_EXPIRED
      : AUTH_CODES.SESSION_INVALID;
    const message = code === AUTH_CODES.SESSION_EXPIRED
      ? 'Session expired. Please sign in again.'
      : 'Invalid or expired token';
    return sendAuthError(res, 401, message, code);
  }

  let user;
  try {
    user = await Promise.resolve(getUserById(decoded.id));
  } catch (e) {
    return sendAuthError(res, 401, 'User lookup failed', AUTH_CODES.USER_INACTIVE);
  }

  if (!user || !user.isActive) {
    return sendAuthError(res, 401, 'User not found or inactive', AUTH_CODES.USER_INACTIVE);
  }

  if (!isActiveSession(user, decoded.sid)) {
    return sendAuthError(
      res,
      401,
      'Your session was ended because this account signed in elsewhere. Please sign in again.',
      AUTH_CODES.SESSION_REPLACED
    );
  }

  req.user = user;
  req.sessionId = decoded.sid;

  let client = null;
  try {
    if (user.clientId) client = await getClientById(user.clientId);
    if (!client) client = await ensureBootstrapFromEnv();
  } catch (e) {
    return sendAuthError(res, 401, 'Client lookup failed', AUTH_CODES.USER_INACTIVE);
  }
  if (!client) {
    return sendAuthError(res, 403, 'No GAM client is linked to this account', AUTH_CODES.USER_INACTIVE);
  }
  req.client = client;
  return runWithClient(client, () => next());
}

// ─── Middleware: require admin ─────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}

// ─── Permission filter for API responses ──────────────────────────────────────
/**
 * Applies user's permission filters to report query params
 * Returns modified params + visibility flags
 */
function applyPermissions(user, queryParams = {}) {
  if (user.role === 'admin') {
    return {
      ...queryParams,
      _permissions: {
        canSeeRevenue: true,
        canSeeOrders: true,
        canSeeInventory: true,
        canSeeImpressions: true,
        canSeeCTR: true,
        canSeeECPM: true,
        isAdmin: true
      }
    };
  }

  const p = user.permissions || {};

  // Date restriction
  let days = parseInt(queryParams.days) || 30;
  if (p.dateRestriction?.maxDaysBack) {
    days = Math.min(days, p.dateRestriction.maxDaysBack);
  }

  return {
    ...queryParams,
    days,
    // These are passed to GAM API filters
    _allowedDomains: p.allowedDomains?.length ? p.allowedDomains : null,
    _allowedAdUnits: p.allowedAdUnits?.length ? p.allowedAdUnits : null,
    _permissions: {
      canSeeRevenue: p.canSeeRevenue !== false,
      canSeeOrders: p.canSeeOrders !== false,
      canSeeInventory: p.canSeeInventory === true,
      canSeeImpressions: p.canSeeImpressions !== false,
      canSeeCTR: p.canSeeCTR !== false,
      canSeeECPM: p.canSeeECPM !== false,
      isAdmin: false
    }
  };
}

/**
 * Filters a summary object based on permissions
 */
function filterSummary(summary, permissions) {
  const result = { ...summary };
  if (!permissions.canSeeRevenue) { delete result.revenue; delete result.ecpm; }
  if (!permissions.canSeeImpressions) { delete result.impressions; delete result.fillRate; }
  if (!permissions.canSeeCTR) { delete result.ctr; delete result.clicks; }
  if (!permissions.canSeeECPM) delete result.ecpm;
  return result;
}

/**
 * Filters trend/ad-type data based on allowed domains/ad units
 */
function filterByAllowedUnits(data, allowedAdUnits) {
  if (!allowedAdUnits || !allowedAdUnits.length) return data;
  return data.filter(row =>
    allowedAdUnits.some(allowed =>
      (row.name || '').toLowerCase().includes(allowed.toLowerCase())
    )
  );
}

module.exports = {
  generateTokens,
  requireAuth,
  requireAdmin,
  applyPermissions,
  filterSummary,
  filterByAllowedUnits,
  SESSION_EXPIRES_IN,
  AUTH_CODES,
};
