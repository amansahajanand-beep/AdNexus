/**
 * Dimension breakdown facts + filter/table queries for AdMob / AdSense.
 */
const { query } = require('../db');

/** Collapse duplicate conflict keys inside a batch (Postgres rejects double UPDATE). */
function dedupeAdMobDimRows(rows) {
  const map = new Map();
  for (const r of rows) {
    const dimValue = String(r.dimValue || 'Unknown').slice(0, 500);
    const key = `${r.reportDate}|${r.dimKind}|${dimValue}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, {
        reportDate: r.reportDate,
        dimKind: r.dimKind,
        dimValue,
        earnings: Number(r.earnings) || 0,
        impressions: Number(r.impressions) || 0,
        clicks: Number(r.clicks) || 0,
        adRequests: Number(r.adRequests) || 0,
        matchedRequests: Number(r.matchedRequests) || 0,
      });
      continue;
    }
    prev.earnings += Number(r.earnings) || 0;
    prev.impressions += Number(r.impressions) || 0;
    prev.clicks += Number(r.clicks) || 0;
    prev.adRequests += Number(r.adRequests) || 0;
    prev.matchedRequests += Number(r.matchedRequests) || 0;
  }
  return [...map.values()];
}

async function upsertAdMobDimRows(clientId, accountId, rows = []) {
  const unique = dedupeAdMobDimRows(rows);
  if (!unique.length) return 0;
  const CHUNK = 40;
  let n = 0;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    chunk.forEach((r, idx) => {
      const base = idx * 10;
      values.push(
        `($${base + 1},$${base + 2},$${base + 3}::date,$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},now())`
      );
      params.push(
        clientId,
        accountId,
        r.reportDate,
        r.dimKind,
        r.dimValue,
        r.earnings,
        r.impressions,
        r.clicks,
        r.adRequests,
        r.matchedRequests,
      );
    });
    await query(
      `INSERT INTO admob_dim_daily (
         client_id, account_id, report_date, dim_kind, dim_value,
         earnings, impressions, clicks, ad_requests, matched_requests, updated_at
       ) VALUES ${values.join(',')}
       ON CONFLICT (client_id, account_id, report_date, dim_kind, dim_value) DO UPDATE SET
         earnings = EXCLUDED.earnings,
         impressions = EXCLUDED.impressions,
         clicks = EXCLUDED.clicks,
         ad_requests = EXCLUDED.ad_requests,
         matched_requests = EXCLUDED.matched_requests,
         updated_at = now()`,
      params
    );
    n += chunk.length;
  }
  return n;
}

async function upsertAdSenseDimRows(clientId, accountId, rows = []) {
  if (!rows.length) return 0;
  let n = 0;
  for (const r of rows) {
    await query(
      `INSERT INTO adsense_dim_daily (
         client_id, account_id, report_date, dim_kind, dim_value,
         earnings, page_views, impressions, clicks, updated_at
       ) VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,now())
       ON CONFLICT (client_id, account_id, report_date, dim_kind, dim_value) DO UPDATE SET
         earnings = EXCLUDED.earnings,
         page_views = EXCLUDED.page_views,
         impressions = EXCLUDED.impressions,
         clicks = EXCLUDED.clicks,
         updated_at = now()`,
      [
        clientId,
        accountId,
        r.reportDate,
        r.dimKind,
        String(r.dimValue || 'Unknown').slice(0, 500),
        Number(r.earnings) || 0,
        Number(r.pageViews) || 0,
        Number(r.impressions) || 0,
        Number(r.clicks) || 0,
      ]
    );
    n += 1;
  }
  return n;
}

function parseList(raw) {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (raw == null || raw === '') return [];
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

const ADMOB_FILTER_SPECS = [
  { kind: 'app', key: 'apps' },
  { kind: 'ad_unit', key: 'adUnits' },
  { kind: 'format', key: 'formats' },
  { kind: 'country', key: 'countries' },
  { kind: 'platform', key: 'platforms' },
  { kind: 'ad_source', key: 'adSources' },
  { kind: 'ad_source_instance', key: 'adSourceInstances' },
  { kind: 'mediation_group', key: 'mediationGroups' },
];

function collectAdMobFilters(opts = {}, excludeKind = null) {
  const all = ADMOB_FILTER_SPECS
    .map(({ kind, key }) => ({ kind, values: parseList(opts[key]) }))
    .filter((f) => f.values.length);
  return {
    all,
    same: excludeKind ? (all.find((f) => f.kind === excludeKind) || null) : null,
    cross: excludeKind ? all.filter((f) => f.kind !== excludeKind) : all,
    hasAny: all.length > 0,
    primary: all[0] || null,
  };
}

/** Append same-dim IN + cross-dim EXISTS clauses; mutates params. */
function appendAdMobFilterClause(params, filterSet, { alias = 'd' } = {}) {
  let clause = '';
  if (filterSet.same?.values?.length) {
    params.push(filterSet.same.values);
    clause += ` AND ${alias}.dim_value = ANY($${params.length}::text[])`;
  }
  for (const f of filterSet.cross) {
    params.push(f.kind);
    params.push(f.values);
    clause += `
      AND EXISTS (
        SELECT 1 FROM admob_dim_daily x
        WHERE x.client_id = ${alias}.client_id AND x.account_id = ${alias}.account_id
          AND x.report_date = ${alias}.report_date
          AND x.dim_kind = $${params.length - 1}
          AND x.dim_value = ANY($${params.length}::text[])
      )`;
  }
  return clause;
}

function emptyAdMobTotals(currency = 'USD') {
  return {
    earnings: 0,
    impressions: 0,
    clicks: 0,
    ad_requests: 0,
    matched_requests: 0,
    currency,
  };
}

async function listAdMobFilterOptions(clientId, { accountId = null, startDate, endDate } = {}) {
  const params = [clientId, startDate, endDate];
  let accountClause = '';
  if (accountId) {
    params.push(accountId);
    accountClause = ` AND account_id = $${params.length}`;
  }
  const { rows } = await query(
    `SELECT dim_kind, dim_value, SUM(earnings)::float AS earnings
     FROM admob_dim_daily
     WHERE client_id = $1
       AND report_date >= $2::date AND report_date <= $3::date
       ${accountClause}
     GROUP BY dim_kind, dim_value
     ORDER BY dim_kind ASC, earnings DESC NULLS LAST
     LIMIT 4000`,
    params
  );
  const out = {
    apps: [],
    formats: [],
    countries: [],
    platforms: [],
    adUnits: [],
    adSources: [],
    adSourceInstances: [],
    mediationGroups: [],
  };
  const map = {
    app: 'apps',
    format: 'formats',
    country: 'countries',
    platform: 'platforms',
    ad_unit: 'adUnits',
    ad_source: 'adSources',
    ad_source_instance: 'adSourceInstances',
    mediation_group: 'mediationGroups',
  };
  for (const r of rows) {
    const key = map[r.dim_kind];
    if (!key) continue;
    out[key].push({ id: r.dim_value, label: r.dim_value });
  }
  return out;
}

async function listAdSenseFilterOptions(clientId, { accountId = null, startDate, endDate } = {}) {
  const params = [clientId, startDate, endDate];
  let accountClause = '';
  if (accountId) {
    params.push(accountId);
    accountClause = ` AND account_id = $${params.length}`;
  }
  const { rows } = await query(
    `SELECT dim_kind, dim_value, SUM(earnings)::float AS earnings
     FROM adsense_dim_daily
     WHERE client_id = $1
       AND report_date >= $2::date AND report_date <= $3::date
       ${accountClause}
     GROUP BY dim_kind, dim_value
     ORDER BY dim_kind ASC, earnings DESC NULLS LAST
     LIMIT 2000`,
    params
  );
  const out = { sites: [], countries: [], platforms: [], adUnits: [] };
  const map = {
    site: 'sites', country: 'countries', platform: 'platforms', ad_unit: 'adUnits',
  };
  for (const r of rows) {
    const key = map[r.dim_kind];
    if (!key) continue;
    out[key].push({ id: r.dim_value, label: r.dim_value });
  }
  return out;
}

async function breakdownAdMob(clientId, {
  accountId = null,
  startDate,
  endDate,
  dimKind = 'app',
  limit = 20,
  apps = [],
  formats = [],
  countries = [],
  platforms = [],
  adUnits = [],
  adSources = [],
  adSourceInstances = [],
  mediationGroups = [],
} = {}) {
  const params = [clientId, startDate, endDate, dimKind];
  let accountClause = '';
  if (accountId) {
    params.push(accountId);
    accountClause += ` AND account_id = $${params.length}`;
  }
  const filterSet = collectAdMobFilters({
    apps, formats, countries, platforms, adUnits, adSources, adSourceInstances, mediationGroups,
  }, dimKind);
  const filterClause = appendAdMobFilterClause(params, filterSet);

  params.push(Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100));
  const { rows } = await query(
    `SELECT d.dim_value AS name,
            SUM(d.earnings)::float AS earnings,
            SUM(d.impressions)::bigint AS impressions,
            SUM(d.clicks)::bigint AS clicks,
            CASE WHEN SUM(d.impressions) > 0
              THEN (SUM(d.earnings) / SUM(d.impressions) * 1000) ELSE 0 END AS ecpm,
            CASE WHEN SUM(d.impressions) > 0
              THEN (SUM(d.clicks)::float8 / SUM(d.impressions) * 100) ELSE 0 END AS ctr
     FROM admob_dim_daily d
     WHERE d.client_id = $1
       AND d.report_date >= $2::date AND d.report_date <= $3::date
       AND d.dim_kind = $4
       ${accountClause}
       ${filterClause}
     GROUP BY d.dim_value
     ORDER BY earnings DESC NULLS LAST
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

