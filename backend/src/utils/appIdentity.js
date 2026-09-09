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

/**
 * Expand assigned/filter App IDs to every alias GAM may store:
 * package, display name, numeric resolved id.
 * Lean sync often writes MOBILE_APP_NAME into inv_app, while the UI assigns packages.
 */
function expandAppFilterAliases(apps = [], mapsInput = null) {
  const maps = mapsInput
    ? (mapsInput.byPackage instanceof Map ? mapsInput : rehydrateAppPackageMaps(mapsInput))
    : { byPackage: new Map(), byName: new Map(), byResolvedId: new Map() };
  const out = new Set();
  const add = (v) => {
    const n = norm(v);
    if (n && n !== '—') out.add(n);
  };

  (apps || []).forEach((raw) => {
    const a = norm(raw);
    if (!a) return;
    add(a);

    maps.byPackage.forEach((name, pkg) => {
      if (norm(pkg) === a) add(name);
    });
    const pkgFromName = maps.byName.get(a);
    if (pkgFromName) {
      add(pkgFromName);
      maps.byPackage.forEach((name, pkg) => {
        if (norm(pkg) === norm(pkgFromName)) add(name);
      });
    }
    const pkgFromId = maps.byResolvedId.get(a) || maps.byResolvedId.get(String(raw || '').trim());
    if (pkgFromId) {
      add(pkgFromId);
      maps.byPackage.forEach((name, pkg) => {
        if (norm(pkg) === norm(pkgFromId)) add(name);
      });
    }
    maps.byResolvedId.forEach((pkg, id) => {
      if (norm(pkg) === a) add(id);
    });
  });

  return [...out];
}

function loadCachedAppPackageMaps() {
  try {
    const { cache } = require('../gam/client');
    const catalog = cache.get('filter_catalog_inventory_v25');
    return rehydrateAppPackageMaps(catalog?.appPackageMaps);
  } catch (_) {
    return { byPackage: new Map(), byName: new Map(), byResolvedId: new Map() };
  }
}

/** Keys used to match App ID filters / permissions — package, resolved IDs, and display names. */
function collectRowAppKeys(row = {}) {
  const keys = new Set();
  const add = (v) => {
    const n = norm(v);
    if (!n || n === '—' || /^\(not\s+applicable\)$/i.test(n) || n === '(unknown)') return;
    keys.add(n);
  };
  add(row.appPackage);
  add(row.appId);
  add(row.gamResolvedId);
  add(row.appName);
  add(row.inv_app);
  if (row.dimensions) {
    add(row.dimensions.mobile_app_resolved_id);
    add(row.dimensions.MOBILE_APP_RESOLVED_ID);
    add(row.dimensions.mobile_app_name);
    add(row.dimensions.MOBILE_APP_NAME);
    add(row.dimensions.appPackage);
    add(row.dimensions.appId);
  }
  return keys;
}

function rowAdUnitLooksLikeApp(row = {}) {
  const adUnit = norm(row.site || row.ad_unit_name || row.AD_UNIT_NAME || row.inv_ad_unit || '');
  if (!adUnit) return '';
  // Android/iOS packages in ad-unit names: com.foo.bar_slot
  if (/^(com|org|net|io)\.[a-z0-9_.]+/i.test(adUnit)) return adUnit;
  return '';
}

function rowMatchesAppKeys(row, assignedSet) {
  if (!assignedSet?.size) return true;
  const expanded = new Set(expandAppFilterAliases([...assignedSet], loadCachedAppPackageMaps()));
  const keys = collectRowAppKeys(row);
  for (const k of keys) {
    if (expanded.has(k)) return true;
  }
  const adUnit = rowAdUnitLooksLikeApp(row);
  if (adUnit) {
    for (const a of expanded) {
      if (isLikelyAppPackage(a) && a.includes('.') && adUnit.startsWith(a)) return true;
    }
  }
  return false;
}

function isMobileAppRow(row = {}) {
  if (collectRowAppKeys(row).size > 0) return true;
  return Boolean(rowAdUnitLooksLikeApp(row));
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
  expandAppFilterAliases,
  loadCachedAppPackageMaps,
  isMobileAppRow,
  appPackageForPicker,
  isLikelyAppPackage,
  isGamInternalAppId,
  norm,
};
