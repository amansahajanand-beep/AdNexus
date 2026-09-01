import {
  TOKEN_KEY,
  SESSION_SUPERSEDED_KEY,
  INTENTIONAL_LOGOUT_KEY,
  INTENTIONAL_LOGOUT_TAB_KEY,
} from './authConstants';

/** Per-tab flag: this tab was signed out because another account used the browser. */
export { TOKEN_KEY } from './authConstants';

export function markSessionSuperseded() {
  sessionStorage.setItem(SESSION_SUPERSEDED_KEY, '1');
}

export function clearSessionSuperseded() {
  sessionStorage.removeItem(SESSION_SUPERSEDED_KEY);
}

export function isSessionSuperseded() {
  return sessionStorage.getItem(SESSION_SUPERSEDED_KEY) === '1';
}

/** Read JWT payload (client-side only — for cross-tab user id comparison). */
export function decodeTokenPayload(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function userIdFromToken(token) {
  return decodeTokenPayload(token)?.id ?? null;
}

export function sessionIdFromToken(token) {
  return decodeTokenPayload(token)?.sid ?? null;
}

export const CROSS_TAB_ACCOUNT_SWITCH = 'account_switch';
export const CROSS_TAB_LOGOUT = 'logout';
export const CROSS_TAB_SESSION_REPLACED = 'session_replaced_elsewhere';

export function dispatchCrossTabEvent(reason) {
  window.dispatchEvent(new CustomEvent('session_superseded', { detail: { reason } }));
}

/** Call before manual sign-out so in-flight 401s do not show "Session Replaced". */
export function beginIntentionalLogout() {
  try {
    sessionStorage.setItem(INTENTIONAL_LOGOUT_TAB_KEY, '1');
    localStorage.setItem(INTENTIONAL_LOGOUT_KEY, String(Date.now()));
  } catch (_) { /* ignore */ }
}

/** Clear cross-tab hint after manual logout; per-tab flag stays until login. */
export function endIntentionalLogout() {
  setTimeout(() => {
    try { localStorage.removeItem(INTENTIONAL_LOGOUT_KEY); } catch (_) { /* ignore */ }
  }, 30000);
}

export function clearIntentionalLogout() {
  try {
    sessionStorage.removeItem(INTENTIONAL_LOGOUT_TAB_KEY);
    localStorage.removeItem(INTENTIONAL_LOGOUT_KEY);
  } catch (_) { /* ignore */ }
}

/** True during manual logout (this tab until login, or another tab within ~30s). */
export function isIntentionalLogout() {
  try {
    if (sessionStorage.getItem(INTENTIONAL_LOGOUT_TAB_KEY) === '1') return true;
    const v = localStorage.getItem(INTENTIONAL_LOGOUT_KEY);
    if (!v) return false;
    const ts = parseInt(v, 10);
    return Number.isFinite(ts) && Date.now() - ts < 30000;
  } catch (_) {
    return false;
  }
}
