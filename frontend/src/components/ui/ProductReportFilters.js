import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MultiSelect from './MultiSelect';
import CompareRangeBar from './CompareRangeBar';
import FilterChips from './FilterChips';
import SavedFiltersBar from './SavedFiltersBar';
import SavePresetButton from './SavePresetButton';
import OnboardingGuide from './OnboardingGuide';
import { FilterFieldIcon } from './Icon';
import { DATE_PRESETS } from '../../utils/gamReportCatalog';
import { presetRange } from '../../utils/datetime';
import { previousPeriodRange } from '../../utils/periodCompare';
import { loadComparePrefs, saveComparePrefs } from '../../utils/dashCharts';
import { isCustomRangeIncomplete } from '../../utils/dateRestriction';
import { isAllSelection } from '../../utils/inventorySelection';
import { copyReportLink } from '../../utils/report/reportShare';
import {
  getRecentFilters,
  saveRecentFilter,
  applyRecentFilter,
  removeRecentFilter,
} from '../../utils/recentFilters';
import { showToast } from '../../hooks/useToast';
import { useMedia } from '../../hooks/useMedia';
import { useReportHotkeys } from '../../hooks/useReportHotkeys';
import { publisherDimKeys, ADMOB_EXTRA_DIM_KEYS } from '../../hooks/usePublisherReport';

const ADMOB_CORE_FIELDS = [
  { key: 'apps', label: 'Apps', icon: 'apps', placeholder: 'Select apps' },
  { key: 'formats', label: 'Formats', icon: 'adunit', placeholder: 'Select formats' },
  { key: 'countries', label: 'Countries', icon: 'domain', placeholder: 'Select countries' },
  { key: 'platforms', label: 'Platforms', icon: 'sites', placeholder: 'Select platforms' },
];

const ADMOB_EXTRA_FIELDS = [
  { key: 'adUnits', label: 'Ad units', icon: 'adunit', placeholder: 'Select ad units' },
  { key: 'adSources', label: 'Ad sources', icon: 'apps', placeholder: 'Select ad sources' },
  { key: 'adSourceInstances', label: 'Ad source instances', icon: 'adunit', placeholder: 'Select instances' },
  { key: 'mediationGroups', label: 'Mediation groups', icon: 'domain', placeholder: 'Select mediation groups' },
];

const ADSENSE_FIELDS = [
  { key: 'sites', label: 'Sites', icon: 'sites', placeholder: 'Select sites' },
  { key: 'countries', label: 'Countries', icon: 'domain', placeholder: 'Select countries' },
  { key: 'platforms', label: 'Platforms', icon: 'apps', placeholder: 'Select platforms' },
];

function fieldsWithValues(extraFields, applied) {
  return extraFields
    .filter((f) => {
      const vals = applied?.[f.key];
      return Array.isArray(vals) && vals.length && !isAllSelection(vals);
    })
    .map((f) => f.key);
}

function cloneFilters(src = {}) {
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    out[k] = Array.isArray(v) ? [...v] : v;
  }
  return out;
}

function buildChips(fields, applied, options, range) {
  const chips = [];
  if (range?.startDate && range?.endDate) {
    chips.push({
      id: 'date-range',
      field: 'date',
      value: null,
      category: 'Date',
      label: `${range.startDate} → ${range.endDate}`,
      removable: false,
    });
  }
  for (const f of fields) {
    const vals = applied[f.key];
    if (!vals?.length || isAllSelection(vals)) continue;
    const optList = options[f.key] || [];
    const labelFor = (id) => optList.find((o) => o.value === id)?.label || id;
    vals.forEach((id) => {
      chips.push({
        id: `${f.key}:${id}`,
        field: f.key,
        value: id,
        category: f.label,
        label: labelFor(id),
        removable: true,
      });
    });
  }
  return chips;
}

function scopedRecent(list, product) {
  return (list || []).filter((item) => (item?.snapshot?.scope || item?.snapshot?.product) === product);
}

/**
 * GAM Dashboard filter card: compare bar, date toolbar, presets, chips, inventory grid.
 */
