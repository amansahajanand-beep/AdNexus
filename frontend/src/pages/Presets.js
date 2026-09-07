import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import PageHeader from '../components/ui/PageHeader';
import RoiPresetDetail from '../components/roi/RoiPresetDetail';
import DashboardPresetDetail from '../components/dashboard/DashboardPresetDetail';
import ReportingPresetDetail from '../components/reporting/ReportingPresetDetail';
import { useAuth } from '../store/useAuth';
import { usePermissions } from '../hooks/usePermissions';
import {
  PRESET_PAGES,
  PRESET_NAME_MAX,
  PRESETS_CHANGED_EVENT,
  getReportPresets,
  updateReportPreset,
  duplicateReportPreset,
  toggleReportPresetPin,
  removeReportPreset,
  summaryForPreset,
} from '../utils/reportPresets';
import { confirmDialog } from '../hooks/useConfirmDialog';
import { validateSavedName, SAVED_NAME_RULES_HINT } from '../utils/namePolicy';

const SPLIT_WIDTH_KEY = 'adnexus.presets.splitWidth';
const SPLIT_DEFAULT_PX = 280;
const SPLIT_MIN_PX = 200;
const SPLIT_HANDLE_PX = 6;

function readStoredSplitWidth() {
  try {
    const raw = localStorage.getItem(SPLIT_WIDTH_KEY);
    const n = Number(raw);
    if (Number.isFinite(n) && n >= SPLIT_MIN_PX) return Math.round(n);
  } catch {
    /* ignore */
  }
  return SPLIT_DEFAULT_PX;
}

function clampSplitWidth(px, containerWidth) {
  const max = Math.max(
    SPLIT_MIN_PX,
    Math.floor((Number(containerWidth) || 800) * 0.5)
  );
  return Math.min(max, Math.max(SPLIT_MIN_PX, Math.round(px)));
}
const SECTIONS = [
  {
    page: PRESET_PAGES.dashboard,
    label: 'Dashboard',
    access: 'dashboard',
    openLabel: 'Open in Dashboard',
    emptyPath: '/dashboard',
  },
  {
    page: PRESET_PAGES.reporting,
    label: 'Reporting',
    access: 'reporting',
    openLabel: 'Open in Reporting',
    emptyPath: '/reporting',
  },
  {
    page: PRESET_PAGES.roi,
    label: 'ROI',
    access: 'roi',
    openLabel: 'Open in ROI',
    emptyPath: '/roi',
  },
];

