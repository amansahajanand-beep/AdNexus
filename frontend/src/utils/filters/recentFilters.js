/**
 * Recently used report filters — persisted to localStorage per user.
 *
 * Each saved item is shaped as:
 *   { id, snapshot, label, when }
 *
 * Storage key: recentReportFilters_v1:<userId> (falls back to legacy global key)
 *
 * Public API (used by Reporting.js and Dashboard.js):
 *   getRecentFilters()  → array of items
 *   saveRecentFilter()  → saves a snapshot, returns updated array
 *   applyRecentFilter() → returns a normalized snapshot for re-application
 *   clearRecentFilters()→ empties storage for the current/all users + notifies UI
 *   labelFor()          → builds a label from a snapshot
 */

import { TOKEN_KEY } from '../auth/authConstants';
import { userIdFromToken } from '../auth/crossTabAuth';

const STORAGE_PREFIX = 'recentReportFilters_v1';
const LEGACY_STORAGE_KEY = 'recentReportFilters_v1';
const MAX = 8;
export const RECENT_FILTERS_CLEARED_EVENT = 'recent_filters_cleared';

function currentUserId() {
  try {
    const token = localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
    return userIdFromToken(token) || null;
  } catch {
    return null;
  }
}

function storageKey(userId) {
  const id = userId || currentUserId();
  return id ? `${STORAGE_PREFIX}:${id}` : LEGACY_STORAGE_KEY;
}

function toArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v.filter(Boolean) : (v ? [v] : []);
}

/** Normalize a filter snapshot into the canonical shape used by the pages. */
function normalize(f = {}) {
  return {
    preset: f.preset || null,
    startDate: f.startDate || null,
    endDate: f.endDate || null,
    country: toArray(f.country),
    domain: toArray(f.domain),
    site: toArray(f.site),
    domainName: toArray(f.domainName),
    domainId: toArray(f.domainId),
    reportDimensions: toArray(f.reportDimensions),
    reportMetrics: toArray(f.reportMetrics),
    reportSettings: f.reportSettings || {},
  };
}

/** Stable key for dedup — compares the meaningful filter payload. */
function snapshotKey(s) {
  return JSON.stringify({
    startDate: s.startDate,
    endDate: s.endDate,
    country: s.country,
    domain: s.domain,
    site: s.site,
    domainName: s.domainName,
    domainId: s.domainId,
    reportDimensions: s.reportDimensions,
    reportMetrics: s.reportMetrics,
    reportSettings: s.reportSettings,
  });
}

function parseList(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => {
        if (entry && entry.snapshot) {
          const snap = normalize(entry.snapshot);
          return {
            id: entry.id || snapshotKey(snap),
            snapshot: snap,
            label: entry.label || labelFor(snap),
            when: entry.when || Date.now(),
          };
        }
        if (entry && entry.payload) {
          const snap = normalize(entry.payload);
          return {
            id: entry.key || snapshotKey(snap),
            snapshot: snap,
            label: entry.labelRef || labelFor(snap),
            when: entry.when || Date.now(),
          };
        }
        return null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Read the persisted list for the active (or given) user. */
export function getRecentFilters(userId) {
  try {
    const key = storageKey(userId);
    const list = parseList(localStorage.getItem(key));
    if (list.length) return list;
    // One-time migrate legacy global list into the per-user key when possible.
    if (key !== LEGACY_STORAGE_KEY) {
      const legacy = parseList(localStorage.getItem(LEGACY_STORAGE_KEY));
      if (legacy.length) {
        localStorage.setItem(key, JSON.stringify(legacy));
        localStorage.removeItem(LEGACY_STORAGE_KEY);
        return legacy;
      }
    }
    return [];
  } catch {
    return [];
  }
}

/** Save/refresh a snapshot in the recent list; returns the updated array. */
export function saveRecentFilter(filter, userId) {
  try {
    const snap = normalize(filter);
    const key = snapshotKey(snap);
    const storeKey = storageKey(userId);
    const existing = getRecentFilters(userId);
    const rest = existing.filter((item) => item.id !== key);
    const next = [
      { id: key, snapshot: snap, label: labelFor(snap), when: Date.now() },
      ...rest,
    ].slice(0, MAX);
    localStorage.setItem(storeKey, JSON.stringify(next));
    return next;
  } catch {
    return getRecentFilters(userId);
  }
}

export function removeRecentFilter(id, userId) {
  try {
    const storeKey = storageKey(userId);
    const next = getRecentFilters(userId).filter((item) => item.id !== id);
    localStorage.setItem(storeKey, JSON.stringify(next));
    return next;
  } catch {
    return getRecentFilters(userId);
  }
}

/** Return a normalized snapshot ready to be applied to the page state. */
export function applyRecentFilter(snapshot) {
  return normalize(snapshot);
}

function notifyCleared() {
  try {
    window.dispatchEvent(new CustomEvent(RECENT_FILTERS_CLEARED_EVENT));
  } catch {
    /* ignore */
  }
}

/**
 * Empty recent filters for the given / current user (and the legacy global key).
 * Call on logout and session expiry so that user starts clean next time.
 */
export function clearRecentFilters(userId) {
  try {
    const id = userId || currentUserId();
    if (id) localStorage.removeItem(`${STORAGE_PREFIX}:${id}`);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  notifyCleared();
}

/** Build a short, human-readable label from a snapshot. */
export function labelFor(item) {
  const p = item && item.snapshot ? item.snapshot : item || {};

  const parts = [];

  if (p.startDate && p.endDate) {
    parts.push(`${p.startDate} → ${p.endDate}`);
  }

  if (p.domain?.length) {
    if (p.domain.length === 1 && p.domain[0] === '__ALL__') parts.push('Domains: All selected');
    else parts.push(
      p.domain.length === 1
        ? `Domain: ${p.domain[0]}`
        : `Domains: ${p.domain[0]} (+${p.domain.length - 1})`
    );
  }

  if (p.site?.length) {
    if (p.site.length === 1 && p.site[0] === '__ALL__') parts.push('Sites: All selected');
    else parts.push(
      p.site.length === 1
        ? `Site: ${p.site[0]}`
        : `Sites: ${p.site[0]} (+${p.site.length - 1})`
    );
  }

  if (p.domainName?.length) {
    if (p.domainName.length === 1 && p.domainName[0] === '__ALL__') parts.push('Ad Units: All selected');
    else parts.push(
      p.domainName.length === 1
        ? `Ad Unit: ${p.domainName[0]}`
        : `Ad Units: ${p.domainName[0]} (+${p.domainName.length - 1})`
    );
  }

  if (p.domainId?.length) {
    if (p.domainId.length === 1 && p.domainId[0] === '__ALL__') parts.push('Apps: All selected');
    else parts.push(
      p.domainId.length === 1
        ? `App: ${p.domainId[0]}`
        : `Apps: ${p.domainId[0]} (+${p.domainId.length - 1})`
    );
  }

  return parts.join(' • ');
}

export default {
  getRecentFilters,
  saveRecentFilter,
  applyRecentFilter,
  clearRecentFilters,
  labelFor,
  removeRecentFilter,
  RECENT_FILTERS_CLEARED_EVENT,
};
