/**
 * Helpers for inventory multi-selects.
 *
 * UI semantics:
 *   []              → nothing selected (default)
 *   ['__ALL__']     → Select All (sentinel — avoids storing thousands of IDs)
 *   ['a','b',...]   → concrete selection
 *
 * API semantics:
 *   [] or __ALL__   → no inventory filter for that field (All) — unless expandAll
 */

export const ALL_SENTINEL = '__ALL__';

export function optionValues(options = []) {
  return (options || [])
    .map((o) => (typeof o === 'object' ? o.value : o))
    .filter((v) => v != null && v !== '' && v !== ALL_SENTINEL);
}

export function isAllSelection(selected) {
  const list = Array.isArray(selected) ? selected : [];
  return list.length === 1 && list[0] === ALL_SENTINEL;
}

export function toAllSelection() {
  return [ALL_SENTINEL];
}

/**
 * If `selected` is the All sentinel or contains every option:
 * - expandAll=false (admin default): return [] for the API (no filter / All)
 * - expandAll=true (scoped domain users): return the concrete option list so
 *   "All domains" still filters by every assigned domain.
 */
export function collapseFullSelection(selected, options, { expandAll = false } = {}) {
  const list = Array.isArray(selected) ? selected.filter(Boolean) : [];
  const opts = optionValues(options);
  if (isAllSelection(list)) {
    return expandAll && opts.length ? [...opts] : [];
  }
  const concrete = list.filter((v) => v !== ALL_SENTINEL);
  if (!concrete.length || !opts.length) return concrete;
  if (concrete.length < opts.length) return concrete;
  const set = new Set(concrete.map(String));
  if (opts.every((v) => set.has(String(v)))) {
    return expandAll ? concrete : [];
  }
  return concrete;
}

/**
 * Normalize inventory fields for API / apply.
 * All-sentinel and full-catalog selections become [] unless expandAll is set.
 * For scoped users, pass expandAll + assignedScope so "All domains" keeps the
 * concrete assigned list instead of collapsing to empty.
 */
export function normalizeInventorySelections(filters = {}, optionLists = {}, opts = {}) {
  const expandAll = !!opts.expandAll;
  const assigned = opts.assignedScope || null;
  const domainOptions = optionLists.domain || optionLists.domainOptions
    || (expandAll ? assigned?.allowedDomains : null);
  const siteOptions = optionLists.site || optionLists.siteOptions
    || (expandAll ? assigned?.allowedSites : null);
  const adUnitOptions = optionLists.domainName || optionLists.adUnitOptions;
  const appOptions = optionLists.domainId || optionLists.appOptions
    || (expandAll ? assigned?.allowedAppIds : null);
  return {
    ...filters,
    domain: collapseFullSelection(filters.domain, domainOptions, { expandAll }),
    site: collapseFullSelection(filters.site, siteOptions, { expandAll }),
    domainName: collapseFullSelection(filters.domainName, adUnitOptions, { expandAll }),
    domainId: collapseFullSelection(filters.domainId, appOptions, { expandAll }),
  };
}

/** Cap size before persisting to session/local storage. */
export const MAX_PERSIST_INVENTORY = 100;

export function slimFiltersForPersist(filters = {}) {
  const slim = { ...filters };
  for (const key of ['domain', 'site', 'domainName', 'domainId', 'country']) {
    if (isAllSelection(slim[key])) {
      slim[key] = toAllSelection();
      continue;
    }
    if (Array.isArray(slim[key]) && slim[key].length > MAX_PERSIST_INVENTORY) {
      slim[key] = toAllSelection();
    }
  }
  return slim;
}
