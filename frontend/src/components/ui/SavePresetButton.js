import React, { useEffect, useRef, useState } from 'react';
import {
  PRESET_NAME_MAX,
  saveReportPreset,
  summaryForPreset,
} from '../../utils/reportPresets';
import { validateSavedName, SAVED_NAME_RULES_HINT } from '../../utils/namePolicy';
import { showToast } from '../../hooks/useToast';

/**
 * Save current dates + filters as a named preset (Presets page only).
 * Place next to Copy link on Dashboard / Reporting.
 */
export default function SavePresetButton({
  page,
  userId,
  getSnapshot,
  disabled = false,
  variant = 'default',
  hint,
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => inputRef.current?.focus(), 40);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
        setError('');
      }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setError('');
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const openForm = () => {
    if (disabled) return;
    const snap = typeof getSnapshot === 'function' ? getSnapshot() : {};
    const hint = summaryForPreset(snap);
    setName(String(hint || '').slice(0, PRESET_NAME_MAX));
    setError('');
    setOpen(true);
  };

  const confirm = (e) => {
    e?.preventDefault?.();
    const snap = typeof getSnapshot === 'function' ? getSnapshot() : {};
    const trimmed = name.trim();
    const nameCheck = validateSavedName(trimmed, { maxLength: PRESET_NAME_MAX, label: 'Preset name' });
    if (!nameCheck.valid) {
      setError(nameCheck.errors[0]);
      return;
    }
    saveReportPreset(page, trimmed, snap, userId);
    setOpen(false);
    setError('');
    showToast({ message: 'Preset saved — open it from Presets' });
  };

  const defaultHint = (
    <>
      Saves <strong>filters only</strong> (not dates). Pick dates on the Presets page or on each report page.
      {' '}
      (Saved filters keep inventory only — no dates.)
    </>
  );

  const hintContent = hint || defaultHint;
  const triggerClass = variant === 'primary'
    ? 'btn-generate save-preset-trigger'
    : 'btn-reset btn-copy-link save-preset-trigger';

  return (
    <div className={`save-preset-wrap${open ? ' is-open' : ''}`} ref={wrapRef}>
      <button
        type="button"
        className={triggerClass}
        onClick={openForm}
        disabled={disabled}
        title="Save filters as a preset (Presets page)"
      >
        Save preset
      </button>
      {open && (
        <div className="save-preset-modal" role="dialog" aria-label="Save preset">
          <div className="save-preset-modal-head">
            <div className="save-preset-modal-title">Save preset</div>
            <button
              type="button"
              className="save-preset-modal-close"
              onClick={() => { setOpen(false); setError(''); }}
              aria-label="Close"
            >
              ×
            </button>
          </div>
          <p className="save-preset-modal-hint">{hintContent}</p>
          <p className="form-note save-preset-name-rules">{SAVED_NAME_RULES_HINT}</p>
          <form onSubmit={confirm}>
            <label className="save-preset-modal-label" htmlFor="save-preset-name">
              Name
            </label>
            <input
              id="save-preset-name"
              ref={inputRef}
              type="text"
              className="saved-filters-name-input"
              placeholder="e.g. My Scan + Message pack"
              value={name}
              maxLength={PRESET_NAME_MAX}
              onChange={(ev) => {
                setName(ev.target.value.slice(0, PRESET_NAME_MAX));
                if (error) setError('');
              }}
            />
            <div className="saved-filters-name-meta">
              {name.trim().length}/{PRESET_NAME_MAX} characters
            </div>
            {error ? <div className="saved-filters-error">{error}</div> : null}
            <div className="save-preset-modal-actions">
              <button type="button" className="btn-reset" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="btn-generate">Save</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
