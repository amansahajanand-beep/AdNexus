import React, { useEffect, useMemo, useState } from 'react';
import {
  buildDateTable,
  groupDateTableRows,
  formatRoiMoney,
  formatRoiNum,
  formatRoiPct,
  roiToneClass,
} from '../../utils/report/roiView';
import { readGst } from './RoiDateTable';

const TABS = [
  { id: 'report', label: 'Report' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'countries', label: 'Countries' },
];

const isSiteRow = (r) => r?.targetType === 'site' || Boolean(r?.earnOnly);
const lc = (v) => String(v || '').toLowerCase();
const dash = '—';
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Add GST on the Ads spend: total expense = spend + GST, profit and % are worked out from that. */
function withExpense(row, gstRate) {
  const spend = Number(row.adsSpend) || 0;
  const earn = Number(row.earn) || 0;
  const gst = r2(spend * gstRate);
  const expense = r2(spend + gst);
  const profit = r2(earn - expense);
  return { ...row, gst, expense, profit, pct: expense > 0 ? r2((profit / expense) * 100) : null, roas: expense > 0 ? earn / expense : null };
}

const monthOf = (ymd) => String(ymd || '').slice(0, 7);
const daysIn = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const dmy = (ymd) => `${ymd.slice(8, 10)}-${ymd.slice(5, 7)}-${ymd.slice(0, 4)}`;
const monthLabel = (ym) => `${ym.slice(5, 7)}-${ym.slice(0, 4)}`;
const shiftMonth = (ym, d) => {
  const [y, m] = ym.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + d, 1));
  return dt.toISOString().slice(0, 7);
};

function Kpi({ label, value, sub, tone }) {
  return (
    <div className="rs-kpi">
      <div className="rs-kpi-label">{label}</div>
      <div className={`rs-kpi-value${tone ? ` ${tone}` : ''}`}>{value}</div>
      <div className="rs-kpi-sub">{sub}</div>
    </div>
  );
}

function MoneyCell({ v, currency, tone }) {
  if (v == null || (Number(v) === 0 && !tone)) return <span className="rs-dim">{dash}</span>;
  return <span className={tone ? roiToneClass(v) : undefined}>{formatRoiMoney(v, currency)}</span>;
}

