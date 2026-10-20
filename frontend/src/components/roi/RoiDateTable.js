import React, { useMemo, useState } from 'react';
import {
  buildDateTable,
  groupDateTableRows,
  formatRoiMoney,
  formatRoiNum,
  formatRoiPct,
  formatRoiEcpm,
  roiToneClass,
} from '../../utils/report/roiView';
import { convertRoi, useRoiDisplayCurrency } from '../../utils/report/roiCurrency';
import { downloadCsv, downloadExcel } from '../../utils/tableExport';

const COLS = [
  { id: 'date', label: 'Date' },
  { id: 'adsSpend', label: 'Ads spend', fmt: 'money' },
  { id: 'impressions', label: 'Impressions', fmt: 'num' },
  { id: 'clicks', label: 'Clicks', fmt: 'num' },
  { id: 'ctr', label: 'CTR', fmt: 'pct' },
  { id: 'ecpm', label: 'Ads eCPM', fmt: 'ecpm' },
  { id: 'earn', label: 'Earn', fmt: 'money' },
  { id: 'otherExpenses', label: 'Expenses', fmt: 'money' },
  { id: 'profitSpend', label: 'Profit (spend)', fmt: 'money', tone: true },
  { id: 'profitExpense', label: 'Profit (expenses)', fmt: 'money', tone: true },
  { id: 'roiSpendPercent', label: 'ROI spend %', fmt: 'pct', tone: true },
  { id: 'roiExpensePercent', label: 'ROI expenses %', fmt: 'pct', tone: true },
  { id: 'gst', label: 'GST (3%)', fmt: 'money' },
  { id: 'profitAfterGst', label: 'Profit after GST', fmt: 'money', tone: true },
  { id: 'roiAfterGst', label: 'ROI after GST %', fmt: 'pct', tone: true },
];

// GST charged on the Ads spend. Profit after GST = earn - spend - GST; ROI after GST = that profit / (spend + GST).
export const GST_RATE = 0.03;
const GST_KEY = 'adnexus.roiGstPercent';
const readGst = () => {
  try {
    const v = parseFloat(localStorage.getItem(GST_KEY));
    return Number.isFinite(v) && v >= 0 && v <= 100 ? v : GST_RATE * 100;
  } catch { return GST_RATE * 100; }
};
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
function withGst(row, rate = GST_RATE) {
  const spend = Number(row.adsSpend) || 0;
  const earn = Number(row.earn) || 0;
  const gst = r2(spend * rate);
  const cost = spend + gst;
  const profitAfterGst = r2(earn - spend - gst);
  return { ...row, gst, profitAfterGst, roiAfterGst: cost > 0 ? r2((profitAfterGst / cost) * 100) : null };
}

function render(row, col, currency) {
  const v = row[col.id];
  if (col.id === 'date') return v || '—';
  if (v == null) return '—';
  if (col.fmt === 'money') return formatRoiMoney(v, currency);
  if (col.fmt === 'pct') return formatRoiPct(v);
  if (col.fmt === 'ecpm') return formatRoiEcpm(v, currency);
  return formatRoiNum(v);
}

/** Date-wise totals of the selected Ads account (one row per day, newest first). Shown only for a single account. */
const GROUP_LABELS = {
  day: { date: 'Date', title: 'Day by day' },
  week: { date: 'Week (Mon–Sun)', title: 'Week by week' },
  month: { date: 'Month', title: 'Month by month' },
  year: { date: 'Year', title: 'Year by year' },
};

