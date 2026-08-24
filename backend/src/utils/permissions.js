const { rowMatchesAppKeys, isMobileAppRow: rowIsMobileApp, isLikelyAppPackage } = require('./appIdentity');
const { buildDateRestrictionPayload, resolveDateRestriction } = require('./dateRestriction');
const {
  domainFromAdUnit,
  rootDomainFromHost,
  pickSiteHost,
  normalizeHost,
  subdomainFromSiteNameLabel,
  subdomainFromAdUnit,
  adUnitAlignsWithSiteHost,
} = require('./adUnit');
const { readSiteUrl } = require('./domainUserAggregate');
const { inferAssignedSiteHost } = require('./inventoryCatalog');

function norm(value) {
  return String(value || '').toLowerCase().trim();
}

function toOptionalSet(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  return new Set(arr.map((v) => norm(v)).filter(Boolean));
}

/** Assigned inventory scope for a child user. null = admin / unrestricted. */
function getUserInventoryScope(user) {
  if (!user || user.role === 'admin') return null;
  const perms = user.permissions;
  if (perms == null) return null;
  return {
    domains: toOptionalSet(perms.allowedDomains),
    sites: toOptionalSet(perms.allowedSites),
    appIds: toOptionalSet(perms.allowedAppIds),
  };
}

/** Assigned root domains. null = admin; empty Set = none assigned. */
function getAllowedDomainSet(user) {
  const scope = getUserInventoryScope(user);
  if (scope === null) return null;
  return scope.domains || new Set();
}

function hostMatchesAllowed(value, allowedSet) {
  if (!value || value === '—') return false;
  const raw = norm(value);
  if (allowedSet.has(raw)) return true;
  const root = rootDomainFromHost(raw);
  if (root && allowedSet.has(root)) return true;
  const fromAdUnit = domainFromAdUnit(value);
  if (fromAdUnit && allowedSet.has(fromAdUnit.toLowerCase())) return true;
  return false;
}

function rowMatchesAllowedDomains(row, allowedSet) {
  if (!allowedSet || allowedSet.size === 0) return false;
  const fields = [
    row.domainName,
    row.gamDomain,
    row.siteName,
    row.siteUrl,
    row.gamSite,
    row.site,
    row.appId,
    domainFromAdUnit(row.site),
  ];
  return fields.some((v) => hostMatchesAllowed(v, allowedSet));
}

function rowSiteHosts(row) {
  const hosts = new Set();
  const add = (v) => {
    const n = normalizeHost(v);
    if (n) hosts.add(n);
  };
  // Real GAM site fields only — never invent hosts from ad-unit names.
  add(pickSiteHost(row.gamSite, row.siteUrl, row.siteName));
  add(row.siteUrl);
  add(row.siteName);
  add(row.gamSite);
  add(row.dimensions?.url_name);
  add(row.dimensions?.site_name);
  add(subdomainFromSiteNameLabel(row.siteName));
  add(subdomainFromAdUnit(row.site));
  add(domainFromAdUnit(row.site));
  const dotLabel = String(row.siteName || '').match(/^(.+?)\s*·\s*/);
  if (dotLabel) add(dotLabel[1].trim());
  return [...hosts];
}

function assignedSiteMatchesRowHost(assignedSite, rowHost) {
  const a = norm(assignedSite);
  const h = norm(rowHost);
  if (!a || !h) return false;
  if (a === h) return true;
  // GAM often resolves finrezo.com while user is assigned finance1.finrezo.com
  if (siteHostUnderDomain(a, h)) return true;
  return false;
}

function rowHostMatchesSiteSet(rowHost, siteSet) {
  const h = norm(rowHost);
  if (!h || !siteSet?.size) return false;
  if (siteSet.has(h)) return true;
  for (const assigned of siteSet) {
    if (assignedSiteMatchesRowHost(assigned, h)) return true;
  }
  return false;
}

