/**
 * Named saved filters — persisted to localStorage per user + page.
 * Dates are intentionally excluded so the user picks a date range when reusing.
 *
 * Storage key: savedReportFilters_v1:<page>:<userId>
 * Item shape: { id, name, snapshot, summary, when }
 *
 * Unlike recentFilters, these are NOT cleared on logout.
 */

import { TOKEN_KEY } from './authConstants';
import { userIdFromToken } from './crossTabAuth';

const STORAGE_PREFIX = 'savedReportFilters_v1';
/** Soft cap so localStorage stays reasonable — not a product limit of 2. */
const MAX = 50;
export const SAVED_FILTERS_PAGES = Object.freeze({
  dashboard: 'dashboard',
  reporting: 'reporting',
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
  const p = page || 'reporting';
  return `${STORAGE_PREFIX}:${p}:${id}`;
}

function toArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v.filter(Boolean) : (v ? [v] : []);
}

/** Normalize a filter snapshot — never keeps dates. */
export function normalizeSavedSnapshot(f = {}) {
  return {
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

function makeId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* ignore */
  }
  return `sf_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Short hint under the name (inventory / dims — no dates). */
export function summaryFor(snapshot) {
  const p = normalizeSavedSnapshot(snapshot);
  const parts = [];

  const fmt = (label, arr) => {
    const list = Array.isArray(arr) ? arr.filter(Boolean) : [];
    if (!list.length) return;
    if (list.length === 1 && list[0] === '__ALL__') {
      parts.push(`${label}: All selected`);
      return;
    }
    const clean = list.filter((v) => v !== '__ALL__');
    if (!clean.length) return;
    if (clean.length === 1) parts.push(`${label}: ${clean[0]}`);
    else parts.push(`${label}s (${clean.length})`);
  };

  fmt('Domain', p.domain);
  fmt('Site', p.site);
  fmt('Ad Unit', p.domainName);
  fmt('App', p.domainId);
  fmt('Country', p.country);
  if (p.reportDimensions?.length) {
    parts.push(`Dims (${p.reportDimensions.length})`);
  }
  if (p.reportMetrics?.length) {
    parts.push(`Metrics (${p.reportMetrics.length})`);
  }

  return parts.length ? parts.join(' • ') : 'No inventory filters';
}

function parseList(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => {
        if (!entry || !entry.snapshot) return null;
        const snap = normalizeSavedSnapshot(entry.snapshot);
        const name = String(entry.name || '').trim() || 'Untitled filter';
        return {
          id: entry.id || makeId(),
          name,
          snapshot: snap,
          summary: entry.summary || summaryFor(snap),
          when: entry.when || Date.now(),
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function writeList(page, userId, list) {
  const next = (Array.isArray(list) ? list : []).slice(0, MAX);
  localStorage.setItem(storageKey(page, userId), JSON.stringify(next));
  return next;
}

export function getSavedFilters(page, userId) {
  try {
    return parseList(localStorage.getItem(storageKey(page, userId)));
  } catch {
    return [];
  }
}

/**
 * Always adds a new named filter (does not replace similar payloads).
 * Dates are stripped. Returns the updated list.
 */
export function saveNamedFilter(page, name, filter, userId) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return getSavedFilters(page, userId);

  try {
    const snap = normalizeSavedSnapshot(filter);
    const existing = getSavedFilters(page, userId);
    const next = [
      {
        id: makeId(),
        name: trimmed.slice(0, 80),
        snapshot: snap,
        summary: summaryFor(snap),
        when: Date.now(),
      },
      ...existing,
    ];
    return writeList(page, userId, next);
  } catch {
    return getSavedFilters(page, userId);
  }
}

/**
 * Update an existing saved filter's name and/or snapshot (from current filters).
 * Pass filter=null/undefined to keep the previous snapshot (rename only).
 */
export function updateNamedFilter(page, id, { name, filter } = {}, userId) {
  if (!id) return getSavedFilters(page, userId);
  try {
    const existing = getSavedFilters(page, userId);
    const idx = existing.findIndex((item) => item.id === id);
    if (idx < 0) return existing;

    const prev = existing[idx];
    const trimmed = name != null ? String(name).trim().slice(0, 80) : prev.name;
    if (!trimmed) return existing;

    const snap = filter != null
      ? normalizeSavedSnapshot(filter)
      : prev.snapshot;

    const updated = {
      ...prev,
      name: trimmed,
      snapshot: snap,
      summary: summaryFor(snap),
      when: Date.now(),
    };

    const next = [updated, ...existing.filter((item) => item.id !== id)];
    return writeList(page, userId, next);
  } catch {
    return getSavedFilters(page, userId);
  }
}

export function removeSavedFilter(page, id, userId) {
  try {
    const next = getSavedFilters(page, userId).filter((item) => item.id !== id);
    return writeList(page, userId, next);
  } catch {
    return getSavedFilters(page, userId);
  }
}

/** Snapshot ready to merge into page state (no dates). */
export function applySavedFilter(snapshot) {
  return normalizeSavedSnapshot(snapshot);
}

export function hasSavableFilters(filter = {}) {
  const s = normalizeSavedSnapshot(filter);
  // Metrics/settings alone (Reporting defaults) are not enough — need inventory,
  // country, or chosen dimensions so the named set is meaningful without dates.
  return Boolean(
    s.domain.length
    || s.site.length
    || s.domainName.length
    || s.domainId.length
    || s.country.length
    || s.reportDimensions.length
  );
}

export default {
  getSavedFilters,
  saveNamedFilter,
  updateNamedFilter,
  removeSavedFilter,
  applySavedFilter,
  summaryFor,
  hasSavableFilters,
  normalizeSavedSnapshot,
  SAVED_FILTERS_PAGES,
};
