/**
 * Helpers for inventory multi-selects.
 *
 * UI semantics:
 *   []              → nothing selected (default)
 *   ['__ALL__']     → Select All (sentinel — avoids storing thousands of IDs)
 *   ['a','b',...]   → concrete selection
 *
 * API semantics:
 *   [] or __ALL__   → no inventory filter for that field (All)
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
 * If `selected` is the All sentinel or contains every option, return [] for the API.
 * Otherwise return the concrete selection (without the sentinel).
 */
export function collapseFullSelection(selected, options) {
  const list = Array.isArray(selected) ? selected.filter(Boolean) : [];
  if (isAllSelection(list)) return [];
  const concrete = list.filter((v) => v !== ALL_SENTINEL);
  const opts = optionValues(options);
  if (!concrete.length || !opts.length) return concrete;
  if (concrete.length < opts.length) return concrete;
  const set = new Set(concrete.map(String));
  if (opts.every((v) => set.has(String(v)))) return [];
  return concrete;
}

/**
 * Normalize inventory fields for API / apply:
 * All-sentinel and full-catalog selections become [] (no filter).
 */
export function normalizeInventorySelections(filters = {}, optionLists = {}) {
  return {
    ...filters,
    domain: collapseFullSelection(filters.domain, optionLists.domain || optionLists.domainOptions),
    site: collapseFullSelection(filters.site, optionLists.site || optionLists.siteOptions),
    domainName: collapseFullSelection(
      filters.domainName,
      optionLists.domainName || optionLists.adUnitOptions
    ),
    domainId: collapseFullSelection(filters.domainId, optionLists.domainId || optionLists.appOptions),
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
