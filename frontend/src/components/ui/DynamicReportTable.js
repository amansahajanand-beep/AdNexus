import React, { useMemo, useState } from 'react';
import TableSearchBar from './TableSearchBar';
import { filterRowsBySearch } from '../../utils/tableSearch';
import {
  buildReportColumns,
  formatCellValue,
  aggregateColumn,
  rowSearchText,
} from '../../utils/dynamicReportTable';
import { sortRowsByColumn } from '../../utils/enrichReportRows';

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
}) {
  const columns = useMemo(
    () => buildReportColumns(dimensions, metrics, visibility),
    [dimensions, metrics, visibility]
  );

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
        </div>
      </div>
      <div className="table-wrap">
        {showEmptyPanel && !loading ? (
          <div className="gam-report-empty">
            <div className="gam-report-empty-icon" aria-hidden>📊</div>
            <p className="gam-report-empty-title">
              {noReport ? noReportMessage : emptyMessage}
            </p>
            <p className="gam-report-empty-hint">
              {noReport
                ? 'Use "Select dimensions and metrics" and "Add filter" above, then apply filters.'
                : 'Try adjusting your date range or filters, then click Apply Filter again.'}
            </p>
            {!noReport && onReset && (
              <button
                type="button"
                className="btn-reset gam-empty-reset-btn"
                onClick={onReset}
                style={{
                  marginTop: 16, padding: '9px 28px', borderRadius: 40,
                  background: '#1a73e8', color: '#fff', border: 'none',
                  fontSize: 13, fontWeight: 600, cursor: 'pointer',
                }}
              >
                ↺ Reset Filters
              </button>
            )}
          </div>
        ) : (
        <table className={`data-table responsive-table report-table ${className}`}>
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
