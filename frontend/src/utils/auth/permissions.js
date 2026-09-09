/** Client-side permission helpers (mirror backend utils/permissions.js). */

export const PERMISSION_SECTIONS = {
  pages: [
    { key: 'canAccessDashboard', label: 'Dashboard', hint: 'Summary cards & detailed report' },
    { key: 'canAccessReporting', label: 'Reporting', hint: 'Full reports & CSV export' },
    { key: 'canAccessRoi', label: 'ROI', hint: 'Ads spend vs GAM earn & ROI %' },
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
      pages: { dashboard: true, reporting: true, roi: true, domainUser: false, presets: true },
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
      presets: p.canAccessDashboard !== false || p.canAccessReporting !== false,
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
  if (page === 'domain-user' && isAdmin(user)) return false;
  if (isAdmin(user)) return true;
  if (page === 'presets') {
    return hasPermission(user, 'canAccessDashboard') || hasPermission(user, 'canAccessReporting');
  }
  const map = {
    dashboard: 'canAccessDashboard',
    reporting: 'canAccessReporting',
    roi: 'canAccessRoi',
    'domain-user': 'canAccessDomainUser',
  };
  const key = map[page];
  return key ? hasPermission(user, key) : false;
}

export function getDefaultHomeRoute(user) {
  if (isAdmin(user)) return '/dashboard';
  const vis = buildClientVisibility(user);
  if (vis.pages.dashboard) return '/dashboard';
  if (vis.pages.reporting) return '/reporting';
  if (vis.pages.roi) return '/roi';
  if (vis.pages.domainUser) return '/domain-user';
  return '/login';
}

export function hasAnyPageAccess(user) {
  if (isAdmin(user)) return true;
  const vis = buildClientVisibility(user);
  return vis.pages.dashboard || vis.pages.reporting || vis.pages.roi || vis.pages.domainUser;
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
  if (p.canAccessDomainUser !== false) badges.push({ label: 'Domain User', type: 'page' });
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
