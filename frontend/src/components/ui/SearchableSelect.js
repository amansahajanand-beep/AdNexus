import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  applyBulkSearchSelection,
  findMatchingOptionValues,
  hasBulkSeparators,
  parseBulkSearchTokens,
} from '../../utils/bulkSelectMatch';

const MAX_VISIBLE = 300;

/**
 * Single-select dropdown with search + paste-to-select (same behavior as report filters).
 * Paste an exact value (or comma-separated list) to select the matching option.
 */
export default function SearchableSelect({
  options = [],
  value = '',
  onChange,
  placeholder = 'Select…',
  disabled = false,
  required = false,
  id,
  fieldKeys = ['value', 'label', 'id'],
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [menuStyle, setMenuStyle] = useState(null);
  const wrapRef = useRef(null);
  const controlRef = useRef(null);
  const menuRef = useRef(null);
  const inputRef = useRef(null);

  const norm = useMemo(
    () => options.map((o) => {
      if (typeof o !== 'object') return { value: o, label: String(o), id: o };
      const v = o.value ?? o.id;
      return { ...o, value: v, label: o.label ?? String(v ?? ''), id: o.id ?? v };
    }),
    [options]
  );

  const selected = useMemo(
    () => norm.find((o) => String(o.value) === String(value)) || null,
    [norm, value]
  );

  const updateMenuPosition = useCallback(() => {
    const el = controlRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const gap = 4;
    const viewportPad = 10;
    const isNarrow = window.innerWidth < 768;
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
    else {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return norm;
    return norm.filter((o) => {
      const blob = fieldKeys
        .map((k) => (k === 'value' ? o.value : o[k]))
        .filter((v) => v != null && v !== '')
        .join(' ')
        .toLowerCase();
      return blob.includes(q);
    });
  }, [norm, query, fieldKeys]);

  const visible = useMemo(() => {
    if (query.trim()) return filtered;
    if (filtered.length <= MAX_VISIBLE) return filtered;
    return filtered.slice(0, MAX_VISIBLE);
  }, [filtered, query]);

  const pick = (next) => {
    onChange?.(next == null ? '' : String(next));
    setQuery('');
    setOpen(false);
  };

  const applyPasteOrEnter = (text) => {
    const raw = String(text || '').trim();
    if (!raw) return false;

    const result = applyBulkSearchSelection({
      query: raw,
      options: norm,
      currentValues: [],
      fieldKeys,
    });
    if (result?.appliedCount > 0 && result.nextValues?.length) {
      pick(result.nextValues[0]);
      return true;
    }

    // Single pasted string without separators: exact match via tokens helper
    const tokens = parseBulkSearchTokens(raw);
    const matched = findMatchingOptionValues(norm, tokens.length ? tokens : [raw], fieldKeys);
    if (matched.length) {
      pick(matched[0]);
      return true;
    }

    // If search/filter leaves exactly one option, select it
    const q = raw.toLowerCase();
    const one = norm.filter((o) => {
      const blob = fieldKeys
        .map((k) => (k === 'value' ? o.value : o[k]))
        .filter((v) => v != null && v !== '')
        .join(' ')
        .toLowerCase();
      return blob.includes(q);
    });
    if (one.length === 1) {
      pick(one[0].value);
      return true;
    }

    setQuery(raw);
    return false;
  };

  const handleSearchKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyPasteOrEnter(query);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  const handleSearchPaste = (e) => {
    const pasted = e.clipboardData?.getData('text') || '';
    if (!pasted.trim()) return;
    e.preventDefault();
    // Prefer pasted text alone; if search already has text and paste has separators, merge like filters
    const text = hasBulkSeparators(pasted) && query
      ? `${query}${pasted}`.trim()
      : pasted.trim();
    if (!applyPasteOrEnter(text)) {
      setOpen(true);
    }
  };

  const label = selected?.label || (value ? String(value) : '');
  const showPlaceholder = !label;

  const menu = open && menuStyle ? (
    <div className="ms-menu ms-menu-portal" ref={menuRef} style={menuStyle}>
      {norm.length > 0 && (
        <input
          ref={inputRef}
          className="ms-search"
          placeholder="Paste exact value, press Enter to select…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          onPaste={handleSearchPaste}
        />
      )}
      <div className="ms-options">
        {filtered.length === 0 ? (
          <div className="ms-empty">{norm.length === 0 ? 'No options available' : 'No matches'}</div>
        ) : (
          <>
            {visible.map((o) => {
              const isSelected = String(o.value) === String(value);
              return (
                <button
                  key={String(o.value)}
                  type="button"
                  className={`ms-option ss-option ${isSelected ? 'ss-option-selected' : ''}`}
                  onClick={() => pick(o.value)}
                  title={o.label}
                >
                  <span className="ms-option-text">{o.label}</span>
                </button>
              );
            })}
            {!query.trim() && filtered.length > MAX_VISIBLE && (
              <div className="ms-empty">
                Showing first {MAX_VISIBLE} of {filtered.length}. Type or paste to find more…
              </div>
            )}
          </>
        )}
      </div>
    </div>
  ) : null;

  return (
    <div className={`ms ss ${disabled ? 'ms-disabled' : ''} ${open ? 'ms-is-open' : ''}`} ref={wrapRef}>
      {/* Hidden input so native form required validation still works */}
      {required && (
        <input
          id={id}
          tabIndex={-1}
          aria-hidden
          required
          value={value || ''}
          onChange={() => {}}
          style={{ position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none' }}
        />
      )}
      <button
        type="button"
        ref={controlRef}
        id={required ? undefined : id}
        className={`ms-control ${open ? 'ms-open' : ''}`}
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span className={`ms-label ${showPlaceholder ? 'ms-placeholder' : ''}`}>
          {showPlaceholder ? placeholder : label}
        </span>
        {value && !disabled && (
          <span
            className="ms-clear"
            title="Clear"
            onClick={(e) => {
              e.stopPropagation();
              pick('');
            }}
          >
            ×
          </span>
        )}
        <span className={`ms-caret${open ? ' is-open' : ''}`} aria-hidden>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>
      {menu && createPortal(menu, document.body)}
    </div>
  );
}
