import { optionsFor, readDomainName, resolveSiteHost, rootDomainFromHost, validSiteHostsOnly } from './filters';
import { catalogRowsToAppIdOptions } from './domainCatalog';
import { isLikelyAppPackage } from './appPackage';
function hostKeysForLookup(site) {
  const keys = new Set();
  const raw = String(site || '').trim().toLowerCase();
  if (!raw) return [];
  keys.add(raw);
  const resolved = resolveSiteHost({ siteUrl: raw, gamSite: raw, siteName: raw });
  if (resolved) keys.add(resolved.toLowerCase());
  const root = rootDomainFromHost(raw);
  if (root && !raw.includes('.')) keys.add(`${raw}.${root}`);
  return Array.from(keys);
}

function rootDomainsForSites(sites = []) {
  return [...new Set(
    sites
      .map((s) => rootDomainFromHost(String(s).trim().toLowerCase()))
      .filter(Boolean)
  )];
}

function collectAdUnitsFromHostMap(adUnitsByHost = {}, siteHosts = null) {
  const set = new Set();
  const addUnits = (units) => {
    (units || []).forEach((u) => {
      const s = String(u || '').trim();
      if (s && s !== '—') set.add(s);
    });
  };
  if (!siteHosts?.length) {
    Object.values(adUnitsByHost).forEach(addUnits);
    return [...set].sort((a, b) => a.localeCompare(b));
  }
  siteHosts.forEach((site) => {
    hostKeysForLookup(site).forEach((h) => addUnits(adUnitsByHost[h]));
  });
  return [...set].sort((a, b) => a.localeCompare(b));
}

function cascadeOptionsForSite(catalog, selections, field, adUnitsByHost = {}, selectedDomains = []) {
  const sites = selections.site || [];
  if (!sites.length) return null;

  const set = new Set(optionsFor(catalog, selections, field));

  if (field === 'adUnit') {
    sites.forEach((site) => {
      hostKeysForLookup(site).forEach((h) => {
        (adUnitsByHost[h] || []).forEach((au) => set.add(au));
      });
    });
  }

  if (!set.size) {
    const roots = rootDomainsForSites(sites);
    if (roots.length) {
      optionsFor(catalog, { ...selections, site: roots }, field).forEach((v) => set.add(v));
    }
  }

  let list = Array.from(set).filter((v) => v && v !== '—').sort();
  if (field === 'adUnit' && selectedDomains.length) {
    const picked = new Set(selectedDomains.map((d) => String(d).toLowerCase()));
    list = list.filter((au) => {
      const row = catalog.find((r) => r.site === au);
      if (!row) return true;
      const dom = readDomainName(row).toLowerCase();
      const root = rootDomainFromHost(dom).toLowerCase();
      return picked.has(dom) || picked.has(root);
    });
  }
  return list;
}

function adUnitsForSelectedSites(catalog, selections, adUnitsByHost = {}, selectedDomains = []) {
  return cascadeOptionsForSite(catalog, selections, 'adUnit', adUnitsByHost, selectedDomains);
}

function appsForSelectedSites(catalog, selections) {
  const sites = selections.site || [];
  if (!sites.length) return null;
  return cascadeOptionsForSite(catalog, selections, 'app');
}

function hostMatchesAllowed(value, allowedDomains) {
  if (!value || value === '—') return false;
  const allowed = new Set(allowedDomains.map((d) => String(d).toLowerCase().trim()));
  const raw = String(value).toLowerCase().trim();
  if (allowed.has(raw)) return true;
  const root = rootDomainFromHost(raw);
  return root && allowed.has(root.toLowerCase());
}

function filterListByAllowed(list = [], allowedDomains) {
  if (!allowedDomains?.length) return [];
  return list.filter((item) => hostMatchesAllowed(item, allowedDomains));
}

function filterSitesByDomainMap(map = {}, allowedDomains) {
  if (!allowedDomains?.length) return {};
  const out = {};
  Object.entries(map).forEach(([dom, hosts]) => {
    if (!hostMatchesAllowed(dom, allowedDomains)) return;
    const scoped = filterListByAllowed(hosts, allowedDomains);
    if (scoped.length) out[dom] = scoped;
  });
  return out;
}

