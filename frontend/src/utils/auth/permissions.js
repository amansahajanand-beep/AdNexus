/** Client-side permission helpers (mirror backend utils/permissions.js). */

import { ADSENSE_ENABLED } from '../productWorkspace';

export const PERMISSION_SECTIONS = {
  pages: [
    { key: 'canAccessDashboard', label: 'Dashboard', hint: 'Summary cards & detailed report' },
    { key: 'canAccessReporting', label: 'Reporting', hint: 'Full reports & CSV export' },
    { key: 'canAccessRoi', label: 'ROI', hint: 'Ads spend vs GAM earn & ROI %' },
    { key: 'canAccessMyAds', label: 'Google Ads', hint: 'Connect own Google Ads accounts' },
    { key: 'canAccessDomainUser', label: 'Domain User', hint: 'Per-domain earnings view' },
  ],
  actions: [
    { key: 'canLogin', label: 'Log in', hint: 'Allow user to sign in' },
    { key: 'canGenerateReports', label: 'View reports', hint: 'Load live report data' },
    { key: 'canDownloadReports', label: 'Download CSV', hint: 'Export report files' },
    { key: 'canUseFilters', label: 'Apply filters', hint: 'Date, country, domain, site filters' },
    { key: 'canUseReportBuilder', label: 'Report builder', hint: 'Dimensions & metrics panel' },
  ],
  metrics: [
    { key: 'canSeeRevenue', label: 'Revenue & earnings' },
    { key: 'canSeeImpressions', label: 'Impressions' },
    { key: 'canSeeCTR', label: 'CTR & clicks' },
    { key: 'canSeeECPM', label: 'eCPM & fill rate' },
    { key: 'canSeeProgrammatic', label: 'Programmatic channel report' },
  ],
};

export const NO_DOMAINS_TITLE = 'No Inventory Assigned';
export const NO_DOMAINS_MSG =
  'No domains, sites, or app IDs have been assigned to your account. Please contact your administrator.';

export const INVENTORY_SCOPE_KEYS = [
  'allowedDomains',
  'allowedSites',
  'allowedAppIds',
  'allowedAdsAccountIds',
];

export function getAssignedDomains(user) {
  if (isAdmin(user)) return null;
  const allowed = user?.permissions?.allowedDomains;
  return Array.isArray(allowed) ? allowed : [];
}

export function getAssignedSites(user) {
  if (isAdmin(user)) return null;
  const allowed = user?.permissions?.allowedSites;
  return Array.isArray(allowed) ? allowed : [];
}

export function getAssignedAppIds(user) {
  if (isAdmin(user)) return null;
  const allowed = user?.permissions?.allowedAppIds;
  return Array.isArray(allowed) ? allowed : [];
}

export function getAssignedAdsAccountIds(user) {
  if (isAdmin(user)) return null;
  const perms = user?.permissions || {};
  if (!Object.prototype.hasOwnProperty.call(perms, 'allowedAdsAccountIds')) return null;
  const allowed = perms.allowedAdsAccountIds;
  return Array.isArray(allowed) ? allowed : [];
}

export function getAssignedInventoryScope(user) {
  if (isAdmin(user)) return null;
  return {
    allowedDomains: getAssignedDomains(user),
    allowedSites: getAssignedSites(user),
    allowedAppIds: getAssignedAppIds(user),
    allowedAdsAccountIds: getAssignedAdsAccountIds(user),
  };
}

/** True when the user may load scoped inventory reports (admin = full network). */
export function hasAssignedInventory(user) {
  if (isAdmin(user)) return true;
  const scope = getAssignedInventoryScope(user);
  return scope.allowedDomains.length > 0
    || scope.allowedSites.length > 0
    || scope.allowedAppIds.length > 0;
}

export function hasAssignedDomains(user) {
  return hasAssignedInventory(user);
}
export const NO_VIEW_REPORTS_TITLE = 'Reports Unavailable';
export const NO_VIEW_REPORTS_MSG =
  "You don't have permission to view reports. Please contact your administrator.";

export function isAdmin(user) {
  return user?.role === 'admin';
}

export const ADMOB_FILTER_DIMS = ['app', 'ad_unit', 'format', 'country', 'platform'];
export const ADSENSE_FILTER_DIMS = ['site', 'ad_unit', 'country', 'platform'];

const FILTER_KEY_BY_DIM = {
  app: 'apps', site: 'sites', ad_unit: 'adUnits', format: 'formats', country: 'countries', platform: 'platforms',
};