function rowMatchesAllowedSites(row, siteSet, siteCtx = null) {
  if (!siteSet?.size) return false;
  if (siteCtx) {
    const resolved = readSiteUrl(row, siteCtx);
    if (rowHostMatchesSiteSet(resolved, siteSet)) return true;
  }
  for (const h of rowSiteHosts(row)) {
    if (rowHostMatchesSiteSet(h, siteSet)) return true;
  }
  const adUnit = String(row.site || '').toLowerCase();
  if (adUnit && adUnit !== '—') {
    for (const assigned of siteSet) {
      const a = String(assigned).toLowerCase();
      if (a && adUnit.includes(a) && adUnitAlignsWithSiteHost(row.site, assigned)) return true;
    }
  }
  const inferred = inferAssignedSiteHost(row, [...siteSet], siteCtx?.adUnitToHost || new Map());
  if (inferred && rowHostMatchesSiteSet(inferred, siteSet)) return true;
  return false;
}

function rowMatchesAllowedAppIds(row, appIdSet) {
  return rowMatchesAppKeys(row, appIdSet);
}

function isMobileAppRow(row) {
  return rowIsMobileApp(row);
}

function isWebInventoryRow(row) {
  if (row.site && row.site !== '—') return true;
  if (rowSiteHosts(row).length) return true;
  const webFields = [row.domainName, row.gamSite, row.siteUrl, row.gamDomain, row.siteName];
  return webFields.some((v) => v && v !== '—');
}

function siteHostUnderDomain(host, domain) {
  const h = norm(host);
  const d = norm(domain);
  if (!h || !d) return false;
  if (h === d) return true;
  const root = rootDomainFromHost(h);
  if (root === d) return true;
  return h.endsWith(`.${d}`);
}

function assignedSitesUnderDomain(domain, siteSet) {
  if (!siteSet?.size) return [];
  return [...siteSet].filter((s) => siteHostUnderDomain(s, domain));
}

/** Web rows: full domain when no sites under it; only listed sites when restricted. */
function rowMatchesWebScope(row, scope, siteCtx = null) {
  if (!scope.domains?.size && !scope.sites?.size) return false;

  if (scope.sites?.size && rowMatchesAllowedSites(row, scope.sites, siteCtx)) {
    return true;
  }

  if (!scope.domains?.size) return false;

  for (const domain of scope.domains) {
    const domainSet = new Set([domain]);
    if (!rowMatchesAllowedDomains(row, domainSet)) continue;

    const restricted = assignedSitesUnderDomain(domain, scope.sites);
    if (!restricted.length) return true;

    const restrictedSet = new Set(restricted);
    if (rowMatchesAllowedSites(row, restrictedSet, siteCtx)) return true;
  }
  return false;
}

function scopeHasAssignment(scope) {
  if (!scope) return true;
  return !!(scope.domains?.size || scope.sites?.size || scope.appIds?.size);
}

function rowMatchesUserScope(row, scope, siteCtx = null) {
  if (!scope) return true;
  if (!scopeHasAssignment(scope)) return false;

  const hasAppScope = !!scope.appIds?.size;
  const hasWebScope = !!(scope.domains?.size || scope.sites?.size);

  if (hasAppScope && hasWebScope) {
    const appMatch = isMobileAppRow(row) && rowMatchesAllowedAppIds(row, scope.appIds);
    const webMatch = isWebInventoryRow(row) && rowMatchesWebScope(row, scope, siteCtx);
    return appMatch || webMatch;
  }
  if (hasAppScope) {
    return isMobileAppRow(row) && rowMatchesAllowedAppIds(row, scope.appIds);
  }
  return rowMatchesWebScope(row, scope, siteCtx);
}

function userHasAssignedInventory(user) {
  const scope = getUserInventoryScope(user);
  if (scope === null) return true;
  return !!(scope.domains?.size || scope.sites?.size || scope.appIds?.size);
}

function getInventoryScopeCacheKey(user) {
  const scope = getUserInventoryScope(user);
  if (scope === null) return 'admin';
  const part = (set) => (set ? [...set].sort().join(',') : '');
  return [
    `d:${part(scope.domains)}`,
    `s:${part(scope.sites)}`,
    `a:${part(scope.appIds)}`,
  ].join('|');
}

function toNormList(value) {
  if (value == null || value === '') return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr.map((v) => norm(v)).filter(Boolean);
}

function clampToScopeSet(values, set) {
  if (!set?.size) return [];
  if (!values.length) return [];
  return values.filter((v) => set.has(norm(v)));
}

function listCoversScopeSet(values, set) {
  if (!set?.size) return false;
  if (!values.length) return false;
  const have = new Set(values.map((v) => norm(v)));
  for (const item of set) {
    if (!have.has(item)) return false;
  }
  return true;
}