/** Client-side safety net: keep only assigned-domain inventory in dropdown options. */
export function scopeCatalogToAssignedDomains(catalog = [], allowedDomains) {
  if (allowedDomains == null) return catalog;
  if (!allowedDomains.length) return [];
  return catalog.filter((row) => {
    const fields = [row.domainName, row.siteName, row.siteUrl, row.gamSite, row.site, row.appId];
    return fields.some((v) => hostMatchesAllowed(v, allowedDomains));
  });
}

/** Site hosts limited to selected root domains (when domain filter is active). */
export function siteHostsForDomains(hosts = [], selectedDomains = []) {
  if (!selectedDomains.length) return hosts;
  const picked = new Set(selectedDomains.map((d) => String(d).toLowerCase()));
  return hosts.filter((h) => {
    const root = rootDomainFromHost(h);
    return picked.has(String(h).toLowerCase()) || picked.has(String(root).toLowerCase());
  });
}

/** Sites for selected domain(s) — uses GAM sitesByDomain map when available (like GAM Site filter). */
export function sitesForSelectedDomains(siteHosts = [], sitesByDomain = {}, selectedDomains = []) {
  if (!selectedDomains.length) return siteHosts;
  if (sitesByDomain && Object.keys(sitesByDomain).length) {
    const out = new Set();
    selectedDomains.forEach((d) => {
      const key = String(d).toLowerCase();
      const root = rootDomainFromHost(d).toLowerCase();
      Object.entries(sitesByDomain).forEach(([dom, hosts]) => {
        const dl = String(dom).toLowerCase();
        if (dl === key || dl === root) hosts.forEach((h) => out.add(h));
      });
    });
    const list = Array.from(out).sort();
    if (list.length) return list;
  }
  return siteHostsForDomains(siteHosts, selectedDomains);
}

function norm(value) {
  return String(value || '').toLowerCase().trim();
}

function mergeAssignedList(options = [], assigned = []) {
  if (!assigned?.length) return options;
  const seen = new Set(options.map((v) => norm(v)));
  const out = [...options];
  assigned.forEach((v) => {
    const key = norm(v);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(v);
    }
  });
  return out.sort((a, b) => String(a).localeCompare(String(b)));
}

/** Admin site picker — full site URL list (not filtered by selected domains). */
export function buildAdminSitePickerOptions({
  catalogRows = [],
  siteHosts = [],
  assignedSites = [],
} = {}) {
  const fromApi = (siteHosts || []).map((h) => String(h).trim()).filter(Boolean);
  const fromCatalog = catalogRows.length ? optionsFor(catalogRows, {}, 'site') : [];
  const assigned = (assignedSites || []).map((h) => String(h).trim()).filter(Boolean);
  const list = [...new Set([...fromApi, ...fromCatalog, ...assigned])].sort();
  return list.map((h) => ({ id: h, label: h }));
}

/** Admin app ID picker — assigned values only (for viewing/removing). */
export function buildAdminAssignedAppOptions(assignedAppIds = []) {
  const seen = new Set();
  const out = [];
  (assignedAppIds || []).forEach((id) => {
    const s = String(id || '').trim();
    if (!s || s === '—') return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id: s, label: s, appId: s });
  });
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/** Admin app ID picker — network catalog packages only; legacy assigned names kept for removal. */
export function buildAdminAppPickerOptions({
  catalogRows = [],
  appIds = [],
  assignedAppIds = [],
} = {}) {
  const seen = new Set();
  const out = [];
  const assignedSet = new Set(
    (assignedAppIds || []).map((v) => String(v || '').trim().toLowerCase()).filter(Boolean)
  );
  const add = (id, label = id) => {
    const s = String(id || '').trim();
    if (!s || s === '—') return;
    const key = s.toLowerCase();
    const isAssigned = assignedSet.has(key);
    if (!isLikelyAppPackage(s) && !isAssigned) return;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id: s, label: isLikelyAppPackage(s) ? s : `${s} (legacy)`, appId: s });
  };
  (assignedAppIds || []).forEach((id) => add(id));
  (appIds || []).filter(isLikelyAppPackage).forEach((id) => add(id));
  catalogRowsToAppIdOptions(catalogRows).forEach((o) => add(o.id, o.label));
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Domain + site dropdown options from API lists (preferred) or catalog rows (fallback).
 */
