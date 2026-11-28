import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, AreaChart, Area,
} from 'recharts';
import {
  BarChart3, Wallet, Globe2, TrendingUp, Megaphone, ChevronDown, Info, Leaf, BadgeDollarSign,
  Clock, RefreshCw, PiggyBank, Receipt, CircleDollarSign, Gauge, Activity, Lightbulb, Link2, ChevronLeft, ChevronRight,
} from 'lucide-react';
import { StatusBadge, SignalBadge, fmtInr, fmtRatio } from './AppsShared';
import { appsListPath, appDetailPath } from './AppsDateBar';
import { CHART_GRID, CHART_AXIS_TICK, CHART_TOOLTIP_STYLE, CHART_SERIES } from '../../utils/chartTheme';

const inr0 = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const signedInr = (n) => `${n < 0 ? '−' : '+'}₹${Math.round(Math.abs(n)).toLocaleString('en-IN')}`;
const hhmm = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')} IST`;
const axisInr = (v) => {
  const n = Math.abs(v);
  if (n >= 1e7) return `₹${(v / 1e7).toFixed(1)}Cr`;
  if (n >= 1e5) return `₹${(v / 1e5).toFixed(1)}L`;
  if (n >= 1e3) return `₹${(v / 1e3).toFixed(0)}k`;
  return `₹${Math.round(v)}`;
};

// ─── generic section card (optionally collapsible) ──────────────────────────

/**
 * Titled card used for every section of the detail page: icon + title + one-line help text, optional right-hand
 * controls, and (when onToggle is given) a Show/Hide toggle.
 */
export function SectionCard({
  id, icon: Icon, title, help, right, open = true, onToggle, children, className = '',
}) {
  const collapsible = typeof onToggle === 'function';
  const heading = (
    <>
      {Icon ? <span className="ar-sec-icon" aria-hidden><Icon size={16} /></span> : null}
      <span className="ar-sec-titles">
        <span className="ar-sec-title">{title}</span>
        {help ? <span className="ar-sec-help">{help}</span> : null}
      </span>
    </>
  );
  return (
    <section id={id} className={`ar-card ar-sec${open ? '' : ' is-closed'} ${className}`.trim()}>
      <div className="ar-sec-head">
        <h3 className="ar-sec-h">
          {collapsible ? (
            <button type="button" className="ar-sec-toggle" onClick={onToggle} aria-expanded={open} aria-controls={id ? `${id}-body` : undefined}>
              {heading}
              <span className="ar-sec-chev">{open ? 'Hide' : 'Show'}<ChevronDown size={16} aria-hidden /></span>
            </button>
          ) : <span className="ar-sec-toggle ar-sec-static">{heading}</span>}
        </h3>
        {right && open ? <div className="ar-sec-right">{right}</div> : null}
      </div>
      {open ? <div id={id ? `${id}-body` : undefined} className="ar-sec-body">{children}</div> : null}
    </section>
  );
}

/** Small "i" icon with a plain-language tooltip. */
function Hint({ text }) {
  return <span className="ar-hint" title={text} aria-label={text} role="img"><Info size={13} aria-hidden /></span>;
}

// ─── switcher bar, breadcrumb, header ───────────────────────────────────────

export const REPORT_TABS = [
  { id: 'report', label: 'Report', icon: BarChart3, hint: 'Summary, charts, insights and all report tables' },
  { id: 'accounts', label: 'Accounts', icon: Wallet, hint: 'Revenue and ad-spend accounts' },
  { id: 'countries', label: 'Countries', icon: Globe2, hint: 'Where the revenue comes from' },
  { id: 'projection', label: 'Projection', icon: TrendingUp, hint: 'Where this month is heading' },
  { id: 'campaigns', label: 'Campaign Building', icon: Megaphone, hint: 'Campaigns and drafts' },
];

