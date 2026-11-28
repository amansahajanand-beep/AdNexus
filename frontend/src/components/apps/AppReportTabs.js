import React, { useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Cell, ComposedChart, Line,
} from 'recharts';
import { Wallet, Receipt, Globe2, BarChart3, TrendingUp, CalendarRange, Megaphone, Hammer } from 'lucide-react';
import { StatusBadge, fmtInr, fmtUsd, fmtNum, fmtPct, fmtRatio } from './AppsShared';
import { SectionCard } from './AppReportSections';
import { CHART_GRID, CHART_AXIS_TICK, CHART_TOOLTIP_STYLE, CHART_SERIES } from '../../utils/chartTheme';

const axisInr = (v) => {
  const n = Math.abs(v);
  if (n >= 1e7) return `₹${(v / 1e7).toFixed(1)}Cr`;
  if (n >= 1e5) return `₹${(v / 1e5).toFixed(1)}L`;
  if (n >= 1e3) return `₹${(v / 1e3).toFixed(0)}k`;
  return `₹${Math.round(v)}`;
};
const signedInr = (n) => `${n < 0 ? '−' : '+'}₹${Math.round(Math.abs(n)).toLocaleString('en-IN')}`;

function Section({ title, right, icon, help, children }) {
  return <SectionCard icon={icon} title={title} help={help} right={right}>{children}</SectionCard>;
}