export function buildFilterDropdownOptions({
  catalog = [],
  selections = {},
  domainRoots = [],
  siteHosts = [],
  sitesByDomain = {},
  adUnitsByHost = {},
  selectedDomains = [],
  allowedDomains = null,
  inventoryScope = null,
  independentAssignment = true,
  appIds = [],
}) {
  const scopedRoots = allowedDomains == null
    ? domainRoots
    : filterListByAllowed(domainRoots, allowedDomains);
  const scopedSiteHosts = allowedDomains == null
    ? siteHosts
    : filterListByAllowed(siteHosts, allowedDomains);
  const scopedSitesByDomain = allowedDomains == null
    ? sitesByDomain
    : filterSitesByDomainMap(sitesByDomain, allowedDomains);
  const scopedCatalog = allowedDomains == null
    ? catalog
    : scopeCatalogToAssignedDomains(catalog, allowedDomains);

  const domainOptions = scopedRoots.length
    ? scopedRoots
    : optionsFor(scopedCatalog, selections, 'domain');

  const allSites = validSiteHostsOnly(
    scopedSiteHosts.length
      ? scopedSiteHosts
      : optionsFor(scopedCatalog, selections, 'site')
  );

  const emptySelections = { domain: [], site: [], adUnit: [], app: [] };
  const siteOptions = validSiteHostsOnly(allSites);

  const networkAppPackages = (appIds || []).filter(isLikelyAppPackage);
  const hostMapAdUnits = collectAdUnitsFromHostMap(adUnitsByHost);

  let domainOptionsOut = domainOptions;
  let siteOptionsOut = siteOptions;
  let adUnitOptions = mergeAssignedList(
    optionsFor(scopedCatalog, emptySelections, 'adUnit'),
    hostMapAdUnits
  );
  let appOptions = mergeAssignedList(
    optionsFor(scopedCatalog, emptySelections, 'app').filter(isLikelyAppPackage),
    networkAppPackages
  );

  // Scoped child users — assigned inventory only; filters stay independent of each other.
  if (independentAssignment && inventoryScope) {
    const scopedSites = inventoryScope.allowedSites || [];
    const scopedDomains = inventoryScope.allowedDomains || [];
    let scopedAdUnits = optionsFor(
      scopedCatalog,
      { domain: scopedDomains, site: [], adUnit: [], app: [] },
      'adUnit'
    );
    if (!scopedAdUnits.length && scopedSites.length) {
      scopedAdUnits = collectAdUnitsFromHostMap(adUnitsByHost, scopedSites);
    }
    if (!scopedAdUnits.length && scopedDomains.length) {
      scopedAdUnits = optionsFor(
        scopedCatalog,
        { domain: scopedDomains, site: scopedSites, adUnit: [], app: [] },
        'adUnit'
      );
    }
    adUnitOptions = scopedAdUnits;
    domainOptionsOut = inventoryScope.allowedDomains?.length
      ? [...inventoryScope.allowedDomains].sort((a, b) => String(a).localeCompare(String(b)))
      : [];
    siteOptionsOut = inventoryScope.allowedSites?.length
      ? validSiteHostsOnly([...inventoryScope.allowedSites])
      : [];
    appOptions = inventoryScope.allowedAppIds?.length
      ? [...inventoryScope.allowedAppIds]
        .map((v) => String(v || '').trim())
        .filter(Boolean)
        .sort((a, b) => String(a).localeCompare(String(b)))
      : [];
    return {
      domainOptions: domainOptionsOut,
      siteOptions: siteOptionsOut,
      adUnitOptions,
      appOptions,
    };
  }

  if (inventoryScope) {
    domainOptionsOut = mergeAssignedList(domainOptionsOut, inventoryScope.allowedDomains);
    siteOptionsOut = mergeAssignedList(siteOptionsOut, inventoryScope.allowedSites);
    appOptions = mergeAssignedList(
      appOptions.filter(isLikelyAppPackage),
      (inventoryScope.allowedAppIds || []).filter(isLikelyAppPackage)
    );
  }

  return {
    domainOptions: domainOptionsOut,
    siteOptions: siteOptionsOut,
    adUnitOptions,
    appOptions,
  };
}

export function hostsUnderDomain(catalog, domain) {
  const picked = String(domain || '').toLowerCase();
  const set = new Set();
  catalog.forEach((row) => {
    if (readDomainName(row).toLowerCase() !== picked) return;
    const h = row.siteUrl || row.siteName || row.gamSite;
    if (h && h !== '—') set.add(h);
  });
  return validSiteHostsOnly(Array.from(set)).sort();
}