/**
 * Inventory dims for scoped-child SQL / lean queries.
 *
 * Assigning domains + sites + apps together must NOT become AND filters —
 * lean rows rarely match domain AND site AND app, so Dashboard/Reporting go empty.
 *
 * Rules:
 * - Clamp any request values to the user's assignment
 * - If the request is empty: sites > domains for web, plus apps (compat-union handles web|app)
 * - If request includes full assigned domains AND full assigned sites: keep sites only
 * - Drop oversized lists (LIKE ANY hangs); prefer sites, then capped domains
 */
function resolveScopedSqlInventoryOpts(user, filters = {}) {
  const { MAX_INVENTORY_FILTER_VALUES } = require('./inventoryFilters');
  const max = MAX_INVENTORY_FILTER_VALUES || 200;
  const scope = getUserInventoryScope(user);
  if (!scope) {
    return {
      domains: toNormList(filters.domain),
      sites: toNormList(filters.site),
      apps: toNormList(filters.domainId),
      adUnitNames: toNormList(filters.domainName),
      webInventoryOr: false,
    };
  }

  const reqDomains = toNormList(filters.domain);
  const reqSites = toNormList(filters.site);
  const reqApps = toNormList(filters.domainId);
  const reqAdUnits = toNormList(filters.domainName);
  const anyRequest = reqDomains.length || reqSites.length || reqApps.length || reqAdUnits.length;

  let domains = clampToScopeSet(reqDomains, scope.domains);
  let sites = clampToScopeSet(reqSites, scope.sites);
  let apps = clampToScopeSet(reqApps, scope.appIds);
  let adUnitNames = reqAdUnits;

  if (!anyRequest) {
    domains = [];
    sites = [];
    apps = [];
    adUnitNames = [];
    if (scope.sites?.size) sites = [...scope.sites];
    else if (scope.domains?.size) domains = [...scope.domains];
    if (scope.appIds?.size) apps = [...scope.appIds];
  } else if (
    domains.length
    && sites.length
    && listCoversScopeSet(domains, scope.domains)
    && listCoversScopeSet(sites, scope.sites)
  ) {
    // Full domain+site assignment applied together — prefer sites (more specific).
    domains = [];
  }

  // Domains/sites use LIKE ANY and hang when huge; prefer sites, cap domains.
  // Apps use equality ANY — still cap so sanitizeInventoryFilters does not wipe them to []
  // (oversized lists are treated as "All", which would leak network-wide SQL to children).
  if (sites.length > max) sites = sites.slice(0, max);
  if (!sites.length && domains.length > max) domains = domains.slice(0, max);
  if (sites.length && domains.length > max) domains = [];
  if (apps.length > max) apps = apps.slice(0, max);

  return {
    domains,
    sites,
    apps,
    adUnitNames,
    // Explicit Domain+Site picks use GAM intersection (AND). OR only when expanding
    // full assignment with no request (legacy empty-filter scope path).
    webInventoryOr: !anyRequest && domains.length > 0 && sites.length > 0,
    // Equality on inv_* — LIKE '%domain%' made Site filter equal Domain-wide.
    skipAdUnitLike: true,
  };
}

function scopeRowsToUser(rows = [], user, siteCtx = null) {
  const scope = getUserInventoryScope(user);
  if (scope === null) return rows;
  if (!userHasAssignedInventory(user)) return [];
  return rows.filter((r) => rowMatchesUserScope(r, scope, siteCtx));
}

/** Scoped overview card: keep web rows; mobile-app rows only when tied to an assigned site. */
function applyScopedOverviewSiteTightening(rows = [], user, siteCtx = null) {
  const scope = getUserInventoryScope(user);
  if (!scope?.sites?.size) return rows;
  return rows.filter((row) => {
    if (!isMobileAppRow(row)) return true;
    return rowMatchesAllowedSites(row, scope.sites, siteCtx);
  });
}

function siteHostInSet(host, siteSet) {
  const h = norm(host);
  if (!h || !siteSet?.size) return false;
  return siteSet.has(h);
}

function pickSiteHostOption(host, scope) {
  if (!host || host === '—') return false;
  if (!scope.sites?.size) return false;
  return siteHostInSet(host, scope.sites);
}

