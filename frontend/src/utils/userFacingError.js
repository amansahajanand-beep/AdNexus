const TECHNICAL_RE = /request failed with status code|network error|axioserror|econnaborted|err_network/i;

function readStatus(err) {
  return err?.status ?? err?.response?.status ?? null;
}

function readServerMessage(err) {
  const data = err?.response?.data;
  if (typeof data?.error === 'string' && data.error.trim()) return data.error.trim();
  if (typeof data?.message === 'string' && data.message.trim()) return data.message.trim();
  return '';
}

function isTechnicalMessage(msg) {
  return !msg || TECHNICAL_RE.test(String(msg));
}

/**
 * User-safe error text. Pass contextFallback for screen-specific copy on generic failures.
 */
export function getUserFacingMessage(err, contextFallback) {
  if (!err) return contextFallback || 'Something went wrong. Please try again.';

  const status = readStatus(err);
  const serverMsg = readServerMessage(err);
  const raw = String(err.message || '').trim();

  if (err.isRateLimited || status === 429) {
    return 'The ad network is rate-limiting requests. Please wait a few minutes and try again.';
  }
  if (err.isTimeout || err.code === 'ECONNABORTED' || /timeout/i.test(raw)) {
    return 'This report is taking too long. Try again or choose a shorter date range.';
  }

  if (status === 403) {
    return serverMsg && !isTechnicalMessage(serverMsg)
      ? serverMsg
      : 'You do not have permission to view this data.';
  }
  if (status === 401) {
    return serverMsg && !isTechnicalMessage(serverMsg)
      ? serverMsg
      : 'Your session has expired. Please sign in again.';
  }
  if (status === 404) {
    return serverMsg && !isTechnicalMessage(serverMsg)
      ? serverMsg
      : (contextFallback || 'The requested resource was not found.');
  }
  if (status === 400) {
    return serverMsg && !isTechnicalMessage(serverMsg)
      ? serverMsg
      : 'Invalid filters or request. Please check your selection and try again.';
  }
  if (status === 414) {
    return 'Too many filters selected. Try selecting fewer items or contact your admin.';
  }
  if (status === 502 || status === 503 || status === 504) {
    return 'The reporting service is temporarily unavailable. Please try again shortly.';
  }
  if (status === 500) {
    return contextFallback || 'We could not load this report right now. Please try again in a moment.';
  }

  if (err.code === 'ERR_NETWORK' || (status == null && !raw)) {
    return 'Could not reach the server. Check your connection and try again.';
  }

  if (serverMsg && !isTechnicalMessage(serverMsg)) return serverMsg;
  if (raw && !isTechnicalMessage(raw)) return raw;

  return contextFallback || 'Something went wrong. Please try again.';
}

/** Full technical details — console only, for debugging. */
export function logErrorForDebug(err, context = 'App') {
  const status = readStatus(err);
  const payload = {
    context,
    userMessage: getUserFacingMessage(err),
    message: err?.message,
    status,
    code: err?.code,
    url: err?.config?.url ?? err?.response?.config?.url,
    method: err?.config?.method ?? err?.response?.config?.method,
    responseData: err?.response?.data,
  };
  if (status && status >= 500) {
    console.error(`[${context}] Report/API failure`, payload, err);
  } else {
    console.warn(`[${context}] Request issue`, payload, err);
  }
}
