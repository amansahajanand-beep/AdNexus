import React, { useEffect, useRef, useState } from 'react';

/** Collapsed preview height (~3 chip rows) before “Show more”. */
const COLLAPSED_MAX_HEIGHT = 96;

/**
 * GAM-style applied filters — one chip per value, wrap to new lines.
 * Collapsed shows a few rows; expanded shows the full wrapped list (like GAM).
 */
export default function FilterChips({
  chips = [],
  onRemove,
  onAddFilter,
  expanded = true,
  onToggleExpand,
  title = 'Applied filters',
  hasData = null,
}) {
  const listRef = useRef(null);
  const [hasOverflow, setHasOverflow] = useState(false);

  useEffect(() => {
    const el = listRef.current;
    if (!el || expanded) {
      setHasOverflow(false);
      return undefined;
    }
    const check = () => setHasOverflow(el.scrollHeight > COLLAPSED_MAX_HEIGHT + 2);
    check();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(check) : null;
    ro?.observe(el);
    window.addEventListener('resize', check);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', check);
    };
  }, [chips, expanded]);

  if (!chips.length) return null;

  const showToggle = hasOverflow || (expanded && chips.length > 8);

  const chipVariant = hasData === true ? 'green' : hasData === false ? 'red' : '';

  const renderChip = (chip) => {
    const removable = onRemove && chip.removable !== false;
    return (
      <span
        key={chip.id}
        className={`filter-chip ${removable ? 'removable' : 'static'} ${chipVariant ? `filter-chip-${chipVariant}` : ''}`}
      >
        <span className="filter-chip-cat">{chip.category}</span>
        <span className="filter-chip-val" title={chip.title || chip.label}>{chip.label}</span>
        {removable && (
          <button
            type="button"
            className="filter-chip-x"
            aria-label={`Remove ${chip.category}: ${chip.label}`}
            onClick={() => onRemove(chip)}
          >
            <span aria-hidden>×</span>
          </button>
        )}
      </span>
    );
  };

  return (
    <div className="filter-chips-bar">
      <div className="filter-chips-head">
        <span className="filter-chips-label">{title}</span>
        {onAddFilter && (
          <button type="button" className="filter-add-btn" onClick={onAddFilter}>
            <span className="filter-add-icon" aria-hidden>+</span>
            Add filter
          </button>
        )}
      </div>
      <div
        ref={listRef}
        className={`filter-chips-list ${expanded ? 'expanded' : 'collapsed'}`}
      >
        {chips.map(renderChip)}
      </div>
      {showToggle && onToggleExpand && (
        <button type="button" className="filter-show-toggle" onClick={onToggleExpand}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}