function mergeAssignedSites(list = [], scope) {
  if (!scope.sites?.size) return list;
  const seen = new Set(list.map((h) => norm(h)));
  const out = [...list];
  scope.sites.forEach((s) => {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  });
  return out.sort((a, b) => String(a).localeCompare(String(b)));
}

function mergeAssignedApps(rows = [], allowedAppIds = []) {
  if (!allowedAppIds?.length) return rows;
  const seen = new Set(
    rows.map((r) => (r.appId && r.appId !== '—' ? norm(r.appId) : '')).filter(Boolean)
  );
  const out = [...rows];
  allowedAppIds.forEach((app) => {
    const key = norm(app);
    if (!seen.has(key)) {
      seen.add(key);
      out.push({
        appId: app,
        appPackage: isLikelyAppPackage(app) ? app : '—',
        appName: isLikelyAppPackage(app) ? '—' : app,
        site: '—',
        domainName: '—',
        siteName: '—',
      });
    }
  });
  return out;
}

function scopeCatalogOptionsForUser(catalog = {}, user) {
  const scope = getUserInventoryScope(user);
  if (scope === null) return { ...catalog, noDomainsAssigned: false, noInventoryAssigned: false };

  if (!userHasAssignedInventory(user)) {
    return {
      rows: [],
      domainRoots: [],
      siteHosts: [],
      sitesByDomain: {},
      adUnitsByHost: {},
      noDomainsAssigned: true,
      noInventoryAssigned: true,
    };
  }

  const domainRoots = (catalog.domainRoots || []).filter((d) => {
    if (!scope.domains?.size) return false;
    return hostMatchesAllowed(d, scope.domains);
  });

  const siteHosts = mergeAssignedSites(
    (catalog.siteHosts || []).filter((h) => pickSiteHostOption(h, scope)),
    scope
  );

  const sitesByDomain = {};
  if (scope.sites?.size) {
    scope.sites.forEach((s) => {
      const root = rootDomainFromHost(s) || s;
      if (!sitesByDomain[root]) sitesByDomain[root] = [];
      if (!sitesByDomain[root].includes(s)) sitesByDomain[root].push(s);
    });
  }

  const rows = mergeAssignedApps(
    (catalog.rows || []).filter((r) => rowMatchesUserScope(r, scope)),
    scope.appIds ? [...scope.appIds] : []
  );

  let appPackages = catalog.appPackages || [];
  if (scope.appIds?.size) {
    const allowed = new Set([...scope.appIds].map(norm));
    const filtered = appPackages.filter((p) => allowed.has(norm(p)));
    scope.appIds.forEach((a) => {
      const s = String(a).trim();
      if (isLikelyAppPackage(s) && !filtered.some((p) => norm(p) === norm(s))) filtered.push(s);
    });
    appPackages = filtered.sort((a, b) => a.localeCompare(b));
  }

  const adUnitsByHost = {};
  if (scope.sites?.size) {
    Object.entries(catalog.adUnitsByHost || {}).forEach(([host, units]) => {
      if (!pickSiteHostOption(host, scope)) return;
      adUnitsByHost[host] = units;
    });
  }

  return {
    ...catalog,
    rows,
    domainRoots,
    siteHosts,
    sitesByDomain,
    adUnitsByHost,
    appPackages,
    noDomainsAssigned: !scopeHasAssignment(scope),
    noInventoryAssigned: false,
  };
}

function userHasAssignedDomains(user) {
  return userHasAssignedInventory(user);
}

function trendFromRows(rows = []) {
  const map = {};
  rows.forEach((r) => { map[r.date] = (map[r.date] || 0) + (r.revenue || 0); });
  return Object.keys(map).sort().map((date) => ({ date, earning: +map[date].toFixed(2) }));
}

const DEFAULT_CHILD_PERMISSIONS = {
  canAccessDashboard: true,
  canAccessReporting: true,
  canAccessDomainUser: true,
  canLogin: true,
  canGenerateReports: true,
  canDownloadReports: true,
  canUseFilters: true,
  canUseReportBuilder: true,
  canSeeRevenue: true,
  canSeeImpressions: true,
  canSeeCTR: true,
  canSeeECPM: true,
  canSeeProgrammatic: true,
  canSeeOrders: false,
  canSeeInventory: false,
  allowedDomains: [],
  allowedSites: [],
  allowedAppIds: [],
  allowedAdUnits: [],
  dateRestriction: null,
};

