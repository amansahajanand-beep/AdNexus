/**
 * Last-applied filters per page — localStorage so returning to a page restores them.
 * Key: lastPageFilters_v1:<page>:<userId>
 * Does not replace URL share hydration (share wins when present).
 */

import { TOKEN_KEY } from '../auth/authConstants';
import { userIdFromToken } from '../auth/crossTabAuth';

const STORAGE_PREFIX = 'lastPageFilters_v1';

export const LAST_FILTER_PAGES = Object.freeze({
  dashboard: 'dashboard',
  reporting: 'reporting',
  roi: 'roi',
});

function currentUserId() {
  try {
    const token = localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
    return userIdFromToken(token) || null;
  } catch {
    return null;
  }
}

function storageKey(page, userId) {
  const id = userId || currentUserId() || 'anon';
  return `${STORAGE_PREFIX}:${page || 'dashboard'}:${id}`;
}

function toArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v.filter(Boolean) : (v ? [v] : []);
}

export function normalizeLastFilters(page, f = {}) {
  const base = {
    preset: f.preset || null,
    startDate: f.startDate || null,
    endDate: f.endDate || null,
    when: f.when || Date.now(),
  };
  if (page === LAST_FILTER_PAGES.roi) {
    return {
      ...base,
      targetType: ['site', 'app', 'all'].includes(f.targetType) ? f.targetType : 'all',
    };
  }
  return {
    ...base,
    country: toArray(f.country),
    domain: toArray(f.domain),
    site: toArray(f.site),
    domainName: toArray(f.domainName),
    domainId: toArray(f.domainId),
    reportDimensions: toArray(f.reportDimensions),
    reportMetrics: toArray(f.reportMetrics),
    reportSettings: f.reportSettings && typeof f.reportSettings === 'object'
      ? { ...f.reportSettings }
      : {},
  };
}

export function getLastPageFilters(page, userId) {
  try {
    const raw = localStorage.getItem(storageKey(page, userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return normalizeLastFilters(page, parsed);
  } catch {
    return null;
  }
}

export function saveLastPageFilters(page, filters, userId) {
  try {
    const snap = normalizeLastFilters(page, { ...filters, when: Date.now() });
    if (!snap.startDate || !snap.endDate) return snap;
    localStorage.setItem(storageKey(page, userId), JSON.stringify(snap));
    return snap;
  } catch {
    return null;
  }
}

export function clearLastPageFilters(page, userId) {
  try {
    localStorage.removeItem(storageKey(page, userId));
  } catch {
    /* ignore */
  }
}

export default {
  getLastPageFilters,
  saveLastPageFilters,
  clearLastPageFilters,
  normalizeLastFilters,
  LAST_FILTER_PAGES,
};
