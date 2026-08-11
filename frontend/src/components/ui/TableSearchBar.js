import React from 'react';

/**
 * Search input for data tables (icon + consistent styling).
 */
export default function TableSearchBar({
  value,
  onChange,
  placeholder = 'Search…',
  className = '',
  onPageReset,
}) {
  return (
    <div className={`table-search ${className}`.trim()}>
      <span className="table-search-icon" aria-hidden>⌕</span>
      <input
        type="search"
        className="search-input table-search-input"
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          onPageReset?.();
        }}
        aria-label={placeholder}
      />
    </div>
  );
}
