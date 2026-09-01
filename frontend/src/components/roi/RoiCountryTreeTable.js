import React, { useMemo, useState } from 'react';
import TableSearchBar from '../ui/TableSearchBar';
import { useMedia } from '../../hooks/useMedia';
import {
  filterCountryTree,
  flattenCountryTreeForExport,
  formatRoiMoney,
  roiToneClass,
} from '../../utils/report/roiView';
import { showToast } from '../../hooks/useToast';
import { downloadCsv, downloadExcel } from '../../utils/tableExport';

const COLS = [
  { id: 'label', label: 'Country / Account / Package', type: 'dimension' },
  { id: 'date', label: 'Date', type: 'dimension' },
  { id: 'adsSpend', label: 'Ads spend', type: 'metric' },
  { id: 'earn', label: 'Earn', type: 'metric' },
  { id: 'profitSpend', label: 'Profit (spend)', type: 'metric' },
  { id: 'roiSpendPercent', label: 'ROI spend %', type: 'metric' },
];

function money(n) {
  return formatRoiMoney(n).replace(/^US\$/, '$');
}

function pct(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return `${Number(n).toFixed(1)}%`;
}

function SortHeader({ label, active, dir, onClick }) {
  return (
    <button
      type="button"
      className={`th-sort-btn${active ? ` is-sorted-${dir}` : ''}`}
      onClick={onClick}
      title={onClick ? `Sort by ${label}` : label}
    >
      <span>{label}</span>
      <span className="th-sort-icon" aria-hidden>{active ? (dir === 'asc' ? '▲' : '▼') : '⇅'}</span>
    </button>
  );
}

function TreeChevron({ open, hasChildren }) {
  if (!hasChildren) {
    return <span className="roi-tree-chevron roi-tree-chevron--spacer" aria-hidden />;
  }
  return (
    <span className={`roi-tree-chevron${open ? ' is-open' : ''}`} aria-hidden>
      ▶
    </span>
  );
}

function renderMetric(row, colId) {
  if (colId === 'adsSpend') return money(row.adsSpend);
  if (colId === 'earn') return money(row.earn);
  if (colId === 'profitSpend') return money(row.profitSpend);
  if (colId === 'roiSpendPercent') return pct(row.roiSpendPercent);
  return '—';
}

function metricCellClass(row, colId) {
  if (colId === 'profitSpend') return roiToneClass(row.profitSpend);
  if (colId === 'roiSpendPercent') return roiToneClass(row.roiSpendPercent);
  return '';
}

/**
 * Nested country → ads account → package → date table.
 * Uses the same filter-card / report-table shell as DynamicReportTable.
 */
