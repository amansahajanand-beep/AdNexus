import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { applyBulkSearchSelection, hasBulkSeparators } from '../../utils/bulkSelectMatch';
import { ALL_SENTINEL, isAllSelection, toAllSelection } from '../../utils/inventorySelection';

/**
 * Lightweight multi-select dropdown (checkbox list) used by the report filters.
 * Menu renders in a portal so parent overflow does not clip the option list.
 *
 * Default value [] = nothing selected.
 * Select All uses a sentinel so we never materialize thousands of IDs.
 */
export default function MultiSelect({
  options = [],
  value = [],
  onChange,
  placeholder = 'Select…',
  disabled = false,
  loading = false,
  searchable = true,
  showSelectAll = true,
  selectAllLabel = 'Select All',
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [menuStyle, setMenuStyle] = useState(null);
  const wrapRef = useRef(null);
  const controlRef = useRef(null);
  const menuRef = useRef(null);

  const norm = useMemo(
    () => options.map((o) => (typeof o === 'object' ? o : { value: o, label: o })),
    [options]
  );

  const updateMenuPosition = useCallback(() => {
    const el = controlRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const gap = 4;
    const viewportPad = 10;
    const isNarrow = window.innerWidth < 768;
    // Keep Apply Filter / sticky foot visible on mobile — short scrollable menu.
    const footReserve = isNarrow ? 72 : 0;
    const hardCap = isNarrow ? Math.min(150, Math.round(window.innerHeight * 0.26)) : 360;
    const softMin = isNarrow ? 96 : 160;
    const spaceBelow = window.innerHeight - rect.bottom - viewportPad - footReserve;
    const spaceAbove = rect.top - viewportPad;
    const openUp = spaceBelow < (isNarrow ? 120 : 180) && spaceAbove > spaceBelow;
    const available = openUp ? spaceAbove - gap : spaceBelow - gap;
    const maxMenuHeight = Math.min(hardCap, Math.max(softMin, available));

    setMenuStyle({
      position: 'fixed',
      left: Math.max(viewportPad, Math.min(rect.left, window.innerWidth - rect.width - viewportPad)),
      width: Math.min(rect.width, window.innerWidth - viewportPad * 2),
      top: openUp ? undefined : rect.bottom + gap,
      bottom: openUp ? window.innerHeight - rect.top + gap : undefined,
      maxHeight: maxMenuHeight,
      height: 'auto',
      overflow: 'hidden',
      zIndex: 1200,
    });
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    updateMenuPosition();
    const onScrollOrResize = () => updateMenuPosition();
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [open, updateMenuPosition]);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (wrapRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const allMode = isAllSelection(value);
  const selectedSet = useMemo(
    () => new Set(allMode ? [] : (value || []).filter((v) => v !== ALL_SENTINEL)),
    [value, allMode]
  );

  const MAX_VISIBLE_OPTIONS = 300;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return norm;
    return norm.filter((o) => String(o.label).toLowerCase().includes(q));
  }, [norm, query]);

  const visibleOptions = useMemo(() => {
    if (query.trim()) return filtered;
    if (filtered.length <= MAX_VISIBLE_OPTIONS) return filtered;
    return filtered.slice(0, MAX_VISIBLE_OPTIONS);
  }, [filtered, query]);

  const selectTarget = query.trim() ? filtered : norm;
  const allSelected = selectTarget.length > 0 && (
    allMode
    || selectTarget.every((o) => selectedSet.has(o.value))
  );
  const someSelected = allMode || selectTarget.some((o) => selectedSet.has(o.value));
  const selectAllText = query.trim() && filtered.length < norm.length
    ? 'Select all shown'
    : selectAllLabel;

  /** Prefer All-sentinel over materializing the full catalog. */
  const emitChange = (next) => {
    if (!Array.isArray(next) || !norm.length) {
      onChange(next);
      return;
    }
    if (isAllSelection(next)) {
      onChange(toAllSelection());
      return;
    }
    const concrete = next.filter((v) => v !== ALL_SENTINEL);
    if (concrete.length >= norm.length) {
      const nextSet = new Set(concrete);
      if (norm.every((o) => nextSet.has(o.value))) {
        onChange(toAllSelection());
        return;
      }
    }
    onChange(concrete);
  };

  const toggle = (val) => {
    if (allMode) {
      // Leaving Select All → keep only this value.
      emitChange([val]);
      return;
    }
    if (selectedSet.has(val)) emitChange(value.filter((v) => v !== val && v !== ALL_SENTINEL));
    else emitChange([...value.filter((v) => v !== ALL_SENTINEL), val]);
  };

  const toggleAll = () => {
    if (!selectTarget.length) return;
    if (allSelected) {
      if (allMode && !query.trim()) {
        // Uncheck Select All → clear to nothing selected.
        emitChange([]);
        return;
      }
      const remove = new Set(selectTarget.map((o) => o.value));
      emitChange(value.filter((v) => v !== ALL_SENTINEL && !remove.has(v)));
      return;
    }
    // Select entire catalog → sentinel (not thousands of IDs).
    const selectingEntireCatalog = !query.trim() && selectTarget.length === norm.length;
    if (selectingEntireCatalog) {
      emitChange(toAllSelection());
      return;
    }
    emitChange([...new Set([
      ...value.filter((v) => v !== ALL_SENTINEL),
      ...selectTarget.map((o) => o.value),
    ])]);
  };

  const clearAll = (e) => {
    e.stopPropagation();
    emitChange([]);
  };

  const applyBulkSearch = (text = query) => {
    const result = applyBulkSearchSelection({
      query: text,
      options: norm,
      currentValues: allMode ? [] : value.filter((v) => v !== ALL_SENTINEL),
      fieldKeys: ['value', 'label'],
    });
    if (!result) return;
    if (result.appliedCount > 0) emitChange(result.nextValues);
    if (result.clearedQuery) setQuery('');
  };

  const handleSearchKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyBulkSearch();
    }
  };

  const handleSearchPaste = (e) => {
    const pasted = e.clipboardData?.getData('text') || '';
    if (!hasBulkSeparators(pasted)) return;
    e.preventDefault();
    applyBulkSearch(`${query}${pasted}`.trim());
  };

  const label = allMode
    ? 'All selected'
    : value.length === 0
      ? placeholder
      : value.length === 1
        ? (norm.find((o) => o.value === value[0])?.label ?? value[0])
        : `${value.length} selected`;

  const menu = open && menuStyle ? (
    <div className="ms-menu ms-menu-portal" ref={menuRef} style={menuStyle}>
      {searchable && norm.length > 0 && !loading && (
        <input
          className="ms-search"
          placeholder="Paste exact values (comma-separated), press Enter…"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          onPaste={handleSearchPaste}
        />
      )}
      <div className="ms-options">
        {loading ? (
          <div className="ms-loading-row">
            <span className="ms-spinner" aria-hidden />
            <span>Loading options…</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="ms-empty">{norm.length === 0 ? 'No options available' : 'No matches'}</div>
        ) : (
          <>
            {showSelectAll && (
              <label className="ms-option ms-option-all">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
                  onChange={toggleAll}
                />
                <span className="ms-option-text ms-option-all-label">{selectAllText}</span>
              </label>
            )}
            {visibleOptions.map((o) => (
              <label key={o.value} className="ms-option">
                <input
                  type="checkbox"
                  checked={allMode || selectedSet.has(o.value)}
                  onChange={() => toggle(o.value)}
                />
                <span className="ms-option-text" title={o.label}>{o.label}</span>
              </label>
            ))}
            {!query.trim() && filtered.length > MAX_VISIBLE_OPTIONS && (
              <div className="ms-empty">
                Showing first {MAX_VISIBLE_OPTIONS} of {filtered.length}. Type to search for more…
              </div>
            )}
          </>
        )}
      </div>
      {!loading && norm.length > 0 && (
        <div className="ms-footer">
          <span className="ms-count">
            {allMode ? `All ${norm.length}` : `${value.filter((v) => v !== ALL_SENTINEL).length} of ${norm.length}`} selected
          </span>
          {(value.length > 0 || allMode) && (
            <button type="button" className="ms-clear-all" onClick={() => emitChange([])}>
              Clear selection
            </button>
          )}
        </div>
      )}
    </div>
  ) : null;

  return (
    <div className={`ms ${disabled ? 'ms-disabled' : ''} ${open ? 'ms-is-open' : ''} ${loading ? 'ms-loading' : ''}`} ref={wrapRef}>
      <button
        type="button"
        ref={controlRef}
        className={`ms-control ${open ? 'ms-open' : ''}`}
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        aria-expanded={open}
        aria-busy={loading}
      >
        {loading && <span className="ms-control-spinner" aria-hidden />}
        <span className={`ms-label ${!allMode && value.length === 0 ? 'ms-placeholder' : ''}`}>
          {loading ? 'Loading…' : label}
        </span>
        {(value.length > 0 || allMode) && !disabled && !loading && (
          <span className="ms-clear" title="Clear" onClick={clearAll}>×</span>
        )}
        <span className="ms-caret">▾</span>
      </button>

      {menu && createPortal(menu, document.body)}
    </div>
  );
}