export function AppSwitcherBar({ apps, slug, range, tab }) {
  const navigate = useNavigate();
  const i = apps.findIndex((a) => a.slug === slug);
  const go = (k) => { if (apps[k]) navigate(appDetailPath(apps[k].slug, range, tab)); };
  return (
    <div className="ar-switcher">
      <button type="button" className="ar-iconbtn" disabled={i <= 0} onClick={() => go(i - 1)} aria-label="Previous app" title="Previous app"><ChevronLeft size={18} /></button>
      <select
        className="ar-switcher-select"
        value={slug}
        onChange={(e) => navigate(appDetailPath(e.target.value, range, tab))}
        aria-label="Switch app"
      >
        {apps.map((a) => <option key={a.id} value={a.slug}>{a.id.replace('APP-', '')} · {a.name}</option>)}
      </select>
      <button type="button" className="ar-iconbtn" disabled={i < 0 || i >= apps.length - 1} onClick={() => go(i + 1)} aria-label="Next app" title="Next app"><ChevronRight size={18} /></button>
      <span className="ar-switcher-count" title="Position in the Apps list">{i + 1} / {apps.length}</span>
    </div>
  );
}

export function BackLink({ range, name }) {
  return (
    <nav className="ar-crumbs" aria-label="Breadcrumb">
      <Link to={appsListPath(range)} className="apps-back">← All Apps</Link>
      {name ? <><span aria-hidden>/</span><span className="ar-crumb-current">{name}</span></> : null}
    </nav>
  );
}

