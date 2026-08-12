const { rowMatchesAppKeys, isMobileAppRow: rowIsMobileApp } = require('./appIdentity');
const {
  pickSiteHost,
  normalizeHost,
  isGamReportSiteHost,
  isAdUnitDerivedSiteHost,
  subdomainFromSiteNameLabel,
  rootDomainFromHost,
  domainFromAdUnit,
  subdomainFromAdUnit,
  subFromHost,
  adUnitAlignsWithSiteHost,
} = require('./adUnit');
const { inferAssignedSiteHost, stripAdUnitSuffix } = require('./inventoryCatalog');

/**
 * Inventory filter query params (legacy names) → meaning:
 *   domain      → root domain name          (DB: inv_domain / domainName)
 *   site        → site URL host             (DB: inv_site / siteUrl)
 *   domainName  → ad unit name              (DB: inv_ad_unit / site / AD_UNIT_NAME)
 *   domainId    → app id / package          (DB: inv_app / appPackage)
 *
 * In-memory matching below; SQL path in gamSyncService.fetchLeanRowsFromDB uses the same mapping.
 */

/** User site filter: exact selected host only — no root-domain expansion. */
function rowHostMatchesFilterSiteSet(rowHost, siteSet) {
  const h = normalizeHost(rowHost) || String(rowHost || '').trim().toLowerCase();
  if (!h || !siteSet?.size) return false;
  return siteSet.has(h);
}

function lookupCatalogAdUnitHost(row = {}, adUnitToHost = null) {
  if (!adUnitToHost?.size || !row.site || row.site === '—') return '';
  const raw = String(row.site).trim().toLowerCase();
  const stripped = stripAdUnitSuffix(row.site).toLowerCase();
  return adUnitToHost.get(raw) || adUnitToHost.get(stripped) || '';
}

/** Canonical site host for filter matching — real GAM site fields only (no ad-unit invent). */
function resolveRowSiteHost(row = {}) {
  const candidates = [
    normalizeHost(row.siteUrl),
    normalizeHost(row.gamSite),
    normalizeHost(row.dimensions?.url_name),
    normalizeHost(row.dimensions?.site_name),
    subdomainFromSiteNameLabel(row.siteName),
    normalizeHost(row.siteName),
    pickSiteHost(row.siteUrl, row.gamSite, row.siteName, row.dimensions?.url_name, row.dimensions?.site_name),
  ].filter(Boolean);
  for (const c of candidates) {
    if (isGamReportSiteHost(c) && !isAdUnitDerivedSiteHost(c)) return c;
  }
  // Keep any valid web host GAM returned (catalog may lag today's active sites).
  for (const c of candidates) {
    if (isGamReportSiteHost(c)) return c;
  }
  return '';
}

function resolveRowDomainName(row = {}) {
  const d = normalizeHost(row.domainName) || rootDomainFromHost(resolveRowSiteHost(row));
  return d || row.domainName || '';
}

/**
 * Hosts used for site filter — real GAM fields / dimensions only.
 * Never invent from ad-unit name. Do not drop hosts just because catalog is incomplete.
 */
function siteHostsForRow(row = {}, selectedSites = null) {
  const selected = selectedSites instanceof Set
    ? selectedSites
    : new Set((selectedSites || []).map((s) => (normalizeHost(s) || String(s).trim().toLowerCase())).filter(Boolean));
  const hosts = new Set();
  const add = (v) => {
    if (!v || v === '—') return;
    const norm = normalizeHost(v) || String(v).trim().toLowerCase();
    if (!norm) return;
    // Always keep hosts the user explicitly selected (GAM Site list parity).
    if (selected.has(norm)) {
      hosts.add(norm);
      return;
    }
    if (isAdUnitDerivedSiteHost(norm)) return;
    if (isGamReportSiteHost(norm)) hosts.add(norm);
  };
  add(resolveRowSiteHost(row));
  add(row.siteUrl);
  add(row.gamSite);
  add(row.siteName);
  add(row.dimensions?.url_name);
  add(row.dimensions?.site_name);
  add(row.URL_NAME);
  add(row.SITE_NAME);
  add(subdomainFromSiteNameLabel(row.siteName));
  add(subdomainFromAdUnit(row.site));
  add(domainFromAdUnit(row.site));
  return hosts;
}