const FLAG_KEYS = [
  'canAccessDashboard', 'canAccessReporting', 'canAccessDomainUser',
  'canLogin', 'canGenerateReports', 'canDownloadReports', 'canUseFilters', 'canUseReportBuilder',
  'canSeeRevenue', 'canSeeImpressions', 'canSeeCTR', 'canSeeECPM', 'canSeeProgrammatic',
  'canSeeOrders', 'canSeeInventory',
];

const INVENTORY_SCOPE_KEYS = ['allowedDomains', 'allowedSites', 'allowedAppIds'];

function isAdmin(user) {
  return user?.role === 'admin';
}

function normalizePermissions(role, input = {}) {
  if (role === 'admin') return null;

  const base = { ...DEFAULT_CHILD_PERMISSIONS };
  FLAG_KEYS.forEach((k) => {
    if (typeof input[k] === 'boolean') base[k] = input[k];
  });
  if (Array.isArray(input.allowedDomains)) base.allowedDomains = input.allowedDomains;
  if (Array.isArray(input.allowedSites)) base.allowedSites = input.allowedSites;
  if (Array.isArray(input.allowedAppIds)) base.allowedAppIds = input.allowedAppIds;
  if (Array.isArray(input.allowedAdUnits)) base.allowedAdUnits = [];
  if (input.dateRestriction != null) {
    base.dateRestriction = resolveDateRestriction(input.dateRestriction)
      || buildDateRestrictionPayload(input.dateRestriction?.startDate, input.dateRestriction?.endDate);
  }
  return base;
}

function hasFlag(user, key) {
  if (isAdmin(user)) return true;
  const p = user?.permissions || {};
  return p[key] !== false;
}

function canAccessPage(user, page) {
  const map = {
    dashboard: 'canAccessDashboard',
    reporting: 'canAccessReporting',
    'domain-user': 'canAccessDomainUser',
    admin: null,
  };
  if (isAdmin(user)) return true;
  const key = map[page];
  if (!key) return false;
  return hasFlag(user, key);
}

function buildVisibility(user) {
  if (isAdmin(user)) {
    return {
      pages: { dashboard: true, reporting: true, domainUser: true },
      revenue: true, impressions: true, ctr: true, ecpm: true, programmatic: true,
      generate: true, download: true, filters: true, reportBuilder: true,
      orders: true, inventory: true,
    };
  }
  const p = user?.permissions || {};
  return {
    pages: {
      dashboard: p.canAccessDashboard !== false,
      reporting: p.canAccessReporting !== false,
      domainUser: p.canAccessDomainUser !== false,
    },
    revenue: p.canSeeRevenue !== false,
    impressions: p.canSeeImpressions !== false,
    ctr: p.canSeeCTR !== false,
    ecpm: p.canSeeECPM !== false,
    programmatic: p.canSeeProgrammatic !== false,
    generate: p.canGenerateReports !== false,
    download: p.canDownloadReports !== false,
    filters: p.canUseFilters !== false,
    reportBuilder: p.canUseReportBuilder !== false,
    orders: p.canSeeOrders === true,
    inventory: p.canSeeInventory === true,
  };
}

function getDefaultHomePage(user) {
  if (isAdmin(user)) return '/dashboard';
  const vis = buildVisibility(user);
  if (vis.pages.dashboard) return '/dashboard';
  if (vis.pages.reporting) return '/reporting';
  if (vis.pages.domainUser) return '/domain-user';
  return '/login';
}

module.exports = {
  DEFAULT_CHILD_PERMISSIONS,
  FLAG_KEYS,
  INVENTORY_SCOPE_KEYS,
  normalizePermissions,
  hasFlag,
  canAccessPage,
  buildVisibility,
  getDefaultHomePage,
  isAdmin,
  scopeRowsToUser,
  applyScopedOverviewSiteTightening,
  scopeCatalogOptionsForUser,
  getAllowedDomainSet,
  getUserInventoryScope,
  getInventoryScopeCacheKey,
  resolveScopedSqlInventoryOpts,
  userHasAssignedDomains,
  userHasAssignedInventory,
  rowMatchesUserScope,
  rowHostMatchesSiteSet,
  assignedSiteMatchesRowHost,
  trendFromRows,
};