export default function RoiCountryTreeTable({
  title = 'Ads spend by country',
  tree = [],
  loading = false,
  search = '',
  onSearchChange,
  onPageReset,
  page = 1,
  pageSize = 25,
  onPageChange,
  density = 'comfortable',
  exportName = 'roi_countries',
  emptyMessage = 'No country spend for the selected filters',
  className = 'reporting-table',
  headerExtra = null,
  emptyActions = null,
  onReset = null,
  freezeFirst = true,
  canDownload = true,
  showPagination = true,
  showTotals = true,
}) {
  const isMobile = useMedia('(max-width: 640px)');
  const [expandedCountries, setExpandedCountries] = useState(() => new Set());
  const [expandedAccounts, setExpandedAccounts] = useState(() => new Set());
  const [expandedPackages, setExpandedPackages] = useState(() => new Set());
  const [sortDir, setSortDir] = useState('desc');

  const filteredTree = useMemo(
    () => filterCountryTree(tree, search),
    [tree, search]
  );

  const sortedTree = useMemo(() => {
    const list = [...filteredTree];
    list.sort((a, b) => {
      const diff = (Number(a.adsSpend) || 0) - (Number(b.adsSpend) || 0);
      return sortDir === 'asc' ? diff : -diff;
    });
    return list;
  }, [filteredTree, sortDir]);

  const totals = useMemo(() => {
    const adsSpend = filteredTree.reduce((s, r) => s + (Number(r.adsSpend) || 0), 0);
    const earn = filteredTree.reduce((s, r) => s + (Number(r.earn) || 0), 0);
    const profitSpend = earn - adsSpend;
    const roiSpendPercent = adsSpend > 0 ? (profitSpend / adsSpend) * 100 : null;
    return { adsSpend, earn, profitSpend, roiSpendPercent };
  }, [filteredTree]);

  const totalPages = Math.max(1, Math.ceil(sortedTree.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageCountries = sortedTree.slice((safePage - 1) * pageSize, safePage * pageSize);
  const colCount = COLS.length;
  const noData = !loading && filteredTree.length === 0;
  const showEmptyPanel = noData;

  const toggleCountry = (id) => {
    setExpandedCountries((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAccount = (id) => {
    setExpandedAccounts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const togglePackage = (id) => {
    setExpandedPackages((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSort = () => {
    setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    onPageChange?.(1);
  };

  const pageNumbers = () => {
    const arr = [];
    let start = Math.max(1, safePage - 2);
    let end = Math.min(totalPages, start + 4);
    start = Math.max(1, end - 4);
    for (let i = start; i <= end; i++) arr.push(i);
    return arr;
  };

  const exportRows = () => {
    const flat = flattenCountryTreeForExport(filteredTree);
    const headers = ['Level', 'Name', 'Date', 'Ads spend', 'Earn', 'Profit (spend)', 'ROI spend %'];
    const body = flat.map((r) => [
      r.level,
      r.name,
      r.date || '',
      Number(r.adsSpend) || 0,
      Number(r.earn) || 0,
      Number(r.profitSpend) || 0,
      r.roiSpendPercent == null ? '' : Number(r.roiSpendPercent),
    ]);
    return { headers, body };
  };

  const copyTable = async () => {
    const { headers, body } = exportRows();
    const text = [
      headers.join('\t'),
      ...body.map((row) => row.map((c) => String(c).replace(/[\t\n]/g, ' ')).join('\t')),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      showToast({ message: `Copied ${body.length} row${body.length === 1 ? '' : 's'}` });
    } catch {
      showToast({ message: 'Could not copy table' });
    }
  };

  const downloadCsvFile = () => {
    const { headers, body } = exportRows();
    downloadCsv(exportName, headers, body);
    showToast({ message: `Downloaded ${body.length} row${body.length === 1 ? '' : 's'} (CSV)` });
  };

  const downloadExcelFile = () => {
    const { headers, body } = exportRows();
    downloadExcel(exportName, headers, body, title || 'Report');
    showToast({ message: `Downloaded ${body.length} row${body.length === 1 ? '' : 's'} (Excel)` });
  };

  const pagInfo = `Page ${safePage} of ${totalPages} · ${filteredTree.length.toLocaleString()} record${filteredTree.length === 1 ? '' : 's'}`;

  const tableClass = [
    'data-table',
    'responsive-table',
    'report-table',
    density === 'compact' ? 'report-table--compact' : 'report-table--comfortable',
    freezeFirst ? 'report-table--freeze-first' : '',
    'roi-country-tree-table',
    className,
  ].filter(Boolean).join(' ');

  const renderTreeRows = () => pageCountries.map((country) => {
    const countryOpen = expandedCountries.has(country.id);
    const hasAccounts = country.accountCount > 0;
    return (
      <React.Fragment key={country.id}>
        <tr className="roi-tree-row roi-tree-row--country">
          <td className="roi-tree-label" data-label={COLS[0].label}>
            <button
              type="button"
              className="roi-tree-toggle"
              onClick={() => hasAccounts && toggleCountry(country.id)}
              disabled={!hasAccounts}
              aria-expanded={hasAccounts ? countryOpen : undefined}
            >
              <TreeChevron open={countryOpen} hasChildren={hasAccounts} />
              <span className="roi-tree-label-text">{country.label}</span>
              {hasAccounts ? (
                <span className="roi-tree-badge">{country.accountCount} account{country.accountCount === 1 ? '' : 's'}</span>
              ) : null}
            </button>
          </td>
          <td data-label={COLS[1].label}>{country.dateLabel || '—'}</td>
          {COLS.slice(2).map((col) => (
            <td key={col.id} data-label={col.label} className={metricCellClass(country, col.id) || undefined}>
              {renderMetric(country, col.id)}
            </td>
          ))}
        </tr>

        {countryOpen && (country.accounts || []).map((account) => {
          const accountOpen = expandedAccounts.has(account.id);
          const hasPackages = (account.packages || []).length > 0;
          return (
            <React.Fragment key={account.id}>
              <tr className="roi-tree-row roi-tree-row--account">
                <td className="roi-tree-label" data-label={COLS[0].label}>
                  <button
                    type="button"
                    className="roi-tree-toggle roi-tree-toggle--account"
                    onClick={() => hasPackages && toggleAccount(account.id)}
                    disabled={!hasPackages}
                    aria-expanded={hasPackages ? accountOpen : undefined}
                  >
                    <TreeChevron open={accountOpen} hasChildren={hasPackages} />
                    <span className="roi-tree-label-text">{account.label}</span>
                    <span className="roi-tree-kind">Ads account</span>
                  </button>
                </td>
                <td data-label={COLS[1].label}>{account.dateLabel || '—'}</td>
                {COLS.slice(2).map((col) => (
                  <td key={col.id} data-label={col.label} className={metricCellClass(account, col.id) || undefined}>
                    {renderMetric(account, col.id)}
                  </td>
                ))}
              </tr>

              {accountOpen && (account.packages || []).map((pkg) => {
                const pkgOpen = expandedPackages.has(pkg.id);
                const hasDays = (pkg.days || []).length > 1;
                return (
                  <React.Fragment key={pkg.id}>
                    <tr className="roi-tree-row roi-tree-row--package">
                      <td className="roi-tree-label" data-label={COLS[0].label}>
                        <button
                          type="button"
                          className="roi-tree-toggle roi-tree-toggle--package"
                          onClick={() => hasDays && togglePackage(pkg.id)}
                          disabled={!hasDays}
                          aria-expanded={hasDays ? pkgOpen : undefined}
                        >
                          <TreeChevron open={pkgOpen} hasChildren={hasDays} />
                          <span className="roi-tree-label-text">{pkg.label}</span>
                          <span className="roi-tree-kind">Package</span>
                          {hasDays ? (
                            <span className="roi-tree-badge">{pkg.days.length} days</span>
                          ) : null}
                        </button>
                      </td>
                      <td data-label={COLS[1].label}>{pkg.dateLabel || '—'}</td>
                      {COLS.slice(2).map((col) => (
                        <td key={col.id} data-label={col.label} className={metricCellClass(pkg, col.id) || undefined}>
                          {renderMetric(pkg, col.id)}
                        </td>
                      ))}
                    </tr>

                    {pkgOpen && (pkg.days || []).map((day) => (
                      <tr key={day.id} className="roi-tree-row roi-tree-row--date">
                        <td className="roi-tree-label" data-label={COLS[0].label}>
                          <div className="roi-tree-toggle roi-tree-toggle--date">
                            <TreeChevron open={false} hasChildren={false} />
                            <span className="roi-tree-label-text">{day.date}</span>
                          </div>
                        </td>
                        <td data-label={COLS[1].label}>{day.date || '—'}</td>
                        {COLS.slice(2).map((col) => (
                          <td key={col.id} data-label={col.label} className={metricCellClass(day, col.id) || undefined}>
                            {renderMetric(day, col.id)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </React.Fragment>
                );
              })}
            </React.Fragment>
          );
        })}
      </React.Fragment>
    );
  });

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
              placeholder="Search country / account / package / date…"
            />
          )}
          {headerExtra}
          {filteredTree.length > 0 && (
            <button type="button" className="btn-reset table-tool-btn" onClick={copyTable}>
              Copy
            </button>
          )}
          {canDownload && filteredTree.length > 0 && (
            <>
              <button type="button" className="btn-reset table-tool-btn" onClick={downloadCsvFile}>
                CSV
              </button>
              <button type="button" className="btn-reset table-tool-btn" onClick={downloadExcelFile}>
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
            <p className="gam-report-empty-title">{emptyMessage}</p>
            <p className="gam-report-empty-hint">
              Try a different date range, or clear a filter and click Apply Filter.
            </p>
            <div className="dash-empty-actions" style={{ marginTop: 14 }}>
              {emptyActions}
              {onReset && (
                <button type="button" className="btn-reset" onClick={onReset}>
                  Reset filters
                </button>
              )}
            </div>
          </div>
        ) : isMobile && !loading && filteredTree.length > 0 ? (
          <div className="report-mobile-list">
            {pageCountries.map((country) => (
              <article key={country.id} className="report-mobile-item">
                <div className="report-mobile-item-head">
                  <p className="report-mobile-title">{country.label}</p>
                  <p className="report-mobile-sub">{country.dateLabel}</p>
                </div>
                <dl className="report-mobile-metrics">
                  {COLS.slice(2).map((col) => (
                    <div key={col.id} className="report-mobile-metric">
                      <dt>{col.label}</dt>
                      <dd className={metricCellClass(country, col.id) || undefined}>
                        {renderMetric(country, col.id)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </article>
            ))}
          </div>
        ) : (
          <table className={tableClass}>
            <thead>
              <tr>
                {COLS.map((col) => (
                  <th key={col.id}>
                    {col.id === 'adsSpend' ? (
                      <SortHeader
                        label={col.label}
                        active
                        dir={sortDir}
                        onClick={toggleSort}
                      />
                    ) : (
                      <SortHeader label={col.label} />
                    )}
                  </th>
                ))}
              </tr>
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
              ) : (
                renderTreeRows()
              )}
            </tbody>
            {showTotals && !loading && !showEmptyPanel && filteredTree.length > 0 && (
              <tfoot>
                <tr className="report-total-row">
                  <td>Total</td>
                  <td>—</td>
                  {COLS.slice(2).map((col) => (
                    <td key={col.id} className={metricCellClass(totals, col.id) || undefined}>
                      {renderMetric(totals, col.id)}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        )}
      </div>

      {showPagination && !loading && filteredTree.length > 0 && onPageChange && (
        <div className="pagination">
          <span className="pag-info">{pagInfo}</span>
          <div className="pag-btns">
            <button
              type="button"
              className="pag-btn"
              disabled={safePage === 1}
              onClick={() => onPageChange(1)}
              title="First page"
            >
              «
            </button>
            <button
              type="button"
              className="pag-btn"
              disabled={safePage <= 1}
              onClick={() => onPageChange(safePage - 1)}
              title="Previous page"
            >
              ‹
            </button>
            {pageNumbers().map((p) => (
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
              disabled={safePage >= totalPages}
              onClick={() => onPageChange(safePage + 1)}
              title="Next page"
            >
              ›
            </button>
            <button
              type="button"
              className="pag-btn"
              disabled={safePage === totalPages}
              onClick={() => onPageChange(totalPages)}
              title="Last page"
            >
              »
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
