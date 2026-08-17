import { getDefaultHomeRoute, isAdmin, buildClientVisibility } from './permissions';

const KEY = 'adnexus.lastRoute';

const ALLOWED = new Set(['/dashboard', '/reporting', '/admin', '/domain-user']);

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
  if (isAdmin(user)) return true;
  const vis = buildClientVisibility(user);
  if (path === '/dashboard') return Boolean(vis.pages.dashboard);
  if (path === '/reporting') return Boolean(vis.pages.reporting);
  if (path === '/domain-user') return Boolean(vis.pages.domainUser);
  return false;
}

/** Last visited allowed page, else the role default. */
export function resolveHomeRoute(user) {
  const last = readLastRoute();
  if (last && routeAllowed(user, last)) return last;
  return getDefaultHomeRoute(user);
}
