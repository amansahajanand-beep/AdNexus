/**
 * Dashboard numbers for a chosen timezone, rebuilt from rollup_hourly (see hourlySyncService).
 *
 * rollup_hourly rows are keyed by the network-timezone date + hour. Converting that wall-clock hour into the chosen
 * timezone gives its local date, and a local "day" is just the hours that land on it.
 */
const { query } = require('../db');
const { APP_TIMEZONE, shiftYMD } = require('../utils/datetime');

const SRC_TZ = APP_TIMEZONE;

/**
 * Zones offered in the picker, west to east. The first entry the picker shows is the network timezone (no change).
 * IANA ids, so daylight-saving shifts are handled per date.
 */
const EXTRA_ZONES = [
  { id: 'Pacific/Honolulu', label: 'Hawaii' },
  { id: 'America/Anchorage', label: 'Alaska' },
  { id: 'America/Los_Angeles', label: 'US Pacific' },
  { id: 'America/Denver', label: 'US Mountain' },
  { id: 'America/Chicago', label: 'US Central' },
  { id: 'America/New_York', label: 'US Eastern' },
  { id: 'America/Sao_Paulo', label: 'Brazil (São Paulo)' },
  { id: 'UTC', label: 'UTC' },
  { id: 'Europe/London', label: 'London' },
  { id: 'Europe/Paris', label: 'Central Europe (Paris)' },
  { id: 'Europe/Istanbul', label: 'Istanbul' },
  { id: 'Africa/Johannesburg', label: 'South Africa' },
  { id: 'Europe/Moscow', label: 'Moscow' },
  { id: 'Asia/Dubai', label: 'Dubai' },
  { id: 'Asia/Karachi', label: 'Pakistan (Karachi)' },
  { id: 'Asia/Kolkata', label: 'India (Kolkata)' },
  { id: 'Asia/Dhaka', label: 'Bangladesh (Dhaka)' },
  { id: 'Asia/Bangkok', label: 'Bangkok' },
  { id: 'Asia/Jakarta', label: 'Jakarta' },
  { id: 'Asia/Tokyo', label: 'Tokyo' },
  { id: 'Australia/Sydney', label: 'Sydney' },
  { id: 'Pacific/Auckland', label: 'New Zealand (Auckland)' },
];

const networkCity = () => String(SRC_TZ).split('/').pop().replace(/_/g, ' ');

/** Offset from UTC in minutes for a zone at `date`. */
function offsetMinutes(tz, date = new Date()) {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
      .formatToParts(date).find((p) => p.type === 'timeZoneName')?.value || 'GMT';
    const m = part.match(/GMT([+-−])?(\d{1,2})?(?::(\d{2}))?/);
    if (!m || !m[2]) return 0;
    const mins = Number(m[2]) * 60 + Number(m[3] || 0);
    return m[1] === '-' || m[1] === '−' ? -mins : mins;
  } catch {
    return 0;
  }
}

/** Options for the picker, network zone first. `approx` = offset to the network zone is not a whole number of hours. */
function timezoneOptions(now = new Date()) {
  const src = offsetMinutes(SRC_TZ, now);
  const list = [{ id: SRC_TZ, label: `${networkCity()} (network)`, approx: false }];
  for (const z of EXTRA_ZONES) {
    if (z.id === SRC_TZ) continue;
    list.push({ ...z, approx: (offsetMinutes(z.id, now) - src) % 60 !== 0 });
  }
  return list;
}

