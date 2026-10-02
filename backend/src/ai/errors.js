/** One error type for everything the AI layer can refuse or fail at, with a stable code for callers. */
class AiError extends Error {
  constructor(code, message, { status = 500, retryAfterSec = null, cause = null } = {}) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
    if (cause) this.cause = cause;
  }
}

const CODES = {
  DISABLED: 'ai_disabled',
  RATE_LIMITED: 'ai_rate_limited',
  BUDGET: 'ai_budget_exceeded',
  TIMEOUT: 'ai_timeout',
  UPSTREAM: 'ai_upstream_error',
  REFUSAL: 'ai_refusal',
  BAD_OUTPUT: 'ai_bad_output',
  BAD_REQUEST: 'ai_bad_request',
};

module.exports = { AiError, CODES };