function Table({ head, children }) {
  return (
    <div className="ar-ledger-scroll">
      <table className="ar-table">
        <thead><tr>{head.map(([label, left]) => <th key={label} className={left ? 'left' : ''}>{label}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

// ─── Accounts ───────────────────────────────────────────────────────────────

export function AccountsTab({ report, rangeLabel, spanLabel }) {
  return (
    <>
      <Section icon={Wallet} help="Where this app's revenue is earned, per account." title={`Revenue accounts · ${rangeLabel}`} right={<span className="ar-muted">{spanLabel}</span>}>
        <Table head={[['Type', true], ['Account', true], ['Status', true], ['Gross $'], ['Share'], ['Deduction $'], ['Net income ₹']]}>
          {report.accountRows.map((a) => (
            <tr key={a.name}>
              <td className="left"><span className="ar-kind">{a.kind}</span></td>
              <td className="left"><b>{a.name}</b><small className="ar-sub">{a.sub}</small></td>
              <td className="left"><StatusBadge status={a.status} /></td>
              <td className="ar-mono">{fmtUsd(a.gross)}</td>
              <td><span className="apps-bar" style={{ width: Math.max(4, a.share * 1.2) }} />{fmtPct(a.share)}</td>
              <td className="ar-mono ar-muted">{fmtUsd(a.deduction)}</td>
              <td>{fmtInr(a.netInr)}</td>
            </tr>
          ))}
        </Table>
      </Section>
      <Section icon={Receipt} help="Where the ad money is spent, per platform." title={`Ad spend accounts · ${rangeLabel}`}>
        <Table head={[['Platform', true], ['Account', true], ['Share of spend'], ['Ad expense ₹'], ['GST ₹'], ['Total cost ₹']]}>
          {report.adAccountRows.map((a) => (
            <tr key={a.platform}>
              <td className="left"><b>{a.platform}</b></td>
              <td className="left ar-mono">{a.ref}</td>
              <td>{fmtPct(a.share)}</td>
              <td>{fmtInr(a.adExp)}</td>
              <td>{fmtInr(a.gst)}</td>
              <td>{fmtInr(a.total)}</td>
            </tr>
          ))}
        </Table>
      </Section>
    </>
  );
}

// ─── Countries ──────────────────────────────────────────────────────────────

export function CountriesTab({ detail, rangeLabel, spanLabel }) {
  return (
    <>
      <Section icon={Globe2} help="Which countries bring in the most revenue." title={`Revenue by country · ${rangeLabel}`} right={<span className="ar-muted">{spanLabel}</span>}>
        <div style={{ height: 300 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={detail.countries} layout="vertical" margin={{ top: 8, right: 16, left: 24, bottom: 0 }}>
              <CartesianGrid {...CHART_GRID} horizontal={false} />
              <XAxis type="number" tick={CHART_AXIS_TICK} tickFormatter={axisInr} />
              <YAxis type="category" dataKey="country" tick={CHART_AXIS_TICK} width={96} />
              <Tooltip contentStyle={CHART_TOOLTIP_STYLE} formatter={(v) => fmtInr(v)} />
              <Bar dataKey="revenueInr" name="Revenue" fill={CHART_SERIES.primary} radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Section>
      <Section icon={BarChart3} help="Revenue, expense and profit for each country." title="Country-wise performance">
        <Table head={[['Country', true], ['Revenue INR'], ['Revenue USD'], ['Expense'], ['Net profit'], ['ROAS'], ['Impressions'], ['eCPM'], ['Share']]}>
          {detail.countries.map((c) => (
            <tr key={c.code}>
              <td className="left">{c.country} <small className="ar-sub" style={{ display: 'inline' }}>({c.code})</small></td>
              <td>{fmtInr(c.revenueInr)}</td>
              <td className="ar-mono">{fmtUsd(c.revenueUsd)}</td>
              <td>{fmtInr(c.expense)}</td>
              <td className={c.profit < 0 ? 'ar-neg' : 'ar-pos'}>{signedInr(c.profit)}</td>
              <td>{fmtRatio(c.roas)}</td>
              <td>{fmtNum(c.impressions)}</td>
              <td className="ar-mono">{fmtUsd(c.ecpm)}</td>
              <td><span className="apps-bar" style={{ width: Math.max(4, c.share * 1.2) }} />{fmtPct(c.share)}</td>
            </tr>
          ))}
        </Table>
      </Section>
    </>
  );
}

// ─── Projection ─────────────────────────────────────────────────────────────

export function ProjectionTab({ projection }) {
  const p = projection;
  return (
    <>
      <p className="ar-note ar-note--top">
        Projection uses the last 7 days as the run-rate for the rest of {p.monthKey}, and the last 30 days for the next
        months. It is independent of the date filter and is a rough guide, not a promise.
      </p>
      <div className="ar-kpis">
        {[
          ['Month to date', p.mtd],
          ['Run-rate / day (last 7d)', p.runRate],
          [`Projected ${p.monthKey} end`, p.projectedEnd],
        ].map(([label, v]) => (
          <div key={label} className="ar-card ar-kpi">
            <div className="ar-eyebrow">{label}</div>
            <div className={`ar-kpi-val ${v.profit < 0 ? 'ar-neg' : 'ar-pos'}`}>{signedInr(v.profit)}</div>
            <div className="ar-kpi-sub">revenue {fmtInr(v.revenue)} · expense {fmtInr(v.expense)}</div>
          </div>
        ))}
        <div className="ar-card ar-kpi">
          <div className="ar-eyebrow">Days left this month</div>
          <div className="ar-kpi-val">{p.daysLeft}</div>
          <div className="ar-kpi-sub">projected days are shown lighter in the chart</div>
        </div>
      </div>
      <Section icon={TrendingUp} help="Lighter bars are projected days." title={`Profit by day · ${p.monthKey} (actual + projected)`}>
        <div style={{ height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={p.chart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid {...CHART_GRID} vertical={false} />
              <XAxis dataKey="label" tick={CHART_AXIS_TICK} interval="preserveStartEnd" />
              <YAxis tick={CHART_AXIS_TICK} tickFormatter={axisInr} />
              <Tooltip contentStyle={CHART_TOOLTIP_STYLE} formatter={(v) => fmtInr(v)} />
              <Legend />
              <Bar dataKey="profit" name="Profit ₹" radius={[3, 3, 0, 0]}>
                {p.chart.map((r) => (
                  <Cell key={r.label} fill={r.profit < 0 ? CHART_SERIES.danger : CHART_SERIES.secondary} fillOpacity={r.projected ? 0.4 : 1} />
                ))}
              </Bar>
              <Line type="monotone" dataKey="revenue" name="Revenue ₹" stroke={CHART_SERIES.primary} strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </Section>
      <Section icon={CalendarRange} help="Estimated from the last 30 days." title="Next 3 months (run-rate projection)">
        <Table head={[['Month', true], ['Revenue ₹'], ['Expense ₹'], ['Profit ₹'], ['ROAS']]}>
          {p.nextMonths.map((m) => (
            <tr key={m.month}>
              <td className="left ar-mono">{m.month}</td>
              <td>{fmtInr(m.revenue)}</td>
              <td>{fmtInr(m.expense)}</td>
              <td className={m.profit < 0 ? 'ar-neg' : 'ar-pos'}>{signedInr(m.profit)}</td>
              <td>{fmtRatio(m.roas)}</td>
            </tr>
          ))}
        </Table>
      </Section>
    </>
  );
}

// ─── Campaign building ──────────────────────────────────────────────────────

const PLATFORMS = ['Google Ads', 'Meta Ads'];
const COUNTRIES = ['United States', 'India', 'United Kingdom', 'Germany', 'Brazil', 'Indonesia', 'Canada', 'Australia'];

export function CampaignsTab({ campaigns, appName, rangeLabel, spanLabel }) {
  // drafts live in component state only (session) — nothing is saved anywhere
  const [drafts, setDrafts] = useState([]);
  const [form, setForm] = useState({
    name: '', platform: PLATFORMS[0], country: COUNTRIES[0], budget: '',
  });
  const [err, setErr] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const add = (e) => {
    e.preventDefault();
    const budget = Number(form.budget);
    if (!form.name.trim()) { setErr('Enter a campaign name.'); return; }
    if (!Number.isFinite(budget) || budget <= 0) { setErr('Enter a daily budget greater than 0.'); return; }
    setErr('');
    setDrafts((d) => [...d, {
      id: `draft-${d.length + 1}`, name: form.name.trim(), platform: form.platform, country: form.country, budget,
    }]);
    setForm({
      name: '', platform: PLATFORMS[0], country: COUNTRIES[0], budget: '',
    });
  };

  const totals = campaigns.reduce((s, c) => ({
    spend: s.spend + c.spend, installs: s.installs + c.installs, revenue: s.revenue + c.revenue,
  }), { spend: 0, installs: 0, revenue: 0 });

  return (
    <>
      <Section icon={Megaphone} help="Running campaigns and any drafts you add here." title={`Campaigns · ${rangeLabel}`} right={<span className="ar-muted">{spanLabel}</span>}>
        <Table head={[['Campaign', true], ['Platform', true], ['Country', true], ['Status', true], ['Daily budget ₹'], ['Spend ₹'], ['Installs'], ['CPI ₹'], ['Revenue ₹'], ['ROAS']]}>
          {campaigns.map((c) => (
            <tr key={c.id}>
              <td className="left"><b>{c.name}</b></td>
              <td className="left">{c.platform}</td>
              <td className="left">{c.country}</td>
              <td className="left"><StatusBadge status={c.status} /></td>
              <td>{fmtInr(c.budget)}</td>
              <td>{fmtInr(c.spend)}</td>
              <td>{fmtNum(c.installs)}</td>
              <td>{fmtInr(c.cpi)}</td>
              <td>{fmtInr(c.revenue)}</td>
              <td>{fmtRatio(c.roas)}</td>
            </tr>
          ))}
          {drafts.map((c) => (
            <tr key={c.id} className="is-draft">
              <td className="left"><b>{c.name}</b></td>
              <td className="left">{c.platform}</td>
              <td className="left">{c.country}</td>
              <td className="left"><span className="apps-badge apps-badge--signal-optimize">Draft</span></td>
              <td>{fmtInr(c.budget)}</td>
              <td><span className="ar-dash">—</span></td>
              <td><span className="ar-dash">—</span></td>
              <td><span className="ar-dash">—</span></td>
              <td><span className="ar-dash">—</span></td>
              <td><span className="ar-dash">—</span></td>
            </tr>
          ))}
          <tr className="is-total">
            <td className="left" colSpan={5}>Total (running campaigns)</td>
            <td>{fmtInr(totals.spend)}</td>
            <td>{fmtNum(totals.installs)}</td>
            <td>{totals.installs ? fmtInr(totals.spend / totals.installs) : '—'}</td>
            <td>{fmtInr(totals.revenue)}</td>
            <td>{totals.spend ? fmtRatio(totals.revenue / totals.spend) : '—'}</td>
          </tr>
        </Table>
      </Section>
      <Section icon={Hammer} help="Fill in the form to add a draft campaign (not saved anywhere)." title={`Build a campaign for ${appName}`}>
        <form className="ar-form" onSubmit={add}>
          <label>Campaign name<input type="text" value={form.name} onChange={set('name')} placeholder="e.g. Holiday push · US" /></label>
          <label>Platform
            <select value={form.platform} onChange={set('platform')}>{PLATFORMS.map((p) => <option key={p}>{p}</option>)}</select>
          </label>
          <label>Country
            <select value={form.country} onChange={set('country')}>{COUNTRIES.map((p) => <option key={p}>{p}</option>)}</select>
          </label>
          <label>Daily budget ₹<input type="number" min="1" value={form.budget} onChange={set('budget')} placeholder="1500" /></label>
          <button type="submit" className="ar-refresh">Add draft campaign</button>
        </form>
        {err ? <p className="ar-note ar-neg">{err}</p> : null}
        <p className="ar-note">Drafts are kept in this page only (mock) — nothing is sent to Google Ads or Meta.</p>
      </Section>
    </>
  );
}
