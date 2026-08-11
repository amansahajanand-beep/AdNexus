import {
  getAssignedInventoryScope,
  hasAssignedInventory,
  isAdmin,
} from './permissions';
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

/** Admin-assigned inventory as dashboard/report filter values. */
export function buildAssignedInventoryFilters(user) {
  if (isAdmin(user) || !hasAssignedInventory(user)) return { ...EMPTY_INVENTORY_FILTERS };
  const scope = getAssignedInventoryScope(user);
  return {
    domain: [...scope.allowedDomains],
    site: [...scope.allowedSites],
    domainName: [],
    domainId: [...scope.allowedAppIds],
  };
}

/**
 * Scoped users start with an empty inventory selection.
 * Overview loads full assigned scope on open; after Apply Filter, KPIs match the selected filters.
 */
export function shouldAutoLoadScopedInventory() {
  return false;
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

/** Initial picker state — empty until user selects; restore only explicit saved picks. */
export function initialInventoryDraft(user, saved = {}) {
  if (isAdmin(user) || !hasAssignedInventory(user)) {
    return {
      domain: saved.domain ?? [],
      site: saved.site ?? [],
      domainName: saved.domainName ?? [],
      domainId: saved.domainId ?? [],
    };
  }
  if (draftHasInventorySelection(saved)) {
    return {
      domain: saved.domain ?? [],
      site: saved.site ?? [],
      domainName: saved.domainName ?? [],
      domainId: saved.domainId ?? [],
    };
  }
  // Scoped users start with an EMPTY selection (no filter applied by default);
  // they pick from their assigned list, which is all the dropdowns even offer.
  return { ...EMPTY_INVENTORY_FILTERS };
}

export function resetInventoryDraft(user) {
  return initialInventoryDraft(user, {});
}

export function resetInventoryApiFilters() {
  return { ...EMPTY_INVENTORY_FILTERS };
}
