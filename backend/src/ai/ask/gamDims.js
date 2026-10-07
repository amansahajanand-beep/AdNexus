/**
 * Google Ad Manager splits by app, ad unit, country or device for the chat, from the warehouse's one-dimension
 * daily rollups (rollup_dim_daily). Each split is exact on its own; two kinds cannot be combined (for example
 * a country within one app) because the rollups hold one dimension at a time.
 *
 * These reads are limited to the signed-in admin's own network by an explicit client id.
 */
const { schemaQuery } = require('../../db');

const KINDS = ['app', 'ad_unit', 'country', 'device'];
const FILTER_KEY = { app: 'apps', ad_unit: 'adUnits', country: 'countries', device: 'devices' };
const NAME_WINDOW_DAYS = 120;

const lowerList = (values) => [...new Set((values || []).map((v) => String(v).trim().toLowerCase()).filter(Boolean))];

function baseParams(clientId, start, end, kind, values) {
  const params = [clientId, start, end, kind];
  let clause = '';
  const wanted = lowerList(values);
  if (wanted.length) {
    params.push(wanted);
    clause = ` AND LOWER(TRIM(dim_value)) = ANY($${params.length}::text[])`;
  }
  return { params, clause };
}

/** One row per value of `kind`, largest earnings first. */
async function dimBreakdown({ clientId, start, end, kind, values = [] }) {
  const { params, clause } = baseParams(clientId, start, end, kind, values);
  const { rows } = await schemaQuery(
    `SELECT dim_value AS name,
            COALESCE(SUM(revenue), 0)::float8 AS earnings,
            COALESCE(SUM(impressions), 0)::float8 AS impressions
     FROM rollup_dim_daily
     WHERE client_id = $1::uuid AND report_date >= $2::date AND report_date <= $3::date AND dim_kind = $4 ${clause}
     GROUP BY dim_value
     ORDER BY earnings DESC`,
    params
  );
  return rows.map((r) => ({
    name: r.name || 'Unknown',
    earnings: r.earnings,
    impressions: r.impressions,
    ecpm: r.impressions > 0 ? (r.earnings / r.impressions) * 1000 : null,
  }));
}

/** Daily earnings for the chosen values of `kind` (all values when none are given). */
async function dimTrend({ clientId, start, end, kind, values = [] }) {
  const { params, clause } = baseParams(clientId, start, end, kind, values);
  const { rows } = await schemaQuery(
    `SELECT report_date::text AS date,
            COALESCE(SUM(revenue), 0)::float8 AS earnings,
            COALESCE(SUM(impressions), 0)::float8 AS impressions
     FROM rollup_dim_daily
     WHERE client_id = $1::uuid AND report_date >= $2::date AND report_date <= $3::date AND dim_kind = $4 ${clause}
     GROUP BY report_date
     ORDER BY report_date`,
    params
  );
  return rows.map((r) => ({
    date: r.date,
    earnings: r.earnings,
    impressions: r.impressions,
    ecpm: r.impressions > 0 ? (r.earnings / r.impressions) * 1000 : null,
  }));
}

/** Exact values of `kind` that match a search, biggest earners first. */
async function dimNames({ clientId, kind, search = '' }) {
  const params = [clientId, NAME_WINDOW_DAYS, kind];
  let clause = '';
  if (search) {
    params.push(`%${String(search).replace(/[%_\\]/g, '\\$&')}%`);
    clause = ` AND dim_value ILIKE $${params.length}`;
  }
  const { rows } = await schemaQuery(
    `SELECT dim_value AS name, COALESCE(SUM(revenue), 0)::float8 AS earnings
     FROM rollup_dim_daily
     WHERE client_id = $1::uuid AND report_date >= (CURRENT_DATE - $2::int) AND dim_kind = $3 AND dim_value <> '' ${clause}
     GROUP BY dim_value
     ORDER BY earnings DESC
     LIMIT 26`,
    params
  );
  return rows.map((r) => r.name);
}

function inventoryWhere(clientId, start, end, { sites = [], domains = [] } = {}) {
  const params = [clientId, start, end];
  let clause = '';
  const wantSites = lowerList(sites);
  const wantDomains = lowerList(domains);
  if (wantSites.length) {
    params.push(wantSites);
    clause += ` AND LOWER(TRIM(inv_site)) = ANY($${params.length}::text[])`;
  }
  if (wantDomains.length) {
    params.push(wantDomains);
    clause += ` AND LOWER(TRIM(inv_domain)) = ANY($${params.length}::text[])`;
  }
  return { params, clause };
}

const withRatios = (r) => ({
  earnings: r.earnings,
  impressions: r.impressions,
  clicks: r.clicks,
  ecpm: r.impressions > 0 ? (r.earnings / r.impressions) * 1000 : null,
  ctr: r.impressions > 0 ? (r.clicks / r.impressions) * 100 : null,
});

/**
 * Earnings by site or domain from the inventory rollup, which holds the same per-site figures as the Dashboard.
 * Reading it directly avoids the Dashboard's live Ad Manager path, which can take a minute for recent days.
 */
