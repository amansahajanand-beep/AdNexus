/** Split search box input into tokens (comma, semicolon, newline, pipe, tab). */
export function parseBulkSearchTokens(input) {
  const raw = String(input || '').trim();
  if (!raw) return [];
  return raw.split(/[,;\n|\t]+/).map((s) => s.trim()).filter(Boolean);
}

export function hasBulkSeparators(input) {
  return /[,;\n|\t]/.test(String(input || ''));
}

function optionFields(option, keys) {
  const out = [];
  keys.forEach((key) => {
    let v;
    if (key === 'value') v = option.value ?? option.id;
    else v = option[key];
    if (v != null && v !== '' && v !== '—') out.push(String(v));
  });
  return out;
}

/** True when token exactly equals a field (case-insensitive). No substring / parent-domain match. */
export function tokenMatchesField(token, field) {
  const t = String(token || '').trim().toLowerCase();
  const f = String(field || '').trim().toLowerCase();
  if (!t || !f) return false;
  return f === t;
}

/**
 * Find option values that match any token (exact match only).
 * @param {Array} options - { value|id, label, ... }
 * @param {string[]} tokens
 * @param {string[]} fieldKeys - fields to match against
 */
export function findMatchingOptionValues(options = [], tokens = [], fieldKeys = ['value', 'label', 'id']) {
  const list = options.map((o) => (typeof o === 'object' ? o : { value: o, label: o, id: o }));
  const matched = new Set();

  tokens.forEach((token) => {
    list.forEach((option) => {
      const value = option.value ?? option.id;
      if (value == null || value === '') return;
      const fields = optionFields(option, fieldKeys);
      if (fields.some((f) => tokenMatchesField(token, f))) {
        matched.add(value);
      }
    });
  });

  return [...matched];
}

/**
 * Apply bulk search: merge matched values into current selection.
 * Comma-separated (and single Enter) values must match options exactly.
 * Returns { nextValues, appliedCount, clearedQuery } or null if nothing to do.
 */
export function applyBulkSearchSelection({
  query,
  options,
  currentValues = [],
  fieldKeys = ['value', 'label', 'id'],
}) {
  const tokens = parseBulkSearchTokens(query);
  if (!tokens.length) return null;

  const toAdd = findMatchingOptionValues(options, tokens, fieldKeys);
  if (!toAdd.length) return { nextValues: currentValues, appliedCount: 0, clearedQuery: false };

  const nextValues = [...new Set([...currentValues, ...toAdd])];
  return {
    nextValues,
    appliedCount: toAdd.length,
    clearedQuery: true,
  };
}