export function AppHeaderCard({ header, signal, tab, onTab }) {
  return (
    <section className="ar-card ar-head">
      <div className="ar-head-top">
        <div className="ar-idbadge" title={`App ID ${header.idNumber}`}>
          <small>ID</small>{header.idNumber}
        </div>
        <div className="ar-head-main">
          <h2 className="ar-title">{header.name}</h2>
          <div className="ar-chips">
            {header.storeLinks ? (
              <>
                <a className="ar-chip ar-chip--link" href={header.storeLinks.organic} target="_blank" rel="noopener noreferrer" title="Open the Google Play page (organic)">
                  <Leaf size={13} aria-hidden /> Organic ↗
                </a>
                <a className="ar-chip ar-chip--paid ar-chip--link" href={header.storeLinks.paid} target="_blank" rel="noopener noreferrer" title="Open the Google Play page with Google Ads tracking (paid)">
                  <BadgeDollarSign size={13} aria-hidden /> Paid ↗
                </a>
              </>
            ) : (
              <>
                {header.organic ? <span className="ar-chip" title="Gets organic (unpaid) installs"><Leaf size={13} aria-hidden /> Organic</span> : null}
                {header.paid ? <span className="ar-chip ar-chip--paid" title="Runs paid ad campaigns"><BadgeDollarSign size={13} aria-hidden /> Paid</span> : null}
              </>
            )}
          </div>
          <div className="ar-pkg" title="Package name">{header.packageName}</div>
        </div>
        <div className="ar-head-side">
          <div className="ar-labeled"><span>Status</span><StatusBadge status={header.status} /></div>
          <div className="ar-labeled"><span>Signal</span><SignalBadge signal={signal} /></div>
        </div>
      </div>
      <dl className="ar-people">
        <div><dt>Partner</dt><dd>{header.partner}</dd></div>
      </dl>
      <div className="ar-tabs" role="tablist" aria-label="App sections">
        {REPORT_TABS.map((t) => {
          const TabIcon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              title={t.hint}
              aria-selected={tab === t.id}
              className={tab === t.id ? 'is-active' : ''}
              onClick={() => onTab(t.id)}
            >
              <TabIcon size={15} aria-hidden />{t.label}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** "On this page" quick links for the Report tab. */
export function JumpNav({ items, onJump }) {
  return (
    <nav className="ar-jump" aria-label="On this page">
      <span className="ar-jump-label">On this page</span>
      <div className="ar-jump-items">
        {items.map((it) => (
          <button key={it.id} type="button" onClick={() => onJump(it.id)}>{it.label}</button>
        ))}
      </div>
    </nav>
  );
}

// ─── today's data ───────────────────────────────────────────────────────────

export function TodayCard({ today }) {
  const [bump, setBump] = useState(0);
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    if (busy) return;
    setBusy(true);
    setTimeout(() => { setBump((b) => b + 1); setBusy(false); }, 600);
  };
  const shift = (m) => (m === null ? null : m + bump * 2);
  return (
    <section id="sec-today" className="ar-card ar-today">
      <div className="ar-today-main">
        <div className="ar-eyebrow"><Clock size={13} aria-hidden /> Today's data · as of {hhmm(today.asOf + bump * 2)}</div>
        <div className="ar-sources" aria-label="Last update time per data source">
          {today.sources.map((s) => (
            <span key={s.name} className={s.at === null ? 'is-missing' : ''}>
              <b>{s.name}</b> <em>{s.at === null ? 'no update' : hhmm(shift(s.at))}</em>
            </span>
          ))}
        </div>
      </div>
      <button type="button" className="ar-refresh" onClick={refresh} disabled={busy}>
        <RefreshCw size={14} className={busy ? 'is-spinning' : ''} aria-hidden />{busy ? 'Refreshing…' : 'Refresh today'}
      </button>
    </section>
  );
}

// ─── KPI cards ──────────────────────────────────────────────────────────────

export function SummaryCards({ cards }) {
  const lifetime = cards.rangeLabel === 'Lifetime';
  const pos = cards.profit >= 0;
  return (
    <div id="sec-kpis" className="ar-kpis">
      <div className="ar-card ar-kpi ar-kpi--profit">
        <span className="ar-kpi-icon" aria-hidden><PiggyBank size={18} /></span>
        <div className="ar-eyebrow">{lifetime ? 'Lifetime net profit' : `Net profit · ${cards.rangeLabel}`}<Hint text="What is left after all expenses: total income minus total expense." /></div>
        <div className={`ar-kpi-val ${pos ? 'ar-pos' : 'ar-neg'}`}>{signedInr(cards.profit)}</div>
        <div className="ar-kpi-sub">
          {cards.profitPct === null ? '—' : `${cards.profitPct.toFixed(1)}%`} of expense · (profit ÷ expense)
        </div>
      </div>
      <div className="ar-card ar-kpi ar-kpi--expense">
        <span className="ar-kpi-icon" aria-hidden><Receipt size={18} /></span>
        <div className="ar-eyebrow">Total expense<Hint text="Everything spent on ads, plus 18% GST." /></div>
        <div className="ar-kpi-val">{inr0(cards.expense)}</div>
        <div className="ar-kpi-sub">Ads {inr0(cards.adExp)} + GST {inr0(cards.gst)}</div>
      </div>
      <div className="ar-card ar-kpi ar-kpi--income">
        <span className="ar-kpi-icon" aria-hidden><CircleDollarSign size={18} /></span>
        <div className="ar-eyebrow">Revenue · after deduction<Hint text="Money earned after the platform's deduction is taken out. This is your total income." /></div>
        <div className="ar-kpi-val">{inr0(cards.incomeAfter)}</div>
        <div className="ar-kpi-sub">
          before deduction {inr0(cards.incomeBefore)} · deduction {inr0(cards.deductionInr)} · ${cards.deductionUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
      </div>
      <div className="ar-card ar-kpi ar-kpi--roas">
        <span className="ar-kpi-icon" aria-hidden><Gauge size={18} /></span>
        <div className="ar-eyebrow">ROAS<Hint text="Return on ad spend: rupees earned for every ₹1 spent. Above 1.00× means the app earns more than it costs." /></div>
        <div className="ar-kpi-val">{cards.expense ? fmtRatio(cards.roas) : '—'}</div>
        <div className="ar-kpi-sub">needs 1.00× to break even · {cards.rangeLabel.toLowerCase()} {cards.expense ? fmtRatio(cards.roas) : '—'}</div>
        {cards.roasSpark.length > 1 ? (
          <div className="ar-kpi-spark" aria-hidden>
            <ResponsiveContainer width="100%" height={28}>
              <AreaChart data={cards.roasSpark} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
                <Area type="monotone" dataKey="v" stroke={CHART_SERIES.secondary} strokeWidth={1.5} fill="transparent" isAnimationActive={false} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ─── pulse + day-by-day ─────────────────────────────────────────────────────

const GRAN_LABEL = { hourly: 'Hourly', daily: 'Daily', monthly: 'Monthly' };

export function PulseCard({ pulse, series, gran, granOptions, onGran }) {
  const pos = pulse.profit >= 0;
  const unit = gran === 'hourly' ? 'hour' : gran === 'monthly' ? 'month' : 'day';
  return (
    <section id="sec-pulse" className="ar-card ar-pulse">
      <div className="ar-pulse-left">
        <div className="ar-eyebrow"><Activity size={13} aria-hidden /> Pulse · {pulse.rangeLabel}<Hint text="A quick read on how this app is doing in the selected period." /></div>
        <div className={`ar-pulse-val ${pos ? 'ar-pos' : 'ar-neg'}`}>{signedInr(pulse.profit)}</div>
        <div className="ar-chips">
          <span className={`ar-pill ${pos ? 'ar-pill--pos' : 'ar-pill--neg'}`}>Profit {pulse.rangeLabel.toLowerCase()}</span>
          <span className="ar-pill">spend {inr0(pulse.spend)}</span>
          <span className="ar-pill ar-pill--pos">revenue {inr0(pulse.revenue)}</span>
        </div>
        <p className="ar-pulse-text">
          <b>{pulse.spanLabel}:</b> {pulse.spend ? `spend ${inr0(pulse.spend)}` : 'No ad spend'} — profit {signedInr(pulse.profit)}.{' '}
          <span>ROAS {pulse.roas.toFixed(2)}× over {pulse.activeDays} active {pulse.activeDays === 1 ? 'day' : 'days'}.</span>{' '}
          <SignalBadge signal={pulse.signal} />
          <span className="ar-muted"> Scale: ROAS ≥ 2.00 · Optimize: 1.30–2.00 · Watch: below 1.30 · Pause: loss below 0.80.</span>
        </p>
      </div>
      <div className="ar-pulse-right">
        <div className="ar-pulse-chart-head">
          <div className="ar-eyebrow">{unit === 'hour' ? 'Hour by hour' : unit === 'month' ? 'Month by month' : 'Day by day'} · {pulse.spanLabel}</div>
          {granOptions.length > 1 ? (
            <div className="apps-segment" role="group" aria-label="Chart granularity">
              {granOptions.map((g) => (
                <button key={g} type="button" className={gran === g ? 'is-active' : ''} onClick={() => onGran(g)}>{GRAN_LABEL[g]}</button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="ar-chart-box">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid {...CHART_GRID} vertical={false} />
              <XAxis dataKey="label" tick={CHART_AXIS_TICK} interval="preserveStartEnd" />
              <YAxis tick={CHART_AXIS_TICK} tickFormatter={axisInr} width={52} />
              <Tooltip contentStyle={CHART_TOOLTIP_STYLE} formatter={(v) => fmtInr(v)} />
              <Legend />
              <Bar dataKey="revenueInr" name="Revenue ₹" fill={CHART_SERIES.secondary} radius={[3, 3, 0, 0]} />
              <Bar dataKey="expense" name="Expense ₹" fill={CHART_SERIES.accent} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </section>
  );
}

// ─── insights ───────────────────────────────────────────────────────────────

const TONE_LABEL = { ok: 'OK', warn: 'WATCH', bad: 'RISK' };

export function InsightsCard({ insights, open, onToggle }) {
  return (
    <SectionCard
      id="sec-insights"
      icon={Lightbulb}
      title="Insights"
      help="Plain-language highlights worked out from this app's numbers."
      open={open}
      onToggle={onToggle}
      className="ar-insights"
    >
      <ul>
        {insights.map((it) => (
          <li key={it.title}>
            <span className={`ar-tone ar-tone--${it.tone}`}>{TONE_LABEL[it.tone]}</span>
            <div>
              <div className="ar-insight-title">{it.title}</div>
              <div className="ar-insight-sub">{it.sub}</div>
            </div>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

// ─── ledger tables (year / month / day) ─────────────────────────────────────

const usd2 = (n) => (n ? `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null);

function Cell({ v, fmt }) {
  const out = v === null || v === undefined || v === 0 ? null : fmt(v);
  return out ? <>{out}</> : <span className="ar-dash">—</span>;
}

export function LedgerTable({
  id, icon, title, help, firstCol, rows, columns, dedFeePct, dedPct, controls, footnote, note, open, onToggle,
}) {
  const taxPct = dedPct - dedFeePct;
  return (
    <SectionCard id={id} icon={icon} title={title} help={help} right={controls} open={open} onToggle={onToggle} className="ar-ledger">
      {note ? <p className="ar-note ar-note--top">{note}</p> : null}
      <div className="ar-ledger-scroll">
        <table className="ar-table">
          <thead>
            <tr>
              <th className="left">{firstCol}</th>
              <th title="Money spent on ads">Ad exp ₹</th>
              <th title="18% tax on ad spend">GST ₹</th>
              <th title="Ad expense + GST">Total expense ₹</th>
              {columns.map((c) => (
                <th key={c.id} className="ar-acct-th" title={`Revenue earned through ${c.name}, in US dollars (before deduction)`}>
                  <span className="ar-kind">{c.kind} · $</span>
                  <b>{c.name}</b>
                  <small>{c.sub}</small>
                </th>
              ))}
              <th className="ar-acct-th" title="Amount taken out of gross revenue before it reaches you">
                <b>Deduction $</b>
                <small>Platform fee ({(dedFeePct * 100).toFixed(1)}%)</small>
                <small>Tax &amp; other ({(taxPct * 100).toFixed(1)}%)</small>
              </th>
              <th title="Revenue after deduction, in rupees">Total income ₹</th>
              <th title="Total income minus total expense">Profit ₹</th>
              <th title="Profit ÷ total expense">Percentage (%)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className={r.isTotal ? 'is-total' : ''}>
                <td className="left ar-mono">{r.label}</td>
                {r.empty ? (
                  <td colSpan={columns.length + 7} className="ar-dash-row">—</td>
                ) : (
                  <>
                    <td><Cell v={r.adExp} fmt={inr0} /></td>
                    <td><Cell v={r.gst} fmt={inr0} /></td>
                    <td><Cell v={r.expense} fmt={inr0} /></td>
                    {r.acct.map((v, k) => <td key={columns[k].id} className="ar-mono"><Cell v={v} fmt={usd2} /></td>)}
                    <td className="ar-mono ar-muted"><Cell v={r.ded} fmt={usd2} /></td>
                    <td><Cell v={r.income} fmt={inr0} /></td>
                    <td className={r.profit < 0 ? 'ar-neg' : 'ar-pos'}><Cell v={r.profit} fmt={signedInr} /></td>
                    <td><Cell v={r.pct} fmt={(v) => `${v.toFixed(1)}%`} /></td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footnote ? <p className="ar-note">{footnote}</p> : null}
    </SectionCard>
  );
}

// ─── website links ──────────────────────────────────────────────────────────

export function WebsiteLinks({ websites, open, onToggle }) {
  const [copied, setCopied] = useState(null);
  const copy = (w) => {
    try { navigator.clipboard?.writeText(w); } catch { /* ignore */ }
    setCopied(w);
    setTimeout(() => setCopied((c) => (c === w ? null : c)), 1500);
  };
  return (
    <SectionCard
      id="sec-websites"
      icon={Link2}
      title="Website links"
      help="Websites that earn revenue for this app. “Link” copies the domain."
      right={<span className="ar-muted">{websites.length} {websites.length === 1 ? 'site' : 'sites'}</span>}
      open={open}
      onToggle={onToggle}
      className="ar-links"
    >
      <ul>
        {websites.map((w) => (
          <li key={w}>
            <span>{w}</span>
            <button type="button" className="ar-linkbtn" onClick={() => copy(w)} title="Copy domain">
              {copied === w ? 'Copied' : 'Link'}
            </button>
          </li>
        ))}
        {websites.length === 0 ? <li className="ar-muted">No websites linked to this app.</li> : null}
      </ul>
    </SectionCard>
  );
}
