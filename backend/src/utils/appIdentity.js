/**
 * Mobile app identity — GAM "App ID" in UI = package/bundle id (applicationId).
 * MOBILE_APP_RESOLVED_ID in reports is often a numeric GAM internal id — map via MobileApplicationService.
 */

function norm(value) {
  return String(value || '').toLowerCase().trim();
}

function cleanValue(v) {
  const s = String(v ?? '').trim();
  if (!s || s === '—' || /^\(not\s+applicable\)$/i.test(s)) return '';
  return s;
}

/** GAM internal mobile app id from reports (e.g. 2527238521) — not a package name. */
function isGamInternalAppId(value) {
  const s = cleanValue(value);
  return Boolean(s && /^\d+$/.test(s));
}

/** Package / bundle id for picker lists — not numeric GAM ids or display names with spaces. */
function isLikelyAppPackage(value) {
  const s = cleanValue(value);
  if (!s) return false;
  if (/\s/.test(s)) return false;
  if (/^https?:\/\//i.test(s)) return false;
  if (isGamInternalAppId(s)) return false;
  return s.length >= 1 && s.length <= 255;
}

function mapsToPlain(maps) {
  return {
    byPackage: Object.fromEntries(maps.byPackage || []),
    byName: Object.fromEntries(maps.byName || []),
    byResolvedId: Object.fromEntries(maps.byResolvedId || []),
  };
}

function rehydrateAppPackageMaps(stored) {
  if (!stored) return { byName: new Map(), byPackage: new Map(), byResolvedId: new Map() };
  return {
    byName: new Map(Object.entries(stored.byName || {})),
    byPackage: new Map(Object.entries(stored.byPackage || {})),
    byResolvedId: new Map(Object.entries(stored.byResolvedId || {})),
  };
}

/** Merge package map stores (plain objects or Maps). */
function mergeAppPackageMapData(target = {}, source = {}) {
  const out = {
    byPackage: { ...(target.byPackage || {}) },
    byName: { ...(target.byName || {}) },
    byResolvedId: { ...(target.byResolvedId || {}) },
  };
  const mergeMap = (key, src) => {
    const m = src instanceof Map ? src : new Map(Object.entries(src || {}));
    m.forEach((val, k) => { out[key][k] = val; });
  };
  mergeMap('byPackage', source.byPackage);
  mergeMap('byName', source.byName);
  mergeMap('byResolvedId', source.byResolvedId);
  return out;
}

function packageListFromMapData(mapData = {}) {
  return Object.keys(mapData.byPackage || {})
    .filter(isLikelyAppPackage)
    .sort((a, b) => a.localeCompare(b));
}

function resolvePackageFromResolvedId(resolved, resolvedIdMap) {
  const key = cleanValue(resolved);
  if (!key) return '';
  if (resolvedIdMap) {
    const fromMap = resolvedIdMap.get(key) || resolvedIdMap.get(norm(key));
    if (fromMap && isLikelyAppPackage(fromMap)) return fromMap;
  }
  if (isLikelyAppPackage(key)) return key;
  return '';
}

/** Resolve package + display name from a raw GAM row or enriched report row. */
function resolveAppFields(source = {}, resolvedIdMap = null) {
  const raw = source.raw || source;
  const dimensions = source.dimensions || {};
  const maps = resolvedIdMap || rehydrateAppPackageMaps(source.appPackageMaps);

  const resolved = cleanValue(raw['Dimension.MOBILE_APP_RESOLVED_ID'])
    || cleanValue(dimensions.mobile_app_resolved_id);

  const appName = cleanValue(raw['Dimension.MOBILE_APP_NAME'])
    || cleanValue(dimensions.mobile_app_name)
    || cleanValue(source.appName);

  let pkg = cleanValue(source.appPackage);
  if (!pkg && resolved) {
    pkg = resolvePackageFromResolvedId(resolved, maps.byResolvedId)
      || (isLikelyAppPackage(resolved) ? resolved : '');
  }
  if (!pkg) {
    const legacy = cleanValue(source.appId);
    if (isGamInternalAppId(legacy) && maps.byResolvedId) {
      pkg = maps.byResolvedId.get(legacy) || maps.byResolvedId.get(norm(legacy)) || '';
    } else if (isLikelyAppPackage(legacy)) {
      pkg = legacy;
    }
  }
  if (!pkg && appName && isLikelyAppPackage(appName)) {
    pkg = appName;
  }

  return {
    appPackage: pkg || '—',
    appName: appName || '—',
    appId: pkg || '—',
    gamResolvedId: resolved || '—',
  };
}

/** GAM report rows — map numeric MOBILE_APP_RESOLVED_ID → package via lookup. */
function buildAppPackageMapsFromGamRows(rawRows = [], resolvedIdMap = new Map()) {
  const byPackage = new Map();
  const byName = new Map();
  rawRows.forEach((r) => {
    const resolved = cleanValue(r['Dimension.MOBILE_APP_RESOLVED_ID']);
    const appName = cleanValue(r['Dimension.MOBILE_APP_NAME']);
    let pkg = resolvePackageFromResolvedId(resolved, resolvedIdMap);
    if (!pkg && isLikelyAppPackage(appName)) pkg = appName;
    if (!pkg) return;
    byPackage.set(pkg, appName || pkg);
    if (appName && appName !== pkg) byName.set(norm(appName), pkg);
  });
  return { byPackage, byName, byResolvedId: new Map() };
}

/** MobileApplicationService — applicationId is the store package / bundle id. */
function buildAppPackageMapsFromMobileApps(apps = []) {
  const byPackage = new Map();
  const byName = new Map();
  const byResolvedId = new Map();
  let missingPackage = 0;

  apps.forEach((app) => {
    const pkg = cleanValue(app.applicationId);
    const gamId = cleanValue(app.id);
    const name = cleanValue(app.displayName);
    if (!pkg || !isLikelyAppPackage(pkg)) {
      if (gamId) missingPackage += 1;
      return;
    }
    byPackage.set(pkg, name || pkg);
    if (name && name !== pkg) byName.set(norm(name), pkg);
    if (gamId && isGamInternalAppId(gamId)) {
      byResolvedId.set(gamId, pkg);
    }
  });

  return { byPackage, byName, byResolvedId, missingPackage };
}

function enrichRowWithAppPackage(row, maps) {
  if (!row || (!maps?.byName?.size && !maps?.byPackage?.size && !maps?.byResolvedId?.size)) {
    return row;
  }

  const fields = resolveAppFields(row, maps);
  if (fields.appPackage !== '—') {
    return {
      ...row,
      appPackage: fields.appPackage,
      appName: fields.appName !== '—' ? fields.appName : (maps.byPackage.get(fields.appPackage) || row.appName || '—'),
      appId: fields.appPackage,
      gamResolvedId: fields.gamResolvedId,
    };
  }
  return row;
}

function enrichRowsWithAppPackages(rows = [], maps) {
  if (!maps?.byName?.size && !maps?.byPackage?.size && !maps?.byResolvedId?.size) return rows;
  return rows.map((r) => enrichRowWithAppPackage(r, maps));
}

/** Keys used to match App ID filters / permissions — package & resolved IDs only (not display names). */
function collectRowAppKeys(row = {}) {
  const keys = new Set();
  const addPackageLike = (v) => {
    const n = norm(v);
    if (!n || n === '—') return;
    // Match real GAM App ID / package — never display names like "Videos" / "XVX HD…".
    if (isLikelyAppPackage(n) || isGamInternalAppId(n)) keys.add(n);
  };
  addPackageLike(row.appPackage);
  addPackageLike(row.appId);
  addPackageLike(row.gamResolvedId);
  if (row.dimensions) {
    addPackageLike(row.dimensions.mobile_app_resolved_id);
    addPackageLike(row.dimensions.mobile_app_name);
  }
  addPackageLike(row.appName);
  return keys;
}

function rowMatchesAppKeys(row, assignedSet) {
  if (!assignedSet?.size) return true;
  const keys = collectRowAppKeys(row);
  if (!keys.size) return false;
  for (const k of keys) {
    if (assignedSet.has(k)) return true;
  }
  return false;
}

function isMobileAppRow(row = {}) {
  return collectRowAppKeys(row).size > 0;
}

function appPackageForPicker(row = {}) {
  const fields = resolveAppFields(row);
  return fields.appPackage !== '—' ? fields.appPackage : '';
}

module.exports = {
  resolveAppFields,
  buildAppPackageMapsFromGamRows,
  buildAppPackageMapsFromMobileApps,
  mergeAppPackageMapData,
  mapsToPlain,
  packageListFromMapData,
  enrichRowWithAppPackage,
  enrichRowsWithAppPackages,
  rehydrateAppPackageMaps,
  collectRowAppKeys,
  rowMatchesAppKeys,
  isMobileAppRow,
  appPackageForPicker,
  isLikelyAppPackage,
  isGamInternalAppId,
  norm,
};
