import React, { useCallback, useEffect, useMemo, useState } from 'react';
import PageHeader from './ui/PageHeader';
import DynamicReportTable from './ui/DynamicReportTable';
import { adsAPI, roiAPI } from '../utils/api';
import { DATE_PRESETS } from '../utils/gamReportCatalog';
import {
  getDateRestriction,
  clampPresetRange,
  defaultReportRangeForUser,
  allowedDatePresets,
  isCustomRangeIncomplete,
  isFixedDateRestriction,
  formatDateRestrictionLabel,
  clampDateValue,
} from '../utils/dateRestriction';
import { useAuth } from '../store/useAuth';
import { nowTimeInTZ } from '../utils/datetime';
import { getUserFacingMessage, logErrorForDebug } from '../utils/userFacingError';
import { useMedia } from '../hooks/useMedia';

const PAGE_SIZE = 50;

function money(n) {
  const v = Number(n) || 0;
  return `US$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pct(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return `${Number(n).toFixed(1)}%`;
}

function roiTone(n) {
  if (n == null || Number.isNaN(Number(n))) return '';
  return Number(n) >= 0 ? 'roi-pos' : 'roi-neg';
}

function emptyExpenseSlot() {
  return {
    amount: '',
    label: '',
    targetType: 'general',
    targetKey: '',
    notes: '',
  };
}

const TARGET_FILTERS = [
  { id: 'all', label: 'Both' },
  { id: 'site', label: 'Site' },
  { id: 'app', label: 'App' },
];

export default function Roi() {
  const { user } = useAuth();
  const dateRestriction = useMemo(() => getDateRestriction(user), [user]);
  const dateFilterLocked = isFixedDateRestriction(dateRestriction);
  const presetOptions = useMemo(
    () => (dateFilterLocked ? [] : allowedDatePresets(dateRestriction, DATE_PRESETS)),
    [dateRestriction, dateFilterLocked]
  );
  const todayInit = useMemo(() => defaultReportRangeForUser(user), [user]);

  const [preset, setPreset] = useState('today');
  const [startDate, setStartDate] = useState(() => {
    const r = clampPresetRange('today', getDateRestriction(user));
    return r?.startDate || todayInit.startDate;
  });
  const [endDate, setEndDate] = useState(() => {
    const r = clampPresetRange('today', getDateRestriction(user));
    return r?.endDate || todayInit.endDate;
  });
  const [applied, setApplied] = useState(() => {
    const r = clampPresetRange('today', getDateRestriction(user));
    return {
      startDate: r?.startDate || todayInit.startDate,
      endDate: r?.endDate || todayInit.endDate,
      targetType: 'all',
    };
  });
  const [targetType, setTargetType] = useState('all');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [filtersOpen, setFiltersOpen] = useState(true);

  const [showExpense, setShowExpense] = useState(false);
  const [expenseSharedDate, setExpenseSharedDate] = useState(() => endDate);
  const [expense1, setExpense1] = useState(emptyExpenseSlot);
  const [expense2, setExpense2] = useState(emptyExpenseSlot);
  const [expenseBusy, setExpenseBusy] = useState(false);

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [tableDensity, setTableDensity] = useState(() => {
    try {
      return localStorage.getItem('adnexus.tableDensity:roi') === 'compact' ? 'compact' : 'comfortable';
    } catch {
      return 'comfortable';
    }
  });
  const isNarrow = useMedia('(max-width: 768px)');

  useEffect(() => {
    try {
      localStorage.setItem('adnexus.tableDensity:roi', tableDensity);
    } catch {
      /* ignore */
    }
  }, [tableDensity]);

  const customDatesIncomplete = isCustomRangeIncomplete(preset, startDate, endDate);
  const presetLabel = useMemo(
    () => DATE_PRESETS.find((p) => p.id === preset)?.label || 'Custom',
    [preset]
  );

  const filterSummary = useMemo(() => {
    if (!applied?.startDate) return null;
    const range = applied.startDate === applied.endDate
      ? applied.startDate
      : `${applied.startDate} → ${applied.endDate}`;
    const scope = TARGET_FILTERS.find((t) => t.id === applied.targetType)?.label || 'Both';
    return `${range} · ${scope}`;
  }, [applied]);

  const load = useCallback(async (range = applied) => {
    if (!range?.startDate || !range?.endDate) return;
    setLoading(true);
    setError(null);
    try {
      const summary = await roiAPI.summary({
        start: range.startDate,
        end: range.endDate,
        targetType: range.targetType || 'all',
      });
      setData(summary);
      setLastUpdated(nowTimeInTZ());
    } catch (err) {
      logErrorForDebug(err, 'ROI summary');
      setError(getUserFacingMessage(err, 'Could not load ROI summary.'));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [applied]);

  useEffect(() => { load(); }, [load]);

  const onPreset = (p) => {
    if (dateFilterLocked) return;
    setPreset(p);
    if (p !== 'custom') {
      const r = clampPresetRange(p, dateRestriction);
      if (r) {
        setStartDate(r.startDate);
        setEndDate(r.endDate);
      }
    }
  };

  const applyPreset = (p) => {
    if (dateFilterLocked) return;
    const r = clampPresetRange(p, dateRestriction);
    if (!r) return;
    setPreset(p);
    setStartDate(r.startDate);
    setEndDate(r.endDate);
    setPage(1);
    const next = { startDate: r.startDate, endDate: r.endDate, targetType };
    setApplied(next);
    load(next);
  };

  const applyFilter = () => {
    if (customDatesIncomplete) return;
    const next = {
      startDate,
      endDate,
      targetType,
    };
    setPage(1);
    setApplied(next);
    load(next);
  };

  const reset = () => {
    const r = clampPresetRange('today', dateRestriction) || todayInit;
    setPreset('today');
    setStartDate(r.startDate);
    setEndDate(r.endDate);
    setTargetType('all');
    setPage(1);
    setSearch('');
    const next = { startDate: r.startDate, endDate: r.endDate, targetType: 'all' };
    setApplied(next);
    load(next);
  };

  const openExpenseForm = () => {
    setExpenseSharedDate(applied?.endDate || endDate);
    setExpense1(emptyExpenseSlot());
    setExpense2(emptyExpenseSlot());
    setShowExpense(true);
  };

  const saveExpenses = async (e) => {
    e.preventDefault();
    const slots = [expense1, expense2]
      .map((slot) => ({
        ...slot,
        expenseDate: expenseSharedDate || applied?.endDate || endDate,
        amount: Number(slot.amount),
      }))
      .filter((slot) => Number.isFinite(slot.amount) && slot.amount > 0);

    if (!slots.length) {
      setError('Enter an amount for at least one of the two expenses.');
      return;
    }

    setExpenseBusy(true);
    setError(null);
    try {
      for (const slot of slots) {
        if (slot.targetType !== 'general' && !String(slot.targetKey || '').trim()) {
          throw new Error('Site/app expenses need a target key.');
        }
        await adsAPI.createExpense(slot);
      }
      setShowExpense(false);
      setExpense1(emptyExpenseSlot());
      setExpense2(emptyExpenseSlot());
      await load();
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not save expenses.'));
    } finally {
      setExpenseBusy(false);
    }
  };

  const deleteExpense = async (id) => {
    try {
      await adsAPI.deleteExpense(id);
      await load();
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not delete expense.'));
    }
  };

  const renderExpenseFields = (slot, setSlot, title) => (
    <div className="filter-field">
      <div className="filter-section-head" style={{ marginBottom: 8 }}>
        <span className="filter-section-title">{title}</span>
      </div>
      <label className="ui-field">
        <span className="ui-field-label">Amount</span>
        <input
          className="ui-field-input"
          type="number"
          value={slot.amount}
          onChange={(e) => setSlot((f) => ({ ...f, amount: e.target.value }))}
          placeholder="0.00"
        />
      </label>
      <label className="ui-field">
        <span className="ui-field-label">Label</span>
        <input
          className="ui-field-input"
          type="text"
          value={slot.label}
          onChange={(e) => setSlot((f) => ({ ...f, label: e.target.value }))}
          placeholder="Creative, tools, salary…"
        />
      </label>
      <label className="ui-field">
        <span className="ui-field-label">Attach to</span>
        <select
          className="ui-field-input"
          value={slot.targetType}
          onChange={(e) => setSlot((f) => ({ ...f, targetType: e.target.value }))}
        >
          <option value="general">General (summary ROI only)</option>
          <option value="site">Site</option>
          <option value="app">App</option>
        </select>
      </label>
      {slot.targetType !== 'general' && (
        <label className="ui-field">
          <span className="ui-field-label">{slot.targetType === 'site' ? 'Site host' : 'App package'}</span>
          <input
            className="ui-field-input"
            type="text"
            value={slot.targetKey}
            onChange={(e) => setSlot((f) => ({ ...f, targetKey: e.target.value }))}
          />
        </label>
      )}
    </div>
  );

  const accounts = data?.accounts || [];
  const rows = data?.rows || [];
  const summary = data?.summary || {};

  const tableRows = useMemo(
    () => rows.map((r) => ({
      ...r,
      date: r.date || '—',
      targetLabel: `${r.targetType || '—'}: ${r.targetKey || '—'}`,
      revenueDollars: true,
    })),
    [rows]
  );

  const tableColumns = useMemo(() => {
    const cols = [
      {
        id: 'date',
        type: 'dimension',
        label: 'Date',
        cellClass: '',
        getValue: (r) => r.date || '—',
        aggregate: 'label',
      },
      {
        id: 'targetLabel',
        type: 'dimension',
        label: 'Site / App',
        cellClass: '',
        getValue: (r) => r.targetLabel || `${r.targetType}: ${r.targetKey}`,
        aggregate: 'label',
      },
    ];
    accounts.forEach((a) => {
      const id = `acc_${a.id}`;
      cols.push({
        id,
        type: 'metric',
        label: a.name || a.customerId || id,
        cellClass: '',
        getValue: (r) => Number(r.spendByAccount?.[a.id]) || 0,
        format: 'money',
        aggregate: 'sum',
      });
    });
    cols.push(
      {
        id: 'adsSpend',
        type: 'metric',
        label: 'Ads spend',
        getValue: (r) => Number(r.adsSpend) || 0,
        format: 'money',
        aggregate: 'sum',
      },
      {
        id: 'otherExpenses',
        type: 'metric',
        label: 'Other',
        getValue: (r) => Number(r.otherExpenses) || 0,
        format: 'money',
        aggregate: 'sum',
      },
      {
        id: 'earn',
        type: 'metric',
        label: 'Earn',
        getValue: (r) => Number(r.earn) || 0,
        format: 'money',
        aggregate: 'sum',
      },
      {
        id: 'profitSpend',
        type: 'metric',
        label: 'Profit (spend)',
        getValue: (r) => Number(r.profitSpend) || 0,
        format: 'money',
        aggregate: 'sum',
      },
      {
        id: 'roiSpendPercent',
        type: 'metric',
        label: 'ROI spend %',
        getValue: (r) => (r.roiSpendPercent == null ? null : Number(r.roiSpendPercent)),
        format: 'percent',
        aggregate: 'none',
        getCellClass: (r) => roiTone(r.roiSpendPercent),
      },
      {
        id: 'profitExpense',
        type: 'metric',
        label: 'Profit (exp.)',
        getValue: (r) => Number(r.profitExpense) || 0,
        format: 'money',
        aggregate: 'sum',
      },
      {
        id: 'roiExpensePercent',
        type: 'metric',
        label: 'ROI exp. %',
        getValue: (r) => (r.roiExpensePercent == null ? null : Number(r.roiExpensePercent)),
        format: 'percent',
        aggregate: 'none',
        getCellClass: (r) => roiTone(r.roiExpensePercent),
      },
    );
    return cols;
  }, [accounts]);

  const tableSummaryTotals = useMemo(() => {
    const totals = {
      adsSpend: Number(summary.adsSpend) || 0,
      otherExpenses: Number(summary.otherExpenses) || 0,
      earn: Number(summary.earn) || 0,
      profitSpend: Number(summary.profitSpend) || 0,
      profitExpense: Number(summary.profitExpense) || 0,
      roiSpendPercent: summary.roiSpendPercent,
      roiExpensePercent: summary.roiExpensePercent,
    };
    accounts.forEach((a) => {
      totals[`acc_${a.id}`] = tableRows.reduce(
        (sum, r) => sum + (Number(r.spendByAccount?.[a.id]) || 0),
        0
      );
    });
    return totals;
  }, [summary, accounts, tableRows]);

  const summaryCards = [
    { key: 'spend', label: 'Ads spend', value: money(summary.adsSpend), icon: '💳', tone: 'blue' },
    { key: 'other', label: 'Other expenses', value: money(summary.otherExpenses), icon: '📄', tone: 'amber' },
    { key: 'earn', label: 'Earn (GAM)', value: money(summary.earn), icon: '🌐', tone: 'green' },
    { key: 'pSpend', label: 'Profit (vs spend)', value: money(summary.profitSpend), icon: '📈', tone: 'green' },
    { key: 'roiSpend', label: 'ROI on spend', value: pct(summary.roiSpendPercent), icon: '%', tone: 'blue' },
    { key: 'pExp', label: 'Profit (vs expenses)', value: money(summary.profitExpense), icon: '📈', tone: 'amber' },
    { key: 'roiExp', label: 'ROI on expenses', value: pct(summary.roiExpensePercent), icon: '%', tone: 'green' },
  ];

  return (
    <div className="dashboard-page reporting-page roi-page">
      <PageHeader
        title="ROI"
        subtitle="Ads spend and other expenses vs GAM earn — separate ROI% for spend and expenses"
        summary={filterSummary}
      >
        <button type="button" className="btn-reset btn-copy-link" onClick={openExpenseForm}>
          Add 2 expenses
        </button>
      </PageHeader>

      {dateRestriction && (
        <p className="form-note page-restriction-note">
          {dateFilterLocked
            ? `Data locked to: ${formatDateRestrictionLabel(dateRestriction)}`
            : `Allowed filter window: ${formatDateRestrictionLabel(dateRestriction)}`}
        </p>
      )}

      <div className={`filter-card gam-report-shell ${filtersOpen ? 'filter-card-open' : ''}`}>
        <div className="filter-card-head filter-card-head-sticky">
          <button
            type="button"
            className="filter-card-title filter-card-toggle"
            onClick={() => setFiltersOpen((v) => !v)}
            aria-expanded={filtersOpen}
          >
            ROI filters {filtersOpen ? '▾' : '▸'}
          </button>
          <div className="filter-actions filter-actions--desktop">
            <button
              type="button"
              className="btn-generate"
              onClick={applyFilter}
              disabled={customDatesIncomplete}
              title={customDatesIncomplete ? 'Select both start and end dates' : ''}
            >
              ✓ Apply Filter
            </button>
            <button type="button" className="btn-reset" onClick={reset}>↺ Reset</button>
          </div>
        </div>

        {filtersOpen && (
          <div className="gam-report-settings">
            <div className="dash-date-toolbar" style={{ marginBottom: 12 }}>
              <div className="dash-date-display">
                <span className="dash-date-label">{presetLabel}</span>
                <span className="dash-date-range">
                  {customDatesIncomplete
                    ? 'Select start & end dates'
                    : (startDate && endDate
                      ? (startDate !== endDate ? `${startDate} → ${endDate}` : startDate)
                      : '…')}
                </span>
              </div>
            </div>

            <div className="filter-section-head">
              <span className="filter-section-title">Date range</span>
              <span className="filter-section-hint">Same presets as Dashboard &amp; Reporting</span>
            </div>

            {!dateFilterLocked && presetOptions.length > 0 && (
              <div className="preset-pills dash-preset-row">
                {presetOptions.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`preset-pill ${preset === p.id ? 'active' : ''}`}
                    onClick={() => onPreset(p.id)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            )}

            {!dateFilterLocked && preset === 'custom' && (
              <div className="filter-grid" style={{ marginTop: 12 }}>
                <div className="filter-field">
                  <label>Start Date</label>
                  <input
                    type="date"
                    value={startDate || ''}
                    min={dateRestriction?.startDate || undefined}
                    max={dateRestriction?.endDate || undefined}
                    onChange={(e) => setStartDate(clampDateValue(e.target.value, dateRestriction))}
                  />
                </div>
                <div className="filter-field">
                  <label>End Date</label>
                  <input
                    type="date"
                    value={endDate || ''}
                    min={dateRestriction?.startDate || undefined}
                    max={dateRestriction?.endDate || undefined}
                    onChange={(e) => setEndDate(clampDateValue(e.target.value, dateRestriction))}
                  />
                </div>
                <div className="custom-range-hint" style={{ gridColumn: '1 / -1' }}>
                  Pick <strong>start</strong> and <strong>end</strong> dates, then click <strong>Apply Filter</strong>.
                </div>
              </div>
            )}

            <div className="filter-section-divider" />
            <div className="filter-section-head">
              <span className="filter-section-title">Inventory scope</span>
              <span className="filter-section-hint">Sites, apps, or both</span>
            </div>
            <div className="preset-pills dash-preset-row">
              {TARGET_FILTERS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`preset-pill ${targetType === t.id ? 'active' : ''}`}
                  onClick={() => setTargetType(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {error && <div className="login-error" style={{ marginTop: 12 }}>{error}</div>}

      {showExpense && (
        <form className="filter-card" style={{ marginTop: 16 }} onSubmit={saveExpenses}>
          <div className="filter-card-head">
            <span className="filter-card-title">Add other expenses (up to 2)</span>
            <div className="filter-actions">
              <button type="submit" className="btn-generate" disabled={expenseBusy}>
                {expenseBusy ? 'Saving…' : '✓ Save expenses'}
              </button>
              <button type="button" className="btn-reset" onClick={() => setShowExpense(false)}>Cancel</button>
            </div>
          </div>
          <div className="filter-field" style={{ marginBottom: 12, maxWidth: 220 }}>
            <label>Date (shared)</label>
            <input
              type="date"
              value={expenseSharedDate || ''}
              onChange={(e) => setExpenseSharedDate(e.target.value)}
              required
            />
          </div>
          <div className="roi-expense-pair">
            {renderExpenseFields(expense1, setExpense1, 'Expense 1')}
            {renderExpenseFields(expense2, setExpense2, 'Expense 2')}
          </div>
          <p className="form-note" style={{ marginTop: 10 }}>
            Leave amount blank to skip one expense. ROI on expenses uses the sum of saved expenses.
          </p>
        </form>
      )}

      <div className={`report-summary-row roi-summary-grid${loading ? ' is-loading' : ''}`}>
        {summaryCards.map((card) => (
          <div key={card.key} className={`report-sum-card${loading ? ' is-loading' : ''}`}>
            <span className={`rsc-icon ${card.tone}`}>{card.icon}</span>
            <div>
              <div className="rsc-label">{card.label}</div>
              <div className="rsc-value">
                {loading ? <span className="card-spinner card-spinner-lg" aria-label="Loading" /> : card.value}
              </div>
            </div>
          </div>
        ))}
        <div className="report-live">
          <span className="dot-pulse" /> Live
          {lastUpdated && <span className="report-updated">Updated {lastUpdated} SGT</span>}
        </div>
      </div>

      {summary.unmappedSpend > 0 && (
        <div className="warn-card warn-card-partial" role="status" style={{ marginTop: 12 }}>
          <div className="warn-card-main">
            <div className="warn-card-left">
              <div className="warn-card-icon-wrap"><span aria-hidden>i</span></div>
              <div className="warn-card-body">
                <div className="warn-card-title">Unmapped Ads spend</div>
                <div className="warn-card-desc">
                  {money(summary.unmappedSpend)} in this range is not mapped to a site/app.
                  Map campaigns in Admin → Campaign mapping so spend appears in ROI rows.
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {!accounts.length && !loading && (
        <div className="warn-card" role="status" style={{ marginTop: 12 }}>
          <div className="warn-card-main">
            <div className="warn-card-left">
              <div className="warn-card-icon-wrap"><span aria-hidden>i</span></div>
              <div className="warn-card-body">
                <div className="warn-card-title">No Google Ads accounts in ROI</div>
                <div className="warn-card-desc">
                  Connect MCC / individual accounts in Admin → Google Ads accounts and enable Include in ROI.
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <DynamicReportTable
        title="ROI by site / app"
        rows={tableRows}
        columns={tableColumns}
        currency="USD"
        loading={loading}
        search={search}
        onSearchChange={setSearch}
        onPageReset={() => setPage(1)}
        searchPlaceholder="Search date / site / app…"
        page={page}
        pageSize={isNarrow ? 12 : PAGE_SIZE}
        onPageChange={setPage}
        showTotals={tableRows.length > 0}
        summaryTotals={tableSummaryTotals}
        density={tableDensity}
        freezeFirst
        headerExtra={(
          <div className="table-density-toggle" role="group" aria-label="Table density">
            <button
              type="button"
              className={`table-density-btn${tableDensity === 'compact' ? ' active' : ''}`}
              onClick={() => setTableDensity('compact')}
            >
              Compact
            </button>
            <button
              type="button"
              className={`table-density-btn${tableDensity === 'comfortable' ? ' active' : ''}`}
              onClick={() => setTableDensity('comfortable')}
            >
              Comfortable
            </button>
          </div>
        )}
        noReportMessage="No ROI rows for this range"
        emptyMessage="No ROI rows for this range"
        onReset={reset}
        emptyActions={(
          <>
            <button type="button" className="btn-generate" onClick={() => applyPreset('yesterday')}>Try yesterday</button>
            <button type="button" className="btn-reset" onClick={() => applyPreset('last7')}>Try last 7 days</button>
          </>
        )}
        columnStorageKey="roi-by-date-target"
        canDownload
        exportName={`roi_${applied?.startDate || startDate}_${applied?.endDate || endDate}`}
        className="roi-report-table"
      />

      {!!data?.generalExpenses?.length && (
        <div className="filter-card" style={{ marginTop: 16 }}>
          <div className="filter-section-head">
            <span className="filter-section-title">General expenses</span>
            <span className="filter-section-hint">Included in ROI on expenses</span>
          </div>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table className="data-table report-table report-table--comfortable">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Label</th>
                  <th>Amount</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.generalExpenses.map((e) => (
                  <tr key={e.id}>
                    <td>{e.expenseDate}</td>
                    <td>{e.label || 'Expense'}</td>
                    <td>{money(e.amount)}</td>
                    <td>
                      <button type="button" className="btn-reset" onClick={() => deleteExpense(e.id)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
