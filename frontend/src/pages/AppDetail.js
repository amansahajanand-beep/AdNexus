import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  Bar, BarChart, Line, LineChart, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Cell, PieChart, Pie,
} from 'recharts';
import {
  CalendarDays, BarChart3, Layers, Calendar, CalendarRange, ArrowUp,
} from 'lucide-react';
import {
  AppKpiStrip, fmtInr, fmtUsd, fmtNum, fmtPct, fmtRatio,
} from '../components/apps/AppsShared';
import AppsDateBar, { useAppsRange } from '../components/apps/AppsDateBar';
import {
  AppSwitcherBar, BackLink, AppHeaderCard, TodayCard, SummaryCards, PulseCard, InsightsCard, LedgerTable, WebsiteLinks,
  SectionCard, JumpNav, REPORT_TABS,
} from '../components/apps/AppReportSections';
import {
  AccountsTab, CountriesTab, ProjectionTab, CampaignsTab,
} from '../components/apps/AppReportTabs';
import { CHART_COLORS, CHART_GRID, CHART_AXIS_TICK, CHART_TOOLTIP_STYLE, CHART_SERIES } from '../utils/chartTheme';
import { getAllApps, getAppDetail, getRangeInfo } from '../mocks/appsData';
import { getAppLedger, getAppReport } from '../mocks/appReport';
import './Apps.css';
import './AppReport.css';
import './AppDetailUx.css';

const axisInr = (v) => {
  const n = Math.abs(v);
  if (n >= 1e7) return `₹${(v / 1e7).toFixed(1)}Cr`;
  if (n >= 1e5) return `₹${(v / 1e5).toFixed(1)}L`;
  if (n >= 1e3) return `₹${(v / 1e3).toFixed(0)}k`;
  return `₹${Math.round(v)}`;
};

const TAB_IDS = REPORT_TABS.map((t) => t.id);

const JUMP_ITEMS = [
  { id: 'sec-today', label: "Today's data" },
  { id: 'sec-kpis', label: 'Key numbers' },
  { id: 'sec-pulse', label: 'Pulse' },
  { id: 'sec-insights', label: 'Insights' },
  { id: 'sec-performance', label: 'Performance' },
  { id: 'sec-yearly', label: 'Year-wise' },
  { id: 'sec-monthly', label: 'Monthly' },
  { id: 'sec-daily', label: 'Daily detail' },
  { id: 'sec-websites', label: 'Websites' },
];

function ChartCard({ title, children, height = 260 }) {
  return (
    <section className="chart-card">
      <div className="chart-card-head"><h4 className="chart-card-title">{title}</h4></div>
      <div className="chart-card-body" style={{ height }}>{children}</div>
    </section>
  );
}

