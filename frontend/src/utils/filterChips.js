/**
 * Build GAM-style filter chips from the currently APPLIED filter state.
 * Each chip can be removed individually (calls onRemove with field + value).
 *
 * Large inventory selections are collapsed to a single summary chip so the UI
 * does not mount thousands of nodes (Select All used to freeze the page).
 *
 * The `__ALL__` sentinel is never shown as a chip label — it expands to the
 * actual option names from the current catalog (or "All selected" if unknown).
 */

import { ALL_SENTINEL, isAllSelection, optionValues } from './inventorySelection';

const CHIP_EXPAND_LIMIT = 200;

function countryLabel(id, countryOptions) {
  const hit = (countryOptions || []).find((c) => String(c.id) === String(id));
  return hit?.name || id;
}

/** Map option value → display label. */
function buildLabelMap(options = []) {
  const map = new Map();
  (options || []).forEach((o) => {
    if (o == null) return;
    if (typeof o === 'object') {
      const value = o.value ?? o.id;
      if (value == null || value === '') return;
      map.set(String(value), o.label ?? o.name ?? String(value));
    } else {
      map.set(String(o), String(o));
    }
  });
  return map;
}

function displayLabel(value, labelMap) {
  if (value == null || value === '' || value === ALL_SENTINEL) return null;
  const key = String(value);
  if (labelMap?.has(key)) return labelMap.get(key);
  return key;
}

/**
 * Resolve applied values into concrete display values.
 * `__ALL__` → all option values from the catalog (never the sentinel string).
 */
function resolveChipValues(values, options) {
  const list = Array.isArray(values) ? values.filter(Boolean) : [];
  if (!list.length) return [];
  if (isAllSelection(list) || list.includes(ALL_SENTINEL)) {
    const all = optionValues(options);
    return all.length ? all : [];
  }
  return list.filter((v) => v !== ALL_SENTINEL);
}

function pushListChips(chips, {
  values,
  field,
  category,
  idPrefix,
  options = [],
  labelFor,
}) {
  const labelMap = buildLabelMap(options);
  const resolved = resolveChipValues(values, options);
  const raw = Array.isArray(values) ? values.filter(Boolean) : [];

  // Select All but catalog options not loaded yet — never show "__ALL__".
  if ((isAllSelection(raw) || raw.includes(ALL_SENTINEL)) && !resolved.length) {
    chips.push({
      id: `${idPrefix}-all`,
      field,
      value: null,
      category,
      label: 'All selected',
      summary: true,
      summaryCount: null,
    });
    return;
  }

  if (!resolved.length) return;

  const labelOf = (v) => {
    if (typeof labelFor === 'function') return labelFor(v);
    return displayLabel(v, labelMap) || String(v);
  };

  if (resolved.length > CHIP_EXPAND_LIMIT) {
    const preview = resolved.slice(0, 3).map(labelOf).filter(Boolean).join(', ');
    chips.push({
      id: `${idPrefix}-summary`,
      field,
      value: null,
      category,
      label: preview
        ? `${preview} +${resolved.length - 3} more`
        : `${resolved.length} selected`,
      summary: true,
      summaryCount: resolved.length,
      title: resolved.map(labelOf).filter(Boolean).join(', '),
    });
    return;
  }

  resolved.forEach((v) => {
    const label = labelOf(v);
    if (!label || label === ALL_SENTINEL) return;
    chips.push({
      id: `${idPrefix}-${v}`,
      field,
      value: v,
      category,
      label,
    });
  });
}

/**
 * @param {object} applied - applied filter payload
 * @param {object} [opts]
 * @param {Array} [opts.countryOptions]
 * @param {Array} [opts.domainOptions]
 * @param {Array} [opts.siteOptions]
 * @param {Array} [opts.adUnitOptions]
 * @param {Array} [opts.appOptions]
 * @returns {Array<{ id, field, value, category, label }>}
 */
export function buildAppliedFilterChips(applied, opts = []) {
  // Back-compat: second arg used to be countryOptions array.
  const options = Array.isArray(opts)
    ? { countryOptions: opts }
    : (opts || {});

  if (!applied) return [];
  const chips = [];

  if (applied.startDate && applied.endDate) {
    chips.push({
      id: 'date-range',
      field: 'date',
      value: null,
      category: 'Date',
      label: `${applied.startDate} → ${applied.endDate}`,
      removable: false,
    });
  }

  if (applied.country?.length) {
    const countries = Array.isArray(applied.country) ? applied.country : [applied.country];
    pushListChips(chips, {
      values: countries,
      field: 'country',
      category: 'Country',
      idPrefix: 'country',
      options: (options.countryOptions || []).map((c) => ({
        value: c.id ?? c.value,
        label: c.name ?? c.label ?? c.id,
      })),
      labelFor: (v) => countryLabel(v, options.countryOptions),
    });
  }

  pushListChips(chips, {
    values: applied.domain,
    field: 'domain',
    category: 'Domain name',
    idPrefix: 'domain',
    options: options.domainOptions,
  });

  pushListChips(chips, {
    values: applied.site,
    field: 'site',
    category: 'Site',
    idPrefix: 'site',
    options: options.siteOptions,
  });

  pushListChips(chips, {
    values: applied.domainName,
    field: 'domainName',
    category: 'Ad Unit',
    idPrefix: 'adunit',
    options: options.adUnitOptions,
  });

  pushListChips(chips, {
    values: applied.domainId,
    field: 'domainId',
    category: 'App ID',
    idPrefix: 'app',
    options: options.appOptions,
  });

  return chips;
}

