/**
 * AdMob combined-grain facts (app × ad unit × format × country × platform per day).
 * Used for domain users: exact scoped totals across one or more AdMob publishers.
 */
const { query, withTransaction } = require('../db');
const { getUnitsPerUsd, normalizeCurrency } = require('../utils/adsCurrency');

const DIM_COLUMNS = {
  app: 'app_name',
  ad_unit: 'ad_unit_name',
  format: 'format',
  country: 'country',
  platform: 'platform',
};

/** Request filter param → grain column. */
const FILTER_COLUMNS = {
  apps: 'app_name',
  adUnits: 'ad_unit_name',
  formats: 'format',
  countries: 'country',
  platforms: 'platform',
};

const FILTER_KEY_BY_DIM = {
  app: 'apps',
  ad_unit: 'adUnits',
  format: 'formats',
  country: 'countries',
  platform: 'platforms',
};

function parseList(raw) {
  if (Array.isArray(raw)) return raw.map(String).map((s) => s.trim()).filter(Boolean);
  if (raw == null || raw === '') return [];
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

function grainKey(r) {
  return [r.reportDate, r.appId, r.adUnitId, r.format, r.country, r.platform].join('|');
}

async function upsertAdMobGrainRows(clientId, accountId, rows = []) {
  const map = new Map();
  for (const r of rows) {
    if (!r?.reportDate) continue;
    const row = {
      reportDate: r.reportDate,
      appId: String(r.appId || '').slice(0, 200),
      appName: String(r.appName || '').slice(0, 300),
      adUnitId: String(r.adUnitId || '').slice(0, 200),
      adUnitName: String(r.adUnitName || '').slice(0, 300),
      format: String(r.format || '').slice(0, 100),
      country: String(r.country || '').slice(0, 100),
      platform: String(r.platform || '').slice(0, 100),
    };
    const key = grainKey(row);
    const prev = map.get(key);
    const add = (target) => {
      target.earnings = (target.earnings || 0) + (Number(r.earnings) || 0);
      target.impressions = (target.impressions || 0) + (Number(r.impressions) || 0);
      target.clicks = (target.clicks || 0) + (Number(r.clicks) || 0);
      target.adRequests = (target.adRequests || 0) + (Number(r.adRequests) || 0);
      target.matchedRequests = (target.matchedRequests || 0) + (Number(r.matchedRequests) || 0);
    };
    if (prev) add(prev);
    else {
      add(row);
      map.set(key, row);
    }
  }
  const unique = [...map.values()];
  if (!unique.length) return 0;
  const dates = [...new Set(unique.map((r) => r.reportDate))];

  await withTransaction(async (q) => {
    // Replace whole days so rows that vanished upstream (e.g. renamed units) don't linger.
    await q(
      `DELETE FROM admob_grain_daily
       WHERE client_id = $1 AND account_id = $2 AND report_date = ANY($3::date[])`,
      [clientId, accountId, dates]
    );
    const COLS = 15;
    const CHUNK = 300;
    for (let i = 0; i < unique.length; i += CHUNK) {
      const chunk = unique.slice(i, i + CHUNK);
      const values = [];
      const params = [];
      chunk.forEach((r, idx) => {
        const b = idx * COLS;
        values.push(`(${Array.from({ length: COLS }, (_, k) => `$${b + k + 1}${k === 2 ? '::date' : ''}`).join(',')},now())`);
        params.push(
          clientId, accountId, r.reportDate,
          r.appId, r.appName, r.adUnitId, r.adUnitName, r.format, r.country, r.platform,
          r.earnings, r.impressions, r.clicks, r.adRequests, r.matchedRequests,
        );
      });
      await q(
        `INSERT INTO admob_grain_daily (
           client_id, account_id, report_date,
           app_id, app_name, ad_unit_id, ad_unit_name, format, country, platform,
           earnings, impressions, clicks, ad_requests, matched_requests, updated_at
         ) VALUES ${values.join(',')}`,
        params
      );
    }
  });
  return unique.length;
}

/**
 * WHERE for scope + filters. scope = { accountIds, apps, adUnits } (keys "accountUuid:googleId").
 * Accounts with no app/ad-unit picks grant the whole account; otherwise a row is in scope when its
 * app or its ad unit is picked.
 */
function buildWhere(clientId, { start, end, scope, filters = {}, excludeFilter = null }) {
  const params = [clientId, start, end];
  let where = 'g.client_id = $1 AND g.report_date >= $2::date AND g.report_date <= $3::date';

  const accountIds = scope?.accountIds || [];
  params.push(accountIds.length ? accountIds : ['00000000-0000-0000-0000-000000000000']);
  where += ` AND g.account_id = ANY($${params.length}::uuid[])`;

  const apps = scope?.apps || [];
  const adUnits = scope?.adUnits || [];
  if (apps.length || adUnits.length) {
    const acct = (k) => k.split(':')[0];
    const p = (v) => { params.push(v); return `$${params.length}::text[]`; };
    const restricted = p([...new Set([...apps, ...adUnits].map(acct))]);
    const appKeys = p(apps);
    const unitKeys = p(adUnits);
    where += ` AND (
      NOT (g.account_id::text = ANY(${restricted}))
      OR (g.account_id::text || ':' || g.app_id) = ANY(${appKeys})
      OR (g.account_id::text || ':' || g.ad_unit_id) = ANY(${unitKeys})
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

/**
 * Per-account currency → one display currency (single shared currency, else USD).
 * Returns { currency, factor(accountId, date) }.
 */
async function currencyConverter(accounts = [], dates = []) {
  const byId = new Map(accounts.map((a) => [String(a.id), normalizeCurrency(a.currencyCode)]));
  const currencies = [...new Set(byId.values())];
  const currency = currencies.length === 1 ? currencies[0] : 'USD';
  if (currencies.every((c) => c === currency)) {
    return { currency, factor: () => 1 };
  }
  const cache = new Map();
  const rate = async (c, d) => {
    const k = `${c}|${d}`;
    if (!cache.has(k)) cache.set(k, await getUnitsPerUsd(c, d));
    return cache.get(k);
  };
  const factors = new Map();
  for (const [id, c] of byId) {
    for (const d of dates) {
      const from = await rate(c, d);
      const to = await rate(currency, d);
      factors.set(`${id}|${d}`, from > 0 && to > 0 ? to / from : 1);
    }
  }
  return { currency, factor: (id, d) => factors.get(`${id}|${d}`) ?? 1 };
}

function emptyTotals() {
  return { earnings: 0, impressions: 0, clicks: 0, ad_requests: 0, matched_requests: 0 };
}

function withDerived(t) {
  const imp = Number(t.impressions) || 0;
  const req = Number(t.ad_requests) || 0;
  return {
    ...t,
    earnings: Number((Number(t.earnings) || 0).toFixed(6)),
    ecpm: imp ? (t.earnings / imp) * 1000 : 0,
    ctr: imp ? (t.clicks / imp) * 100 : 0,
    match_rate: req ? (t.matched_requests / req) * 100 : 0,
  };
}

/**
 * Aggregate grain rows by an optional group column, converting each account/day to one currency.
 * Returns { currency, groups: Map(groupKey → totals) }.
 */
async function aggregate(clientId, accounts, opts, groupExpr = null) {
  const { where, params } = buildWhere(clientId, opts);
  const groupSel = groupExpr ? `${groupExpr} AS grp,` : "'' AS grp,";
  const { rows } = await query(
    `SELECT ${groupSel}
            g.account_id::text AS account_id,
            g.report_date::text AS d,
            SUM(g.earnings)::float8 AS earnings,
            SUM(g.impressions)::bigint AS impressions,
            SUM(g.clicks)::bigint AS clicks,
            SUM(g.ad_requests)::bigint AS ad_requests,
            SUM(g.matched_requests)::bigint AS matched_requests
     FROM admob_grain_daily g
     WHERE ${where}
     GROUP BY 1, 2, 3`,
    params
  );
  const dates = [...new Set(rows.map((r) => r.d))];
  const fx = await currencyConverter(accounts, dates);
  const groups = new Map();
  for (const r of rows) {
    const key = r.grp ?? '';
    if (!groups.has(key)) groups.set(key, emptyTotals());
    const t = groups.get(key);
    t.earnings += (Number(r.earnings) || 0) * fx.factor(r.account_id, r.d);
    t.impressions += Number(r.impressions) || 0;
    t.clicks += Number(r.clicks) || 0;
    t.ad_requests += Number(r.ad_requests) || 0;
    t.matched_requests += Number(r.matched_requests) || 0;
  }
  return { currency: fx.currency, groups };
}

async function scopedTotals(clientId, accounts, opts) {
  const { currency, groups } = await aggregate(clientId, accounts, opts);
  return { ...withDerived(groups.get('') || emptyTotals()), currency };
}

async function scopedTrend(clientId, accounts, opts) {
  const { groups } = await aggregate(clientId, accounts, opts, 'g.report_date::text');
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, t]) => ({ date, ...withDerived(t) }));
}

async function scopedBreakdown(clientId, accounts, opts, dimKind = 'app', limit = 20) {
  const col = DIM_COLUMNS[dimKind];
  if (!col) return [];
  const { groups } = await aggregate(clientId, accounts, opts, `g.${col}`);
  const cap = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 500);
  return [...groups.entries()]
    .map(([name, t]) => ({ name: name || 'Unknown', ...withDerived(t) }))
    .sort((a, b) => b.earnings - a.earnings)
    .slice(0, cap);
}

/** Distinct filter values inside the scope (display names only — no Google ids). */
async function scopedFilterOptions(clientId, opts, allowedDims = Object.keys(DIM_COLUMNS)) {
  const out = { apps: [], formats: [], countries: [], platforms: [], adUnits: [] };
  for (const dim of allowedDims) {
    const col = DIM_COLUMNS[dim];
    const key = FILTER_KEY_BY_DIM[dim];
    if (!col || !key) continue;
    const { where, params } = buildWhere(clientId, { ...opts, filters: {} });
    const { rows } = await query(
      `SELECT g.${col} AS v, SUM(g.earnings)::float8 AS e
       FROM admob_grain_daily g
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

/** Admin picker: apps + ad units per AdMob account (with Google ids for scope keys). */
async function grainScopeCatalog(clientId, accountIds = []) {
  if (!accountIds.length) return { apps: [], adUnits: [] };
  const { rows } = await query(
    `SELECT account_id::text AS account_id, app_id, MAX(app_name) AS app_name,
            ad_unit_id, MAX(ad_unit_name) AS ad_unit_name, SUM(earnings)::float8 AS e
     FROM admob_grain_daily
     WHERE client_id = $1 AND account_id = ANY($2::uuid[])
       AND report_date >= (CURRENT_DATE - INTERVAL '180 days')
     GROUP BY account_id, app_id, ad_unit_id
     ORDER BY e DESC NULLS LAST`,
    [clientId, accountIds]
  );
  const apps = new Map();
  const adUnits = [];
  for (const r of rows) {
    if (r.app_id) {
      const k = `${r.account_id}:${r.app_id}`;
      if (!apps.has(k)) apps.set(k, { key: k, accountId: r.account_id, appId: r.app_id, name: r.app_name || r.app_id });
    }
    if (r.ad_unit_id) {
      adUnits.push({
        key: `${r.account_id}:${r.ad_unit_id}`,
        accountId: r.account_id,
        appKey: r.app_id ? `${r.account_id}:${r.app_id}` : null,
        name: r.ad_unit_name || r.ad_unit_id,
      });
    }
  }
  return { apps: [...apps.values()], adUnits };
}

module.exports = {
  DIM_COLUMNS,
  upsertAdMobGrainRows,
  scopedTotals,
  scopedTrend,
  scopedBreakdown,
  scopedFilterOptions,
  grainScopeCatalog,
};
