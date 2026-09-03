/**
 * Named report presets — filter snapshot only (no dates).
 * Dates are chosen on the Presets page, same as switching dates on Dashboard.
 *
 * Storage key: reportPresets_v1:<page>:<userId>
 * Item shape: { id, name, snapshot, summary, when, pinned, pinnedAt }
 */

import { TOKEN_KEY } from '../auth/authConstants';
import { userIdFromToken } from '../auth/crossTabAuth';
import { encodeReportShare } from './reportShare';
import { assertValidSavedName } from '../auth/namePolicy';

const STORAGE_PREFIX = 'reportPresets_v1';
const MAX = 50;
export const PRESET_NAME_MAX = 40;
export const PRESET_PAGES = Object.freeze({
  dashboard: 'dashboard',
  reporting: 'reporting',
  roi: 'roi',
});
export const PRESETS_CHANGED_EVENT = 'report_presets_changed';

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
  const p = page || PRESET_PAGES.dashboard;
  return `${STORAGE_PREFIX}:${p}:${id}`;
}

function toArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v.filter(Boolean) : (v ? [v] : []);
}

/** Full snapshot shape (dates optional — legacy presets may still have them). */
export function normalizePresetSnapshot(f = {}) {
  return {
    preset: f.preset || null,
    startDate: f.startDate || null,
    endDate: f.endDate || null,
    targetType: f.targetType || null,
    country: toArray(f.country),
    domain: toArray(f.domain),
    site: toArray(f.site),
    domainName: toArray(f.domainName),
    domainId: toArray(f.domainId),
    reportDimensions: toArray(f.reportDimensions),
    reportMetrics: toArray(f.reportMetrics),
    // ROI Ads filters (MultiSelect values; may include __ALL__)
    accountIds: toArray(f.accountIds),
    campaignIds: toArray(f.campaignIds),
    appKeys: toArray(f.appKeys),
    siteKeys: toArray(f.siteKeys),
    countryCodes: toArray(f.countryCodes),
    accountLabels: toArray(f.accountLabels),
    campaignLabels: toArray(f.campaignLabels),
    appLabels: toArray(f.appLabels),
    siteLabels: toArray(f.siteLabels),
    countryLabels: toArray(f.countryLabels),
  };
}

/** Strip dates from a snapshot before persisting a preset. */
export function filtersOnlySnapshot(f = {}) {
  const snap = normalizePresetSnapshot(f);
  const {
    preset,
    startDate,
    endDate,
    ...filters
  } = snap;
  return filters;
}

/** Merge saved filter preset with active date range (Presets page / open in …). */
export function mergePresetWithDates(filterSnapshot = {}, { startDate, endDate, preset } = {}) {
  return {
    ...filtersOnlySnapshot(filterSnapshot),
    ...(startDate && endDate ? { startDate, endDate } : {}),
    ...(preset ? { preset } : {}),
  };
}