/**
 * Account totals for a date range with inventory filters applied (from dim facts).
 * Uses the first active filter dim as the sum base + EXISTS for the rest.
 */
async function sumAdMobFiltered(clientId, opts = {}) {
  const filterSet = collectAdMobFilters(opts);
  if (!filterSet.hasAny || !filterSet.primary) return null;

  const primaryKind = filterSet.primary.kind;
  const scoped = collectAdMobFilters(opts, primaryKind);
  const params = [clientId, opts.startDate, opts.endDate, primaryKind];
  let accountClause = '';
  if (opts.accountId) {
    params.push(opts.accountId);
    accountClause += ` AND account_id = $${params.length}`;
  }
  const filterClause = appendAdMobFilterClause(params, scoped);

  const { rows } = await query(
    `SELECT COALESCE(SUM(d.earnings),0)::float AS earnings,
            COALESCE(SUM(d.impressions),0)::bigint AS impressions,
            COALESCE(SUM(d.clicks),0)::bigint AS clicks,
            COALESCE(SUM(d.ad_requests),0)::bigint AS ad_requests,
            COALESCE(SUM(d.matched_requests),0)::bigint AS matched_requests
     FROM admob_dim_daily d
     WHERE d.client_id = $1
       AND d.report_date >= $2::date AND d.report_date <= $3::date
       AND d.dim_kind = $4
       ${accountClause}
       ${filterClause}`,
    params
  );
  return { ...(rows[0] || emptyAdMobTotals()), currency: opts.currencyCode || 'USD' };
}