/** Ad unit → selected site: explicit host/label in name, or catalog map — never d1/d2 slot guessing. */
function adUnitMatchesSelectedSite(adUnit, selectedSite) {
  const au = String(adUnit || '').toLowerCase().replace(/\s*\(\d+\)\s*$/, '').trim();
  const site = String(selectedSite || '').toLowerCase().trim();
  if (!au || !site) return false;
  if (!adUnitAlignsWithSiteHost(adUnit, selectedSite)) return false;
  if (au.includes(site)) return true;
  const root = rootDomainFromHost(site);
  const label = subFromHost(site, root);
  if (!root || !label) return false;
  if (au.includes(`${root}_${label}`)) return true;
  const fromAu = subdomainFromAdUnit(adUnit);
  return Boolean(fromAu && fromAu.toLowerCase() === site);
}

function rowMatchesSiteFilter(row, siteUrls = [], matchOpts = {}) {
  if (!siteUrls.length) return true;
  const selected = new Set(
    siteUrls.map((s) => (normalizeHost(s) || String(s).trim().toLowerCase())).filter(Boolean)
  );
  const adUnitToHost = matchOpts.adUnitToHost || null;

  const mappedHost = lookupCatalogAdUnitHost(row, adUnitToHost);
  if (
    mappedHost
    && adUnitAlignsWithSiteHost(row.site, mappedHost)
    && rowHostMatchesFilterSiteSet(mappedHost, selected)
  ) return true;

  const candidates = [
    subdomainFromAdUnit(row.site),
    subdomainFromSiteNameLabel(row.siteName),
    resolveRowSiteHost(row),
    normalizeHost(row.siteUrl),
    normalizeHost(row.gamSite),
    normalizeHost(row.siteName),
    normalizeHost(row.dimensions?.url_name),
    normalizeHost(row.dimensions?.site_name),
  ]
    .map((h) => normalizeHost(h) || String(h || '').trim().toLowerCase())
    .filter(Boolean);

  for (const h of candidates) {
    if (
      adUnitAlignsWithSiteHost(row.site, h)
      && rowHostMatchesFilterSiteSet(h, selected)
    ) return true;
  }

  const adUnit = String(row.site || '').toLowerCase();
  if (adUnit && adUnit !== '—') {
    for (const site of selected) {
      if (adUnitMatchesSelectedSite(adUnit, site)) return true;
    }
  }

  return false;
}

function rowMatchesDomainFilter(row, domains = []) {
  if (!domains.length) return true;
  const d = resolveRowDomainName(row);
  const normDomains = new Set(domains.map((v) => String(v).toLowerCase().trim()));
  return normDomains.has(String(d).toLowerCase().trim())
    || normDomains.has(String(row.domainName || '').toLowerCase().trim());
}

function normAppId(value) {
  return String(value || '').toLowerCase().trim();
}

function rowMatchesAppFilter(row, apps = []) {
  if (!apps.length) return true;
  const assigned = new Set(apps.map(normAppId));
  return rowMatchesAppKeys(row, assigned);
}

function isMobileAppRow(row = {}) {
  return rowIsMobileApp(row);
}

/** Admin / manual filters: AND across every active dimension. */
function rowMatchesInventoryFilters(row, { apps = [], adUnits = [], domains = [], siteUrls = [] } = {}, matchOpts = {}) {
  if (apps.length && !rowMatchesAppFilter(row, apps)) return false;
  if (adUnits.length && !adUnits.includes(row.site)) return false;
  if (!rowMatchesDomainFilter(row, domains)) return false;
  if (!rowMatchesSiteFilter(row, siteUrls, matchOpts)) return false;
  return true;
}

/**
 * Scoped child users: match assignment like permissions (OR across families).
 * - Domain + site together → row matches if it hits site OR domain (not AND).
 *   Lean rows often have domain without site host; AND empties Dashboard/Reporting
 *   when admins assign domains + sites (+ apps) together.
 * - Web + app together → mobile-app rows use app match; web rows use web match.
 */
