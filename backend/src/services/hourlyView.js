/**
 * Dashboard numbers for a chosen timezone, rebuilt from rollup_hourly (see hourlySyncService).
 *
 * rollup_hourly rows are keyed by the network-timezone date + hour. Converting that wall-clock hour into the chosen
 * timezone gives its local date, and a local "day" is just the hours that land on it.
 */
const { query } = require('../db');
const { APP_TIMEZONE, shiftYMD, ymdInTZ } = require('../utils/datetime');

/** Default network timezone when a network's own is not known (see networkTimezone.js). */
const SRC_TZ = APP_TIMEZONE;
const HOUR_MS = 3600000;
/** Hourly rows older than this (behind the clock) mean the sync is lagging, so the current day would be understated. */
const FRESH_MS = 3 * HOUR_MS;

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
  { id: 'Asia/Singapore', label: 'Singapore' },
  { id: 'Asia/Hong_Kong', label: 'Hong Kong' },
  { id: 'Asia/Seoul', label: 'Seoul' },
  { id: 'Asia/Tokyo', label: 'Tokyo' },
  { id: 'Australia/Sydney', label: 'Sydney' },
  { id: 'Pacific/Auckland', label: 'New Zealand (Auckland)' },
];

const cityOf = (tz) => String(tz).split('/').pop().replace(/_/g, ' ');

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
function timezoneOptions(srcTz = SRC_TZ, now = new Date()) {
  const src = offsetMinutes(srcTz, now);
  const list = [{ id: srcTz, label: `${cityOf(srcTz)} (network)`, approx: false }];
  for (const z of EXTRA_ZONES) {
    if (z.id === srcTz) continue;
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

/** Instant (ms) of a wall-clock date + hour in `tz` (the first occurrence when daylight saving repeats the hour). */
function wallToInstant(ymd, hour, tz) {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour);
  const off = offsetMinutes(tz, new Date(guess));
  let inst = guess - off * 60000;
  const off2 = offsetMinutes(tz, new Date(inst));
  if (off2 !== off) inst = guess - off2 * 60000;
  return inst;
}

/** Midnight at the start of local date `ymd` in `tz`, as an instant. */
const localMidnight = (ymd, tz) => wallToInstant(ymd, 0, tz);

/** The newest unbroken run of stored network hours, as [oldest hour start, newest hour start] instants. */
async function storedRun(clientId, srcTz, today, kind = 'network') {
  const { rows } = await query(
    `SELECT to_char(report_date, 'YYYY-MM-DD') AS day, hour
     FROM rollup_hourly
     WHERE client_id = $1::uuid AND kind = $3 AND report_date >= $2::date
     GROUP BY report_date, hour
     ORDER BY report_date DESC, hour DESC`,
    [clientId, shiftYMD(today, -400), kind]
  );
  let newest = null;
  let oldest = null;
  for (const r of rows) {
    const inst = wallToInstant(r.day, Number(r.hour), srcTz);
    if (newest == null) {
      newest = inst;
    } else {
      const gap = oldest - inst;
      // A repeated daylight-saving hour is stored once, so the step across it is two hours.
      const dstStep = gap === 2 * HOUR_MS && offsetMinutes(srcTz, new Date(oldest)) !== offsetMinutes(srcTz, new Date(inst));
      if (gap !== HOUR_MS && !dstStep) break;
    }
    oldest = inst;
  }
  return newest == null ? null : { oldest, newest };
}

/**
 * Which local days of `tz` the stored hours can serve.
 *  - from: first local date that starts inside the stored run.
 *  - through: last local date that is covered. The current local day counts while it is still filling (partial),
 *    as long as the hourly sync is fresh, so "today" in another timezone is its hours so far.
 * null when nothing usable is stored or the sync has fallen behind.
 */
async function coverage(clientId, tz, today, srcTz = SRC_TZ, now = Date.now(), kind = 'network') {
  const run = await storedRun(clientId, srcTz, today, kind);
  if (!run) return null;
  const firstDay = ymdInTZ(new Date(run.oldest), tz);
  const from = localMidnight(firstDay, tz) >= run.oldest ? firstDay : shiftYMD(firstDay, 1);

  const end = run.newest + HOUR_MS; // the stored hours cover everything before this instant
  const lastDay = ymdInTZ(new Date(end - 1), tz);
  const dayComplete = localMidnight(shiftYMD(lastDay, 1), tz) <= end;
  const fresh = now - end <= FRESH_MS;
  const through = fresh || dayComplete ? lastDay : shiftYMD(lastDay, -1);
  if (through < from) return null;
  return { from, through, partialDay: !dayComplete && fresh ? lastDay : null };
}

/** First local date the hourly data covers (null when none). */
async function coverageFrom(clientId, tz, today, srcTz = SRC_TZ) {
  return (await coverage(clientId, tz, today, srcTz))?.from || null;
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

/** Root domain of a stored site host, the same rule the warehouse rollups use for a row's domain. */
const DOMAIN_SQL = `LOWER(COALESCE(NULLIF(SUBSTRING(TRIM(COALESCE(h.dim_b, '')) FROM '[^.]+\\.[^.]+$'), ''), NULLIF(TRIM(h.dim_a), '')))`;

/**
 * Extra WHERE for one slice of rollup_hourly.
 *  filter = { domains[], sites[], apps[] } plus, for a domain user's assigned inventory, `scoped: true` (domains match
 *  the way the rollups match them, and a domain OR a site grants access when `webOr` is set).
 * Plain admin filters keep their exact meaning: domain and site are both required.
 */
function filterSql(kind, filter, params) {
  if (!filter) return '';
  if (kind === 'app') {
    const apps = norm(filter.apps);
    if (!apps.length) return '';
    let wanted = apps;
    if (!filter.exactApps) {
      // A domain user's app grants may name an app by package, name or resolved id; match any of its spellings.
      try {
        const { expandAppFilterAliases, loadCachedAppPackageMaps } = require('../utils/appIdentity');
        wanted = norm(expandAppFilterAliases(apps, loadCachedAppPackageMaps()));
      } catch { /* aliases are optional */ }
    }
    params.push(wanted.length ? wanted : apps);
    return ` AND LOWER(h.dim_b) = ANY($${params.length}::text[])`;
  }
  if (kind !== 'inventory') return '';
  const domains = norm(filter.domains);
  const sites = norm(filter.sites);
  const parts = [];
  if (domains.length) {
    params.push(domains);
    parts.push(`(${filter.scoped ? DOMAIN_SQL : 'LOWER(h.dim_a)'} = ANY($${params.length}::text[]))`);
  }
  if (sites.length) {
    params.push(sites);
    parts.push(`(LOWER(TRIM(h.dim_b)) = ANY($${params.length}::text[]))`);
  }
  if (!parts.length) return '';
  return ` AND ${parts.length === 1 ? parts[0] : `(${parts.join(filter.webOr ? ' OR ' : ' AND ')})`}`;
}

const zonedParams = (clientId, startDate, endDate, srcTz, tz) => [clientId, shiftYMD(startDate, -2), shiftYMD(endDate, 2), startDate, endDate, srcTz, tz];

/** Revenue, impressions and clicks per local day of `tz`, from one slice of the hourly data. */
async function hourlyTrend({ clientId, startDate, endDate, tz, srcTz = SRC_TZ, kind = 'network', filter = null }) {
  const params = zonedParams(clientId, startDate, endDate, srcTz, tz);
  const extra = filterSql(kind, filter, params);
  const { rows } = await query(
    withZones(`SELECT to_char(ld, 'YYYY-MM-DD') AS date,
                      SUM(revenue)::float8 AS earning, SUM(impressions)::float8 AS impressions, SUM(clicks)::float8 AS clicks
               FROM (
                 SELECT ${LOCAL_TS()}::date AS ld, h.revenue * 0.5 AS revenue, h.impressions * 0.5 AS impressions, h.clicks * 0.5 AS clicks
                 FROM rollup_hourly h ${HALVES}
                 WHERE h.client_id = $1::uuid AND h.kind = '${kind}'
                   AND h.report_date BETWEEN $2::date AND $3::date${extra}
               ) x
               WHERE ld BETWEEN $4::date AND $5::date
               GROUP BY ld ORDER BY ld`, 6),
    params
  );
  return rows.map((r) => ({
    date: r.date,
    earning: +Number(r.earning).toFixed(2),
    impressions: Math.round(Number(r.impressions) || 0),
    clicks: Math.round(Number(r.clicks) || 0),
  }));
}

/**
 * Per-item rows (domain x site, or app) for the local days of `tz`.
 *  perDay: one row per local day and item (the Dashboard and Reporting tables); false adds each item up over the range.
 *  limit: per day when perDay, otherwise overall. Biggest earners first.
 */
async function hourlyRows({
  clientId, startDate, endDate, tz, srcTz = SRC_TZ, kind = 'inventory', filter = null, perDay = true, limit = 200,
}) {
  const params = zonedParams(clientId, startDate, endDate, srcTz, tz);
  const extra = filterSql(kind, filter, params);
  params.push(limit);
  const lim = params.length;
  const { rows } = await query(
    withZones(`WITH agg AS (
                 SELECT ${perDay ? 'ld' : 'NULL::date AS ld'}, dim_a, dim_b,
                        SUM(revenue)::float8 AS revenue, SUM(impressions)::float8 AS impressions, SUM(clicks)::float8 AS clicks
                 FROM (
                   SELECT ${LOCAL_TS()}::date AS ld, h.dim_a, h.dim_b,
                          h.revenue * 0.5 AS revenue, h.impressions * 0.5 AS impressions, h.clicks * 0.5 AS clicks
                   FROM rollup_hourly h ${HALVES}
                   WHERE h.client_id = $1::uuid AND h.kind = '${kind}'
                     AND h.report_date BETWEEN $2::date AND $3::date${extra}
                 ) x
                 WHERE ld BETWEEN $4::date AND $5::date
                 GROUP BY ${perDay ? 'ld, ' : ''}dim_a, dim_b
                 HAVING SUM(impressions) > 0 OR SUM(revenue) > 0
               ), ranked AS (
                 SELECT *, ROW_NUMBER() OVER (${perDay ? 'PARTITION BY ld ' : ''}ORDER BY revenue DESC, impressions DESC) AS rk FROM agg
               )
               SELECT ${perDay ? "to_char(ld, 'YYYY-MM-DD')" : 'NULL'} AS date, dim_a, dim_b, revenue, impressions, clicks
               FROM ranked WHERE rk <= $${lim} ORDER BY ${perDay ? 'ld ASC, ' : ''}revenue DESC`, 6),
    params
  );
  return rows.map((r) => (kind === 'app'
    ? rowFor({ ...r, appId: r.dim_b })
    : rowFor({ ...r, domain: r.dim_a, site: r.dim_b })));
}

/**
 * Trend, rows and totals for local days [startDate, endDate] (already clamped to covered days).
 * filters: { domains[], sites[], apps[] } — any of them switches totals to the filtered slice.
 */
async function buildHourlyView({ clientId, startDate, endDate, tz, srcTz = SRC_TZ, filters = {}, rowLimitPerDay = 200 }) {
  const domains = norm(filters.domains);
  const sites = norm(filters.sites);
  const apps = norm(filters.apps);
  const appMode = apps.length > 0 && !domains.length && !sites.length;
  const inventoryFiltered = domains.length > 0 || sites.length > 0;
  // Admin filters here are exact app ids/names, so skip the alias expansion that domain-user scopes use.
  const filter = { domains, sites, apps, exactApps: true };
  const trendKind = appMode ? 'app' : (inventoryFiltered ? 'inventory' : 'network');
  const rowKind = appMode ? 'app' : 'inventory';
  const [trend, rows] = await Promise.all([
    hourlyTrend({ clientId, startDate, endDate, tz, srcTz, kind: trendKind, filter }),
    hourlyRows({ clientId, startDate, endDate, tz, srcTz, kind: rowKind, filter, perDay: true, limit: rowLimitPerDay }),
  ]);
  return { trend, rows };
}

/**
 * The same for a domain user: only their assigned inventory, as resolved by resolveScopedSqlInventoryOpts
 * ({ domains, sites, apps, webInventoryOr }). Sites/domains come from the site slice and apps from the app slice;
 * the two are added together (access to either grants the revenue), like the warehouse totals.
 */
async function buildScopedHourlyView({
  clientId, startDate, endDate, tz, srcTz = SRC_TZ, scope, rowLimitPerDay = 200,
}) {
  const domains = norm(scope.domains);
  const sites = norm(scope.sites);
  const apps = norm(scope.apps);
  const hasWeb = domains.length > 0 || sites.length > 0;
  const hasApp = apps.length > 0;
  if (!hasWeb && !hasApp) return { trend: [], rows: [] };
  const base = { clientId, startDate, endDate, tz, srcTz };
  const webFilter = { domains, sites, scoped: true, webOr: Boolean(scope.webInventoryOr) };
  const appFilter = { apps };
  const [webTrend, appTrend, webRows, appRows] = await Promise.all([
    hasWeb ? hourlyTrend({ ...base, kind: 'inventory', filter: webFilter }) : [],
    hasApp ? hourlyTrend({ ...base, kind: 'app', filter: appFilter }) : [],
    hasWeb ? hourlyRows({ ...base, kind: 'inventory', filter: webFilter, perDay: true, limit: rowLimitPerDay }) : [],
    hasApp ? hourlyRows({ ...base, kind: 'app', filter: appFilter, perDay: true, limit: rowLimitPerDay }) : [],
  ]);
  const byDate = new Map();
  for (const d of [...webTrend, ...appTrend]) {
    const cur = byDate.get(d.date) || { date: d.date, earning: 0, impressions: 0, clicks: 0 };
    cur.earning = +(cur.earning + d.earning).toFixed(2);
    cur.impressions += d.impressions;
    cur.clicks += d.clicks;
    byDate.set(d.date, cur);
  }
  const trend = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const rows = [...webRows, ...appRows].sort((a, b) => (a.date === b.date ? b.revenue - a.revenue : a.date.localeCompare(b.date)));
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

module.exports = { SRC_TZ, timezoneOptions, isValidTz, coverage, coverageFrom, wallToInstant, localMidnight, buildHourlyView, buildScopedHourlyView, hourlyTrend, hourlyRows, rowFor, summaryFromTrend,
};