export default function AppDetail() {
  const { appId } = useParams();
  const [range, setRange] = useAppsRange();
  const [params, setParams] = useSearchParams();
  const topRef = useRef(null);
  const rawTab = params.get('tab');
  const tab = TAB_IDS.includes(rawTab) ? rawTab : 'report';
  const setTab = (t) => setParams((prev) => {
    const p = new URLSearchParams(prev);
    if (t === 'report') p.delete('tab'); else p.set('tab', t);
    return p;
  }, { replace: true });

  const rangeInfo = getRangeInfo(range);
  const detail = useMemo(() => getAppDetail(appId, range), [appId, range]);
  const ledger = useMemo(() => getAppLedger(appId), [appId]);
  const report = useMemo(() => getAppReport(appId, range), [appId, range]);
  const allApps = useMemo(() => getAllApps(range), [range]);

  const [granPick, setGranPick] = useState(null);
  // Long report tables start collapsed so the page is not overwhelming; "On this page" opens them.
  const [open, setOpen] = useState({
    insights: true, performance: true, yearly: true, monthly: false, daily: false, websites: true,
  });
  const toggle = (k) => () => setOpen((o) => ({ ...o, [k]: !o[k] }));

  const defaultMonth = useMemo(() => {
    if (!ledger) return null;
    const opts = ledger.monthOptions;
    return range === 'lastMonth' ? opts[opts.length - 2].key : opts[opts.length - 1].key;
  }, [ledger, range]);
  const [month, setMonth] = useState(defaultMonth);
  const [year, setYear] = useState(ledger ? ledger.years[ledger.years.length - 1] : null);
  useEffect(() => { setMonth(defaultMonth); }, [defaultMonth, appId]);
  useEffect(() => { if (ledger) setYear(ledger.years[ledger.years.length - 1]); }, [ledger]);

  const jump = (id) => {
    const key = { 'sec-insights': 'insights', 'sec-performance': 'performance', 'sec-yearly': 'yearly', 'sec-monthly': 'monthly', 'sec-daily': 'daily', 'sec-websites': 'websites' }[id];
    if (key) setOpen((o) => ({ ...o, [key]: true }));
    setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30);
  };
  const toTop = () => topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  if (!detail || !ledger || !report) {
    return (
      <div className="apps-page">
        <BackLink range={range} />
        <div className="apps-notfound">
          <h3>App not found</h3>
          <p>No app with ID “{appId}” exists.</p>
        </div>
      </div>
    );
  }

  const gran = detail.granOptions.includes(granPick) ? granPick : detail.defaultGran;
  const series = detail.series[gran];
  const monthIdx = ledger.monthOptions.findIndex((m) => m.key === month);
  const monthRows = ledger.dailyByMonth[month] || [];
  const stepMonth = (d) => {
    const next = ledger.monthOptions[monthIdx + d];
    if (next) setMonth(next.key);
  };
  const ledgerCommon = { columns: ledger.columns, dedPct: ledger.dedPct, dedFeePct: ledger.dedFeePct };

  return (
    <div className="apps-page ar-page" key={detail.id} ref={topRef}>
      <AppSwitcherBar apps={allApps} slug={detail.slug} range={range} tab={tab} />
      <BackLink range={range} name={detail.name} />

      <AppHeaderCard header={ledger.header} signal={detail.signal} tab={tab} onTab={setTab} />

      <div className="ar-period">
        <span className="ar-period-label"><CalendarDays size={15} aria-hidden /> Period</span>
        <AppsDateBar value={range} onChange={setRange} />
      </div>

      {tab === 'report' && (
        <>
          <JumpNav items={JUMP_ITEMS} onJump={jump} />

          <TodayCard today={ledger.today} />
          <SummaryCards cards={report.cards} />
          <PulseCard
            pulse={report.pulse}
            series={series}
            gran={gran}
            granOptions={detail.granOptions}
            onGran={setGranPick}
          />
          <InsightsCard insights={report.insights} open={open.insights} onToggle={toggle('insights')} />

          <SectionCard
            id="sec-performance"
            icon={BarChart3}
            title={`Performance · ${rangeInfo.label}`}
            help="Key metrics and trends for the selected period, compared with the one before it."
            right={<span className="ar-muted">{rangeInfo.spanLabel}</span>}
            open={open.performance}
            onToggle={toggle('performance')}
          >
            <AppKpiStrip kpis={detail.kpis} idPrefix={`app-${detail.id}`} compareLabel={rangeInfo.compareLabel} />
            <div className="charts-grid" style={{ marginTop: 16 }}>
              <ChartCard title="Net profit (INR)">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={series} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                    <CartesianGrid {...CHART_GRID} />
                    <XAxis dataKey="label" tick={CHART_AXIS_TICK} interval="preserveStartEnd" />
                    <YAxis tick={CHART_AXIS_TICK} tickFormatter={axisInr} width={52} />
                    <Tooltip contentStyle={CHART_TOOLTIP_STYLE} formatter={(v) => fmtInr(v)} />
                    <Bar dataKey="profit" name="Net profit" radius={[3, 3, 0, 0]}>
                      {series.map((r) => <Cell key={r.label} fill={r.profit >= 0 ? CHART_SERIES.secondary : CHART_SERIES.danger} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>
              <ChartCard title="ROAS">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={series} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                    <CartesianGrid {...CHART_GRID} />
                    <XAxis dataKey="label" tick={CHART_AXIS_TICK} interval="preserveStartEnd" />
                    <YAxis tick={CHART_AXIS_TICK} tickFormatter={(v) => `${v}x`} width={40} />
                    <Tooltip contentStyle={CHART_TOOLTIP_STYLE} formatter={(v) => fmtRatio(v)} />
                    <Line type="monotone" dataKey="roas" name="ROAS" stroke={CHART_SERIES.accent} strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </ChartCard>
              <ChartCard title="Revenue share by ad network">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={detail.networks} dataKey="revenueUsd" nameKey="network" innerRadius="52%" outerRadius="80%" paddingAngle={2}>
                      {detail.networks.map((n, i) => <Cell key={n.network} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                    </Pie>
                    <Tooltip contentStyle={CHART_TOOLTIP_STYLE} formatter={(v) => fmtUsd(v)} />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </ChartCard>
              <div className="chart-card ar-netcard">
                <div className="chart-card-head"><h4 className="chart-card-title">Ad network performance</h4></div>
                <div className="ar-ledger-scroll">
                  <table className="ar-table">
                    <thead>
                      <tr>
                        <th className="left">Ad network</th><th>Revenue USD</th><th>Impressions</th><th>Fill rate</th><th>eCPM</th><th>Share</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.networks.map((n) => (
                        <tr key={n.network}>
                          <td className="left">{n.network}</td>
                          <td className="ar-mono">{fmtUsd(n.revenueUsd)}</td>
                          <td>{fmtNum(n.impressions)}</td>
                          <td>{fmtPct(n.fillRate)}</td>
                          <td className="ar-mono">{fmtUsd(n.ecpm)}</td>
                          <td>{fmtPct(n.share)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </SectionCard>

          <LedgerTable
            {...ledgerCommon}
            id="sec-yearly"
            icon={Layers}
            title="Year-wise"
            help="Totals for each year, all periods. Not affected by the date filter."
            firstCol="Year"
            rows={ledger.yearly}
            open={open.yearly}
            onToggle={toggle('yearly')}
          />

          <LedgerTable
            {...ledgerCommon}
            id="sec-monthly"
            icon={CalendarRange}
            title="Monthly"
            help="Month-by-month totals for the chosen year."
            firstCol="Month"
            rows={ledger.monthlyByYear[year] || []}
            open={open.monthly}
            onToggle={toggle('monthly')}
            controls={(
              <select value={year || ''} onChange={(e) => setYear(e.target.value)} aria-label="Year">
                {ledger.years.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            )}
          />

          <LedgerTable
            {...ledgerCommon}
            id="sec-daily"
            icon={Calendar}
            title="Daily detail"
            help="Day-by-day numbers for one month, with a month total."
            firstCol="Date"
            rows={monthRows}
            open={open.daily}
            onToggle={toggle('daily')}
            controls={(
              <>
                <button type="button" className="ar-iconbtn" disabled={monthIdx <= 0} onClick={() => stepMonth(-1)} aria-label="Previous month">‹</button>
                <select value={month || ''} onChange={(e) => setMonth(e.target.value)} aria-label="Month">
                  {ledger.monthOptions.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                </select>
                <button type="button" className="ar-iconbtn" disabled={monthIdx >= ledger.monthOptions.length - 1} onClick={() => stepMonth(1)} aria-label="Next month">›</button>
              </>
            )}
            footnote={`Day-wise data starts from ${ledger.monthOptions[0].key}. Account and link columns are in $ (gross, before deduction). Deduction is summed per column; Total income ₹ = revenue after deduction at ₹83.5 per US$. Percentage (%) = profit ÷ total expense — in the total row too (total profit ÷ total expense).`}
          />

          <WebsiteLinks websites={ledger.websites} open={open.websites} onToggle={toggle('websites')} />
        </>
      )}

      {tab === 'accounts' && <AccountsTab report={report} rangeLabel={rangeInfo.label} spanLabel={rangeInfo.spanLabel} />}
      {tab === 'countries' && <CountriesTab detail={detail} rangeLabel={rangeInfo.label} spanLabel={rangeInfo.spanLabel} />}
      {tab === 'projection' && <ProjectionTab projection={report.projection} />}
      {tab === 'campaigns' && (
        <CampaignsTab
          key={detail.id}
          campaigns={report.campaigns}
          appName={detail.name}
          rangeLabel={rangeInfo.label}
          spanLabel={rangeInfo.spanLabel}
        />
      )}

      <button type="button" className="ar-totop" onClick={toTop}><ArrowUp size={14} aria-hidden /> Back to top</button>
    </div>
  );
}