const PUBLISHER_SCOPES = {
  admob: { key: 'admobScope', dims: ADMOB_FILTER_DIMS },
  adsense: { key: 'adsenseScope', dims: ADSENSE_FILTER_DIMS },
};

/** Admin list rows carry the full scope; a domain user's own session only gets accountCount. */
function scopeAccountCount(user, product) {
  const s = user?.permissions?.[PUBLISHER_SCOPES[product].key];
  if (!s) return 0;
  if (Array.isArray(s.accountIds)) return s.accountIds.length;
  return Number(s.accountCount) || 0;
}

function allowedFilters(user, product) {
  const { key, dims } = PUBLISHER_SCOPES[product];
  if (isAdmin(user)) return dims;
  if (!hasPermission(user, 'canUseFilters')) return [];
  const f = user?.permissions?.[key]?.filters;
  return Array.isArray(f) ? f.filter((d) => dims.includes(d)) : [];
}

export function admobScopeAccountCount(user) {
  return scopeAccountCount(user, 'admob');
}

export function hasAdmobAccess(user) {
  if (isAdmin(user)) return true;
  return admobScopeAccountCount(user) > 0;
}

/** AdMob filter dimensions this user may use (admin = all). */
export function admobAllowedFilters(user) {
  return allowedFilters(user, 'admob');
}

/** Filter-bar keys for ProductReportFilters; null = admin (all filters, incl. mediation). */
export function admobFilterKeysForUser(user) {
  if (isAdmin(user)) return null;
  return admobAllowedFilters(user).map((d) => FILTER_KEY_BY_DIM[d]);
}

export function adsenseScopeAccountCount(user) {
  return scopeAccountCount(user, 'adsense');
}

export function hasAdsenseAccess(user) {
  if (!ADSENSE_ENABLED) return false;
  if (isAdmin(user)) return true;
  return adsenseScopeAccountCount(user) > 0;
}

/** AdSense filter dimensions this user may use (admin = all). */
export function adsenseAllowedFilters(user) {
  return allowedFilters(user, 'adsense');
}

/** Filter-bar keys for ProductReportFilters; null = admin (no restriction). */
export function adsenseFilterKeysForUser(user) {
  if (isAdmin(user)) return null;
  return adsenseAllowedFilters(user).map((d) => FILTER_KEY_BY_DIM[d]);
}

/**
 * Whether a domain user's product scope opens a report area ('dashboard' | 'reporting' | 'download').
 * Older users have no list: pages stay open and downloads follow the general flag.
 */
export function scopeReportAllowed(user, product, area) {
  if (isAdmin(user)) return true;
  const reports = user?.permissions?.[PUBLISHER_SCOPES[product].key]?.reports;
  if (!Array.isArray(reports)) return area === 'download' ? hasPermission(user, 'canDownloadReports') : true;
  return reports.includes(area);
}

function productPageAllowed(user, product, page) {
  if (page === `${product}-dashboard`) return scopeReportAllowed(user, product, 'dashboard');
  if (page === `${product}-presets`) {
    return scopeReportAllowed(user, product, 'dashboard') || scopeReportAllowed(user, product, 'reporting');
  }
  return scopeReportAllowed(user, product, 'reporting');
}

export function canViewReports(user) {
  return hasPermission(user, 'canGenerateReports');
}

export function hasPermission(user, key) {
  if (isAdmin(user)) return true;
  const p = user?.permissions || {};
  if (key === 'canSeeOrders' || key === 'canSeeInventory') return p[key] === true;
  return p[key] !== false;
}

