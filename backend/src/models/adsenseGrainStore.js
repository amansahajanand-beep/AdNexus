/**
 * AdSense combined-grain facts (site × country × platform per day).
 * Used for domain users: exact scoped totals across one or more AdSense publishers, with filters applied together.
 * AdSense reports are in USD, so no currency conversion is needed.
 *
 * Ad units are not part of the grain: AdSense attributes only part of the earnings to ad units, so adding that
 * dimension would drop most of the revenue and make every total wrong.
 */
const { query, withTransaction } = require('../db');

const DIM_COLUMNS = {
  site: 'site',
  country: 'country',
  platform: 'platform',
};

/** Request filter param → grain column. */
const FILTER_COLUMNS = {
  sites: 'site',
  countries: 'country',
  platforms: 'platform',
};

const FILTER_KEY_BY_DIM = {
  site: 'sites',
  country: 'countries',
  platform: 'platforms',
};

const NO_ACCOUNT = '00000000-0000-0000-0000-000000000000';

function parseList(raw) {
  if (Array.isArray(raw)) return raw.map(String).map((s) => s.trim()).filter(Boolean);
  if (raw == null || raw === '') return [];
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

function grainKey(r) {
  return [r.reportDate, r.site, r.country, r.platform].join('|');
}

async function upsertAdSenseGrainRows(clientId, accountId, rows = []) {
  const map = new Map();
  for (const r of rows) {
    if (!r?.reportDate) continue;
    const row = {
      reportDate: r.reportDate,
      site: String(r.site || '').slice(0, 300),
      country: String(r.country || '').slice(0, 100),
      platform: String(r.platform || '').slice(0, 100),
    };
    const key = grainKey(row);
    const target = map.get(key) || row;
    target.earnings = (target.earnings || 0) + (Number(r.earnings) || 0);
    target.pageViews = (target.pageViews || 0) + (Number(r.pageViews) || 0);
    target.impressions = (target.impressions || 0) + (Number(r.impressions) || 0);
    target.clicks = (target.clicks || 0) + (Number(r.clicks) || 0);
    map.set(key, target);
  }
  const unique = [...map.values()];
  if (!unique.length) return 0;
  const dates = [...new Set(unique.map((r) => r.reportDate))];

  await withTransaction(async (q) => {
    // Replace whole days so rows that vanished upstream (e.g. a renamed site) don't linger.
    await q(
      `DELETE FROM adsense_scope_grain_daily
       WHERE client_id = $1 AND account_id = $2 AND report_date = ANY($3::date[])`,
      [clientId, accountId, dates]
    );
    const COLS = 10;
    const CHUNK = 400;
    for (let i = 0; i < unique.length; i += CHUNK) {
      const chunk = unique.slice(i, i + CHUNK);
      const values = [];
      const params = [];
      chunk.forEach((r, idx) => {
        const b = idx * COLS;
        values.push(`(${Array.from({ length: COLS }, (_, k) => `$${b + k + 1}${k === 2 ? '::date' : ''}`).join(',')},now())`);
        params.push(
          clientId, accountId, r.reportDate,
          r.site, r.country, r.platform,
          r.earnings, r.pageViews, r.impressions, r.clicks,
        );
      });
      await q(
        `INSERT INTO adsense_scope_grain_daily (
           client_id, account_id, report_date,
           site, country, platform,
           earnings, page_views, impressions, clicks, updated_at
         ) VALUES ${values.join(',')}`,
        params
      );
    }
  });
  return unique.length;
}

/**
 * WHERE for scope + filters. scope = { accountIds, sites } (site keys are "accountUuid:siteName").
 * An account with no site picked grants the whole account; otherwise only the picked sites.
 */
function buildWhere(clientId, { start, end, scope, filters = {}, excludeFilter = null }) {
  const params = [clientId, start, end];
  let where = 'g.client_id = $1 AND g.report_date >= $2::date AND g.report_date <= $3::date';

  const accountIds = scope?.accountIds || [];
  params.push(accountIds.length ? accountIds : [NO_ACCOUNT]);
  where += ` AND g.account_id = ANY($${params.length}::uuid[])`;

  const sites = scope?.sites || [];
  if (sites.length) {
    const acct = (k) => k.split(':')[0];
    const p = (v) => { params.push(v); return `$${params.length}::text[]`; };
    const restricted = p([...new Set(sites.map(acct))]);
    const siteKeys = p(sites);
    where += ` AND (
      NOT (g.account_id::text = ANY(${restricted}))
      OR (g.account_id::text || ':' || g.site) = ANY(${siteKeys})
    )`;
  }

  for (const [key, col] of Object.entries(FILTER_COLUMNS)) {
    if (key === excludeFilter) continue;
    const values = parseList(filters[key]);
    if (!values.length) continue;
    params.push(values);
    where += ` AND g.${col} = ANY($${params.length}::text[])`;
  }
  return { where, params };
}

function emptyTotals() {
  return { earnings: 0, page_views: 0, impressions: 0, clicks: 0 };
}

function withDerived(t) {
  const pv = Number(t.page_views) || 0;
  const imp = Number(t.impressions) || 0;
  return {
    ...t,
    earnings: Number((Number(t.earnings) || 0).toFixed(6)),
    rpm: pv ? (t.earnings / pv) * 1000 : 0,
    ctr: imp ? (t.clicks / imp) * 100 : 0,
  };
}

async function aggregate(clientId, opts, groupExpr = null) {
  const { where, params } = buildWhere(clientId, opts);
  const { rows } = await query(
    `SELECT ${groupExpr ? `${groupExpr} AS grp,` : "'' AS grp,"}
            SUM(g.earnings)::float8 AS earnings,
            SUM(g.page_views)::bigint AS page_views,
            SUM(g.impressions)::bigint AS impressions,
            SUM(g.clicks)::bigint AS clicks
     FROM adsense_scope_grain_daily g
     WHERE ${where}
     GROUP BY 1`,
    params
  );
  const groups = new Map();
  for (const r of rows) {
    groups.set(r.grp ?? '', {
      earnings: Number(r.earnings) || 0,
      page_views: Number(r.page_views) || 0,
      impressions: Number(r.impressions) || 0,
      clicks: Number(r.clicks) || 0,
    });
  }
  return groups;
}

// `accounts` is accepted (and unused) so these match the AdMob scoped store signature the router calls.
async function scopedTotals(clientId, accounts, opts) {
  const groups = await aggregate(clientId, opts);
  return { ...withDerived(groups.get('') || emptyTotals()), currency: 'USD' };
}

async function scopedTrend(clientId, accounts, opts) {
  const groups = await aggregate(clientId, opts, 'g.report_date::text');
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, t]) => ({ date, ...withDerived(t) }));
}

