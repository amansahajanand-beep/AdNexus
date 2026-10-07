/**
 * Google Ad Manager figures for the chat, read from the same /dashboard rows the Dashboard page shows
 * (one row per day × site, with domain). Filtering and grouping happen here, in memory, so a question like
 * "revenue of quiz13.arenapro6.com last month" works for any site.
 */
const { callRouter } = require('../internalCall');
const { tzHeaders } = require('../viewTz');

const BLANK = new Set(['', '—', '-', 'null', 'undefined']);
const UNASSIGNED = 'Unassigned (no site in the report)';

const num = (v) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
};

function clean(v) {
  const s = String(v == null ? '' : v).trim();
  return BLANK.has(s) ? '' : s;
}

function siteOf(row) {
  return clean(row.siteName) || clean(row.siteUrl) || clean(row.gamSite) || clean(row.site);
}

function domainOf(row) {
  return clean(row.domainName) || clean(row.gamDomain) || clean(row.domain);
}

/** All rows for the period as the signed-in user sees them. */
async function loadGamRows({ start, end, authorization, ctx }) {
  const res = await callRouter(require('../../routes/reports'), {
    path: '/dashboard',
    query: { startDate: start, endDate: end, allRows: 'true' },
    authorization,
    timeoutMs: 60_000,
    headers: tzHeaders(ctx),
  });
  if (res.status !== 200) {
    const reason = res.status === 403 ? 'This user is not allowed to see that data.' : (res.body?.error || 'The data could not be loaded.');
    const err = new Error(reason);
    err.status = res.status;
    throw err;
  }
  const body = res.body || {};
  return {
    rows: Array.isArray(body.rows) ? body.rows : [],
    currency: body.summary?.currency || body.currency || 'USD',
    visibility: body.visibility || null,
    warning: body.reportWarning || null,
  };
}

const lower = (list) => new Set((list || []).map((v) => String(v).trim().toLowerCase()).filter(Boolean));

/** Keep rows whose site / domain match the filter names (case-insensitive, exact). */
function filterRows(rows, { sites = [], domains = [] } = {}) {
  const wantSites = lower(sites);
  const wantDomains = lower(domains);
  if (!wantSites.size && !wantDomains.size) return rows;
  return rows.filter((r) => {
    const site = siteOf(r).toLowerCase();
    const domain = domainOf(r).toLowerCase();
    if (wantSites.size && !wantSites.has(site) && !wantSites.has(String(r.siteUrl || '').toLowerCase())) return false;
    if (wantDomains.size && !wantDomains.has(domain)) return false;
    return true;
  });
}

function total(rows) {
  const t = { earnings: 0, impressions: 0, clicks: 0 };
  for (const r of rows) {
    t.earnings += num(r.revenue) || 0;
    t.impressions += num(r.impression ?? r.impressions) || 0;
    t.clicks += num(r.clicks) || 0;
  }
  return t;
}

function derived(t) {
  return {
    earnings: t.earnings,
    impressions: t.impressions,
    clicks: t.clicks,
    ecpm: t.impressions > 0 ? (t.earnings / t.impressions) * 1000 : null,
    ctr: t.impressions > 0 ? (t.clicks / t.impressions) * 100 : null,
  };
}

/** Rows grouped by site or domain, largest earnings first. */
function breakdown(rows, dimension, limit = 15) {
  const keyOf = dimension === 'domain' ? domainOf : siteOf;
  const groups = new Map();
  for (const r of rows) {
    const key = keyOf(r) || UNASSIGNED;
    const g = groups.get(key) || { earnings: 0, impressions: 0, clicks: 0 };
    g.earnings += num(r.revenue) || 0;
    g.impressions += num(r.impression ?? r.impressions) || 0;
    g.clicks += num(r.clicks) || 0;
    groups.set(key, g);
  }
  return [...groups.entries()]
    .map(([name, g]) => ({ name, ...derived(g) }))
    .sort((a, b) => b.earnings - a.earnings)
    .slice(0, limit);
}

function dailyTrend(rows) {
  const days = new Map();
  for (const r of rows) {
    const date = String(r.date || r.report_date || '').slice(0, 10);
    if (!date) continue;
    const g = days.get(date) || { earnings: 0, impressions: 0, clicks: 0 };
    g.earnings += num(r.revenue) || 0;
    g.impressions += num(r.impression ?? r.impressions) || 0;
    g.clicks += num(r.clicks) || 0;
    days.set(date, g);
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, g]) => ({ date, ...derived(g) }));
}

/** Site and domain names from the network catalog, for "look up the exact name" calls. */
async function loadGamNames({ authorization }) {
  const res = await callRouter(require('../../routes/reports'), { path: '/filter-catalog', authorization, timeoutMs: 30_000 });
  if (res.status !== 200) {
    const err = new Error(res.status === 403 ? 'This user is not allowed to see that data.' : (res.body?.error || 'The names could not be loaded.'));
    err.status = res.status;
    throw err;
  }
  const b = res.body || {};
  return { sites: b.siteHosts || [], domains: b.domainRoots || [] };
}

module.exports = {
  loadGamRows, loadGamNames, filterRows, breakdown, dailyTrend, total, derived, siteOf, domainOf, UNASSIGNED,
};
