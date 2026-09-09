import { getDefaultHomeRoute, isAdmin, canAccessPage } from './auth/permissions';

const KEY = 'adnexus.lastRoute';

const ALLOWED = new Set(['/dashboard', '/reporting', '/roi', '/presets', '/admin', '/domain-user']);

export function rememberLastRoute(pathname) {
  const path = String(pathname || '').split('?')[0];
  if (!ALLOWED.has(path)) return;
  try {
    localStorage.setItem(KEY, path);
  } catch {
    /* ignore */
  }
}

export function readLastRoute() {
  try {
    const path = localStorage.getItem(KEY);
    return ALLOWED.has(path) ? path : null;
  } catch {
    return null;
  }
}

function routeAllowed(user, path) {
  if (path === '/admin') return isAdmin(user);
  const pageMap = {
    '/dashboard': 'dashboard',
    '/reporting': 'reporting',
    '/roi': 'roi',
    '/presets': 'presets',
    '/domain-user': 'domain-user',
  };
  const page = pageMap[path];
  if (page) return canAccessPage(user, page);
  return false;
}

/** Last visited allowed page, else the role default. */
export function resolveHomeRoute(user) {
  const last = readLastRoute();
  if (last && routeAllowed(user, last)) return last;
  return getDefaultHomeRoute(user);
}