async function scopedBreakdown(clientId, accounts, opts, dimKind = 'site', limit = 20) {
  const col = DIM_COLUMNS[dimKind];
  if (!col) return [];
  const groups = await aggregate(clientId, opts, `g.${col}`);
  const cap = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 500);
  return [...groups.entries()]
    .map(([name, t]) => ({ name: name || 'Unknown', ...withDerived(t) }))
    .sort((a, b) => b.earnings - a.earnings)
    .slice(0, cap);
}

/** Distinct filter values inside the scope (display names only). */
async function scopedFilterOptions(clientId, opts, allowedDims = Object.keys(DIM_COLUMNS)) {
  const out = { sites: [], countries: [], platforms: [] };
  for (const dim of allowedDims) {
    const col = DIM_COLUMNS[dim];
    const key = FILTER_KEY_BY_DIM[dim];
    if (!col || !key) continue;
    const { where, params } = buildWhere(clientId, { ...opts, filters: {} });
    const { rows } = await query(
      `SELECT g.${col} AS v, SUM(g.earnings)::float8 AS e
       FROM adsense_scope_grain_daily g
       WHERE ${where} AND g.${col} <> ''
       GROUP BY 1
       ORDER BY e DESC NULLS LAST
       LIMIT 2000`,
      params
    );
    out[key] = rows.map((r) => ({ id: r.v, label: r.v }));
  }
  return out;
}

/** Admin picker: sites per AdSense account (keys are "accountUuid:siteName"). */
async function grainScopeCatalog(clientId, accountIds = []) {
  if (!accountIds.length) return { sites: [] };
  const { rows } = await query(
    `SELECT account_id::text AS account_id, site, SUM(earnings)::float8 AS e
     FROM adsense_scope_grain_daily
     WHERE client_id = $1 AND account_id = ANY($2::uuid[]) AND site <> ''
       AND report_date >= (CURRENT_DATE - INTERVAL '180 days')
     GROUP BY account_id, site
     ORDER BY e DESC NULLS LAST`,
    [clientId, accountIds]
  );
  return {
    sites: rows.map((r) => ({ key: `${r.account_id}:${r.site}`, accountId: r.account_id, name: r.site })),
  };
}

module.exports = {
  DIM_COLUMNS,
  upsertAdSenseGrainRows,
  scopedTotals,
  scopedTrend,
  scopedBreakdown,
  scopedFilterOptions,
  grainScopeCatalog,
};