function rowMatchesScopedInventoryFilter(row, { apps = [], adUnits = [], domains = [], siteUrls = [] } = {}, matchOpts = {}) {
  const hasDom = domains.length > 0;
  const hasSite = siteUrls.length > 0;
  const hasAd = adUnits.length > 0;
  const hasApp = apps.length > 0;
  const hasWebFilter = hasDom || hasSite || hasAd;

  if (!hasWebFilter && !hasApp) return true;

  // Site-only filter = web inventory; do not attribute mobile-app rows via ad-unit name guessing.
  if (hasSite && !hasApp && !hasDom && isMobileAppRow(row)) return false;

  let webOk = true;
  if (hasDom || hasSite) {
    const siteOk = hasSite && rowMatchesSiteFilter(row, siteUrls, matchOpts);
    const domOk = hasDom && rowMatchesDomainFilter(row, domains);
    if (hasDom && hasSite) webOk = siteOk || domOk;
    else webOk = hasSite ? siteOk : domOk;
  }
  if (hasAd) {
    webOk = webOk && adUnits.includes(row.site);
  }

  const appOk = rowMatchesAppFilter(row, apps);

  if (hasWebFilter && hasApp) {
    if (isMobileAppRow(row)) return appOk;
    return webOk;
  }
  if (hasApp) return appOk;
  return webOk;
}

function toFilterArray(v) {
  if (v == null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

function hasInventoryFilters(filters = {}) {
  return toFilterArray(filters.domain).length > 0
    || toFilterArray(filters.site).length > 0
    || toFilterArray(filters.domainName).length > 0
    || toFilterArray(filters.domainId).length > 0;
}

/**
 * Cap inventory filter arrays. Selecting "everything" often arrives as thousands of
 * IDs — that makes SQL (LIKE ANY) and JS matching hang. Above the threshold we
 * treat that dimension as unfiltered (All).
 */
const MAX_INVENTORY_FILTER_VALUES = Math.max(
  50,
  parseInt(process.env.MAX_INVENTORY_FILTER_VALUES || '200', 10)
);

function sanitizeInventoryFilters(filters = {}) {
  const out = { ...filters };
  for (const key of ['domain', 'site', 'domainName', 'domainId']) {
    const list = toFilterArray(out[key]).filter((v) => v !== '__ALL__');
    // Sentinel or oversized list → treat as All (no filter for this dimension).
    out[key] = list.length > MAX_INVENTORY_FILTER_VALUES ? [] : list;
  }
  return out;
}

function filterRowsByInventory(rows = [], filters = {}, opts = {}) {
  const safe = sanitizeInventoryFilters(filters);
  if (!hasInventoryFilters(safe)) return rows;
  const invFilters = {
    apps: toFilterArray(safe.domainId),
    adUnits: toFilterArray(safe.domainName),
    domains: toFilterArray(safe.domain),
    siteUrls: toFilterArray(safe.site),
  };
  const matchOpts = { adUnitToHost: opts.adUnitToHost || null };
  const matcher = opts.scopedChild
    ? (r) => rowMatchesScopedInventoryFilter(r, invFilters, matchOpts)
    : (r) => rowMatchesInventoryFilters(r, invFilters, matchOpts);
  return rows.filter(matcher);
}

/**
 * Human labels for inventory filter families that are active.
 * Used when AND across web+app returns nothing and we fall back to a compatible subset.
 */
function inventoryFilterFamilyLabels(filters = {}) {
  const labels = [];
  if (toFilterArray(filters.domain).length) labels.push('Domain name');
  if (toFilterArray(filters.site).length) labels.push('Site');
  if (toFilterArray(filters.domainName).length) labels.push('Ad Unit');
  if (toFilterArray(filters.domainId).length) labels.push('App ID');
  if (toFilterArray(filters.country).length) labels.push('Country');
  return labels;
}

/** True when both web inventory and app filters are selected (often empty under strict AND). */
function hasMixedWebAndAppFilters(filters = {}) {
  const hasWeb = toFilterArray(filters.domain).length
    || toFilterArray(filters.site).length
    || toFilterArray(filters.domainName).length;
  const hasApp = toFilterArray(filters.domainId).length > 0;
  return Boolean(hasWeb && hasApp);
}

module.exports = {
  resolveRowSiteHost,
  resolveRowDomainName,
  rowMatchesSiteFilter,
  rowMatchesDomainFilter,
  rowMatchesInventoryFilters,
  rowMatchesScopedInventoryFilter,
  rowMatchesAppFilter,
  hasInventoryFilters,
  filterRowsByInventory,
  sanitizeInventoryFilters,
  MAX_INVENTORY_FILTER_VALUES,
  toFilterArray,
  lookupCatalogAdUnitHost,
  inventoryFilterFamilyLabels,
  hasMixedWebAndAppFilters,
};