function PeriodTable({ title, first, rows, total, currency, totalLabel, headRight, emptyNote }) {
  const body = (r, strong) => (
    <tr key={r.key || r.date} className={strong ? 'rs-total-row' : (r.empty ? 'rs-empty-row' : undefined)}>
      <td className="rs-mono">{r.label}</td>
      <td><MoneyCell v={r.empty ? null : r.adsSpend} currency={currency} /></td>
      <td><MoneyCell v={r.empty ? null : r.gst} currency={currency} /></td>
      <td><MoneyCell v={r.empty ? null : r.expense} currency={currency} /></td>
      <td><MoneyCell v={r.empty ? null : r.earn} currency={currency} /></td>
      <td><MoneyCell v={r.empty ? null : r.profit} currency={currency} tone /></td>
      <td className={r.empty || r.pct == null ? undefined : roiToneClass(r.pct)}>{r.empty || r.pct == null ? <span className="rs-dim">{dash}</span> : formatRoiPct(r.pct)}</td>
    </tr>
  );
  return (
    <section className="rs-card">
      <div className="rs-card-head">
        <h3>{title}</h3>
        {headRight}
      </div>
      <div className="table-wrap">
        <table className="rs-table">
          <thead>
            <tr>
              <th>{first}</th><th>Ad exp</th><th>GST</th><th>Total expense</th><th>Revenue</th><th>Profit</th><th>Percentage (%)</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? rows.map((r) => body(r)) : <tr><td colSpan={7} className="rs-dim rs-pad">{emptyNote || 'No data for these dates.'}</td></tr>}
            {rows.length && total ? body({ ...total, label: totalLabel, key: 'total' }, true) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * ROI sheet laid out like an app page: app switcher, header card, Report / Accounts / Countries tabs.
 * Everything is worked out from the sheet's per-day country × app/site rows, so picking an app only filters them.
 */
export default function RoiAppSheetView({
  title, subtitle, dailyRows, countryRows, siteApp, currency, loading, appKey, onAppKey, tab, onTab, range, actions,
}) {
  const gstRate = readGst() / 100;

  // Apps of this sheet (Ads packages), biggest spend first.
  const apps = useMemo(() => {
    const m = new Map();
    (countryRows.length ? countryRows : dailyRows).forEach((r) => {
      if (isSiteRow(r) || !r.targetKey) return;
      const k = lc(r.targetKey);
      const cur = m.get(k) || { key: k, spend: 0, earn: 0 };
      cur.spend += Number(r.adsSpend) || 0;
      cur.earn += Number(r.earn) || 0;
      m.set(k, cur);
    });
    return [...m.values()].sort((a, b) => b.spend - a.spend || b.earn - a.earn || a.key.localeCompare(b.key));
  }, [countryRows, dailyRows]);

  useEffect(() => { if (appKey && !apps.some((a) => a.key === appKey) && !loading) onAppKey(''); }, [apps, appKey, loading, onAppKey]);

  const inScope = useMemo(() => {
    if (!appKey) return () => true;
    return (r) => (isSiteRow(r) ? siteApp[lc(r.targetKey)] === appKey : lc(r.targetKey) === appKey);
  }, [appKey, siteApp]);

  const daily = useMemo(() => dailyRows.filter(inScope), [dailyRows, inScope]);
  const countries = useMemo(() => countryRows.filter(inScope), [countryRows, inScope]);

  const table = useMemo(() => buildDateTable(daily), [daily]);
  const dayRows = useMemo(() => table.rows.map((r) => withExpense(r, gstRate)), [table, gstRate]);
  const total = useMemo(() => withExpense(table.total, gstRate), [table, gstRate]);
  const monthRows = useMemo(() => groupDateTableRows(table.rows, 'month').map((r) => withExpense({ ...r, label: monthLabel(r.date), key: r.date }, gstRate)), [table, gstRate]);
  const yearRows = useMemo(() => groupDateTableRows(table.rows, 'year').map((r) => withExpense({ ...r, label: r.date, key: r.date }, gstRate)), [table, gstRate]);

  const endMonth = monthOf(range?.endDate) || monthOf(new Date().toISOString());
  const [year, setYear] = useState('');
  const [month, setMonth] = useState('');
  useEffect(() => { setYear(''); setMonth(''); }, [appKey, range?.startDate, range?.endDate]);
  const years = useMemo(() => [...new Set([...yearRows.map((r) => r.date), endMonth.slice(0, 4)])].sort().reverse(), [yearRows, endMonth]);
  const activeYear = year || years[0];
  const activeMonth = month || endMonth;

  const monthsOfYear = useMemo(() => {
    const byKey = new Map(monthRows.map((r) => [r.date, r]));
    const out = [];
    for (let m = 1; m <= 12; m += 1) {
      const ym = `${activeYear}-${String(m).padStart(2, '0')}`;
      if (ym > endMonth && !byKey.has(ym)) continue;
      out.push(byKey.get(ym) || { key: ym, label: monthLabel(ym), empty: true });
    }
    const sumOf = monthRows.filter((r) => r.date.startsWith(activeYear));
    const t = withExpense(sumOf.reduce((a, r) => ({
      adsSpend: a.adsSpend + r.adsSpend, earn: a.earn + r.earn,
    }), { adsSpend: 0, earn: 0 }), gstRate);
    return { rows: out, total: sumOf.length ? t : null };
  }, [monthRows, activeYear, endMonth, gstRate]);

  const daysOfMonth = useMemo(() => {
    const byDate = new Map(dayRows.map((r) => [r.date, r]));
    const out = [];
    for (let d = 1; d <= daysIn(activeMonth); d += 1) {
      const ymd = `${activeMonth}-${String(d).padStart(2, '0')}`;
      if (range?.endDate && ymd > range.endDate) break;
      out.push({ ...(byDate.get(ymd) || { empty: true }), key: ymd, label: dmy(ymd) });
    }
    const mr = monthRows.find((r) => r.date === activeMonth);
    return { rows: out, total: mr || null };
  }, [dayRows, monthRows, activeMonth, range?.endDate]);

  // Pulse: the month the range ends in.
  const pulse = monthRows.find((r) => r.date === endMonth);

  const sel = apps.find((a) => a.key === appKey);
  const idx = sel ? apps.indexOf(sel) : -1;
  const go = (d) => {
    if (!apps.length) return;
    const n = idx === -1 ? (d > 0 ? 0 : apps.length - 1) : idx + d;
    onAppKey(n < 0 || n >= apps.length ? '' : apps[n].key);
  };
  const name = sel ? sel.key : title;
  const badge = (sel ? sel.key : title).replace(/[^a-z0-9]/gi, '').slice(0, 3).toUpperCase() || '#';

  // Sites (Firebase subdomains) that earn for the picked app (or all of them).
  const sites = useMemo(() => {
    const m = new Map();
    daily.forEach((r) => { if (isSiteRow(r) && r.targetKey) m.set(lc(r.targetKey), (m.get(lc(r.targetKey)) || 0) + (Number(r.earn) || 0)); });
    return [...m.entries()].map(([host, earn]) => ({ host, earn })).sort((a, b) => b.earn - a.earn);
  }, [daily]);

  // Countries: expense / revenue / profit per country.
  const countryTable = useMemo(() => {
    const m = new Map();
    countries.forEach((r) => {
      const k = r.countryCode || r.countryName || '?';
      const cur = m.get(k) || { code: r.countryCode || '', name: r.countryName || r.countryCode || '—', adsSpend: 0, earn: 0, impressions: 0, clicks: 0 };
      cur.adsSpend += isSiteRow(r) ? 0 : (Number(r.adsSpend) || 0);
      cur.earn += Number(r.earn) || 0;
      cur.impressions += Number(r.impressions) || 0;
      cur.clicks += Number(r.clicks) || 0;
      m.set(k, cur);
    });
    return [...m.values()].map((c) => withExpense(c, gstRate)).sort((a, b) => b.earn - a.earn);
  }, [countries, gstRate]);

  const spendRows = useMemo(() => {
    const m = new Map();
    countries.forEach((r) => {
      if (isSiteRow(r) || !r.targetKey) return;
      const k = lc(r.targetKey);
      const cur = m.get(k) || { key: k, adsSpend: 0, earn: 0 };
      cur.adsSpend += Number(r.adsSpend) || 0;
      cur.earn += Number(r.earn) || 0;
      m.set(k, cur);
    });
    return [...m.values()].sort((a, b) => b.adsSpend - a.adsSpend);
  }, [countries]);

  const money = (v) => formatRoiMoney(v, currency);
  const noData = !loading && !dayRows.length;

  const insights = [];
  if (!noData) {
    if (total.profit >= 0) insights.push({ tone: 'good', head: `Paid back: profit ${money(total.profit)}`, body: `Spent ${money(total.expense)}, earned ${money(total.earn)} (ROAS ${total.roas == null ? dash : `${total.roas.toFixed(2)}×`}).` });
    else insights.push({ tone: 'bad', head: `Not paid back yet: ${money(total.profit)}`, body: `Spent ${money(total.expense)}, earned ${money(total.earn)} (ROAS ${total.roas == null ? dash : `${total.roas.toFixed(2)}×`}).` });
    if (!pulse) insights.push({ tone: 'ok', head: `No activity in ${endMonth}`, body: 'No spend and no revenue recorded on any day of this month.' });
    else if (pulse.profit < 0) insights.push({ tone: 'bad', head: `Losing money in ${endMonth}`, body: `Expense ${money(pulse.expense)} against revenue ${money(pulse.earn)}.` });
  }

  return (
    <div className="rs">
      <div className="rs-switch">
        <button type="button" className="rs-nav" onClick={() => go(-1)} aria-label="Previous app" disabled={!apps.length}>‹</button>
        <select className="rs-select" value={appKey} onChange={(e) => onAppKey(e.target.value)} aria-label="App">
          <option value="">All apps in this sheet ({apps.length})</option>
          {apps.map((a, i) => <option key={a.key} value={a.key}>{i + 1} · {a.key}</option>)}
        </select>
        <button type="button" className="rs-nav" onClick={() => go(1)} aria-label="Next app" disabled={!apps.length}>›</button>
        <span className="rs-count">{sel ? `${idx + 1} / ${apps.length}` : `${apps.length} apps`}</span>
      </div>

      <section className="rs-header">
        <div className="rs-header-top">
          <div className="rs-badge" aria-hidden>{badge}</div>
          <div className="rs-header-main">
            <h2 className="rs-title">{name}</h2>
            <div className="rs-sub">{sel ? `${title} · app` : subtitle}{range?.startDate ? ` · ${range.startDate === range.endDate ? range.startDate : `${range.startDate} → ${range.endDate}`}` : ''}</div>
          </div>
          <div className="rs-header-side">
            <span className="rs-live"><span className="rs-live-dot" />Live</span>
            <div className="rs-actions">{actions}</div>
          </div>
        </div>
        <div className="rs-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`rs-tab${tab === t.id ? ' is-active' : ''}`} onClick={() => onTab(t.id)}>{t.label}</button>
          ))}
        </div>
      </section>

      {tab === 'report' && (
        <>
          <div className="rs-kpis">
            <Kpi label="Net profit" value={loading ? '…' : `${total.profit >= 0 ? '+' : ''}${money(total.profit)}`} tone={roiToneClass(total.profit) || undefined} sub={total.pct == null ? 'Master %' : `Master % ${total.pct >= 0 ? '+' : ''}${total.pct.toFixed(1)}% (profit ÷ expense)`} />
            <Kpi label="Total expense" value={loading ? '…' : money(total.expense)} sub={`Ads ${money(total.adsSpend)} + GST ${money(total.gst)}`} />
            <Kpi label="Revenue" value={loading ? '…' : money(total.earn)} sub={`${sites.length} site${sites.length === 1 ? '' : 's'} linked`} />
            <Kpi label="ROAS" value={loading ? '…' : (total.roas == null ? dash : `${total.roas.toFixed(2)}×`)} sub={total.roas == null ? 'No spend' : (total.roas >= 1 ? 'Above break-even (1.00×)' : 'Needs 1.00× to break even')} />
          </div>

          <section className="rs-card rs-pulse">
            <div className="rs-pulse-left">
              <div className="rs-eyebrow">Pulse · {endMonth}</div>
              <div className={`rs-pulse-value ${pulse ? roiToneClass(pulse.profit) : ''}`}>{pulse ? `${pulse.profit >= 0 ? '+' : ''}${money(pulse.profit)}` : `+${money(0)}`}</div>
              <div className="rs-chips">
                <span className="rs-chip">spend {money(pulse?.expense || 0)}</span>
                <span className="rs-chip">revenue {money(pulse?.earn || 0)}</span>
              </div>
            </div>
            <div className="rs-pulse-right">
              <div className="rs-eyebrow">Day by day · {endMonth}</div>
              {daysOfMonth.rows.some((d) => !d.empty) ? (
                <div className="rs-bars">
                  {(() => {
                    const peak = Math.max(...daysOfMonth.rows.map((d) => Math.max(d.expense || 0, d.earn || 0)), 1);
                    return daysOfMonth.rows.map((d) => (
                      <div key={d.key} className="rs-bar-col" title={`${d.label}: revenue ${money(d.earn || 0)} · expense ${money(d.expense || 0)}`}>
                        <span className="rs-bar rs-bar-rev" style={{ height: `${((d.earn || 0) / peak) * 100}%` }} />
                        <span className="rs-bar rs-bar-exp" style={{ height: `${((d.expense || 0) / peak) * 100}%` }} />
                      </div>
                    ));
                  })()}
                </div>
              ) : <div className="rs-dim rs-pad">No spend or revenue yet this month.</div>}
              <div className="rs-legend"><span className="rs-sw rs-sw-rev" />Revenue <span className="rs-sw rs-sw-exp" />Expense</div>
            </div>
          </section>

          {insights.length > 0 && (
            <section className="rs-card">
              <div className="rs-card-head"><h3>Insights</h3><span className="rs-dim">from the numbers below</span></div>
              {insights.map((i) => (
                <div key={i.head} className="rs-insight">
                  <span className={`rs-pill ${i.tone}`}>{i.tone === 'bad' ? '!' : 'OK'}</span>
                  <div><div className="rs-insight-head">{i.head}</div><div className="rs-dim">{i.body}</div></div>
                </div>
              ))}
            </section>
          )}

          <PeriodTable
            title="Monthly"
            first="Month"
            rows={monthsOfYear.rows}
            total={monthsOfYear.total}
            totalLabel={`${activeYear} total`}
            currency={currency}
            emptyNote={loading ? 'Loading…' : undefined}
            headRight={<select className="rs-select rs-select-sm" value={activeYear} onChange={(e) => { setYear(e.target.value); setMonth(''); }}>{years.map((y) => <option key={y} value={y}>{y}</option>)}</select>}
          />

          <PeriodTable
            title="Daily detail"
            first="Date"
            rows={daysOfMonth.rows}
            total={daysOfMonth.total}
            totalLabel={`${monthLabel(activeMonth)} total`}
            currency={currency}
            emptyNote={loading ? 'Loading…' : undefined}
            headRight={(
              <div className="rs-month-nav">
                <button type="button" className="rs-nav" onClick={() => setMonth(shiftMonth(activeMonth, -1))} aria-label="Previous month">‹</button>
                <span className="rs-select rs-select-sm rs-mono">{activeMonth}</span>
                <button type="button" className="rs-nav" onClick={() => setMonth(shiftMonth(activeMonth, 1))} disabled={activeMonth >= endMonth} aria-label="Next month">›</button>
              </div>
            )}
          />
          <p className="rs-note">Total expense = Ad exp + GST ({(gstRate * 100).toFixed(1).replace(/\.0$/, '')}%). Percentage = profit ÷ total expense. Amounts in {currency} unless the display currency is changed above.</p>

          <section className="rs-card">
            <div className="rs-card-head"><h3>Website links</h3><span className="rs-dim">{sites.length}</span></div>
            {sites.length ? sites.map((s) => (
              <div key={s.host} className="rs-link-row"><span>{s.host}</span><span className="rs-mono rs-dim">{money(s.earn)}</span></div>
            )) : <div className="rs-dim rs-pad">{loading ? 'Loading…' : 'No linked websites earned in these dates.'}</div>}
          </section>
        </>
      )}

      {tab === 'accounts' && (
        <>
          <section className="rs-card">
            <div className="rs-card-head"><h3>Ad spend ({sel ? 'this app' : 'apps'})</h3><span className="rs-dim">{spendRows.length}</span></div>
            <div className="table-wrap">
              <table className="rs-table">
                <thead><tr><th>App</th><th>Spend</th><th>Revenue</th><th>Profit</th></tr></thead>
                <tbody>
                  {spendRows.length ? spendRows.map((r) => (
                    <tr key={r.key}><td>{r.key}</td><td>{money(r.adsSpend)}</td><td>{money(r.earn)}</td><td className={roiToneClass(r.earn - r.adsSpend)}>{money(r.earn - r.adsSpend)}</td></tr>
                  )) : <tr><td colSpan={4} className="rs-dim rs-pad">{loading ? 'Loading…' : 'No spend in these dates.'}</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
          <section className="rs-card">
            <div className="rs-card-head"><h3>Revenue sites</h3><span className="rs-dim">{sites.length}</span></div>
            <div className="table-wrap">
              <table className="rs-table">
                <thead><tr><th>Site</th><th>Revenue</th></tr></thead>
                <tbody>
                  {sites.length ? sites.map((s) => <tr key={s.host}><td>{s.host}</td><td>{money(s.earn)}</td></tr>) : <tr><td colSpan={2} className="rs-dim rs-pad">{loading ? 'Loading…' : 'No site revenue in these dates.'}</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {tab === 'countries' && (
        <section className="rs-card">
          <div className="rs-card-head"><h3>Countries for this {sel ? 'app' : 'sheet'}</h3><span className="rs-dim">{countryTable.length}</span></div>
          <div className="table-wrap">
            <table className="rs-table">
              <thead><tr><th>Country</th><th>Expense</th><th>Revenue</th><th>Profit</th><th>ROAS</th><th>Impressions</th><th>Clicks</th></tr></thead>
              <tbody>
                {countryTable.length ? (
                  <>
                    <tr className="rs-total-row">
                      <td>Total · {countryTable.length} countries</td>
                      <td>{money(total.expense)}</td><td>{money(total.earn)}</td>
                      <td className={roiToneClass(total.profit)}>{money(total.profit)}</td>
                      <td>{total.roas == null ? dash : `${total.roas.toFixed(2)}×`}</td>
                      <td>{formatRoiNum(countryTable.reduce((s, c) => s + c.impressions, 0))}</td>
                      <td>{formatRoiNum(countryTable.reduce((s, c) => s + c.clicks, 0))}</td>
                    </tr>
                    {countryTable.map((c) => (
                      <tr key={c.code || c.name}>
                        <td>{c.name} {c.code ? <span className="rs-dim">{c.code}</span> : null}</td>
                        <td>{money(c.expense)}</td><td>{money(c.earn)}</td>
                        <td className={roiToneClass(c.profit)}>{c.profit >= 0 ? '+' : ''}{money(c.profit)}</td>
                        <td>{c.roas == null ? dash : `${c.roas.toFixed(2)}×`}</td>
                        <td>{formatRoiNum(c.impressions)}</td><td>{formatRoiNum(c.clicks)}</td>
                      </tr>
                    ))}
                  </>
                ) : <tr><td colSpan={7} className="rs-dim rs-pad">{loading ? 'Loading…' : 'No country data in these dates.'}</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