function makeId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* ignore */
  }
  return `rp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function summaryForPreset(snapshot) {
  const p = normalizePresetSnapshot(snapshot);
  const parts = [];

  if (p.targetType && p.targetType !== 'all') {
    parts.push(p.targetType === 'site' ? 'Sites' : 'Apps');
  }

  const fmt = (label, arr) => {
    const list = Array.isArray(arr) ? arr.filter(Boolean) : [];
    if (!list.length) return;
    if (list.length === 1 && list[0] === '__ALL__') {
      parts.push(`${label}: All`);
      return;
    }
    const clean = list.filter((v) => v !== '__ALL__');
    if (!clean.length) return;
    if (clean.length === 1) parts.push(`${label}: ${clean[0]}`);
    else parts.push(`${label}s (${clean.length})`);
  };

  const fmtCountOrLabels = (singular, plural, ids, labels) => {
    const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
    if (!list.length) return;
    if (list.length === 1 && list[0] === '__ALL__') {
      parts.push(`All ${plural}`);
      return;
    }
    const clean = list.filter((v) => v !== '__ALL__');
    if (!clean.length) return;
    const names = Array.isArray(labels) ? labels.filter(Boolean) : [];
    if (clean.length === 1) {
      parts.push(`${singular}: ${names[0] || clean[0]}`);
      return;
    }
    parts.push(`${clean.length} ${plural}`);
  };

  fmt('Domain', p.domain);
  fmt('Site', p.site);
  fmt('Ad Unit', p.domainName);
  fmt('App', p.domainId);
  fmt('Country', p.country);
  if (p.reportDimensions?.length) parts.push(`Dims (${p.reportDimensions.length})`);
  if (p.reportMetrics?.length) parts.push(`Metrics (${p.reportMetrics.length})`);

  fmtCountOrLabels('Account', 'accounts', p.accountIds, p.accountLabels);
  fmtCountOrLabels('Campaign', 'campaigns', p.campaignIds, p.campaignLabels);
  fmtCountOrLabels('App ID', 'apps', p.appKeys, p.appLabels);
  fmtCountOrLabels('Site', 'sites', p.siteKeys, p.siteLabels);
  fmtCountOrLabels('Country', 'countries', p.countryCodes, p.countryLabels);

  return parts.length ? parts.join(' • ') : 'Default filters';
}

function defaultNameFromSnapshot(snapshot) {
  const summary = summaryForPreset(snapshot);
  if (summary && summary !== 'Default filters') {
    return summary.slice(0, PRESET_NAME_MAX);
  }
  return 'Untitled preset';
}

function sortPresets(list) {
  return [...list].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    const pa = a.pinnedAt || 0;
    const pb = b.pinnedAt || 0;
    if (a.pinned && b.pinned && pa !== pb) return pb - pa;
    return (b.when || 0) - (a.when || 0);
  });
}

function parseList(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const list = parsed
      .map((entry) => {
        if (!entry || !entry.snapshot) return null;
        const snap = normalizePresetSnapshot(entry.snapshot);
        const name = String(entry.name || '').trim() || defaultNameFromSnapshot(snap);
        return {
          id: entry.id || makeId(),
          name: name.slice(0, PRESET_NAME_MAX),
          snapshot: snap,
          summary: entry.summary || summaryForPreset(snap),
          when: entry.when || Date.now(),
          pinned: Boolean(entry.pinned),
          pinnedAt: entry.pinnedAt || null,
        };
      })
      .filter(Boolean);
    return sortPresets(list);
  } catch {
    return [];
  }
}

function notifyChanged() {
  try {
    window.dispatchEvent(new CustomEvent(PRESETS_CHANGED_EVENT));
  } catch {
    /* ignore */
  }
}

function writeList(page, userId, list) {
  const next = sortPresets(Array.isArray(list) ? list : []).slice(0, MAX);
  localStorage.setItem(storageKey(page, userId), JSON.stringify(next));
  notifyChanged();
  return next;
}

export function getReportPresets(page, userId) {
  try {
    return parseList(localStorage.getItem(storageKey(page, userId)));
  } catch {
    return [];
  }
}

export function saveReportPreset(page, name, filter, userId) {
  const snap = filtersOnlySnapshot(filter);
  let trimmed;
  try {
    trimmed = assertValidSavedName(
      String(name || '').trim() || defaultNameFromSnapshot(snap),
      { maxLength: PRESET_NAME_MAX, label: 'Preset name' },
    );
  } catch (err) {
    return getReportPresets(page, userId);
  }
  try {
    const existing = getReportPresets(page, userId);
    const next = [
      {
        id: makeId(),
        name: trimmed.slice(0, PRESET_NAME_MAX),
        snapshot: snap,
        summary: summaryForPreset(snap),
        when: Date.now(),
        pinned: false,
        pinnedAt: null,
      },
      ...existing,
    ];
    return writeList(page, userId, next);
  } catch {
    return getReportPresets(page, userId);
  }
}

export function updateReportPreset(page, id, { name } = {}, userId) {
  if (!id) return getReportPresets(page, userId);
  try {
    const existing = getReportPresets(page, userId);
    const idx = existing.findIndex((item) => item.id === id);
    if (idx < 0) return existing;
    const prev = existing[idx];
    let trimmed = prev.name;
    if (name != null) {
      try {
        trimmed = assertValidSavedName(String(name).trim(), {
          maxLength: PRESET_NAME_MAX,
          label: 'Preset name',
        });
      } catch {
        return existing;
      }
    }
    if (!trimmed) return existing;
    const updated = { ...prev, name: trimmed, when: Date.now() };
    const next = existing.map((item) => (item.id === id ? updated : item));
    return writeList(page, userId, next);
  } catch {
    return getReportPresets(page, userId);
  }
}

export function toggleReportPresetPin(page, id, userId) {
  if (!id) return getReportPresets(page, userId);
  try {
    const existing = getReportPresets(page, userId);
    const next = existing.map((item) => {
      if (item.id !== id) return item;
      const pinned = !item.pinned;
      return {
        ...item,
        pinned,
        pinnedAt: pinned ? Date.now() : null,
        when: Date.now(),
      };
    });
    return writeList(page, userId, next);
  } catch {
    return getReportPresets(page, userId);
  }
}

export function removeReportPreset(page, id, userId) {
  try {
    const next = getReportPresets(page, userId).filter((item) => item.id !== id);
    return writeList(page, userId, next);
  } catch {
    return getReportPresets(page, userId);
  }
}

/** Build path+query to open this preset (include dates in snapshot when opening a page). */
export function hrefForPreset(page, snapshot) {
  const path = page === PRESET_PAGES.reporting
    ? '/reporting'
    : page === PRESET_PAGES.roi
      ? '/roi'
      : '/dashboard';
  const qs = encodeReportShare(normalizePresetSnapshot(snapshot));
  return qs ? `${path}?${qs}` : path;
}

export default {
  getReportPresets,
  saveReportPreset,
  updateReportPreset,
  toggleReportPresetPin,
  removeReportPreset,
  summaryForPreset,
  normalizePresetSnapshot,
  filtersOnlySnapshot,
  mergePresetWithDates,
  hrefForPreset,
  PRESET_PAGES,
  PRESET_NAME_MAX,
  PRESETS_CHANGED_EVENT,
};
