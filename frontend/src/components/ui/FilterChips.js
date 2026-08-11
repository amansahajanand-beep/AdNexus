import React, { useEffect, useRef, useState } from 'react';

const COLLAPSED_MAX_HEIGHT = 62; // ~2 chip rows

/**
 * GAM-style applied filters — single list, max 2 rows collapsed, show more/less, add filter.
 * hasData: true = green chips, false = red chips, null/undefined = default grey
 */
export default function FilterChips({
  chips = [],
  onRemove,
  onAddFilter,
  expanded = false,
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

  const showToggle = hasOverflow || expanded;

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
