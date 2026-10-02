/**
 * AI foundation entry point. Features (preset analysis, mapping suggestions, ...) import from here.
 */
const { run } = require('./provider');
const { getOrCompute, stableKey } = require('./cache');
const { resolveAiAccess, setAccountAiEnabled, getAccountSetting } = require('./flags');
const { usageToday } = require('./limits');
const {
  logUsage, addFeedback, usageSummary, dailySeries, tokenSeries, tokenAverages, flush: flushUsage,
  recentFeedback, recentFailures,
} = require('./telemetry');
const { AiError, CODES } = require('./errors');

/**
 * Try the AI path; on any AI failure run the deterministic path instead so the screen still
 * has useful content. Resolves to { source: 'ai' | 'fallback', value, error? }.
 */
async function withFallback(aiFn, fallbackFn, { feature, ctx = {} } = {}) {
  try {
    return { source: 'ai', value: await aiFn() };
  } catch (err) {
    if (!(err instanceof AiError)) throw err;
    logUsage({ userId: ctx.userId, clientId: ctx.clientId, feature, status: 'fallback', errorCode: err.code });
    return {
      source: 'fallback',
      value: await fallbackFn(err),
      error: { code: err.code, message: err.message },
    };
  }
}

/** Express middleware: 403 with a reason unless AI is on for this user's account. */
async function requireAiEnabled(req, res, next) {
  try {
    const access = await resolveAiAccess(req.user);
    if (!access.enabled) {
      return res.status(403).json({ error: 'AI features are turned off.', code: CODES.DISABLED, reason: access.reason });
    }
    req.aiCtx = { userId: req.user.id, clientId: req.user.clientId || null };
    return next();
  } catch (err) {
    return next(err);
  }
}

/** Express error mapping for AiError so routes can `catch (e) { return sendAiError(res, e) }`. */
function sendAiError(res, err) {
  if (!(err instanceof AiError)) return false;
  if (err.retryAfterSec) res.set('Retry-After', String(err.retryAfterSec));
  res.status(err.status === 499 ? 499 : err.status).json({ error: err.message, code: err.code });
  return true;
}

module.exports = {
  run,
  getOrCompute,
  stableKey,
  withFallback,
  requireAiEnabled,
  sendAiError,
  resolveAiAccess,
  setAccountAiEnabled,
  getAccountSetting,
  dailySeries,
  tokenSeries,
  tokenAverages,
  flushUsage,
  recentFeedback,
  recentFailures,
  usageToday,
  usageSummary,
  addFeedback,
  logUsage,
  AiError,
  CODES,
};
