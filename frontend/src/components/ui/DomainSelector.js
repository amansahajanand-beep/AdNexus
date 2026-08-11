import React, { useMemo, useState } from 'react';
import { applyBulkSearchSelection, hasBulkSeparators } from '../../utils/bulkSelectMatch';

/**
 * Reusable domain/channel multi-select with "Select All" + search.
 * Used by Add/Edit user, Edit Channel Permissions and the Domain Permissions tab.
 */
export default function DomainSelector({
  domains = [],
  selected = [],
  onChange,
  loading = false,
  disabled = false,
  selectAllLabel = 'Select All Domains',
  searchPlaceholder = 'Search domain…',
  emptyLabel = 'No domains found',
  itemLabel = 'domains',
}) {
  const [search, setSearch] = useState('');

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const displayItems = useMemo(() => {
    const sel = new Set(selected);
    const byId = new Map(domains.map((d) => [d.id, d]));
    selected.forEach((id) => {
      if (!id || byId.has(id)) return;
      byId.set(id, { id, label: id });
    });
    return Array.from(byId.values()).sort((a, b) => {
      const aSelected = sel.has(a.id);
      const bSelected = sel.has(b.id);
      if (aSelected !== bSelected) return aSelected ? -1 : 1;
      return String(a.label).localeCompare(String(b.label));
    });
  }, [domains, selected]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return displayItems;
    return displayItems.filter((d) =>
      d.label.toLowerCase().includes(q)
      || String(d.id || '').toLowerCase().includes(q)
      || String(d.appId || '').toLowerCase().includes(q)
      || String(d.domainName || '').toLowerCase().includes(q)
    );
  }, [displayItems, search]);

  const allSelected = displayItems.length > 0 && displayItems.every((d) => selectedSet.has(d.id));

  const toggle = (id) => {
    if (disabled) return;
    const next = new Set(selectedSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange?.(Array.from(next));
  };

  const toggleAll = () => {
    if (disabled) return;
    onChange?.(allSelected ? [] : displayItems.map((d) => d.id));
  };

  const applyBulkSearch = (text = search) => {
    const result = applyBulkSearchSelection({
      query: text,
      options: displayItems,
      currentValues: selected,
      fieldKeys: ['value', 'label', 'id', 'domainName', 'appId'],
    });
    if (!result) return;
    if (result.appliedCount > 0) onChange?.(result.nextValues);
    if (result.clearedQuery) setSearch('');
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
    <div className={`domain-selector ${disabled ? 'is-disabled' : ''}`}>
      <div className="domain-selector-head">
        <label className="domain-check domain-check-all">
          <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={disabled || loading} />
          <span>{selectAllLabel}</span>
        </label>
        <div className="domain-search">
          <span className="domain-search-icon">⌕</span>
          <input
            type="text"
            placeholder={`${searchPlaceholder} — paste comma-separated, Enter to select`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            onPaste={handleSearchPaste}
            disabled={disabled || loading}
          />
        </div>
      </div>

      <div className="domain-selector-list">
        {loading ? (
          <div className="domain-selector-loading">
            <span className="domain-selector-spinner" aria-hidden />
            <span>Loading…</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="domain-selector-empty">{emptyLabel}</div>
        ) : (
          filtered.map((d) => (
            <label key={d.id} className="domain-check">
              <input
                type="checkbox"
                checked={selectedSet.has(d.id)}
                onChange={() => toggle(d.id)}
                disabled={disabled}
              />
              <span className="domain-check-label">{d.label}</span>
            </label>
          ))
        )}
      </div>

      {!loading && displayItems.length > 0 && (
        <div className="domain-selector-foot">
          {selected.length} of {displayItems.length} {itemLabel} selected
        </div>
      )}
    </div>
  );
}
