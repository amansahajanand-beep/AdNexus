import React, { useEffect, useRef, useState } from 'react';
import {
  getSavedFilters,
  saveNamedFilter,
  updateNamedFilter,
  removeSavedFilter,
  applySavedFilter,
  hasSavableFilters,
  summaryFor,
} from '../../utils/savedFilters';
import { validateSavedName, SAVED_NAME_RULES_HINT } from '../../utils/namePolicy';

/**
 * Save current filters with a name + browse / apply / edit / delete saved sets.
 * Dates are never saved or applied — caller keeps the current date range.
 */
export default function SavedFiltersBar({
  page,
  userId,
  /** Current filter draft used when saving (inventory / dims / metrics). */
  getSnapshot,
  /** Called with normalized snapshot (no dates) when user picks a saved set. */
  onApply,
  canSave = true,
  disabled = false,
}) {
  const [list, setList] = useState(() => getSavedFilters(page, userId));
  const [panelOpen, setPanelOpen] = useState(false);
  /** null | 'create' | { mode: 'edit', id, name } */
  const [form, setForm] = useState(null);
  const [name, setName] = useState('');
  const [updateSnapshot, setUpdateSnapshot] = useState(true);
  const [error, setError] = useState('');
  const inputRef = useRef(null);
  const panelRef = useRef(null);

  const formOpen = Boolean(form);

  useEffect(() => {
    setList(getSavedFilters(page, userId));
  }, [page, userId]);

  useEffect(() => {
    if (!formOpen) return undefined;
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [formOpen, form?.mode, form?.id]);

  useEffect(() => {
    if (!panelOpen && !formOpen) return undefined;
    const onDoc = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        setPanelOpen(false);
        setForm(null);
        setError('');
      }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setPanelOpen(false);
        setForm(null);
        setError('');
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [panelOpen, formOpen]);

  const closeForm = () => {
    setForm(null);
    setName('');
    setError('');
    setUpdateSnapshot(true);
  };

  const openCreate = () => {
    if (disabled || !canSave) return;
    const snap = typeof getSnapshot === 'function' ? getSnapshot() : {};
    if (!hasSavableFilters(snap)) {
      setError('Select at least one filter before saving.');
      setForm({ mode: 'create' });
      setName('');
      setPanelOpen(false);
      return;
    }
    setError('');
    setName('');
    setUpdateSnapshot(true);
    setForm({ mode: 'create' });
    setPanelOpen(false);
  };

  const openEdit = (item, e) => {
    e?.stopPropagation?.();
    if (disabled) return;
    setError('');
    setName(item.name || '');
    setUpdateSnapshot(true);
    setForm({ mode: 'edit', id: item.id });
    setPanelOpen(true);
  };

  const FILTER_NAME_MAX = 20;

  const confirmForm = (e) => {
    e?.preventDefault?.();
    const trimmed = name.trim();
    const nameCheck = validateSavedName(trimmed, {
      maxLength: FILTER_NAME_MAX,
      label: 'Filter name',
    });
    if (!nameCheck.valid) {
      setError(nameCheck.errors[0]);
      return;
    }

    if (form?.mode === 'edit' && form.id) {
      let filterPayload = null;
      if (updateSnapshot) {
        const snap = typeof getSnapshot === 'function' ? getSnapshot() : {};
        if (!hasSavableFilters(snap)) {
          setError('Select at least one filter to update this saved set, or uncheck “Update with current filters”.');
          return;
        }
        filterPayload = snap;
      }
      const next = updateNamedFilter(page, form.id, { name: trimmed, filter: filterPayload }, userId);
      setList(next);
      closeForm();
      setPanelOpen(true);
      return;
    }

    const snap = typeof getSnapshot === 'function' ? getSnapshot() : {};
    if (!hasSavableFilters(snap)) {
      setError('Select at least one filter before saving.');
      return;
    }
    const next = saveNamedFilter(page, trimmed, snap, userId);
    setList(next);
    closeForm();
    setPanelOpen(true);
  };

  const handleApply = (item) => {
    if (disabled) return;
    onApply?.(applySavedFilter(item.snapshot), item);
    setPanelOpen(false);
    closeForm();
  };

  const handleRemove = (id, e) => {
    e?.stopPropagation?.();
    setList(removeSavedFilter(page, id, userId));
    if (form?.mode === 'edit' && form.id === id) closeForm();
  };

  const isEdit = form?.mode === 'edit';

  return (
    <div className={`saved-filters-bar${panelOpen || formOpen ? ' is-open' : ''}`} ref={panelRef}>
      <button
        type="button"
        className="btn-saved-filter"
        onClick={openCreate}
        disabled={disabled}
        title="Save inventory/country filters only — dates are not saved (unlike Save preset)"
      >
        💾 Save filter
      </button>
      <button
        type="button"
        className={`btn-saved-filter ${panelOpen && !formOpen ? 'active' : ''}`}
        onClick={() => {
          setPanelOpen((v) => !v);
          closeForm();
        }}
        disabled={disabled}
        title="Named filters without dates — different from Presets (which include dates)"
        aria-expanded={panelOpen}
      >
        ★ Saved filters{list.length ? ` (${list.length})` : ''}
      </button>

      {formOpen && (
        <div className="saved-filters-popover" role="dialog" aria-label={isEdit ? 'Edit saved filter' : 'Save filter'}>
          <div className="saved-filters-popover-title">{isEdit ? 'Edit saved filter' : 'Save filter'}</div>
          <p className="saved-filters-popover-hint">
            {isEdit
              ? 'Rename this set. Optionally replace its filters with what you have selected now (dates stay unsaved).'
              : 'Saves inventory/country filters only — not the date range. For dates + filters together, use Save preset (Presets page).'}
          </p>
          <form onSubmit={confirmForm}>
            <input
              ref={inputRef}
              type="text"
              className="saved-filters-name-input"
              placeholder="e.g. MediaMonetix apps"
              value={name}
              maxLength={FILTER_NAME_MAX}
              onChange={(e) => {
                setName(e.target.value.slice(0, FILTER_NAME_MAX));
                if (error) setError('');
              }}
            />
            <div className="saved-filters-name-meta">
              {name.trim().length}/{FILTER_NAME_MAX} characters
            </div>
            <p className="form-note saved-filters-name-rules">{SAVED_NAME_RULES_HINT}</p>
            {isEdit && (
              <label className="saved-filters-update-toggle">
                <input
                  type="checkbox"
                  checked={updateSnapshot}
                  onChange={(e) => setUpdateSnapshot(e.target.checked)}
                />
                Update with current filters
              </label>
            )}
            {error && <div className="saved-filters-error">{error}</div>}
            <div className="saved-filters-popover-actions">
              <button type="button" className="btn-reset" onClick={closeForm}>
                Cancel
              </button>
              <button type="submit" className="btn-generate">{isEdit ? 'Save changes' : 'Save'}</button>
            </div>
          </form>
        </div>
      )}

      {panelOpen && !formOpen && (
        <div className="saved-filters-popover saved-filters-list-popover" role="listbox" aria-label="Saved filters">
          <div className="saved-filters-popover-title">Saved filters ({list.length})</div>
          <p className="saved-filters-popover-hint">
            Apply a set, then change the date range as needed. You can save many filters and edit any of them.
          </p>
          {list.length === 0 ? (
            <div className="saved-filters-empty">No saved filters yet. Click “Save filter” after selecting filters.</div>
          ) : (
            <ul className="saved-filters-list">
              {list.map((item) => (
                <li key={item.id} className="saved-filters-item">
                  <button
                    type="button"
                    className="saved-filters-item-main"
                    onClick={() => handleApply(item)}
                    title={item.summary || summaryFor(item.snapshot)}
                  >
                    <span className="saved-filters-item-name">{item.name}</span>
                    <span className="saved-filters-item-summary">{item.summary || summaryFor(item.snapshot)}</span>
                  </button>
                  <button
                    type="button"
                    className="saved-filters-item-edit"
                    title="Edit name or filters"
                    aria-label={`Edit ${item.name}`}
                    onClick={(e) => openEdit(item, e)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="saved-filters-item-delete"
                    title="Delete saved filter"
                    aria-label={`Delete ${item.name}`}
                    onClick={(e) => handleRemove(item.id, e)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
