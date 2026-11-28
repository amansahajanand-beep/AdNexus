import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import PageHeader from '../components/ui/PageHeader';
import TableSearchBar from '../components/ui/TableSearchBar';
import Button from '../components/ui/Button';
import {
  AppKpiStrip, StatusBadge, SignalBadge, ChangeText,
  fmtInr, fmtUsd, fmtPct, fmtRatio,
} from '../components/apps/AppsShared';
import AppsDateBar, { useAppsRange, appDetailPath } from '../components/apps/AppsDateBar';
import { getAllApps, getRangeInfo, APP_STATUSES, APP_SIGNALS } from '../mocks/appsData';
import './Apps.css';

const PAGE_SIZE = 10;

const COLUMNS = [
  { id: 'id', label: 'App ID', left: true },
  { id: 'name', label: 'App Name', left: true },
  { id: 'packageName', label: 'Package Name', left: true },
  { id: 'status', label: 'Status', left: true },
  { id: 'expense', label: 'Expense (INR)', num: true },
  { id: 'revenueInr', label: 'Revenue INR', num: true },
  { id: 'revenueUsd', label: 'Revenue USD', num: true },
  { id: 'profit', label: 'Net Profit', num: true },
  { id: 'margin', label: 'Margin', num: true },
  { id: 'roas', label: 'ROAS', num: true },
  { id: 'signal', label: 'Signal', left: true },
  { id: 'profitVsPrev', label: 'Profit vs Previous', num: true },
];

const ROAS_BANDS = {
  all: () => true,
  lt1: (r) => r.roas < 1,
  '1to2': (r) => r.roas >= 1 && r.roas < 2,
  gte2: (r) => r.roas >= 2,
};