export function buildClientVisibility(user) {
  if (isAdmin(user)) {
    return {
      pages: {
        dashboard: true,
        reporting: true,
        roi: true,
        domainUser: false,
        myAds: false,
        presets: true,
        admob: true,
        adsense: true,
      },
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
      roi: p.canAccessRoi !== false,
      domainUser: p.canAccessDomainUser !== false,
      myAds: p.canAccessMyAds !== false,
      presets: p.canAccessDashboard !== false || p.canAccessReporting !== false,
      admob: hasAdmobAccess(user),
      adsense: hasAdsenseAccess(user),
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

export function canAccessPage(user, page) {
  if ((page === 'domain-user' || page === 'my-ads') && isAdmin(user)) return false;
  if (page === 'help') return true;
  if (isAdmin(user)) return true;
  if (page === 'presets') {
    return hasPermission(user, 'canAccessDashboard') || hasPermission(user, 'canAccessReporting');
  }
  if (page === 'admob-roi' || page === 'adsense-roi') return false;
  if (String(page).startsWith('admob-')) return hasAdmobAccess(user) && productPageAllowed(user, 'admob', page);
  if (String(page).startsWith('adsense-')) return hasAdsenseAccess(user) && productPageAllowed(user, 'adsense', page);
  const map = {
    dashboard: 'canAccessDashboard',
    reporting: 'canAccessReporting',
    roi: 'canAccessRoi',
    'domain-user': 'canAccessDomainUser',
    'my-ads': 'canAccessMyAds',
  };
  const key = map[page];
  return key ? hasPermission(user, key) : false;
}

/** First product page the user's scope opens, or null. */
function publisherHome(user, product, enabled) {
  if (!enabled) return null;
  if (scopeReportAllowed(user, product, 'dashboard')) return `/${product}/dashboard`;
  if (scopeReportAllowed(user, product, 'reporting')) return `/${product}/reporting`;
  return null;
}

export function getDefaultHomeRoute(user) {
  if (isAdmin(user)) return '/dashboard';
  const vis = buildClientVisibility(user);
  const admobHome = publisherHome(user, 'admob', vis.pages.admob);
  const adsenseHome = publisherHome(user, 'adsense', vis.pages.adsense);
  if (!hasAssignedInventory(user)) {
    if (admobHome) return admobHome;
    if (adsenseHome) return adsenseHome;
  }
  if (vis.pages.dashboard) return '/dashboard';
  if (vis.pages.reporting) return '/reporting';
  if (vis.pages.roi) return '/roi';
  if (vis.pages.myAds) return '/my-ads';
  if (vis.pages.domainUser) return '/domain-user';
  if (admobHome) return admobHome;
  if (adsenseHome) return adsenseHome;
  return '/login';
}

export function hasAnyPageAccess(user) {
  if (isAdmin(user)) return true;
  const vis = buildClientVisibility(user);
  return vis.pages.dashboard || vis.pages.reporting || vis.pages.roi
    || vis.pages.myAds || vis.pages.domainUser || vis.pages.admob || vis.pages.adsense;
}

export function permissionsFromUser(user) {
  if (isAdmin(user)) return null;
  return user?.permissions || {};
}

export function permissionsToPayload(state) {
  return {
    ...state.flags,
    allowedDomains: state.allowedDomains,
    allowedSites: state.allowedSites,
    allowedAppIds: state.allowedAppIds,
    ...dateRestrictionPayload(state.dateRestrictionStart, state.dateRestrictionEnd),
  };
}

/** Compact badges for admin user list. */
export function permissionBadgeList(user) {
  if (isAdmin(user)) return [{ label: 'Full access', type: 'admin' }];
  const p = user?.permissions || {};
  const badges = [];
  if (p.canAccessDashboard !== false) badges.push({ label: 'Dashboard', type: 'page' });
  if (p.canAccessReporting !== false) badges.push({ label: 'Reporting', type: 'page' });
  if (p.canAccessRoi !== false) badges.push({ label: 'ROI', type: 'page' });
  if (p.canAccessMyAds !== false) badges.push({ label: 'Google Ads', type: 'page' });
  if (p.canAccessDomainUser !== false) badges.push({ label: 'Domain User', type: 'page' });
  const nAdmob = admobScopeAccountCount(user);
  if (nAdmob) badges.push({ label: `AdMob · ${nAdmob} publisher${nAdmob === 1 ? '' : 's'}`, type: 'page' });
  const nAdsense = ADSENSE_ENABLED ? adsenseScopeAccountCount(user) : 0;
  if (nAdsense) badges.push({ label: `AdSense · ${nAdsense} publisher${nAdsense === 1 ? '' : 's'}`, type: 'page' });
  if (p.canUseReportBuilder === false) badges.push({ label: 'No builder', type: 'off' });
  if (p.canSeeProgrammatic === false) badges.push({ label: 'No programmatic', type: 'off' });
  if (p.canSeeECPM === false) badges.push({ label: 'No eCPM', type: 'off' });
  const nDom = p.allowedDomains?.length || 0;
  const nSite = p.allowedSites?.length || 0;
  const nApp = p.allowedAppIds?.length || 0;
  const parts = [];
  if (nDom) parts.push(`${nDom} domain${nDom === 1 ? '' : 's'}`);
  if (nSite) parts.push(`${nSite} site${nSite === 1 ? '' : 's'}`);
  if (nApp) parts.push(`${nApp} app${nApp === 1 ? '' : 's'}`);
  badges.push({ label: parts.length ? parts.join(', ') : 'No inventory', type: 'scope' });
  return badges;
}
