import React, { useEffect, useMemo, useRef, useState } from 'react';
import TableSearchBar from './TableSearchBar';
import { filterRowsBySearch } from '../../utils/tableSearch';
import {
  buildReportColumns,
  formatCellValue,
  aggregateColumn,
  rowSearchText,
} from '../../utils/dynamicReportTable';
import { sortRowsByColumn } from '../../utils/enrichReportRows';
import { useMedia } from '../../hooks/useMedia';
import { showToast } from '../../hooks/useToast';
import { downloadCsv, downloadExcel, exportCellValue } from '../../utils/tableExport';

/**
 * GAM-style table — columns driven by selected dimensions & metrics.
 * Supports client-side pagination (default) or server cursor pagination.
 */
export default function DynamicReportTable({
  title = 'Report Data',
  rows = [],
  dimensions = [],
  metrics = [],
  visibility = {},
  currency = 'USD',
  loading = false,
  search = '',
  onSearchChange,
  onPageReset,
  searchPlaceholder = 'Search report…',
  page = 1,
  pageSize = 50,
  onPageChange,
  serverPaginated = false,
  pagination = null,
  onNextPage,
  onPrevPage,
  sortColumn: controlledSortColumn = null,
  sortDir: controlledSortDir = 'asc',
  onSortChange,
  showTotals = true,
  summaryTotals = null,
  showPagination = true,
  emptyMessage = 'No records found for the selected filters',
  noReportMessage = 'Select dimensions and metrics in the report builder, then click Apply Filter.',
  className = 'reporting-table',
  headerExtra = null,
  onReset = null,
  emptyActions = null,
  density = 'comfortable',
  freezeFirst = false,
  columnStorageKey = '',
  canDownload = true,
  exportName = 'report',
}) {
  const isMobile = useMedia('(max-width: 640px)');
  const allColumns = useMemo(
    () => buildReportColumns(dimensions, metrics, visibility),
    [dimensions, metrics, visibility]
  );
  const [hiddenIds, setHiddenIds] = useState(() => {
    if (!columnStorageKey) return [];
    try {
      const raw = localStorage.getItem(`adnexus.tableCols:${columnStorageKey}`);
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const [colsOpen, setColsOpen] = useState(false);
  const colsRef = useRef(null);

  useEffect(() => {
    if (!columnStorageKey) return;
    try {
      localStorage.setItem(`adnexus.tableCols:${columnStorageKey}`, JSON.stringify(hiddenIds));
    } catch {
      /* ignore */
    }
  }, [hiddenIds, columnStorageKey]);

  useEffect(() => {
    if (!colsOpen) return undefined;
    const onDoc = (e) => {
      if (colsRef.current && !colsRef.current.contains(e.target)) setColsOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [colsOpen]);

  const columns = useMemo(() => {
    const visible = allColumns.filter((c) => !hiddenIds.includes(c.id));
    return visible.length ? visible : allColumns;
  }, [allColumns, hiddenIds]);

  const [localSortColumn, setLocalSortColumn] = useState(null);
  const [localSortDir, setLocalSortDir] = useState('asc');

  const sortColumn = serverPaginated ? controlledSortColumn : localSortColumn;
  const sortDir = serverPaginated ? controlledSortDir : localSortDir;

  const handleSort = (colId) => {
    if (serverPaginated && onSortChange) {
      const nextDir = sortColumn === colId && sortDir === 'asc' ? 'desc' : 'asc';
      onSortChange(colId, nextDir);
      onPageChange?.(1);
      return;
    }
    if (localSortColumn === colId) {
      setLocalSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setLocalSortColumn(colId);
      setLocalSortDir('asc');
    }
    onPageChange?.(1);
  };

  const noReport = columns.length === 0;
  const noData = !loading && rows.length === 0;
  const showEmptyPanel = noReport || noData;
  const colCount = Math.max(columns.length, 1);
  const dimColumns = useMemo(
    () => columns.filter((c) => c.type === 'dimension'),
    [columns]
  );
  const metricColumns = useMemo(
    () => columns.filter((c) => c.type === 'metric'),
    [columns]
  );
  const useCompactList = isMobile && columns.length > 0 && !showEmptyPanel;

  const renderCompactItem = (row, i) => {
    const titleCols = dimColumns.length ? dimColumns.slice(0, 2) : columns.slice(0, 1);
    const extraDims = dimColumns.slice(2);
    const stats = metricColumns.length ? metricColumns : columns.filter((c) => !titleCols.includes(c));
    return (
      <article key={i} className="report-mobile-item">
        <div className="report-mobile-item-head">
          <p className="report-mobile-title">
            {titleCols.map((col) => renderCell(row, col)).filter(Boolean).join(' · ') || '—'}
          </p>
          {extraDims.length > 0 && (
            <p className="report-mobile-sub">
              {extraDims.map((col) => renderCell(row, col)).filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
        {stats.length > 0 && (
          <dl className="report-mobile-metrics">
            {stats.map((col) => (
              <div key={col.id} className="report-mobile-metric">
                <dt>{col.label}</dt>
                <dd>{renderCell(row, col)}</dd>
              </div>
            ))}
          </dl>
        )}
      </article>
    );
  };

  const sortedRows = useMemo(() => {
    if (serverPaginated || !sortColumn) return rows;
    return sortRowsByColumn(rows, columns, sortColumn, sortDir);
  }, [rows, columns, sortColumn, sortDir, serverPaginated]);

  const filteredRows = useMemo(
    () => filterRowsBySearch(sortedRows, search, (r) => [rowSearchText(r, columns)]),
    [sortedRows, search, columns]
  );

  const totalRows = serverPaginated
    ? (pagination?.totalRows ?? filteredRows.length)
    : filteredRows.length;
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = serverPaginated
    ? filteredRows
    : filteredRows.slice((safePage - 1) * pageSize, safePage * pageSize);

  const pageNumbers = () => {
    const arr = [];
    let start = Math.max(1, safePage - 2);
    let end = Math.min(totalPages, start + 4);
    start = Math.max(1, end - 4);
    for (let i = start; i <= end; i++) arr.push(i);
    return arr;
  };

  const money = (v, cur) => {
    const sym = cur === 'INR' ? '\u20B9' : '$';
    const numVal = parseFloat(v || 0);
    return `${sym}${numVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };
  const num = (v) => parseInt(v || 0, 10).toLocaleString();

  const copyTable = async () => {
    const header = columns.map((c) => c.label).join('\t');
    const body = filteredRows.slice(0, 2000).map((row) => columns
      .map((c) => String(formatCellValue(c.getValue(row), c.format, currency, money, num)).replace(/[\t\n]/g, ' '))
      .join('\t'));
    const text = [header, ...body].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      showToast({ message: `Copied ${body.length} row${body.length === 1 ? '' : 's'}` });
    } catch {
      showToast({ message: 'Could not copy table' });
    }
  };

  const exportRows = () => {
    const headers = columns.map((c) => c.label);
    const body = filteredRows.slice(0, 10000).map((row) => columns.map((c) => exportCellValue(c, row)));
    return { headers, body };
  };

  const downloadTableCsv = () => {
    const { headers, body } = exportRows();
    downloadCsv(exportName, headers, body);
    showToast({ message: `Downloaded ${body.length} row${body.length === 1 ? '' : 's'} (CSV)` });
  };

  const downloadTableExcel = () => {
    const { headers, body } = exportRows();
    downloadExcel(exportName, headers, body, title || 'Report');
    showToast({ message: `Downloaded ${body.length} row${body.length === 1 ? '' : 's'} (Excel)` });
  };

  const toggleColumn = (id) => {
    setHiddenIds((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      return allColumns.some((c) => !next.includes(c.id)) ? next : prev;
    });
  };

  const renderCell = (row, col) => {
    const raw = col.getValue(row);
    return formatCellValue(raw, col.format, currency, money, num);
  };

  const renderTotalCell = (col) => {
    if (summaryTotals && col.type === 'metric' && summaryTotals[col.id] != null) {
      const v = Number(summaryTotals[col.id]);
      if (Number.isFinite(v)) {
        return formatCellValue(v, col.format, currency, money, num);
      }
    }
    const raw = aggregateColumn(filteredRows, col);
    if (raw === '—' || raw === 'Total') return raw;
    return formatCellValue(raw, col.format, currency, money, num);
  };

  const pagInfo = serverPaginated && pagination
    ? (() => {
        const start = (pagination.offset || 0) + 1;
        const end = Math.min((pagination.offset || 0) + pageRows.length, totalRows);
        return `Showing ${start}–${end} of ${totalRows.toLocaleString()} records`;
      })()
    : (pagination?.truncated && pagination?.totalRows > filteredRows.length
      ? `Page ${safePage} of ${totalPages} · ${filteredRows.length.toLocaleString()} of ${Number(pagination.totalRows).toLocaleString()} records`
      : `Page ${safePage} of ${totalPages} · ${filteredRows.length.toLocaleString()} records`);

  const canGoPrev = serverPaginated
    ? Boolean(pagination?.prevCursor) || (pagination?.offset || 0) > 0
    : safePage > 1;
  const canGoNext = serverPaginated
    ? Boolean(pagination?.hasMore)
    : safePage < totalPages;

  return (
    <div className="filter-card">
      <div className="filter-card-head">
        <span className="filter-card-title">{title}</span>
        <div className="filter-actions">
          {onSearchChange && (
            <TableSearchBar
              value={search}
              onChange={onSearchChange}
              onPageReset={onPageReset}
              placeholder={searchPlaceholder}
            />
          )}
          {headerExtra}
          {allColumns.length > 0 && (
            <div className="table-col-picker" ref={colsRef}>
              <button
                type="button"
                className="btn-reset table-tool-btn"
                onClick={() => setColsOpen((v) => !v)}
                aria-expanded={colsOpen}
              >
                Columns
              </button>
              {colsOpen && (
                <div className="table-col-menu" role="menu">
                  {allColumns.map((col) => (
                    <label key={col.id} className="table-col-item">
                      <input
                        type="checkbox"
                        checked={!hiddenIds.includes(col.id)}
                        onChange={() => toggleColumn(col.id)}
                      />
                      {col.label}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
          {filteredRows.length > 0 && (
            <button type="button" className="btn-reset table-tool-btn" onClick={copyTable}>
              Copy
            </button>
          )}
          {canDownload && filteredRows.length > 0 && (
            <>
              <button type="button" className="btn-reset table-tool-btn" onClick={downloadTableCsv}>
                CSV
              </button>
              <button type="button" className="btn-reset table-tool-btn" onClick={downloadTableExcel}>
                Excel
              </button>
            </>
          )}
        </div>
      </div>
      <div className="table-wrap">
        {showEmptyPanel && !loading ? (
          <div className="gam-report-empty">
            <div className="gam-report-empty-icon" aria-hidden>—</div>
            <p className="gam-report-empty-title">
              {noReport ? noReportMessage : emptyMessage}
            </p>
            <p className="gam-report-empty-hint">
              {noReport
                ? 'Use "Select dimensions and metrics" and "Add filter" above, then apply filters.'
                : 'Try a different date range, or clear a filter and click Apply Filter.'}
            </p>
            <div className="dash-empty-actions" style={{ marginTop: 14 }}>
              {emptyActions}
              {!noReport && onReset && (
                <button type="button" className="btn-reset" onClick={onReset}>
                  Reset filters
                </button>
              )}
            </div>
          </div>
        ) : useCompactList ? (
          <div className="report-mobile-list">
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="report-mobile-item">
                  <div className="skeleton" style={{ height: 14, width: '70%', marginBottom: 10 }} />
                  <div className="report-mobile-metrics">
                    {Array.from({ length: 4 }).map((_, j) => (
                      <div key={j} className="skeleton" style={{ height: 28 }} />
                    ))}
                  </div>
                </div>
              ))
            ) : pageRows.length === 0 ? (
              <p className="report-mobile-empty">
                {search.trim() ? 'No records match your search' : emptyMessage}
              </p>
            ) : (
              <>
                {pageRows.map((row, i) => renderCompactItem(row, i))}
                {showTotals && !serverPaginated && filteredRows.length > 0 && (
                  <div className="report-mobile-item report-mobile-totals">
                    <p className="report-mobile-title">Total</p>
                    <dl className="report-mobile-metrics">
                      {(metricColumns.length ? metricColumns : columns.slice(1)).map((col) => (
                        <div key={col.id} className="report-mobile-metric">
                          <dt>{col.label}</dt>
                          <dd>{renderTotalCell(col)}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
        <table className={[
          'data-table',
          'responsive-table',
          'report-table',
          density === 'compact' ? 'report-table--compact' : 'report-table--comfortable',
          freezeFirst ? 'report-table--freeze-first' : '',
          className,
        ].filter(Boolean).join(' ')}>
          <thead>
            {columns.length > 0 && (
              <tr>
                {columns.map((col) => (
                  <th key={col.id}>
                    <button
                      type="button"
                      className={`th-sort-btn ${sortColumn === col.id ? `is-sorted-${sortDir}` : ''}`}
                      onClick={() => handleSort(col.id)}
                      title={`Sort by ${col.label}`}
                    >
                      <span>{col.label}</span>
                      <span className="th-sort-icon" aria-hidden>
                        {sortColumn === col.id ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}
                      </span>
                    </button>
                  </th>
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: colCount }).map((_, j) => (
                    <td key={j} data-label="">
                      <div className="skeleton" style={{ height: 16 }} />
                    </td>
                  ))}
                </tr>
              ))
            ) : pageRows.length === 0 ? (
              <tr>
                <td colSpan={colCount} style={{ textAlign: 'center', color: '#888', padding: 40 }}>
                  {search.trim() ? 'No records match your search' : emptyMessage}
                </td>
              </tr>
            ) : (
              pageRows.map((row, i) => (
                <tr key={i}>
                  {columns.map((col) => (
                    <td
                      key={col.id}
                      data-label={col.label}
                      className={col.cellClass || undefined}
                    >
                      {renderCell(row, col)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
          {showTotals && !serverPaginated && !showEmptyPanel && !loading && filteredRows.length > 0 && (
            <tfoot>
              <tr className="report-total-row">
                {columns.map((col, idx) => (
                  <td key={col.id}>
                    {idx === 0 && col.aggregate === 'label' ? 'Total' : renderTotalCell(col)}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
        )}
      </div>

      {showPagination && !loading && (serverPaginated ? totalRows > 0 : filteredRows.length > 0) && (
        serverPaginated ? onNextPage && onPrevPage : onPageChange
      ) && (
        <div className="pagination">
          <span className="pag-info">{pagInfo}</span>
          <div className="pag-btns">
            {/* First page */}
            {!serverPaginated && (
              <button
                type="button"
                className="pag-btn"
                disabled={safePage === 1}
                onClick={() => onPageChange(1)}
                title="First page"
              >
                «
              </button>
            )}
            <button
              type="button"
              className="pag-btn"
              disabled={!canGoPrev}
              onClick={() => (serverPaginated ? onPrevPage() : onPageChange(safePage - 1))}
              title="Previous page"
            >
              ‹
            </button>
            {!serverPaginated && pageNumbers().map((p) => (
              <button
                key={p}
                type="button"
                className={`pag-btn ${safePage === p ? 'active' : ''}`}
                onClick={() => onPageChange(p)}
              >
                {p}
              </button>
            ))}
            <button
              type="button"
              className="pag-btn"
              disabled={!canGoNext}
              onClick={() => (serverPaginated ? onNextPage() : onPageChange(safePage + 1))}
              title="Next page"
            >
              ›
            </button>
            {/* Last page */}
            {!serverPaginated && (
              <button
                type="button"
                className="pag-btn"
                disabled={safePage === totalPages}
                onClick={() => onPageChange(totalPages)}
                title="Last page"
              >
                »
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