export default function RoiDateTable({
  dailyRows, loading, currency = 'USD', exportName = 'roi_by_date', groupBy = 'day', titleSuffix = 'for the selected Ads account',
}) {
  const labels = GROUP_LABELS[groupBy] || GROUP_LABELS.day;
  useRoiDisplayCurrency();
  const [dir, setDir] = useState('desc');
  // GST on the Ads spend: 3% unless changed here (remembered in this browser).
  const [gstText, setGstText] = useState(() => String(readGst()));
  const gstPct = (() => { const v = parseFloat(gstText); return Number.isFinite(v) && v >= 0 && v <= 100 ? v : readGst(); })();
  const onGst = (e) => {
    setGstText(e.target.value);
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v) && v >= 0 && v <= 100) { try { localStorage.setItem(GST_KEY, String(v)); } catch { /* ignore */ } }
  };
  const cols = COLS.map((c) => (c.id === 'gst' ? { ...c, label: `GST (${gstPct}%)` } : c));
  const { rows, total } = useMemo(() => {
    const t = buildDateTable(dailyRows);
    const grouped = groupBy === 'day' ? t.rows : groupDateTableRows(t.rows, groupBy);
    // The total row is worked out from the total spend / earn, not by adding the period percentages.
    return { rows: grouped.map((r) => withGst(r, gstPct / 100)), total: withGst(t.total, gstPct / 100) };
  }, [dailyRows, groupBy, gstPct]);
  const sorted = useMemo(() => (dir === 'desc' ? rows : [...rows].reverse()), [rows, dir]);

  const exportCsv = () => downloadCsv(
    exportName,
    [...cols.map((c) => (c.id === 'date' ? labels.date : c.label)), 'Earn by site / app'],
    [...sorted, total].map((r) => [
      ...cols.map((c) => render(r, c, currency)),
      (r.parts || []).map((p) => `${p.name}: ${formatRoiMoney(p.earn, currency)}`).join(' | '),
    ]),
  );

  // Excel gets real numbers (money / counts / percents) so the sheet can be summed and sorted.
  const excelValue = (r, c) => {
    if (c.id === 'date') return r.date || '';
    const v = r[c.id];
    if (v == null || !Number.isFinite(Number(v))) return '';
    return c.fmt === 'money' || c.fmt === 'ecpm' ? Math.round(convertRoi(v, currency) * 100) / 100 : Number(v);
  };
  const exportExcel = () => downloadExcel(
    exportName,
    [...cols.map((c) => (c.id === 'date' ? labels.date : c.label)), 'Earn by site / app'],
    [...sorted, total].map((r) => [
      ...cols.map((c) => excelValue(r, c)),
      (r.parts || []).map((p) => `${p.name}: ${formatRoiMoney(p.earn, currency)}`).join(' | '),
    ]),
    'ROI by date',
  );

  if (!loading && !rows.length) return null;

  return (
    <div className="filter-card roi-date-table" style={{ marginTop: 16 }}>
      <div className="filter-card-head">
        <span className="filter-card-title">{labels.title} — spend, earnings and ROI {titleSuffix}</span>
        <div className="filter-actions">
          <label className="roi-gst-input" title="GST charged on Ads spend">
            GST %
            <input type="number" min="0" max="100" step="0.1" value={gstText} onChange={onGst} />
          </label>
          {rows.length > 0 && (
            <>
              <button type="button" className="btn-reset table-tool-btn" onClick={exportCsv}>CSV</button>
              <button type="button" className="btn-reset table-tool-btn" onClick={exportExcel}>Excel</button>
            </>
          )}
        </div>
      </div>
      <div className="table-wrap">
        <table className="data-table responsive-table report-table reporting-table">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c.id}>
                  {c.id === 'date' ? (
                    <button type="button" className="th-sort-btn" onClick={() => setDir((d) => (d === 'desc' ? 'asc' : 'desc'))}>
                      <span>{labels.date}</span>
                      <span className="th-sort-icon" aria-hidden>{dir === 'desc' ? '▼' : '▲'}</span>
                    </button>
                  ) : c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && !rows.length ? (
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={i}>{cols.map((c) => <td key={c.id}><div className="skeleton" style={{ height: 16 }} /></td>)}</tr>
              ))
            ) : sorted.map((r) => (
              <tr key={r.date}>
                {cols.map((c) => (
                  <td
                    key={c.id}
                    data-label={c.label}
                    className={[c.tone ? roiToneClass(r[c.id]) : '', c.id === 'earn' ? 'roi-earn-cell' : ''].filter(Boolean).join(' ') || undefined}
                  >
                    {c.id === 'earn' ? (
                      <>
                        <div className="roi-earn-main">{render(r, c, currency)}</div>
                        {r.parts?.length > 0 && (
                          <div className="roi-earn-parts">
                            {r.parts.map((p) => (
                              <span key={`${p.type}|${p.name}`} className={`roi-earn-part roi-earn-part-${p.type}`} title={`${p.type === 'site' ? 'Site' : 'App'}: ${p.name}`}>
                                <span className="roi-earn-part-name">{p.name}</span>
                                <span className="roi-earn-part-amt">{formatRoiMoney(p.earn, currency)}</span>
                              </span>
                            ))}
                          </div>
                        )}
                      </>
                    ) : render(r, c, currency)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className="report-total-row">
                {cols.map((c) => (
                  <td key={c.id} className={c.tone ? roiToneClass(total[c.id]) || undefined : undefined}>
                    {render(total, c, currency)}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