async function trendAdMobFiltered(clientId, opts = {}) {
  const filterSet = collectAdMobFilters(opts);
  if (!filterSet.hasAny || !filterSet.primary) return null;

  const primaryKind = filterSet.primary.kind;
  const scoped = collectAdMobFilters(opts, primaryKind);
  const params = [clientId, opts.startDate, opts.endDate, primaryKind];
  let accountClause = '';
  if (opts.accountId) {
    params.push(opts.accountId);
    accountClause += ` AND account_id = $${params.length}`;
  }
  const filterClause = appendAdMobFilterClause(params, scoped);

  const { rows } = await query(
    `SELECT d.report_date::text AS date,
            COALESCE(SUM(d.earnings),0)::float AS earnings,
            COALESCE(SUM(d.impressions),0)::bigint AS impressions,
            COALESCE(SUM(d.clicks),0)::bigint AS clicks,
            COALESCE(SUM(d.ad_requests),0)::bigint AS ad_requests,
            COALESCE(SUM(d.matched_requests),0)::bigint AS matched_requests,
            CASE WHEN SUM(d.impressions) > 0
              THEN (SUM(d.earnings) / SUM(d.impressions) * 1000) ELSE 0 END AS ecpm,
            CASE WHEN SUM(d.impressions) > 0
              THEN (SUM(d.clicks)::float8 / SUM(d.impressions) * 100) ELSE 0 END AS ctr,
            CASE WHEN SUM(d.ad_requests) > 0
              THEN (SUM(d.matched_requests)::float8 / SUM(d.ad_requests) * 100) ELSE 0 END AS match_rate
     FROM admob_dim_daily d
     WHERE d.client_id = $1
       AND d.report_date >= $2::date AND d.report_date <= $3::date
       AND d.dim_kind = $4
       ${accountClause}
       ${filterClause}
     GROUP BY d.report_date
     ORDER BY d.report_date ASC`,
    params
  );
  return rows;
}

