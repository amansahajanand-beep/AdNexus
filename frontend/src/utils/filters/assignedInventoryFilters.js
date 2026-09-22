import {
  getAssignedInventoryScope,
  hasAssignedInventory,
  isAdmin,
} from '../auth/permissions';
import { isAllSelection } from './inventorySelection';

export const EMPTY_INVENTORY_FILTERS = {
  domain: [],
  site: [],
  domainName: [],
  domainId: [],
};

export function draftHasInventorySelection(draft = {}) {
  return !!(
    isAllSelection(draft.domain) || draft.domain?.length
    || isAllSelection(draft.site) || draft.site?.length
    || isAllSelection(draft.domainName) || draft.domainName?.length
    || isAllSelection(draft.domainId) || draft.domainId?.length
  );
}

/** True when chart/table should load — user must pick inventory filters first. */
export function hasInventoryFilterSelection(applied) {
  return draftHasInventorySelection(applied);
}

/**
 * True only for concrete domain/site/ad-unit/app picks.
 * Select-All (`__ALL__`) is network-wide — KPIs must use overview (tenant rollup),
 * not the filtered dashboard path (which previously could leak another network).
 */
export function hasConcreteInventoryFilterSelection(applied) {
  const a = applied || {};
  const concrete = (key) => {
    const list = Array.isArray(a[key]) ? a[key] : [];
    if (!list.length || isAllSelection(list)) return false;
    return list.some((v) => v != null && v !== '' && v !== '__ALL__');
  };
  return concrete('domain') || concrete('site') || concrete('domainName') || concrete('domainId');
}

/** Admin-assigned inventory as dashboard/report filter values. */
export function buildAssignedInventoryFilters(user) {
  if (isAdmin(user) || !hasAssignedInventory(user)) return { ...EMPTY_INVENTORY_FILTERS };
  const scope = getAssignedInventoryScope(user);
  // Send full assignment — backend ORs domains∪sites and unions apps (never prefer sites-only).
  return {
    domain: [...scope.allowedDomains],
    site: [...scope.allowedSites],
    domainName: [],
    domainId: [...scope.allowedAppIds],
  };
}

/**
 * Domain users: auto-apply full assigned inventory so overview + table load on login.
 */
export function shouldAutoLoadScopedInventory(user) {
  return !isAdmin(user) && hasAssignedInventory(user);
}

/** Default applied filters for scoped dashboard (date range + full assigned inventory). */
export function buildScopedDashboardApplied(user, dateRange) {
  return {
    ...(dateRange || {}),
    ...buildAssignedInventoryFilters(user),
  };
}

/** Which inventory filter fields to show for a scoped child user. */
export function getAssignedFilterVisibility(user) {
  if (isAdmin(user) || !hasAssignedInventory(user)) {
    return {
      showDomain: true,
      showSite: true,
      showAdUnit: true,
      showApp: true,
      isScopedUser: false,
    };
  }
  const scope = getAssignedInventoryScope(user);
  const hasDom = scope.allowedDomains.length > 0;
  const hasSite = scope.allowedSites.length > 0;
  const hasApp = scope.allowedAppIds.length > 0;
  return {
    showDomain: hasDom,
    showSite: hasSite,
    showAdUnit: false,
    showApp: hasApp,
    isScopedUser: true,
  };
}

/** Initial picker state — restore saved picks, else full assignment for scoped auto-load. */
export function initialInventoryDraft(user, saved = {}) {
  if (isAdmin(user) || !hasAssignedInventory(user)) {
    return {
      domain: saved.domain ?? [],
      site: saved.site ?? [],
      domainName: saved.domainName ?? [],
      domainId: saved.domainId ?? [],
    };
  }
  const hasSaved = draftHasInventorySelection(saved);
  if (hasSaved) {
    return {
      domain: saved.domain ?? [],
      site: saved.site ?? [],
      domainName: saved.domainName ?? [],
      domainId: saved.domainId ?? [],
    };
  }
  return buildAssignedInventoryFilters(user);
}

export function resetInventoryDraft(user) {
  return initialInventoryDraft(user, {});
}

export function resetInventoryApiFilters() {
  return { ...EMPTY_INVENTORY_FILTERS };
}