/** Remove one chip from applied + draft filter objects (returns new copies). */
export function removeFilterChip(applied, draft, chip, optionLists = {}) {
  const nextApplied = { ...applied };
  const nextDraft = { ...draft };

  const clearField = (field) => {
    nextApplied[field] = [];
    nextDraft[field] = [];
  };

  const removeOne = (field, options) => {
    const current = applied[field];
    if (chip.summary || chip.value == null) {
      clearField(field);
      return;
    }
    // Select-All was shown as real names — materialize options, then drop this one.
    if (isAllSelection(current) || (Array.isArray(current) && current.includes(ALL_SENTINEL))) {
      const all = optionValues(options);
      const next = (all.length ? all : []).filter((v) => String(v) !== String(chip.value));
      nextApplied[field] = next;
      nextDraft[field] = next;
      return;
    }
    nextApplied[field] = (applied[field] || []).filter((v) => v !== chip.value);
    nextDraft[field] = (draft[field] || []).filter((v) => v !== chip.value);
  };

  // Summary chip → clear the whole field.
  if (chip.summary) {
    if (chip.field === 'country') clearField('country');
    else if (chip.field === 'domain') clearField('domain');
    else if (chip.field === 'site') clearField('site');
    else if (chip.field === 'domainName') clearField('domainName');
    else if (chip.field === 'domainId') clearField('domainId');
    return { nextApplied, nextDraft };
  }

  switch (chip.field) {
    case 'date':
      // Caller handles date reset via handleRemoveChip (presetRange).
      break;
    case 'country':
      removeOne('country', (optionLists.countryOptions || []).map((c) => ({
        value: c.id ?? c.value,
        label: c.name ?? c.label ?? c.id,
      })));
      break;
    case 'domain':
      removeOne('domain', optionLists.domainOptions);
      break;
    case 'site':
      removeOne('site', optionLists.siteOptions);
      break;
    case 'domainName':
      removeOne('domainName', optionLists.adUnitOptions);
      break;
    case 'domainId':
      removeOne('domainId', optionLists.appOptions);
      break;
    default:
      break;
  }

  return { nextApplied, nextDraft };
}

/**
 * Returns a human-readable summary of which filters are active in an applied object.
 * Used in "no data" messages so the user knows which filter had no results.
 */
export function describeActiveFilters(applied, optionLists = {}) {
  if (!applied) return '';
  const parts = [];
  const fmt = (label, arr, options) => {
    const resolved = resolveChipValues(arr, options);
    if (!resolved.length) {
      const raw = Array.isArray(arr) ? arr.filter(Boolean) : [];
      if (isAllSelection(raw) || raw.includes(ALL_SENTINEL)) {
        parts.push(`${label}: All selected`);
      }
      return;
    }
    const labelMap = buildLabelMap(options);
    const names = resolved.map((v) => displayLabel(v, labelMap) || String(v));
    if (names.length > 8) parts.push(`${label}: ${names.slice(0, 3).join(', ')} +${names.length - 3} more`);
    else parts.push(`${label}: ${names.join(', ')}`);
  };
  fmt('Domain', applied.domain, optionLists.domainOptions);
  fmt('Site', applied.site, optionLists.siteOptions);
  fmt('Ad Unit', applied.domainName, optionLists.adUnitOptions);
  fmt('App ID', applied.domainId, optionLists.appOptions);
  if (applied.country?.length) {
    const ids = Array.isArray(applied.country) ? applied.country : [applied.country];
    fmt('Country', ids, (optionLists.countryOptions || []).map((c) => ({
      value: c.id ?? c.value,
      label: c.name ?? c.label ?? c.id,
    })));
  }
  return parts.join(' · ');
}

export {
  dimensionsToChips,
  metricsToChips,
  reportSettingsToChips,
  DEFAULT_REPORT_DIMENSIONS,
  DEFAULT_REPORT_METRICS,
  DEFAULT_REPORT_SETTINGS,
} from './gamReportCatalog';