export default function ProductReportFilters({
  product = 'admob',
  range,
  onRangeChange,
  filters = {},
  filterOptions = {},
  onFilterChange,
  onFiltersApply,
  onClear,
  canUseFilters = true,
  disabled = false,
  datePreset = 'last7',
  onDatePresetChange,
  compareMode = 'prior',
  onCompareModeChange,
  compareStart = '',
  compareEnd = '',
  onCompareStart,
  onCompareEnd,
  showCompare = true,
  onApply,
  userId,
  savedPage,
  presetPage,
  getSavedFilterSnapshot,
  getPresetSnapshot,
  getSharePayload,
  onApplySavedFilter,
  onApplyRecentFilter,
  timeZone = null,
  /** AdMob Reporting: allow adding ad unit / ad source / mediation filters. */
  enableExtraFilters = false,
}) {
  const coreFields = useMemo(
    () => (product === 'adsense' ? ADSENSE_FIELDS : ADMOB_CORE_FIELDS),
    [product]
  );
  const extraFields = useMemo(
    () => (product === 'admob' && enableExtraFilters ? ADMOB_EXTRA_FIELDS : []),
    [product, enableExtraFilters]
  );
  const dimKeyList = useMemo(
    () => publisherDimKeys(product, { includeExtra: enableExtraFilters }),
    [product, enableExtraFilters]
  );
  const isNarrow = useMedia('(max-width: 768px)');
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(() => !isNarrow);
  const [chipsExpanded, setChipsExpanded] = useState(false);
  const [breakdownOpen, setBreakdownOpen] = useState(true);
  const [draftStart, setDraftStart] = useState(range?.startDate || '');
  const [draftEnd, setDraftEnd] = useState(range?.endDate || '');
  const [draftFilters, setDraftFilters] = useState(() => cloneFilters(filters));
  const [recentFilters, setRecentFilters] = useState(() => scopedRecent(getRecentFilters(userId), product));
  const [activeExtraKeys, setActiveExtraKeys] = useState(() => fieldsWithValues(extraFields, filters));
  const [extraMenuOpen, setExtraMenuOpen] = useState(false);
  const panelRef = useRef(null);
  const extraMenuRef = useRef(null);

  const visibleFields = useMemo(() => {
    if (!extraFields.length) return coreFields;
    const extras = extraFields.filter((f) => activeExtraKeys.includes(f.key));
    return [...coreFields, ...extras];
  }, [coreFields, extraFields, activeExtraKeys]);

  const availableExtraFields = useMemo(
    () => extraFields.filter((f) => !activeExtraKeys.includes(f.key)),
    [extraFields, activeExtraKeys]
  );

  useEffect(() => {
    setMobileFiltersOpen(!isNarrow);
  }, [isNarrow]);

  useEffect(() => {
    if (datePreset !== 'custom') {
      setDraftStart(range?.startDate || '');
      setDraftEnd(range?.endDate || '');
    }
  }, [range?.startDate, range?.endDate, datePreset]);

  useEffect(() => {
    setDraftFilters(cloneFilters(filters));
    if (extraFields.length) {
      setActiveExtraKeys((prev) => {
        const fromVals = fieldsWithValues(extraFields, filters);
        const merged = new Set([...prev, ...fromVals]);
        return extraFields.map((f) => f.key).filter((k) => merged.has(k));
      });
    }
  }, [filters, extraFields]);

  useEffect(() => {
    setRecentFilters(scopedRecent(getRecentFilters(userId), product));
  }, [userId, product]);

  useEffect(() => {
    if (!extraMenuOpen) return undefined;
    const onDoc = (e) => {
      if (extraMenuRef.current && !extraMenuRef.current.contains(e.target)) {
        setExtraMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [extraMenuOpen]);

  const presetLabel = DATE_PRESETS.find((p) => p.id === datePreset)?.label || 'Custom';
  const customIncomplete = isCustomRangeIncomplete(datePreset, draftStart, draftEnd);
  const displayStart = datePreset === 'custom' ? draftStart : (range?.startDate || '');
  const displayEnd = datePreset === 'custom' ? draftEnd : (range?.endDate || '');
  const rangeText = useMemo(() => {
    if (customIncomplete) return 'Select start & end dates';
    if (!displayStart || !displayEnd) return '…';
    return displayStart !== displayEnd ? `${displayStart} → ${displayEnd}` : displayStart;
  }, [customIncomplete, displayStart, displayEnd]);

  const appliedChips = useMemo(
    () => buildChips(visibleFields, filters, filterOptions, range),
    [visibleFields, filters, filterOptions, range]
  );

  const commitDimensionFilters = useCallback((next) => {
    const scoped = {};
    for (const key of dimKeyList) {
      scoped[key] = next?.[key] || [];
    }
    // Drop extra keys that were removed from the UI
    if (enableExtraFilters) {
      for (const key of ADMOB_EXTRA_DIM_KEYS) {
        if (!activeExtraKeys.includes(key)) scoped[key] = [];
      }
    }
    if (typeof onFiltersApply === 'function') {
      onFiltersApply(scoped);
      return;
    }
    dimKeyList.forEach((key) => onFilterChange?.(key, scoped[key] || []));
  }, [onFiltersApply, onFilterChange, dimKeyList, enableExtraFilters, activeExtraKeys]);

  const persistRecent = useCallback((nextRange, nextFilters, nextPreset) => {
    const snapshot = {
      scope: product,
      product,
      preset: nextPreset,
      startDate: nextRange?.startDate,
      endDate: nextRange?.endDate,
    };
    for (const key of dimKeyList) {
      snapshot[key] = nextFilters?.[key] || [];
    }
    setRecentFilters(scopedRecent(saveRecentFilter(snapshot, userId), product));
  }, [product, userId, dimKeyList]);

  const applyPreset = useCallback((id) => {
    onDatePresetChange?.(id);
    if (id === 'custom') {
      setDraftStart('');
      setDraftEnd('');
      setMobileFiltersOpen(true);
      setBreakdownOpen(true);
      return;
    }
    const next = presetRange(id, timeZone ? { timeZone } : {});
    setDraftStart(next.startDate);
    setDraftEnd(next.endDate);
    onRangeChange?.(next);
  }, [onDatePresetChange, onRangeChange, timeZone]);

  const applyFilter = useCallback(() => {
    if (datePreset === 'custom') {
      if (customIncomplete) return;
      onRangeChange?.({ startDate: draftStart, endDate: draftEnd });
    }
    commitDimensionFilters(draftFilters);
    const nextRange = datePreset === 'custom'
      ? { startDate: draftStart, endDate: draftEnd }
      : range;
    persistRecent(nextRange, draftFilters, datePreset);
    onApply?.();
  }, [
    datePreset, customIncomplete, draftStart, draftEnd, onRangeChange,
    commitDimensionFilters, draftFilters, onApply, persistRecent, range,
  ]);

  const resetAll = useCallback(() => {
    const next = presetRange('last7', timeZone ? { timeZone } : {});
    onDatePresetChange?.('last7');
    setDraftStart(next.startDate);
    setDraftEnd(next.endDate);
    setDraftFilters({});
    setActiveExtraKeys([]);
    setExtraMenuOpen(false);
    onRangeChange?.(next);
    onClear?.();
  }, [onDatePresetChange, onRangeChange, onClear, timeZone]);

  const handleAddFilter = useCallback(() => {
    setBreakdownOpen(true);
    setMobileFiltersOpen(true);
    window.setTimeout(() => {
      const section = document.getElementById(`${product}-inventory-filters`);
      if (!section) {
        panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      section.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const control = section.querySelector('.ms-control:not([disabled])');
      if (control && !section.querySelector('.ms-is-open')) {
        control.focus();
        control.click();
      }
    }, isNarrow && !mobileFiltersOpen ? 120 : 0);
  }, [product, isNarrow, mobileFiltersOpen]);

  const addExtraField = useCallback((key) => {
    setActiveExtraKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
    setExtraMenuOpen(false);
    setBreakdownOpen(true);
    setMobileFiltersOpen(true);
  }, []);

  const removeExtraField = useCallback((key) => {
    setActiveExtraKeys((prev) => prev.filter((k) => k !== key));
    setDraftFilters((prev) => ({ ...prev, [key]: [] }));
  }, []);

  const handleRemoveChip = useCallback((chip) => {
    if (!chip?.field || chip.field === 'date' || chip.removable === false) return;
    const current = filters[chip.field] || [];
    const nextVals = current.filter((v) => v !== chip.value);
    const next = { ...cloneFilters(filters), [chip.field]: nextVals };
    setDraftFilters(next);
    if (typeof onFiltersApply === 'function') onFiltersApply(next);
    else onFilterChange?.(chip.field, nextVals);
  }, [filters, onFilterChange, onFiltersApply]);

  const handleCompareMode = useCallback((mode) => {
    onCompareModeChange?.(mode);
    if (mode === 'custom' && (!compareStart || !compareEnd)) {
      const prior = previousPeriodRange(range?.startDate, range?.endDate);
      if (prior) {
        onCompareStart?.(prior.startDate);
        onCompareEnd?.(prior.endDate);
      }
    }
  }, [onCompareModeChange, compareStart, compareEnd, range, onCompareStart, onCompareEnd]);

  const handleCopyLink = useCallback(async () => {
    const payload = typeof getSharePayload === 'function'
      ? getSharePayload()
      : {
        preset: datePreset,
        startDate: range?.startDate,
        endDate: range?.endDate,
        ...filters,
      };
    await copyReportLink(payload);
    showToast({ message: 'Link copied — opens this exact report' });
  }, [getSharePayload, datePreset, range, filters]);

  const handleApplySaved = useCallback((snapshot) => {
    const next = {};
    for (const key of dimKeyList) {
      next[key] = Array.isArray(snapshot?.[key]) ? snapshot[key] : [];
    }
    setDraftFilters(next);
    if (extraFields.length) {
      setActiveExtraKeys(fieldsWithValues(extraFields, next));
    }
    onApplySavedFilter?.(snapshot);
    if (!onApplySavedFilter) commitDimensionFilters(next);
  }, [dimKeyList, extraFields, onApplySavedFilter, commitDimensionFilters]);

  const handleApplyRecent = useCallback((item) => {
    const snapshot = applyRecentFilter(item.snapshot);
    const next = {};
    for (const key of dimKeyList) {
      next[key] = Array.isArray(snapshot[key]) ? snapshot[key] : [];
    }
    setDraftFilters(next);
    if (extraFields.length) {
      setActiveExtraKeys(fieldsWithValues(extraFields, next));
    }
    if (snapshot.startDate && snapshot.endDate) {
      setDraftStart(snapshot.startDate);
      setDraftEnd(snapshot.endDate);
    }
    onApplyRecentFilter?.(snapshot);
    if (!onApplyRecentFilter) {
      if (snapshot.preset) onDatePresetChange?.(snapshot.preset);
      if (snapshot.startDate && snapshot.endDate) {
        onRangeChange?.({ startDate: snapshot.startDate, endDate: snapshot.endDate });
      }
      commitDimensionFilters(next);
    }
  }, [dimKeyList, extraFields, onApplyRecentFilter, onDatePresetChange, onRangeChange, commitDimensionFilters]);

  useReportHotkeys({
    enabled: canUseFilters && !disabled,
    onApply: () => {
      if (customIncomplete) return;
      applyFilter();
    },
    onReset: resetAll,
  });

  const applyDisabled = disabled || !canUseFilters || customIncomplete;
  const inventoryTitle = 'Inventory filters';
  const inventoryHint = product === 'adsense'
    ? 'Site, country, platform & custom dates'
    : enableExtraFilters
      ? 'Core filters below — use Add more filter for ad units, sources & mediation'
      : 'App, format, country, platform & custom dates';
  const savedSnapshot = getSavedFilterSnapshot
    || (() => {
      const snap = {};
      for (const key of dimKeyList) snap[key] = draftFilters[key] || [];
      return snap;
    });
  const presetSnapshot = getPresetSnapshot || savedSnapshot;

  return (
    <div className="product-filter-shell">
      {showCompare ? (
        <CompareRangeBar
          mode={compareMode}
          onModeChange={handleCompareMode}
          customStart={compareStart}
          customEnd={compareEnd}
          onCustomStart={onCompareStart}
          onCustomEnd={onCompareEnd}
          disabled={disabled || !canUseFilters}
        />
      ) : null}

      {canUseFilters ? (
        <OnboardingGuide
          visible
          onPickDates={() => {
            setBreakdownOpen(true);
            setMobileFiltersOpen(true);
            panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
          onApply={() => {
            if (!customIncomplete) applyFilter();
          }}
        />
      ) : null}

      <div className="filter-card dash-overview-shell" ref={panelRef}>
        <div className="dash-date-toolbar filter-card-head-sticky">
          <div className="dash-date-display">
            <span className="dash-date-label">{presetLabel}</span>
            <span className="dash-date-range">{rangeText}</span>
          </div>
          <div className="filter-actions filter-actions--desktop">
            <button
              type="button"
              className="btn-generate"
              onClick={applyFilter}
              disabled={applyDisabled}
              title={customIncomplete ? 'Select both start and end dates, then click Apply Filter' : ''}
            >
              ✓ Apply Filter
            </button>
            {savedPage ? (
              <SavedFiltersBar
                page={savedPage}
                userId={userId}
                getSnapshot={savedSnapshot}
                onApply={handleApplySaved}
                canSave={canUseFilters}
                disabled={!canUseFilters || disabled}
              />
            ) : null}
            <button type="button" className="btn-reset" onClick={resetAll} disabled={disabled || !canUseFilters}>
              ↺ Reset
            </button>
          </div>
        </div>

        {isNarrow && (
          <div className="filter-mobile-toggle-row">
            <button
              type="button"
              className="filter-mobile-toggle"
              aria-expanded={mobileFiltersOpen}
              onClick={() => setMobileFiltersOpen((v) => !v)}
            >
              Filters{appliedChips.length ? ` (${appliedChips.length})` : ''} {mobileFiltersOpen ? '▴' : '▾'}
            </button>
            {canUseFilters ? (
              <button type="button" className="btn-reset btn-copy-link" onClick={handleCopyLink}>
                Copy link
              </button>
            ) : null}
            {presetPage && canUseFilters ? (
              <SavePresetButton
                page={presetPage}
                userId={userId}
                getSnapshot={presetSnapshot}
                disabled={!canUseFilters || disabled}
              />
            ) : null}
          </div>
        )}

        <div className={`filter-panel-body${!mobileFiltersOpen && isNarrow ? ' is-collapsed' : ''}`}>
          <div className="preset-pills dash-preset-row">
            {DATE_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`preset-pill${datePreset === p.id ? ' active' : ''}`}
                disabled={disabled || !canUseFilters}
                onClick={() => applyPreset(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>

          {datePreset === 'custom' && (
            <>
              <div className="filter-grid dash-custom-dates">
                <div className="filter-field">
                  <label htmlFor={`${product}-from`}>
                    <FilterFieldIcon name="calendar" />
                    Start Date
                  </label>
                  <input
                    id={`${product}-from`}
                    type="date"
                    value={draftStart}
                    disabled={disabled || !canUseFilters}
                    max={draftEnd || undefined}
                    onChange={(e) => {
                      setDraftStart(e.target.value);
                      onDatePresetChange?.('custom');
                    }}
                  />
                </div>
                <div className="filter-field">
                  <label htmlFor={`${product}-to`}>
                    <FilterFieldIcon name="calendar" />
                    End Date
                  </label>
                  <input
                    id={`${product}-to`}
                    type="date"
                    value={draftEnd}
                    disabled={disabled || !canUseFilters}
                    min={draftStart || undefined}
                    onChange={(e) => {
                      setDraftEnd(e.target.value);
                      onDatePresetChange?.('custom');
                    }}
                  />
                </div>
              </div>
              <div className="custom-range-hint">
                Pick <strong>start</strong> and <strong>end</strong> dates, then click <strong>Apply Filter</strong> to load data.
              </div>
            </>
          )}

          {appliedChips.length > 0 && (
            <FilterChips
              chips={appliedChips}
              expanded={chipsExpanded}
              onToggleExpand={() => setChipsExpanded((v) => !v)}
              onAddFilter={canUseFilters ? handleAddFilter : undefined}
              onRemove={canUseFilters ? handleRemoveChip : undefined}
              title="Applied filters"
            />
          )}

          {recentFilters.length > 0 && (
            <div className="dash-breakdown-section gam-report-breakdown-section" style={{ marginTop: 8 }}>
              <div className="filter-section-divider" />
              <div className="filter-section-head" style={{ marginBottom: 8 }}>
                <span className="filter-section-title">Recently used filters</span>
                <span className="filter-section-hint">Tap a saved set to reuse it</span>
              </div>
              <div className="preset-pills dash-preset-row">
                {recentFilters.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="preset-pill recent-filter-pill"
                    onClick={() => handleApplyRecent(item)}
                  >
                    <span className="recent-filter-label">{item.label}</span>
                    <span
                      className="recent-filter-close"
                      title="Remove filter"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRecentFilters(scopedRecent(removeRecentFilter(item.id, userId), product));
                      }}
                    >
                      ×
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {isNarrow && savedPage ? (
            <div className="filter-actions filter-actions--mobile-inline" style={{ marginTop: 10 }}>
              <SavedFiltersBar
                page={savedPage}
                userId={userId}
                getSnapshot={savedSnapshot}
                onApply={handleApplySaved}
                canSave={canUseFilters}
                disabled={!canUseFilters || disabled}
              />
            </div>
          ) : null}

          {breakdownOpen && canUseFilters ? (
            <div
              id={`${product}-inventory-filters`}
              className="dash-breakdown-section gam-report-breakdown-section"
            >
              <div className="filter-section-divider" />
              <div className="filter-section-head" style={{ marginBottom: 12 }}>
                <span className="filter-section-title">{inventoryTitle}</span>
                <span className="filter-section-hint">{inventoryHint}</span>
              </div>
              <div className="filter-grid">
                {visibleFields.map((f) => {
                  const isExtra = ADMOB_EXTRA_DIM_KEYS.includes(f.key);
                  return (
                    <div key={f.key} className="filter-field">
                      <label>
                        <FilterFieldIcon name={f.icon} />
                        {f.label}
                        {isExtra ? (
                          <button
                            type="button"
                            className="filter-field-remove"
                            title={`Remove ${f.label} filter`}
                            aria-label={`Remove ${f.label} filter`}
                            onClick={() => removeExtraField(f.key)}
                          >
                            ×
                          </button>
                        ) : null}
                      </label>
                      <MultiSelect
                        options={filterOptions[f.key] || []}
                        value={draftFilters[f.key] || []}
                        onChange={(v) => setDraftFilters((prev) => ({ ...prev, [f.key]: v }))}
                        placeholder={f.placeholder}
                        disabled={disabled}
                        searchable
                      />
                    </div>
                  );
                })}
              </div>
              {enableExtraFilters && availableExtraFields.length > 0 ? (
                <div className="filter-add-more" ref={extraMenuRef}>
                  <button
                    type="button"
                    className="btn-reset filter-add-more-btn"
                    onClick={() => setExtraMenuOpen((o) => !o)}
                    disabled={disabled}
                    aria-expanded={extraMenuOpen}
                    aria-haspopup="listbox"
                  >
                    + Add more filter
                  </button>
                  {extraMenuOpen ? (
                    <ul className="filter-add-more-menu" role="listbox">
                      {availableExtraFields.map((f) => (
                        <li key={f.key}>
                          <button
                            type="button"
                            role="option"
                            onClick={() => addExtraField(f.key)}
                          >
                            {f.label}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {!canUseFilters ? (
            <p className="filter-locked-note">Filters are disabled for your account.</p>
          ) : null}
        </div>

        {breakdownOpen && canUseFilters ? (
          <div className="filter-actions-foot">
            <button
              type="button"
              className="btn-generate"
              onClick={applyFilter}
              disabled={applyDisabled}
            >
              ✓ Apply Filter
            </button>
            <button type="button" className="btn-reset" onClick={resetAll} disabled={disabled}>
              ↺ Reset
            </button>
          </div>
        ) : null}
      </div>

      {canUseFilters && (
        <>
          <button type="button" className="filter-add-fab" onClick={handleAddFilter} aria-label="Add filter">
            <span className="filter-add-icon" aria-hidden>+</span>
            Add filter
          </button>
          <div className="filter-actions-foot filter-actions-foot--mobile">
            <button
              type="button"
              className="btn-generate"
              onClick={applyFilter}
              disabled={applyDisabled}
            >
              ✓ Apply Filter
            </button>
            <button type="button" className="btn-reset-link" onClick={resetAll} disabled={disabled}>
              Reset
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Persisted compare-mode state (mirrors GAM Dashboard prefs). */
export function useProductCompareState(userId) {
  const [compareMode, setCompareMode] = useState(() => loadComparePrefs(userId).mode || 'prior');
  const [compareStart, setCompareStart] = useState(() => loadComparePrefs(userId).startDate || '');
  const [compareEnd, setCompareEnd] = useState(() => loadComparePrefs(userId).endDate || '');

  useEffect(() => {
    const prefs = loadComparePrefs(userId);
    setCompareMode(prefs.mode || 'prior');
    setCompareStart(prefs.startDate || '');
    setCompareEnd(prefs.endDate || '');
  }, [userId]);

  useEffect(() => {
    saveComparePrefs(userId, { mode: compareMode, startDate: compareStart, endDate: compareEnd });
  }, [userId, compareMode, compareStart, compareEnd]);

  return {
    compareMode,
    setCompareMode,
    compareStart,
    setCompareStart,
    compareEnd,
    setCompareEnd,
  };
}