async function inventoryBreakdown({ clientId, start, end, field, sites, domains }) {
  const column = field === 'domain' ? 'inv_domain' : 'inv_site';
  const { params, clause } = inventoryWhere(clientId, start, end, { sites, domains });
  const { rows } = await schemaQuery(
    `SELECT ${column} AS name,
            COALESCE(SUM(revenue), 0)::float8 AS earnings,
            COALESCE(SUM(impressions), 0)::float8 AS impressions,
            COALESCE(SUM(clicks), 0)::float8 AS clicks
     FROM rollup_inventory_kpi_daily
     WHERE client_id = $1::uuid AND report_date >= $2::date AND report_date <= $3::date ${clause}
     GROUP BY ${column}
     ORDER BY earnings DESC`,
    params
  );
  return rows.map((r) => ({ name: r.name || 'Unassigned (no site in the report)', ...withRatios(r) }));
}

async function inventoryTrend({ clientId, start, end, sites, domains }) {
  const { params, clause } = inventoryWhere(clientId, start, end, { sites, domains });
  const { rows } = await schemaQuery(
    `SELECT report_date::text AS date,
            COALESCE(SUM(revenue), 0)::float8 AS earnings,
            COALESCE(SUM(impressions), 0)::float8 AS impressions,
            COALESCE(SUM(clicks), 0)::float8 AS clicks
     FROM rollup_inventory_kpi_daily
     WHERE client_id = $1::uuid AND report_date >= $2::date AND report_date <= $3::date ${clause}
     GROUP BY report_date
     ORDER BY report_date`,
    params
  );
  return rows.map((r) => ({ date: r.date, ...withRatios(r) }));
}

/**
 * Site or domain names with earnings, from the inventory rollup (the same source as the Dashboard's per-site rows).
 * Reading them here avoids a live Ad Manager catalog report, which is slow and sometimes fails.
 */
async function inventoryNames({ clientId, field, search = '' }) {
  const column = field === 'domain' ? 'inv_domain' : 'inv_site';
  const params = [clientId, NAME_WINDOW_DAYS];
  let clause = '';
  if (search) {
    params.push(`%${String(search).replace(/[%_\\]/g, '\\$&')}%`);
    clause = ` AND ${column} ILIKE $${params.length}`;
  }
  const { rows } = await schemaQuery(
    `SELECT ${column} AS name, COALESCE(SUM(revenue), 0)::float8 AS earnings
     FROM rollup_inventory_kpi_daily
     WHERE client_id = $1::uuid AND report_date >= (CURRENT_DATE - $2::int) AND ${column} <> '' ${clause}
     GROUP BY ${column}
     ORDER BY earnings DESC
     LIMIT 26`,
    params
  );
  return rows.map((r) => r.name);
}

/**
 * The viewer's timezone: days rebuilt from the stored hourly data. Returns null when the hourly data does not
 * cover the whole range (callers then fall back to the network's own days and say so).
 */
async function tzCoverage(ctx, start, end) {
  if (!ctx?.viewTz || !ctx?.clientId) return null;
  const hv = require('../../services/hourlyView');
  const { todayInTZ, shiftYMD } = require('../../utils/datetime');
  const today = todayInTZ(ctx.viewTz);
  // Per-site figures come from the per-site hours, so it is those hours that must cover the range: mixing them with
  // network totals would put the two answers in different timezones.
  const cov = await hv.coverage(ctx.clientId, ctx.viewTz, today, ctx.networkTz, Date.now(), 'inventory');
  if (!cov || start < cov.from || end > cov.through) {
    // Behind on recent hours: ask for a refresh so the next question is covered (the network totals come first).
    if (end >= shiftYMD(today, -2)) {
      require('../../models/clientStore').getClientById(ctx.clientId)
        .then((client) => client && require('../../services/hourlySyncService').refreshNetworkHours(client))
        .catch(() => {});
    }
    return null;
  }
  return { hv, cov };
}

async function tzInventoryBreakdown({ ctx, start, end, field, sites, domains }) {
  const c = await tzCoverage(ctx, start, end);
  if (!c) return null;
  const rows = await c.hv.hourlyRows({
    clientId: ctx.clientId, startDate: start, endDate: end, tz: ctx.viewTz, srcTz: ctx.networkTz,
    kind: 'inventory', filter: { domains: lowerList(domains), sites: lowerList(sites) }, perDay: false, limit: 5000,
  });
  const groups = new Map();
  for (const r of rows) {
    const name = (field === 'domain' ? r.domainName : r.siteName) || 'Unassigned (no site in the report)';
    const g = groups.get(name) || { earnings: 0, impressions: 0, clicks: 0 };
    g.earnings += r.revenue;
    g.impressions += r.impression;
    g.clicks += r.clicks;
    groups.set(name, g);
  }
  return [...groups.entries()].map(([name, g]) => ({ name, ...withRatios(g) })).sort((a, b) => b.earnings - a.earnings);
}

async function tzInventoryTrend({ ctx, start, end, sites, domains }) {
  const c = await tzCoverage(ctx, start, end);
  if (!c) return null;
  const filtered = lowerList(sites).length || lowerList(domains).length;
  const days = await c.hv.hourlyTrend({
    clientId: ctx.clientId, startDate: start, endDate: end, tz: ctx.viewTz, srcTz: ctx.networkTz,
    kind: filtered ? 'inventory' : 'network',
    filter: filtered ? { domains: lowerList(domains), sites: lowerList(sites) } : null,
  });
  return days.map((d) => ({ date: d.date, ...withRatios({ earnings: d.earning, impressions: d.impressions, clicks: d.clicks }) }));
}

module.exports = {
  KINDS, FILTER_KEY, dimBreakdown, dimTrend, dimNames, inventoryNames, inventoryBreakdown, inventoryTrend,
  tzInventoryBreakdown, tzInventoryTrend,
};