function formatWhen(when) {
  if (!when) return '';
  try {
    return new Date(when).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export default function Presets() {
  const { user } = useAuth();
  const { canPage } = usePermissions();
  const [searchParams, setSearchParams] = useSearchParams();
  const userId = user?.id;

  const [tick, setTick] = useState(0);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null);
  const [renameError, setRenameError] = useState('');
  const [actionError, setActionError] = useState('');
  const [compareMode, setCompareMode] = useState(false);
  const [compareId, setCompareId] = useState(null);
  const [listWidthPx, setListWidthPx] = useState(readStoredSplitWidth);
  const [isResizing, setIsResizing] = useState(false);
  const splitContainerRef = useRef(null);

  const availableSections = useMemo(
    () => SECTIONS.filter((s) => canPage(s.access)),
    [canPage]
  );

  const [selectedPage, setSelectedPage] = useState(() => {
    const pageQ = searchParams.get('page');
    if (pageQ && SECTIONS.some((s) => s.page === pageQ)) return pageQ;
    return null;
  });
  const [selectedId, setSelectedId] = useState(() => searchParams.get('id') || null);

  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    const onStorage = (e) => {
      if (e.key && String(e.key).startsWith('reportPresets_v1')) reload();
    };
    const onChanged = () => reload();
    window.addEventListener('storage', onStorage);
    window.addEventListener(PRESETS_CHANGED_EVENT, onChanged);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(PRESETS_CHANGED_EVENT, onChanged);
    };
  }, [reload]);

  // Resolve selected page from URL or first available
  useEffect(() => {
    if (!availableSections.length) {
      setSelectedPage(null);
      return;
    }
    const pageQ = searchParams.get('page');
    if (pageQ && availableSections.some((s) => s.page === pageQ)) {
      setSelectedPage(pageQ);
      return;
    }
    setSelectedPage((prev) => {
      if (prev && availableSections.some((s) => s.page === prev)) return prev;
      return availableSections[0].page;
    });
  }, [availableSections, searchParams]);

  const activeSection = availableSections.find((s) => s.page === selectedPage) || availableSections[0];

  const items = useMemo(() => {
    if (!activeSection) return [];
    const needle = search.trim().toLowerCase();
    let list = getReportPresets(activeSection.page, userId);
    if (needle) {
      list = list.filter((item) => {
        const hay = `${item.name} ${item.summary || summaryForPreset(item.snapshot)}`.toLowerCase();
        return hay.includes(needle);
      });
    }
    return list;
  }, [activeSection, userId, search, tick]);

  // Deep-link + auto-select first preset for active page
  useEffect(() => {
    if (!activeSection) return;
    const pageQ = searchParams.get('page');
    const idQ = searchParams.get('id');
    const all = getReportPresets(activeSection.page, userId);
    if (pageQ === activeSection.page && idQ && all.some((i) => i.id === idQ)) {
      setSelectedId(idQ);
      return;
    }
    setSelectedId((prev) => {
      if (prev && all.some((i) => i.id === prev)) return prev;
      return all[0]?.id || null;
    });
  }, [activeSection, searchParams, userId, tick]);

  const selectedItem = useMemo(
    () => items.find((i) => i.id === selectedId) || null,
    [items, selectedId]
  );

  const compareItem = useMemo(() => {
    if (!compareMode || !compareId || activeSection?.page !== PRESET_PAGES.roi) return null;
    return items.find((i) => i.id === compareId) || null;
  }, [compareMode, compareId, items, activeSection?.page]);

  // Leaving ROI (or losing B) clears compare mode.
  useEffect(() => {
    if (activeSection?.page !== PRESET_PAGES.roi) {
      setCompareMode(false);
      setCompareId(null);
    }
  }, [activeSection?.page]);

  useEffect(() => {
    if (!compareMode) return;
    if (compareId && !items.some((i) => i.id === compareId)) {
      setCompareId(null);
    }
  }, [compareMode, compareId, items]);

  const totalCount = useMemo(
    () => availableSections.reduce((n, s) => n + getReportPresets(s.page, userId).length, 0),
    [availableSections, userId, tick]
  );
  const pinnedCount = useMemo(
    () => availableSections.reduce(
      (n, s) => n + getReportPresets(s.page, userId).filter((i) => i.pinned).length,
      0
    ),
    [availableSections, userId, tick]
  );

  useEffect(() => {
    try {
      localStorage.setItem(SPLIT_WIDTH_KEY, String(listWidthPx));
    } catch {
      /* ignore */
    }
  }, [listWidthPx]);

  const onSplitPointerDown = useCallback((e) => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    const container = splitContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    setIsResizing(true);

    const onMove = (ev) => {
      const next = clampSplitWidth(ev.clientX - rect.left, rect.width);
      setListWidthPx(next);
    };
    const onUp = () => {
      setIsResizing(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, []);

  const selectPage = (page) => {
    setSelectedPage(page);
    setCompareMode(false);
    setCompareId(null);
    setActionError('');
    const first = getReportPresets(page, userId)[0];
    const id = first?.id || null;
    setSelectedId(id);
    if (id) setSearchParams({ page, id }, { replace: true });
    else setSearchParams({ page }, { replace: true });
  };

  const selectPreset = (item) => {
    if (!activeSection) return;
    if (
      compareMode
      && activeSection.page === PRESET_PAGES.roi
      && selectedId
      && item.id !== selectedId
    ) {
      setCompareId(item.id);
      setActionError('');
      return;
    }
    setSelectedId(item.id);
    if (compareMode && item.id === selectedId) {
      /* keep A */
    } else if (compareMode) {
      setCompareId(null);
    }
    setSearchParams({ page: activeSection.page, id: item.id }, { replace: true });
  };

  const exitCompare = () => {
    setCompareMode(false);
    setCompareId(null);
  };

  const startCompare = () => {
    if (activeSection?.page !== PRESET_PAGES.roi || !selectedItem) return;
    setCompareMode(true);
    setCompareId(null);
    setActionError('');
  };

  const duplicatePreset = (item) => {
    if (!activeSection || !item) return;
    setActionError('');
    const result = duplicateReportPreset(activeSection.page, item.id, userId);
    if (!result.ok) {
      setActionError(result.error || 'Could not duplicate preset.');
      return;
    }
    reload();
    const created = result.preset;
    if (created?.id) {
      setSelectedId(created.id);
      setSearchParams({ page: activeSection.page, id: created.id }, { replace: true });
      if (compareMode) {
        setCompareId(null);
      }
    }
  };

  const startRename = (item) => {
    if (!activeSection) return;
    setRenameError('');
    setEditing({ page: activeSection.page, id: item.id, name: item.name || '' });
  };

  const cancelRename = () => {
    setEditing(null);
    setRenameError('');
  };

  const confirmRename = (e) => {
    e?.preventDefault?.();
    if (!editing) return;
    const trimmed = String(editing.name || '').trim();
    const nameCheck = validateSavedName(trimmed, {
      maxLength: PRESET_NAME_MAX,
      label: 'Preset name',
    });
    if (!nameCheck.valid) {
      setRenameError(nameCheck.errors[0]);
      return;
    }
    updateReportPreset(editing.page, editing.id, { name: trimmed }, userId);
    cancelRename();
    reload();
  };

  const togglePin = (item) => {
    if (!activeSection) return;
    toggleReportPresetPin(activeSection.page, item.id, userId);
    reload();
  };

  const deletePreset = async (item) => {
    if (!activeSection) return;
    const ok = await confirmDialog({
      title: 'Delete preset?',
      message: `Delete preset “${item.name}”?`,
    });
    if (!ok) return;
    removeReportPreset(activeSection.page, item.id, userId);
    if (editing?.id === item.id) cancelRename();
    if (compareId === item.id) setCompareId(null);
    if (selectedId === item.id) {
      setSelectedId(null);
      setCompareMode(false);
      setCompareId(null);
      setSearchParams({ page: activeSection.page }, { replace: true });
    }
    reload();
  };

  const detailProps = selectedItem
    ? {
      presetItem: selectedItem,
      compareItem,
      compareMode: compareMode && activeSection?.page === PRESET_PAGES.roi,
      onPin: () => togglePin(selectedItem),
      onRename: () => startRename(selectedItem),
      onDelete: () => deletePreset(selectedItem),
      onDuplicate: () => duplicatePreset(selectedItem),
      onExitCompare: exitCompare,
    }
    : { presetItem: null };

  return (
    <div className="dashboard-page presets-page">
      <PageHeader
        title="Presets"
        subtitle="Saved filter combos — pick a date range on the right to preview data."
        summary={totalCount
          ? `${totalCount} saved${pinnedCount ? ` · ${pinnedCount} pinned` : ''}`
          : null}
      />

      <div className="filter-card presets-clarify-card">
        <p className="form-note" style={{ margin: 0 }}>
          Use <strong>Save preset</strong> on Dashboard, Reporting, or ROI to save filters only.
          Click a preset here, change the date range (same as Dashboard), and preview overview + table.
          <strong> Open in …</strong> opens the full page with your current dates and filters applied.
        </p>
      </div>

      <div className="filter-card" style={{ marginBottom: 16 }}>
        <label className="ui-field" style={{ maxWidth: 360, margin: 0 }}>
          <span className="ui-field-label">Search presets</span>
          <input
            className="ui-field-input"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name or filters…"
          />
        </label>
      </div>

      {availableSections.length === 0 ? (
        <div className="warn-card" role="status">
          <div className="warn-card-main">
            <div className="warn-card-left">
              <div className="warn-card-icon-wrap"><span aria-hidden>i</span></div>
              <div className="warn-card-body">
                <div className="warn-card-title">No pages available</div>
                <div className="warn-card-desc">
                  Presets need Dashboard, Reporting, or ROI access.
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div
          ref={splitContainerRef}
          className={`presets-master-detail filter-card${isResizing ? ' is-resizing' : ''}`}
          style={{
            '--presets-list-width': `${listWidthPx}px`,
            '--presets-split-handle': `${SPLIT_HANDLE_PX}px`,
          }}
        >
          <div className="presets-master-list">
            <div className="presets-page-tabs" role="tablist" aria-label="Preset pages">
              {availableSections.map((s) => (
                <button
                  key={s.page}
                  type="button"
                  role="tab"
                  aria-selected={activeSection?.page === s.page}
                  className={`presets-page-tab${activeSection?.page === s.page ? ' active' : ''}`}
                  onClick={() => selectPage(s.page)}
                >
                  {s.label}
                </button>
              ))}
            </div>

            <div className="filter-section-head" style={{ marginTop: 12 }}>
              <span className="filter-section-title">{activeSection?.label}</span>
              <span className="filter-section-hint">
                {items.length
                  ? `${items.length} preset${items.length === 1 ? '' : 's'}`
                  : 'None yet'}
              </span>
            </div>

            {activeSection?.page === PRESET_PAGES.roi && items.length > 0 ? (
              <div className="presets-compare-toolbar">
                {compareMode ? (
                  <>
                    <span className="form-note" style={{ margin: 0 }}>
                      {compareId
                        ? 'Comparing A vs B — click another preset to change B.'
                        : 'Click another preset to set B.'}
                    </span>
                    <button type="button" className="btn-reset" onClick={exitCompare}>
                      Exit compare
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn-reset"
                    disabled={!selectedItem || items.length < 2}
                    title={items.length < 2 ? 'Need at least two ROI presets to compare' : 'Compare two presets'}
                    onClick={startCompare}
                  >
                    Compare
                  </button>
                )}
              </div>
            ) : null}

            {actionError ? (
              <div className="login-error" style={{ marginTop: 8 }} role="alert">{actionError}</div>
            ) : null}

            {items.length === 0 ? (
              <p className="form-note" style={{ marginTop: 8 }}>
                On {activeSection?.label}, click <strong>Save preset</strong>.
                {' '}
                <Link to={activeSection?.emptyPath || '/'}>Open {activeSection?.label}</Link>
              </p>
            ) : (
              <ul className="presets-list">
                {items.map((item) => {
                  const isEditing = editing?.page === activeSection.page && editing?.id === item.id;
                  const isSelected = item.id === selectedId;
                  const isCompareB = compareMode && item.id === compareId;
                  const roleBadge = isSelected && compareMode
                    ? 'A'
                    : (isCompareB ? 'B' : null);
                  return (
                    <li
                      key={item.id}
                      className={`presets-item${item.pinned ? ' is-pinned' : ''}${isSelected ? ' is-selected' : ''}${isCompareB ? ' is-compare-b' : ''}`}
                    >
                      {isEditing ? (
                        <form className="presets-item-edit" onSubmit={confirmRename}>
                          <input
                            className="ui-field-input"
                            type="text"
                            value={editing.name}
                            maxLength={PRESET_NAME_MAX}
                            autoFocus
                            onChange={(e) => {
                              setEditing((prev) => ({
                                ...prev,
                                name: e.target.value.slice(0, PRESET_NAME_MAX),
                              }));
                              if (renameError) setRenameError('');
                            }}
                          />
                          <div className="presets-item-edit-meta">
                            {String(editing.name || '').trim().length}/{PRESET_NAME_MAX}
                            {renameError ? <span className="presets-rename-error">{renameError}</span> : null}
                          </div>
                          <p className="form-note presets-rename-rules">{SAVED_NAME_RULES_HINT}</p>
                          <div className="presets-item-actions">
                            <button type="button" className="btn-reset" onClick={cancelRename}>Cancel</button>
                            <button type="submit" className="btn-generate">Save name</button>
                          </div>
                        </form>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="presets-item-body presets-item-select"
                            onClick={() => selectPreset(item)}
                          >
                            <div className="presets-item-name">
                              {roleBadge ? (
                                <span className={`presets-compare-badge${roleBadge === 'B' ? ' is-b' : ''}`}>
                                  {roleBadge}
                                </span>
                              ) : null}
                              {item.pinned ? <span className="presets-pin-badge" title="Pinned">★</span> : null}
                              {item.name}
                            </div>
                            <div className="presets-item-summary">
                              {item.summary || summaryForPreset(item.snapshot)}
                            </div>
                            {item.when ? (
                              <div className="presets-item-when">Updated {formatWhen(item.when)}</div>
                            ) : null}
                          </button>
                          <div className="presets-item-actions">
                            <button
                              type="button"
                              className="btn-generate"
                              onClick={() => selectPreset(item)}
                            >
                              {compareMode && item.id !== selectedId ? 'Set as B' : 'View'}
                            </button>
                            <button
                              type="button"
                              className={`btn-reset${item.pinned ? ' presets-pin-active' : ''}`}
                              onClick={() => togglePin(item)}
                              title={item.pinned ? 'Unpin' : 'Pin favorite'}
                            >
                              {item.pinned ? 'Unpin' : 'Pin'}
                            </button>
                            <button
                              type="button"
                              className="btn-reset"
                              onClick={() => duplicatePreset(item)}
                            >
                              Duplicate
                            </button>
                            <button
                              type="button"
                              className="btn-reset"
                              onClick={() => startRename(item)}
                            >
                              Rename
                            </button>
                            <button
                              type="button"
                              className="btn-reset"
                              onClick={() => deletePreset(item)}
                            >
                              Delete
                            </button>
                          </div>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div
            className="presets-split-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize presets list"
            aria-valuenow={listWidthPx}
            tabIndex={0}
            onPointerDown={onSplitPointerDown}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
              e.preventDefault();
              const container = splitContainerRef.current;
              const width = container?.getBoundingClientRect().width || 800;
              const delta = e.key === 'ArrowLeft' ? -16 : 16;
              setListWidthPx((prev) => clampSplitWidth(prev + delta, width));
            }}
          >
            <span className="presets-split-handle-grip" aria-hidden />
          </div>

          <div className="presets-master-detail-pane">
            {activeSection?.page === PRESET_PAGES.dashboard ? (
              <DashboardPresetDetail {...detailProps} />
            ) : null}
            {activeSection?.page === PRESET_PAGES.reporting ? (
              <ReportingPresetDetail {...detailProps} />
            ) : null}
            {activeSection?.page === PRESET_PAGES.roi ? (
              <RoiPresetDetail {...detailProps} />
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