async function breakdownAdSense(clientId, {
  accountId = null,
  startDate,
  endDate,
  dimKind = 'site',
  limit = 20,
  sites = [],
  countries = [],
  platforms = [],
} = {}) {
  const params = [clientId, startDate, endDate, dimKind];
  let accountClause = '';
  if (accountId) {
    params.push(accountId);
    accountClause += ` AND account_id = $${params.length}`;
  }
  const all = [
    { kind: 'site', values: parseList(sites) },
    { kind: 'country', values: parseList(countries) },
    { kind: 'platform', values: parseList(platforms) },
  ].filter((f) => f.values.length);
  const same = all.find((f) => f.kind === dimKind) || null;
  const cross = all.filter((f) => f.kind !== dimKind);

  let filterClause = '';
  if (same?.values?.length) {
    params.push(same.values);
    filterClause += ` AND d.dim_value = ANY($${params.length}::text[])`;
  }
  for (const f of cross) {
    params.push(f.kind);
    params.push(f.values);
    filterClause += `
      AND EXISTS (
        SELECT 1 FROM adsense_dim_daily x
        WHERE x.client_id = d.client_id AND x.account_id = d.account_id
          AND x.report_date = d.report_date
          AND x.dim_kind = $${params.length - 1}
          AND x.dim_value = ANY($${params.length}::text[])
      )`;
  }

  params.push(Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100));
  const { rows } = await query(
    `SELECT d.dim_value AS name,
            SUM(d.earnings)::float AS earnings,
            SUM(d.page_views)::bigint AS page_views,
            SUM(d.impressions)::bigint AS impressions,
            SUM(d.clicks)::bigint AS clicks,
            CASE WHEN SUM(d.page_views) > 0
              THEN (SUM(d.earnings) / SUM(d.page_views) * 1000) ELSE 0 END AS rpm,
            CASE WHEN SUM(d.impressions) > 0
              THEN (SUM(d.clicks)::float8 / SUM(d.impressions) * 100) ELSE 0 END AS ctr
     FROM adsense_dim_daily d
     WHERE d.client_id = $1
       AND d.report_date >= $2::date AND d.report_date <= $3::date
       AND d.dim_kind = $4
       ${accountClause}
       ${filterClause}
     GROUP BY d.dim_value
     ORDER BY earnings DESC NULLS LAST
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

async function dateRowsAdMob(clientId, {
  accountId = null,
  startDate,
  endDate,
  limit = 100,
} = {}) {
  const params = [clientId, startDate, endDate];
  let accountClause = '';
  if (accountId) {
    params.push(accountId);
    accountClause = ` AND account_id = $${params.length}`;
  }
  params.push(Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500));
  const { rows } = await query(
    `SELECT report_date::text AS name,
            SUM(earnings)::float AS earnings,
            SUM(impressions)::bigint AS impressions,
            SUM(clicks)::bigint AS clicks,
            CASE WHEN SUM(impressions) > 0
              THEN (SUM(earnings) / SUM(impressions) * 1000) ELSE 0 END AS ecpm,
            CASE WHEN SUM(impressions) > 0
              THEN (SUM(clicks)::float8 / SUM(impressions) * 100) ELSE 0 END AS ctr
     FROM admob_report_daily
     WHERE client_id = $1
       AND report_date >= $2::date AND report_date <= $3::date
       ${accountClause}
     GROUP BY report_date
     ORDER BY report_date DESC
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

async function tableAdMob(clientId, {
  accountId = null,
  startDate,
  endDate,
  dimKind = 'ad_unit',
  limit = 100,
  apps = [],
  formats = [],
  countries = [],
  platforms = [],
  adUnits = [],
  adSources = [],
  adSourceInstances = [],
  mediationGroups = [],
} = {}) {
  const cap = Math.min(limit, 500);
  const opts = {
    accountId, startDate, endDate, limit: cap,
    apps, formats, countries, platforms,
    adUnits, adSources, adSourceInstances, mediationGroups,
  };
  const hasFilters = collectAdMobFilters(opts).hasAny;
  const order = [];
  const seen = new Set();
  for (const kind of [
    dimKind, 'app', 'ad_unit', 'format', 'country', 'platform',
    'ad_source', 'ad_source_instance', 'mediation_group',
  ]) {
    if (!kind || seen.has(kind)) continue;
    seen.add(kind);
    order.push(kind);
  }
  for (const kind of order) {
    const rows = await breakdownAdMob(clientId, { ...opts, dimKind: kind });
    if (rows.length) {
      rows.resolvedDim = kind;
      return rows;
    }
  }
  // With inventory filters active, never fall back to unfiltered day totals.
  if (hasFilters) {
    const empty = [];
    empty.resolvedDim = dimKind;
    return empty;
  }
  const dateRows = await dateRowsAdMob(clientId, { accountId, startDate, endDate, limit: cap });
  dateRows.resolvedDim = 'date';
  return dateRows;
}

async function tableAdSense(clientId, {
  accountId = null,
  startDate,
  endDate,
  dimKind = 'ad_unit',
  limit = 100,
  sites = [],
  countries = [],
  platforms = [],
} = {}) {
  return breakdownAdSense(clientId, {
    accountId, startDate, endDate, dimKind, limit: Math.min(limit, 500),
    sites, countries, platforms,
  });
}

module.exports = {
  upsertAdMobDimRows,
  upsertAdSenseDimRows,
  listAdMobFilterOptions,
  listAdSenseFilterOptions,
  breakdownAdMob,
  breakdownAdSense,
  sumAdMobFiltered,
  trendAdMobFiltered,
  tableAdMob,
  tableAdSense,
  parseList,
  collectAdMobFilters,
};