function isValidTz(tz) {
  if (!tz || typeof tz !== 'string' || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Local timestamp of a stored (network date + hour) in the target zone. $S = network zone, $T = target zone. */
/**
 * Local timestamp of each half-hour of a stored (network date + hour) in the target zone. Every stored hour is split
 * into two halves (joined via HALVES, each worth half the hour), so zones whose offset from the network zone is not a
 * whole number of hours (India, Nepal…) get the boundary hour shared between their two days instead of dropped.
 */
const HALVES = 'CROSS JOIN LATERAL (VALUES (0), (30)) AS hh(m)';
const LOCAL_TS = (alias = 'h') => `(((${alias}.report_date + make_interval(hours => ${alias}.hour::int, mins => hh.m)) AT TIME ZONE $S) AT TIME ZONE $T)`;
const withZones = (sql, base) => sql.replace(/\$S/g, `$${base}`).replace(/\$T/g, `$${base + 1}`);

/**
 * First local date (in `tz`) that is fully covered by stored hours, counting back from yesterday over consecutive
 * full days. null when nothing usable is stored.
 */
async function coverageFrom(clientId, tz, today) {
  const { rows } = await query(
    `SELECT to_char(report_date, 'YYYY-MM-DD') AS day
     FROM rollup_hourly
     WHERE client_id = $1::uuid AND kind = 'network' AND report_date >= $2::date
     GROUP BY report_date HAVING COUNT(DISTINCT hour) = 24`,
    [clientId, shiftYMD(today, -400)]
  );
  const full = new Set(rows.map((r) => r.day));
  let first = null;
  for (let d = shiftYMD(today, -1); full.has(d); d = shiftYMD(d, -1)) first = d;
  if (!first) return null;
  // Local midnight of that first day in `tz` may fall mid-day in the network zone: use the next local day then.
  const { rows: [r] } = await query(
    `SELECT to_char(ts::date, 'YYYY-MM-DD') AS day, (ts::time = '00:00') AS exact
     FROM (SELECT ((($1::date)::timestamp AT TIME ZONE $2) AT TIME ZONE $3) AS ts) x`,
    [first, SRC_TZ, tz]
  );
  return r.exact ? r.day : shiftYMD(r.day, 1);
}

function rowFor(r, currency = 'USD') {
  const impression = Math.round(Number(r.impressions) || 0);
  const revenue = +(Number(r.revenue) || 0).toFixed(2);
  const clicks = Math.round(Number(r.clicks) || 0);
  const ecpm = impression > 0 && revenue > 0 ? +((revenue / impression) * 1000).toFixed(2) : 0;
  const ctr = impression > 0 && clicks > 0 ? +((clicks / impression) * 100).toFixed(4) : 0;
  const domain = r.domain || '';
  const site = r.site || '';
  const appId = r.appId || '';
  return {
    date: r.date, report_date: r.date, country: '', device: '', COUNTRY_NAME: '', DEVICE_CATEGORY_NAME: '',
    site, AD_UNIT_NAME: '', ad_unit_name: '',
    domainName: domain, domain, gamDomain: domain,
    siteUrl: site, gamSite: site, siteName: site,
    appId, appPackage: appId,
    impression, revenue, revenueDollars: true, clicks, ctr, viewableRate: 0, ecpm, currency,
    metrics: {
      total_line_item_level_impressions: impression,
      total_line_item_level_clicks: clicks,
      total_line_item_level_all_revenue: revenue,
      total_line_item_level_cpm_and_cpc_revenue: revenue,
      total_line_item_level_ctr: ctr,
      total_line_item_level_without_cpd_average_ecpm: ecpm,
      total_active_view_viewable_impressions_rate: 0,
    },
  };
}

const norm = (list) => [...new Set((list || []).map((v) => String(v || '').trim().toLowerCase()).filter(Boolean))];

/**
 * Trend, rows and totals for local days [startDate, endDate] (already clamped to covered days).
 * filters: { domains[], sites[], apps[] } — any of them switches totals to the filtered slice.
 */
async function buildHourlyView({ clientId, startDate, endDate, tz, filters = {}, rowLimitPerDay = 200 }) {
  const domains = norm(filters.domains);
  const sites = norm(filters.sites);
  const apps = norm(filters.apps);
  const appMode = apps.length > 0 && !domains.length && !sites.length;
  const inventoryFiltered = domains.length > 0 || sites.length > 0;

  const winFrom = shiftYMD(startDate, -2);
  const winTo = shiftYMD(endDate, 2);
  const base = [clientId, winFrom, winTo, startDate, endDate, SRC_TZ, tz];
  const zones = (sql) => withZones(sql, 6);

  const trendKind = appMode ? 'app' : (inventoryFiltered ? 'inventory' : 'network');
  let filterSql = '';
  const params = [...base];
  if (trendKind === 'inventory') {
    if (domains.length) { params.push(domains); filterSql += ` AND LOWER(h.dim_a) = ANY($${params.length}::text[])`; }
    if (sites.length) { params.push(sites); filterSql += ` AND LOWER(h.dim_b) = ANY($${params.length}::text[])`; }
  } else if (trendKind === 'app') {
    params.push(apps);
    filterSql += ` AND LOWER(h.dim_b) = ANY($${params.length}::text[])`;
  }
  const trendRes = await query(
    zones(`SELECT to_char(ld, 'YYYY-MM-DD') AS date,
                  SUM(revenue)::float8 AS earning, SUM(impressions)::float8 AS impressions, SUM(clicks)::float8 AS clicks
           FROM (
             SELECT ${LOCAL_TS()}::date AS ld, h.revenue * 0.5 AS revenue, h.impressions * 0.5 AS impressions, h.clicks * 0.5 AS clicks
             FROM rollup_hourly h ${HALVES}
             WHERE h.client_id = $1::uuid AND h.kind = '${trendKind}'
               AND h.report_date BETWEEN $2::date AND $3::date${filterSql}
           ) x
           WHERE ld BETWEEN $4::date AND $5::date
           GROUP BY ld ORDER BY ld`),
    params
  );

  let rowKind = appMode ? 'app' : 'inventory';
  const rowParams = [...base];
  let rowFilter = '';
  if (rowKind === 'inventory') {
    if (domains.length) { rowParams.push(domains); rowFilter += ` AND LOWER(h.dim_a) = ANY($${rowParams.length}::text[])`; }
    if (sites.length) { rowParams.push(sites); rowFilter += ` AND LOWER(h.dim_b) = ANY($${rowParams.length}::text[])`; }
  } else {
    rowParams.push(apps);
    rowFilter += ` AND LOWER(h.dim_b) = ANY($${rowParams.length}::text[])`;
  }
  rowParams.push(rowLimitPerDay);
  const limitIdx = rowParams.length;
  const rowRes = await query(
    zones(`WITH agg AS (
             SELECT ld, dim_a, dim_b, SUM(revenue)::float8 AS revenue, SUM(impressions)::float8 AS impressions, SUM(clicks)::float8 AS clicks
             FROM (
               SELECT ${LOCAL_TS()}::date AS ld, h.dim_a, h.dim_b, h.revenue * 0.5 AS revenue, h.impressions * 0.5 AS impressions, h.clicks * 0.5 AS clicks
               FROM rollup_hourly h ${HALVES}
               WHERE h.client_id = $1::uuid AND h.kind = '${rowKind}'
                 AND h.report_date BETWEEN $2::date AND $3::date${rowFilter}
             ) x
             WHERE ld BETWEEN $4::date AND $5::date
             GROUP BY ld, dim_a, dim_b
             HAVING SUM(impressions) > 0 OR SUM(revenue) > 0
           ), ranked AS (
             SELECT *, ROW_NUMBER() OVER (PARTITION BY ld ORDER BY revenue DESC, impressions DESC) AS rk FROM agg
           )
           SELECT to_char(ld, 'YYYY-MM-DD') AS date, dim_a, dim_b, revenue, impressions, clicks
           FROM ranked WHERE rk <= $${limitIdx} ORDER BY ld ASC, revenue DESC`),
    rowParams
  );

  const trend = (trendRes.rows || []).map((r) => ({
    date: r.date,
    earning: +Number(r.earning).toFixed(2),
    impressions: Math.round(Number(r.impressions) || 0),
    clicks: Math.round(Number(r.clicks) || 0),
  }));
  const rows = (rowRes.rows || []).map((r) => (rowKind === 'app'
    ? rowFor({ ...r, appId: r.dim_b })
    : rowFor({ ...r, domain: r.dim_a, site: r.dim_b })));
  return { trend, rows };
}

/** Summary object shaped like the Dashboard's, from (possibly merged) trend + rows. */
function summaryFromTrend(trend, rows, { viewability = 0, currency = 'USD' } = {}) {
  const revenue = +trend.reduce((a, d) => a + (d.earning || 0), 0).toFixed(2);
  const impressions = Math.round(trend.reduce((a, d) => a + (d.impressions || 0), 0));
  const clicks = Math.round(trend.reduce((a, d) => a + (d.clicks || 0), 0));
  const keys = new Set();
  for (const r of rows) {
    const d = String(r.domainName || '').trim().toLowerCase();
    const a = String(r.appId || '').trim().toLowerCase();
    if (d) keys.add(`web:${d}`);
    if (a) keys.add(`app:${a}`);
  }
  return {
    totalEarning: revenue, totalEarningChange: 0,
    selectRange: revenue, selectRangeChange: 0,
    last7Days: +trend.slice(-7).reduce((a, d) => a + (d.earning || 0), 0).toFixed(2), last7DaysChange: 0,
    pageViews: impressions, pageViewsChange: 0,
    impressions, impressionsChange: 0,
    clicks, clicksChange: 0,
    ctr: impressions > 0 ? +((clicks / impressions) * 100).toFixed(4) : 0,
    revenue, revenueChange: 0,
    ecpm: impressions > 0 ? +((revenue / impressions) * 1000).toFixed(2) : 0, ecpmChange: 0,
    viewability, viewabilityChange: 0,
    totalDomains: keys.size,
    currency,
  };
}

module.exports = { SRC_TZ, timezoneOptions, isValidTz, coverageFrom, buildHourlyView, summaryFromTrend };