export default function Apps() {
  const navigate = useNavigate();
  const [range, setRange] = useAppsRange();
  const rangeInfo = getRangeInfo(range);
  const all = useMemo(() => getAllApps(range), [range]);
  const categories = useMemo(() => [...new Set(all.map((a) => a.category))].sort(), [all]);

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [signal, setSignal] = useState('all');
  const [profitFilter, setProfitFilter] = useState('all');
  const [roasBand, setRoasBand] = useState('all');
  const [category, setCategory] = useState('all');
  const [sort, setSort] = useState({ key: 'id', dir: 'asc' });
  const [page, setPage] = useState(1);
  const theadRef = useRef(null);
  const tableRef = useRef(null);

  const filtersActive = search || status !== 'all' || signal !== 'all'
    || profitFilter !== 'all' || roasBand !== 'all' || category !== 'all';

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = all.filter((r) => {
      if (q && !`${r.id} ${r.name} ${r.packageName}`.toLowerCase().includes(q)) return false;
      if (status !== 'all' && r.status !== status) return false;
      if (signal !== 'all' && r.signal !== signal) return false;
      if (category !== 'all' && r.category !== category) return false;
      if (profitFilter === 'profit' && r.profit < 0) return false;
      if (profitFilter === 'loss' && r.profit >= 0) return false;
      return ROAS_BANDS[roasBand](r);
    });
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      const x = a[sort.key];
      const y = b[sort.key];
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
      return String(x).localeCompare(String(y), undefined, { numeric: true }) * dir;
    });
  }, [all, search, status, signal, category, profitFilter, roasBand, sort]);

  const totals = useMemo(() => {
    const t = rows.reduce((s, r) => ({
      expense: s.expense + r.expense,
      revenueInr: s.revenueInr + r.revenueInr,
      revenueUsd: s.revenueUsd + r.revenueUsd,
      profit: s.profit + r.profit,
      pExpense: s.pExpense + (r.prev?.expense || 0),
      pRevenueInr: s.pRevenueInr + (r.prev?.revenueInr || 0),
      pProfit: s.pProfit + (r.prev?.profit || 0),
    }), {
      expense: 0, revenueInr: 0, revenueUsd: 0, profit: 0, pExpense: 0, pRevenueInr: 0, pProfit: 0,
    });
    const hasPrev = rows.some((r) => r.prev);
    const pct = (c, p) => (hasPrev ? Math.round((p ? ((c - p) / Math.abs(p)) * 100 : (c ? 100 : 0)) * 10) / 10 : null);
    const roas = t.expense ? t.revenueInr / t.expense : 0;
    const pRoas = t.pExpense ? t.pRevenueInr / t.pExpense : 0;
    return {
      ...t,
      roas,
      margin: t.revenueInr ? (t.profit / t.revenueInr) * 100 : 0,
      dRevenue: pct(t.revenueInr, t.pRevenueInr),
      dExpense: pct(t.expense, t.pExpense),
      dProfit: pct(t.profit, t.pProfit),
      dRoas: pct(roas, pRoas),
    };
  }, [rows]);

  const kpis = [
    { key: 'revenueInr', label: 'Total revenue (INR)', value: totals.revenueInr, format: 'money', currency: 'INR', change: totals.dRevenue },
    { key: 'expense', label: 'Total expense (INR)', value: totals.expense, format: 'money', currency: 'INR', change: totals.dExpense },
    { key: 'profit', label: 'Net profit (INR)', value: totals.profit, format: 'money', currency: 'INR', change: totals.dProfit },
    { key: 'roas', label: 'Blended ROAS', value: totals.roas, format: 'ratio', change: totals.dRoas },
  ];

  // The Total row sticks right under the (sticky) header, so measure the header's height.
  useLayoutEffect(() => {
    const h = theadRef.current?.offsetHeight;
    if (h && tableRef.current) tableRef.current.style.setProperty('--apps-head-h', `${h}px`);
  });

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const curPage = Math.min(page, pageCount);
  const pageRows = rows.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE);

  const resetPage = () => setPage(1);
  const onSort = (key) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
    resetPage();
  };
  const clearFilters = () => {
    setSearch(''); setStatus('all'); setSignal('all'); setProfitFilter('all');
    setRoasBand('all'); setCategory('all'); setPage(1);
  };
  const openApp = (r) => navigate(appDetailPath(r.slug, range));

  return (
    <div className="apps-page">
      <PageHeader
        title="Apps"
        subtitle={`All apps · ${rangeInfo.label} (${rangeInfo.spanLabel}) · ${all.length} apps · ₹83.5 per US$ (mock data)`}
      />

      <AppsDateBar value={range} onChange={(r) => { setRange(r); setPage(1); }} />

      <AppKpiStrip kpis={kpis} idPrefix="apps-all" compareLabel={rangeInfo.compareLabel} />

      <div className="apps-toolbar">
        <TableSearchBar
          value={search}
          onChange={setSearch}
          onPageReset={resetPage}
          placeholder="Search app name, ID or package…"
        />
        <select value={status} onChange={(e) => { setStatus(e.target.value); resetPage(); }} aria-label="Filter by status">
          <option value="all">All statuses</option>
          {APP_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={signal} onChange={(e) => { setSignal(e.target.value); resetPage(); }} aria-label="Filter by signal">
          <option value="all">All signals</option>
          {APP_SIGNALS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={profitFilter} onChange={(e) => { setProfitFilter(e.target.value); resetPage(); }} aria-label="Filter by profit">
          <option value="all">Profit &amp; loss</option>
          <option value="profit">Profitable only</option>
          <option value="loss">Loss-making only</option>
        </select>
        <select value={roasBand} onChange={(e) => { setRoasBand(e.target.value); resetPage(); }} aria-label="Filter by ROAS">
          <option value="all">Any ROAS</option>
          <option value="lt1">ROAS &lt; 1x</option>
          <option value="1to2">ROAS 1x – 2x</option>
          <option value="gte2">ROAS ≥ 2x</option>
        </select>
        <select value={category} onChange={(e) => { setCategory(e.target.value); resetPage(); }} aria-label="Filter by category">
          <option value="all">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {filtersActive ? <Button variant="ghost" onClick={clearFilters}>Reset</Button> : null}
        <span className="apps-count">{rows.length} of {all.length} apps</span>
      </div>

      <div className="table-wrap apps-table-wrap">
        <table className="data-table apps-table" ref={tableRef}>
          <thead ref={theadRef}>
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.id}
                  className={`is-sortable${c.num ? ' num' : ''}${c.left ? ' left' : ''}`}
                  onClick={() => onSort(c.id)}
                  aria-sort={sort.key === c.id ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  {c.label}
                  {sort.key === c.id ? <span className="sort-ind">{sort.dir === 'asc' ? '▲' : '▼'}</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="apps-total-row">
              <td className="left">Total · {rows.length} {rows.length === 1 ? 'app' : 'apps'}</td>
              <td className="left" />
              <td className="left" />
              <td className="left" />
              <td className="num">{fmtInr(totals.expense)}</td>
              <td className="num">{fmtInr(totals.revenueInr)}</td>
              <td className="num">{fmtUsd(totals.revenueUsd)}</td>
              <td className={`num ${totals.profit < 0 ? 'apps-neg' : 'apps-pos'}`}>{fmtInr(totals.profit)}</td>
              <td className={`num ${totals.margin < 0 ? 'apps-neg' : ''}`}>{fmtPct(totals.margin)}</td>
              <td className="num">{fmtRatio(totals.roas)}</td>
              <td className="left" />
              <td className="num"><ChangeText value={totals.dProfit} /></td>
            </tr>
            {pageRows.length === 0 ? (
              <tr><td colSpan={COLUMNS.length} className="apps-empty">No apps match the current filters.</td></tr>
            ) : pageRows.map((r) => (
              <tr
                key={r.id}
                className="apps-row"
                role="link"
                tabIndex={0}
                onClick={() => openApp(r)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openApp(r); } }}
                aria-label={`Open ${r.name}`}
              >
                <td className="left">{r.id}</td>
                <td className="left"><span className="apps-name">{r.name}</span><span className="apps-sub">{r.category}</span></td>
                <td className="left apps-pkg">{r.packageName}</td>
                <td className="left"><StatusBadge status={r.status} /></td>
                <td className="num">{fmtInr(r.expense)}</td>
                <td className="num">{fmtInr(r.revenueInr)}</td>
                <td className="num">{fmtUsd(r.revenueUsd)}</td>
                <td className={`num ${r.profit < 0 ? 'apps-neg' : 'apps-pos'}`}>{fmtInr(r.profit)}</td>
                <td className={`num ${r.margin < 0 ? 'apps-neg' : ''}`}>{fmtPct(r.margin)}</td>
                <td className="num">{fmtRatio(r.roas)}</td>
                <td className="left"><SignalBadge signal={r.signal} /></td>
                <td className="num"><ChangeText value={r.profitVsPrev} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="apps-pager">
        <span>
          {rows.length ? `${(curPage - 1) * PAGE_SIZE + 1}–${Math.min(curPage * PAGE_SIZE, rows.length)} of ${rows.length}` : '0 results'}
        </span>
        <div className="apps-pager-btns">
          <Button variant="ghost" disabled={curPage <= 1} onClick={() => setPage(curPage - 1)}>Prev</Button>
          <span>Page {curPage} / {pageCount}</span>
          <Button variant="ghost" disabled={curPage >= pageCount} onClick={() => setPage(curPage + 1)}>Next</Button>
        </div>
      </div>
    </div>
  );
}
