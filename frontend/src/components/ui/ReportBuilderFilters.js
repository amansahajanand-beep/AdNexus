import React, { useEffect, useMemo, useRef, useState } from 'react';
import { applyBulkSearchSelection, hasBulkSeparators } from '../../utils/bulkSelectMatch';
import {
  GAM_DIMENSION_CATEGORIES,
  GAM_METRIC_CATEGORIES,
  GAM_CATALOG_STATS,
  DEFAULT_REPORT_DIMENSIONS,
  DEFAULT_REPORT_METRICS,
  dimensionsToChips,
  metricsToChips,
} from '../../utils/gamReportCatalog';

export {
  DEFAULT_REPORT_DIMENSIONS,
  DEFAULT_REPORT_METRICS,
  dimensionsToChips,
  metricsToChips,
};

function toggle(list, id, onChange) {
  const set = new Set(list || []);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  onChange([...set]);
}

function FilterCategory({
  category, selected, onToggle, onToggleAll, disabled, expandAll, forceSearchOpen, defaultOpen,
}) {
  const ids = category.items.map(i => i.id);
  const count = ids.filter(id => selected.includes(id)).length;
  const allSelected = ids.length > 0 && count === ids.length;
  // Always start collapsed; Expand all / search can open categories later.
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const prevExpandAll = useRef(expandAll);

  useEffect(() => {
    if (expandAll) setOpen(true);
    else if (prevExpandAll.current && !expandAll) setOpen(false);
    prevExpandAll.current = expandAll;
  }, [expandAll]);

  useEffect(() => {
    if (forceSearchOpen) setOpen(true);
  }, [forceSearchOpen]);

  return (
    <div className={`gam-filter-cat ${open ? 'is-open' : ''}`}>
      <button type="button" className="gam-filter-cat-head" onClick={() => setOpen(v => !v)}>
        <span className="gam-filter-cat-title">{category.label}</span>
        {count > 0 && <span className="gam-filter-cat-count">{count}</span>}
        <span className={`gam-filter-cat-caret${open ? ' is-open' : ''}`} aria-hidden>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>
      {open && (
        <div className="gam-filter-list">
          <label className="gam-filter-check gam-filter-check-selectall" style={{ borderBottom: '1px solid #e8eaed', marginBottom: 4, paddingBottom: 4 }}>
            <input
              type="checkbox"
              checked={allSelected}
              disabled={disabled}
              onChange={() => onToggleAll(ids, allSelected)}
            />
            <span className="gam-filter-check-label" style={{ fontWeight: 600, color: '#3c4043' }}>Select All</span>
          </label>
          {category.items.map(item => (
            <label key={item.id} className="gam-filter-check">
              <input
                type="checkbox"
                checked={selected.includes(item.id)}
                disabled={disabled}
                onChange={() => onToggle(item.id)}
              />
              <span className="gam-filter-check-label">{item.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function FilterColumn({
  title, hint, categories, selected, onChange, disabled, search, onSearchChange, expandAll, onToggleExpand,
}) {
  const q = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return categories;
    return categories
      .map(cat => ({
        ...cat,
        items: cat.items.filter(i =>
          i.label.toLowerCase().includes(q) || (i.api || '').toLowerCase().includes(q)
        ),
      }))
      .filter(cat => cat.items.length > 0);
  }, [categories, q]);

  const allIds = useMemo(() => filtered.flatMap(c => c.items.map(i => i.id)), [filtered]);
  const allSelected = allIds.length > 0 && allIds.every(id => selected.includes(id));
  const optionCount = allIds.length;

  const handleSelectAll = () => {
    if (allSelected) {
      const removeSet = new Set(allIds);
      onChange(selected.filter(id => !removeSet.has(id)));
    } else {
      const addSet = new Set([...selected, ...allIds]);
      onChange([...addSet]);
    }
  };

  const flatItems = useMemo(
    () => filtered.flatMap((c) => c.items.map((i) => ({ value: i.id, label: i.label, id: i.id, api: i.api }))),
    [filtered]
  );

  const applyBulkSearch = (text = search) => {
    const result = applyBulkSearchSelection({
      query: text,
      options: flatItems,
      currentValues: selected,
      fieldKeys: ['value', 'label', 'id', 'api'],
    });
    if (!result) return;
    if (result.appliedCount > 0) onChange(result.nextValues);
    if (result.clearedQuery) onSearchChange('');
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
    applyBulkSearch(`${search}${pasted}`.trim());
  };

  return (
    <div className="gam-filter-column">
      <div className="gam-filter-column-head">
        <div className="gam-filter-column-top">
          <div className="filter-section-head">
            <span className="filter-section-title">{title}</span>
            <span className="filter-section-hint">{hint} · {optionCount} options</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn-reset gam-expand-btn" onClick={handleSelectAll} disabled={disabled}>
              {allSelected ? 'Deselect All' : 'Select All'}
            </button>
            {onToggleExpand && (
              <button type="button" className="btn-reset gam-expand-btn" onClick={onToggleExpand}>
                {expandAll ? 'Collapse' : 'Expand all'}
              </button>
            )}
          </div>
        </div>
        <input
          type="search"
          className="gam-filter-column-search"
          placeholder={`Search ${title.toLowerCase()} — paste comma-separated, Enter to select`}
          value={search}
          onChange={e => onSearchChange(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          onPaste={handleSearchPaste}
          disabled={disabled}
        />
      </div>
      <div className="gam-filter-categories">
        {filtered.map((cat) => (
            <FilterCategory
              key={cat.id}
              category={cat}
              selected={selected}
              disabled={disabled}
              expandAll={expandAll}
              forceSearchOpen={!!q}
              defaultOpen={false}
              onToggle={(id) => toggle(selected, id, onChange)}
              onToggleAll={(ids, allSel) => {
                if (allSel) {
                  const removeSet = new Set(ids);
                  onChange(selected.filter(id => !removeSet.has(id)));
                } else {
                  onChange([...new Set([...selected, ...ids])]);
                }
              }}
            />
          ))}
        {filtered.length === 0 && (
          <p className="gam-filter-empty">No matches for &ldquo;{search}&rdquo;</p>
        )}
      </div>
    </div>
  );
}

export default function ReportBuilderFilters({
  dimensions = DEFAULT_REPORT_DIMENSIONS,
  metrics = DEFAULT_REPORT_METRICS,
  onDimensionsChange,
  onMetricsChange,
  disabled = false,
}) {
  const [dimSearch, setDimSearch] = useState('');
  const [metSearch, setMetSearch] = useState('');
  const [expandDims, setExpandDims] = useState(false);
  const [expandMets, setExpandMets] = useState(false);

  return (
    <div className="gam-report-builder-wrap">
      <p className="gam-filter-toolbar-note">
        {GAM_CATALOG_STATS.dimensions} dimensions · {GAM_CATALOG_STATS.metrics} metrics
        {' · '}{dimensions.length} + {metrics.length} selected
      </p>
      <div className="gam-report-builder">
        <FilterColumn
          title="Dimensions"
          hint="Step 1"
          categories={GAM_DIMENSION_CATEGORIES}
          selected={dimensions}
          onChange={onDimensionsChange}
          disabled={disabled}
          search={dimSearch}
          onSearchChange={setDimSearch}
          expandAll={expandDims}
          onToggleExpand={() => setExpandDims(v => !v)}
        />
        <FilterColumn
          title="Metrics"
          hint="Step 2"
          categories={GAM_METRIC_CATEGORIES}
          selected={metrics}
          onChange={onMetricsChange}
          disabled={disabled}
          search={metSearch}
          onSearchChange={setMetSearch}
          expandAll={expandMets}
          onToggleExpand={() => setExpandMets(v => !v)}
        />
      </div>
    </div>
  );
}
