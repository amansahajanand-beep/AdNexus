const { query } = require('../db');
const {
  listRoiClientAccounts,
  listOtherExpenses,
  listCampaignMaps,
} = require('../models/adsAccountStore');
const { coerceWarehouseRevenue } = require('../utils/gamReportMetrics');
const { adsSpendSql, adsSpendDisplayCurrency, usdToSpendCurrency } = require('../utils/adsCurrency');
const { kpiSliceFilterSql } = require('./reportGrainStore');
const { cache } = require('../gam/client');

/** Prefer cost_native (Google Ads account currency) so totals match the Ads UI. */
const SPEND = (alias = 's') => adsSpendSql(alias);

/** Convert GAM USD earn → Ads display currency (INR when ADS_FORCE_CURRENCY=INR). */
async function earnInSpendCurrency(earnUsd, endDate = null) {
  const cur = adsSpendDisplayCurrency();
  if (cur === 'USD') return round2(earnUsd);
  return round2(await usdToSpendCurrency(earnUsd, endDate));
}

const ROI_SUMMARY_CACHE_TTL = Math.max(
  15,
  parseInt(process.env.ROI_SUMMARY_CACHE_TTL || '60', 10) || 60
);
const ROI_BREAKDOWN_CACHE_TTL = Math.max(
  30,
  parseInt(process.env.ROI_BREAKDOWN_CACHE_TTL || '120', 10) || 120
);

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function targetExpenseKey(type, key) {
  return `${type}:${String(key || '').trim().toLowerCase()}`;
}

/** Site/app expenses keyed by target and by date+target (general excluded). */
function buildSiteAppExpenseMaps(expenses, {
  includeSite = true,
  includeApp = true,
  allowTarget = null,
} = {}) {
  const byTarget = new Map();
  const byTargetDate = new Map();
  for (const e of expenses || []) {
    if (!e || e.targetType === 'general') continue;
    if (e.targetType === 'site' && !includeSite) continue;
    if (e.targetType === 'app' && !includeApp) continue;
    const tk = targetExpenseKey(e.targetType, e.targetKey);
    if (typeof allowTarget === 'function' && !allowTarget(e.targetType, e.targetKey)) continue;
    byTarget.set(tk, round2((byTarget.get(tk) || 0) + (Number(e.amount) || 0)));
    const day = ymd(e.expenseDate);
    if (day) {
      const dk = `${day}:${tk}`;
      byTargetDate.set(dk, round2((byTargetDate.get(dk) || 0) + (Number(e.amount) || 0)));
    }
  }
  return { byTarget, byTargetDate };
}

function sumAdsSpendByTarget(rows = []) {
  const m = new Map();
  for (const r of rows) {
    const k = targetExpenseKey(r.targetType, r.targetKey);
    m.set(k, round2((m.get(k) || 0) + (Number(r.adsSpend) || 0)));
  }
  return m;
}

function sumAdsSpendByTargetDate(rows = []) {
  const m = new Map();
  for (const r of rows) {
    const k = `${ymd(r.date)}:${targetExpenseKey(r.targetType, r.targetKey)}`;
    m.set(k, round2((m.get(k) || 0) + (Number(r.adsSpend) || 0)));
  }
  return m;
}

/** Split a target's expense across country/account rows by Ads spend share. */
function allocateTargetExpense(expenseTotal, rowSpend, targetSpendTotal) {
  const exp = Number(expenseTotal) || 0;
  const spend = Number(rowSpend) || 0;
  const total = Number(targetSpendTotal) || 0;
  if (!(exp > 0) || !(spend > 0) || !(total > 0)) return 0;
  return round2(exp * (spend / total));
}

function expenseMetricsFromConvertedEarn(earnConverted, adsSpend, otherExpenses) {
  const e = Number(earnConverted) || 0;
  const other = Number(otherExpenses) || 0;
  const spend = Number(adsSpend) || 0;
  return {
    otherExpenses: round2(other),
    profitExpense: round2(e - other),
    roiExpensePercent: other > 0 ? round2(((e - other) / other) * 100) : null,
    totalCost: round2(spend + other),
    profit: round2(e - spend - other),
    roiPercent: (spend + other) > 0 ? round2(((e - spend - other) / (spend + other)) * 100) : null,
  };
}

function ymd(d) {
  if (!d) return '';
  if (d instanceof Date && !Number.isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10);
  }
  return String(d).slice(0, 10);
}

/** ROI% = (earn − cost) / cost × 100 when cost > 0 */
function roiPercent(earn, cost) {
  const c = Number(cost) || 0;
  if (c <= 0) return null;
  const profit = (Number(earn) || 0) - c;
  return round2((profit / c) * 100);
}

/** Google Ads engagement metrics (from synced ads_spend_* tables). */
function adsEngagementMetrics({
  impressions = 0,
  clicks = 0,
  conversions = 0,
  adsSpend = 0,
} = {}) {
  const imps = Math.round(Number(impressions) || 0);
  const cl = Math.round(Number(clicks) || 0);
  const conv = Number(conversions) || 0;
  const spend = Number(adsSpend) || 0;
  return {
    impressions: imps,
    clicks: cl,
    conversions: round2(conv),
    /** CTR % = clicks / impressions × 100 */
    ctr: imps > 0 ? round2((cl / imps) * 100) : null,
    /** Ads eCPM = spend / impressions × 1000 */
    ecpm: imps > 0 ? round2((spend / imps) * 1000) : null,
  };
}

async function metricsFor(earn, adsSpend, otherExpenses, engagement = {}, { endDate = null } = {}) {
  // GAM earn is USD in warehouse; Ads spend may be native INR — convert earn for ROI math/UI.
  const e = await earnInSpendCurrency(earn, endDate);
  const spend = Number(adsSpend) || 0;
  const other = Number(otherExpenses) || 0;
  const profitSpend = round2(e - spend);
  const profitExpense = round2(e - other);
  const totalCost = round2(spend + other);
  return {
    adsSpend: round2(spend),
    otherExpenses: round2(other),
    totalCost,
    earn: round2(e),
    profitSpend,
    profitExpense,
    profit: round2(e - totalCost),
    roiSpendPercent: roiPercent(e, spend),
    roiExpensePercent: roiPercent(e, other),
    roiPercent: roiPercent(e, totalCost),
    ...adsEngagementMetrics({ ...engagement, adsSpend: spend }),
  };
}

/**
 * Network-wide GAM earn — same source as Dashboard Overview cards
 * (rollup_kpi_daily from the canonical KPI / channel slice).
 * Do NOT sum inventory_core + app_id (those overlap and ~2× Overview).
 */
async function loadCanonicalGamEarn(clientId, start, end) {
  // Prefer network rollup (same source as dashboard overview) — one row/day, avoids
  // contending with grain scans while Ads/GAM sync holds pool connections.
  try {
    const { fetchNetworkTotalsFromDB } = require('./networkRollupStore');
    const net = await fetchNetworkTotalsFromDB(start, end);
    const impressions = Number(net.impressions) || 0;
    const revenue = coerceWarehouseRevenue(net.revenue, impressions);
    if (revenue > 0 || impressions > 0) return round2(revenue);
  } catch (_) { /* fall through */ }

  const rollup = await query(
    `SELECT
       COALESCE(SUM(revenue), 0)::float8 AS revenue,
       COALESCE(SUM(impressions), 0)::float8 AS impressions
     FROM rollup_kpi_daily
     WHERE client_id = $1::uuid
       AND report_date BETWEEN $2::date AND $3::date`,
    [clientId, start, end]
  );
  const rt = rollup.rows[0] || {};
  let revenue = coerceWarehouseRevenue(rt.revenue, Number(rt.impressions) || 0);
  if (revenue > 0) return round2(revenue);

  const grain = await query(
    `SELECT
       COALESCE(SUM(g.revenue), 0)::float8 AS revenue,
       COALESCE(SUM(g.impressions), 0)::float8 AS impressions
     FROM report_grain g
     WHERE g.client_id = $1::uuid
       AND g.report_date BETWEEN $2::date AND $3::date
       AND ${kpiSliceFilterSql('g')}`,
    [clientId, start, end]
  );
  const gt = grain.rows[0] || {};
  revenue = coerceWarehouseRevenue(gt.revenue, Number(gt.impressions) || 0);
  return round2(revenue);
}

/**
 * GAM earn only for inventory linked to Ads spend in range:
 * - App Campaign package IDs on ads_spend_* rows
 * - Site/app targets from ads_campaign_map for spend without app_id
 * Never returns full-network revenue (that inflated ROI overview vs Ads apps).
 */
async function loadAdsLinkedGamEarn(clientId, start, end, spendOpts = {}) {
  const useCountry = Array.isArray(spendOpts.countryCodes) && spendOpts.countryCodes.length > 0;
  const table = useCountry ? 'ads_spend_country_daily' : 'ads_spend_daily';
  // $1–$3 = client/start/end; filter placeholders must continue from $4.
  const { extra, params: filterParams } = spendFilterSql(spendOpts, 's', 3);
  const params = [clientId, start, end, ...filterParams];

  const { rows: linkRows } = await query(
    `SELECT target_type, target_key FROM (
       SELECT 'app'::text AS target_type,
              LOWER(TRIM(s.app_id)) AS target_key
       FROM ${table} s
       WHERE s.client_id = $1
         AND s.report_date BETWEEN $2 AND $3
         AND NULLIF(TRIM(s.app_id), '') IS NOT NULL
         ${extra}
       UNION
       SELECT LOWER(TRIM(m.target_type)) AS target_type,
              LOWER(TRIM(m.target_key)) AS target_key
       FROM ${table} s
       JOIN ads_campaign_map m
         ON m.client_id = s.client_id
        AND m.ads_account_id = s.ads_account_id
        AND m.campaign_id = s.campaign_id
       WHERE s.client_id = $1
         AND s.report_date BETWEEN $2 AND $3
         AND NULLIF(TRIM(s.app_id), '') IS NULL
         AND NULLIF(TRIM(m.target_key), '') IS NOT NULL
         ${extra}
     ) x
     WHERE NULLIF(target_key, '') IS NOT NULL
     GROUP BY 1, 2`,
    params
  );

  const appKeys = [];
  const siteKeys = [];
  (linkRows || []).forEach((r) => {
    const type = String(r.target_type || '').toLowerCase();
    const key = String(r.target_key || '').trim().toLowerCase();
    if (!key) return;
    if (type === 'site') siteKeys.push(key);
    else appKeys.push(key);
  });
  const uniqApps = [...new Set(appKeys)];
  const uniqSites = [...new Set(siteKeys)];
  if (!uniqApps.length && !uniqSites.length) return 0;

  let earn = 0;
  if (uniqApps.length) {
    const appParams = [clientId, start, end, uniqApps];
    const { rows } = await query(
      `SELECT
         COALESCE(SUM(g.revenue), 0)::float8 AS revenue,
         COALESCE(SUM(g.impressions), 0)::float8 AS impressions
       FROM report_grain g
       WHERE g.client_id = $1::uuid
         AND g.report_date BETWEEN $2::date AND $3::date
         AND g.slice_key = 'app_id'
         AND LOWER(TRIM(COALESCE(NULLIF(g.app_id, ''), g.app_name))) = ANY($4::text[])`,
      appParams
    );
    const t = rows[0] || {};
    earn += coerceWarehouseRevenue(t.revenue, Number(t.impressions) || 0);
  }
  if (uniqSites.length) {
    const siteParams = [clientId, start, end, uniqSites];
    const { rows } = await query(
      `SELECT
         COALESCE(SUM(g.revenue), 0)::float8 AS revenue,
         COALESCE(SUM(g.impressions), 0)::float8 AS impressions
       FROM report_grain g
       JOIN dim_site ds ON ds.id = g.site_id AND ds.client_id = g.client_id
       WHERE g.client_id = $1::uuid
         AND g.report_date BETWEEN $2::date AND $3::date
         AND g.slice_key = 'inventory_core'
         AND g.site_id > 0
         AND LOWER(TRIM(ds.name)) = ANY($4::text[])`,
      siteParams
    );
    const t = rows[0] || {};
    earn += coerceWarehouseRevenue(t.revenue, Number(t.impressions) || 0);
  }
  return round2(earn);
}

/** Daily per site/app earn for ROI table rows (attribution), not for network summary. */
async function loadGamEarnByTargetDaily(clientId, start, end, { countryNames = null } = {}) {
  const countryFilter = Array.isArray(countryNames) && countryNames.length
    ? countryNames.map((n) => String(n).trim().toLowerCase()).filter(Boolean)
    : null;
  const countryParams = countryFilter ? [countryFilter] : [];
  const countryClause = countryFilter
    ? ` AND EXISTS (
         SELECT 1 FROM dim_country dc
         WHERE dc.id = g.country_id
           AND LOWER(TRIM(dc.name)) = ANY($${4}::text[])
       )`
    : '';

  const siteRes = await query(
    `SELECT g.report_date::text AS report_date,
            LOWER(TRIM(ds.name)) AS target_key,
            COALESCE(SUM(g.revenue), 0)::float8 AS earn
     FROM report_grain g
     JOIN dim_site ds ON ds.id = g.site_id AND ds.client_id = g.client_id
     WHERE g.client_id = $1
       AND g.report_date BETWEEN $2 AND $3
       AND g.slice_key = 'inventory_core'
       AND g.site_id > 0
       AND NULLIF(TRIM(ds.name), '') IS NOT NULL
       ${countryClause}
     GROUP BY 1, 2`,
    [clientId, start, end, ...countryParams]
  );

  const appRes = await query(
    `SELECT g.report_date::text AS report_date,
            LOWER(TRIM(COALESCE(NULLIF(g.app_id, ''), g.app_name))) AS target_key,
            COALESCE(SUM(g.revenue), 0)::float8 AS earn
     FROM report_grain g
     WHERE g.client_id = $1
       AND g.report_date BETWEEN $2 AND $3
       AND g.slice_key = 'app_id'
       AND NULLIF(TRIM(COALESCE(NULLIF(g.app_id, ''), g.app_name)), '') IS NOT NULL
       ${countryClause}
     GROUP BY 1, 2`,
    [clientId, start, end, ...countryParams]
  );

  const sites = [];
  siteRes.rows.forEach((r) => {
    if (!r.target_key) return;
    sites.push({
      date: ymd(r.report_date),
      targetKey: r.target_key,
      earn: Number(r.earn) || 0,
    });
  });
  const apps = [];
  appRes.rows.forEach((r) => {
    if (!r.target_key) return;
    apps.push({
      date: ymd(r.report_date),
      targetKey: r.target_key,
      earn: Number(r.earn) || 0,
    });
  });
  return { sites, apps };
}

/** Per site/app earn totals (no daily grain) — used when ROI table rows are not requested. */
async function loadGamEarnByTargetAggregated(clientId, start, end, { countryNames = null } = {}) {
  const countryFilter = Array.isArray(countryNames) && countryNames.length
    ? countryNames.map((n) => String(n).trim().toLowerCase()).filter(Boolean)
    : null;
  const countryParams = countryFilter ? [countryFilter] : [];
  const countryClause = countryFilter
    ? ` AND EXISTS (
         SELECT 1 FROM dim_country dc
         WHERE dc.id = g.country_id
           AND LOWER(TRIM(dc.name)) = ANY($${4}::text[])
       )`
    : '';

  const siteRes = await query(
    `SELECT LOWER(TRIM(ds.name)) AS target_key,
            COALESCE(SUM(g.revenue), 0)::float8 AS earn
     FROM report_grain g
     JOIN dim_site ds ON ds.id = g.site_id AND ds.client_id = g.client_id
     WHERE g.client_id = $1
       AND g.report_date BETWEEN $2 AND $3
       AND g.slice_key = 'inventory_core'
       AND g.site_id > 0
       AND NULLIF(TRIM(ds.name), '') IS NOT NULL
       ${countryClause}
     GROUP BY 1`,
    [clientId, start, end, ...countryParams]
  );

  const appRes = await query(
    `SELECT LOWER(TRIM(COALESCE(NULLIF(g.app_id, ''), g.app_name))) AS target_key,
            COALESCE(SUM(g.revenue), 0)::float8 AS earn
     FROM report_grain g
     WHERE g.client_id = $1
       AND g.report_date BETWEEN $2 AND $3
       AND g.slice_key = 'app_id'
       AND NULLIF(TRIM(COALESCE(NULLIF(g.app_id, ''), g.app_name)), '') IS NOT NULL
       ${countryClause}
     GROUP BY 1`,
    [clientId, start, end, ...countryParams]
  );

  const sites = [];
  siteRes.rows.forEach((r) => {
    if (!r.target_key) return;
    sites.push({
      targetKey: r.target_key,
      earn: Number(r.earn) || 0,
    });
  });
  const apps = [];
  appRes.rows.forEach((r) => {
    if (!r.target_key) return;
    apps.push({
      targetKey: r.target_key,
      earn: Number(r.earn) || 0,
    });
  });
  return { sites, apps };
}

/** Scoped site/app earn — avoids full report_grain scans when inventory filters are set. */
async function loadGamEarnByTargetAggregatedScoped(clientId, start, end, {
  appKeys = [],
  siteKeys = [],
  countryNames = null,
} = {}) {
  const apps = [...new Set((appKeys || []).map((k) => String(k).trim().toLowerCase()).filter(Boolean))];
  const sites = [...new Set((siteKeys || []).map((k) => String(k).trim().toLowerCase()).filter(Boolean))];
  if (!apps.length && !sites.length) return { sites: [], apps: [] };

  const countryFilter = Array.isArray(countryNames) && countryNames.length
    ? countryNames.map((n) => String(n).trim().toLowerCase()).filter(Boolean)
    : null;

  const outSites = [];
  const outApps = [];

  if (sites.length) {
    const exactSites = [...new Set(sites.map((k) => normSiteHost(k)).filter(Boolean))];
    const params = [clientId, start, end, exactSites];
    let countryClause = '';
    if (countryFilter?.length) {
      params.push(countryFilter);
      countryClause = ` AND EXISTS (
         SELECT 1 FROM dim_country dc
         WHERE dc.id = g.country_id
           AND LOWER(TRIM(dc.name)) = ANY($${params.length}::text[])
       )`;
    }
    const { rows } = await query(
      `SELECT LOWER(TRIM(REGEXP_REPLACE(ds.name, '^www\\.', '', 'i'))) AS target_key,
              COALESCE(SUM(g.revenue), 0)::float8 AS revenue,
              COALESCE(SUM(g.impressions), 0)::float8 AS impressions
       FROM report_grain g
       JOIN dim_site ds ON ds.id = g.site_id AND ds.client_id = g.client_id
       WHERE g.client_id = $1
         AND g.report_date BETWEEN $2 AND $3
         AND g.site_id > 0
         AND g.slice_key = 'inventory_core'
         AND LOWER(TRIM(REGEXP_REPLACE(ds.name, '^www\\.', '', 'i'))) = ANY($4::text[])
         ${countryClause}
       GROUP BY 1`,
      params
    );
    rows.forEach((r) => {
      if (!r.target_key) return;
      outSites.push({
        targetKey: normSiteHost(r.target_key),
        earn: coerceWarehouseRevenue(r.revenue, Number(r.impressions) || 0),
      });
    });
  }

  if (apps.length) {
    const params = [clientId, start, end, apps];
    let countryClause = '';
    if (countryFilter?.length) {
      params.push(countryFilter);
      countryClause = ` AND EXISTS (
         SELECT 1 FROM dim_country dc
         WHERE dc.id = g.country_id
           AND LOWER(TRIM(dc.name)) = ANY($${params.length}::text[])
       )`;
    }
    const { rows } = await query(
      `SELECT LOWER(TRIM(COALESCE(NULLIF(g.app_id, ''), g.app_name))) AS target_key,
              COALESCE(SUM(g.revenue), 0)::float8 AS earn
       FROM report_grain g
       WHERE g.client_id = $1
         AND g.report_date BETWEEN $2 AND $3
         AND g.slice_key = 'app_id'
         AND LOWER(TRIM(COALESCE(NULLIF(g.app_id, ''), g.app_name))) = ANY($4::text[])
         ${countryClause}
       GROUP BY 1`,
      params
    );
    rows.forEach((r) => {
      if (!r.target_key) return;
      outApps.push({ targetKey: r.target_key, earn: Number(r.earn) || 0 });
    });
  }

  return { sites: outSites, apps: outApps };
}

async function resolveCountryNames(clientId, countryCodes = []) {
  const codes = [...new Set(
    (countryCodes || []).map((c) => String(c).trim().toUpperCase()).filter(Boolean)
  )];
  if (!codes.length) return [];
  const { rows } = await query(
    `SELECT UPPER(TRIM(country_code)) AS country_code,
            MAX(country_name) AS country_name
     FROM ads_spend_country_daily
     WHERE client_id = $1
       AND UPPER(TRIM(country_code)) = ANY($2::text[])
     GROUP BY 1`,
    [clientId, codes]
  );
  return rows.map((r) => String(r.country_name || r.country_code || '').trim()).filter(Boolean);
}

async function loadGamEarnByCountry(clientId, start, end) {
  const rollup = await query(
    `SELECT LOWER(TRIM(dim_value)) AS country_key,
            MAX(dim_value) AS country_name,
            COALESCE(SUM(revenue), 0)::float8 AS earn
     FROM rollup_dim_daily
     WHERE client_id = $1
       AND report_date BETWEEN $2 AND $3
       AND dim_kind = 'country'
       AND NULLIF(TRIM(dim_value), '') IS NOT NULL
     GROUP BY 1`,
    [clientId, start, end]
  );
  if (rollup.rows?.length) {
    const map = new Map();
    rollup.rows.forEach((r) => {
      const key = String(r.country_key || '').trim().toLowerCase();
      if (!key) return;
      map.set(key, {
        countryName: r.country_name || key,
        earn: Number(r.earn) || 0,
      });
    });
    return map;
  }

  const { rows } = await query(
    `SELECT LOWER(TRIM(dc.name)) AS country_key,
            dc.name AS country_name,
            COALESCE(SUM(g.revenue), 0)::float8 AS earn
     FROM report_grain g
     JOIN dim_country dc ON dc.id = g.country_id AND dc.id <> 0
     WHERE g.client_id = $1
       AND g.report_date BETWEEN $2 AND $3
       AND ${kpiSliceFilterSql('g')}
     GROUP BY dc.id, dc.name`,
    [clientId, start, end]
  );
  const map = new Map();
  rows.forEach((r) => {
    const key = String(r.country_key || '').trim().toLowerCase();
    if (!key) return;
    map.set(key, {
      countryName: r.country_name || key,
      earn: Number(r.earn) || 0,
    });
  });
  return map;
}

async function loadCountrySpendBreakdown(clientId, start, end, {
  accountIds = null,
  campaignIds = null,
  countryCodes = null,
} = {}) {
  const params = [clientId, start, end];
  let extra = '';
  if (accountIds?.length) {
    params.push(accountIds);
    extra += ` AND s.ads_account_id = ANY($${params.length}::uuid[])`;
  }
  if (campaignIds?.length) {
    params.push(campaignIds.map(String));
    extra += ` AND s.campaign_id = ANY($${params.length}::text[])`;
  }
  if (countryCodes?.length) {
    params.push(countryCodes.map((c) => String(c).trim().toUpperCase()));
    extra += ` AND UPPER(TRIM(s.country_code)) = ANY($${params.length}::text[])`;
  }
  const { rows } = await query(
    `SELECT UPPER(TRIM(s.country_code)) AS country_code,
            MAX(s.country_name) AS country_name,
            COALESCE(SUM(${SPEND('s')}), 0)::float8 AS ads_spend,
            COALESCE(SUM(s.clicks), 0)::bigint AS clicks,
            COALESCE(SUM(s.impressions), 0)::bigint AS impressions,
            COALESCE(SUM(s.conversions), 0)::float8 AS conversions
     FROM ads_spend_country_daily s
     WHERE s.client_id = $1
       AND s.report_date BETWEEN $2 AND $3
       ${extra}
     GROUP BY 1
     ORDER BY ads_spend DESC, country_name ASC`,
    params
  );
  return rows.map((r) => ({
    countryCode: String(r.country_code || '').toUpperCase(),
    countryName: String(r.country_name || r.country_code || '').trim(),
    adsSpend: Number(r.ads_spend) || 0,
    clicks: Number(r.clicks) || 0,
    impressions: Number(r.impressions) || 0,
    conversions: Number(r.conversions) || 0,
  }));
}

/** Spend by ads account × site/app × country (from synced country grain). */
async function loadCountrySpendByTarget(clientId, start, end, {
  accountIds = null,
  campaignIds = null,
  countryCodes = null,
} = {}) {
  const params = [clientId, start, end];
  let extra = '';
  if (accountIds?.length) {
    params.push(accountIds);
    extra += ` AND s.ads_account_id = ANY($${params.length}::uuid[])`;
  }
  if (campaignIds?.length) {
    params.push(campaignIds.map(String));
    extra += ` AND s.campaign_id = ANY($${params.length}::text[])`;
  }
  if (countryCodes?.length) {
    params.push(countryCodes.map((c) => String(c).trim().toUpperCase()));
    extra += ` AND UPPER(TRIM(s.country_code)) = ANY($${params.length}::text[])`;
  }

  const { rows } = await query(
    `SELECT x.ads_account_id,
            MAX(a.descriptive_name) AS account_name,
            MAX(a.customer_id) AS customer_id,
            x.target_type,
            x.target_key,
            x.country_code,
            MAX(x.country_name) AS country_name,
            COALESCE(SUM(x.cost), 0)::float8 AS ads_spend,
            COALESCE(SUM(x.clicks), 0)::bigint AS clicks,
            COALESCE(SUM(x.impressions), 0)::bigint AS impressions,
            COALESCE(SUM(x.conversions), 0)::float8 AS conversions
     FROM (
       SELECT s.ads_account_id,
              'app'::text AS target_type,
              LOWER(TRIM(s.app_id)) AS target_key,
              UPPER(TRIM(s.country_code)) AS country_code,
              s.country_name,
              ${SPEND('s')} AS cost,
              s.clicks,
              s.impressions,
              s.conversions
       FROM ads_spend_country_daily s
       WHERE s.client_id = $1
         AND s.report_date BETWEEN $2 AND $3
         AND NULLIF(TRIM(s.app_id), '') IS NOT NULL
         AND NULLIF(TRIM(s.country_code), '') IS NOT NULL
         ${extra}
       UNION ALL
       SELECT s.ads_account_id,
              m.target_type,
              LOWER(TRIM(m.target_key)) AS target_key,
              UPPER(TRIM(s.country_code)) AS country_code,
              s.country_name,
              ${SPEND('s')} AS cost,
              s.clicks,
              s.impressions,
              s.conversions
       FROM ads_spend_country_daily s
       JOIN ads_campaign_map m
         ON m.client_id = s.client_id
        AND m.ads_account_id = s.ads_account_id
        AND m.campaign_id = s.campaign_id
       WHERE s.client_id = $1
         AND s.report_date BETWEEN $2 AND $3
         AND NULLIF(TRIM(s.app_id), '') IS NULL
         AND NULLIF(TRIM(s.country_code), '') IS NOT NULL
         ${extra}
     ) x
     JOIN ads_accounts a ON a.id = x.ads_account_id
     WHERE x.target_key IS NOT NULL
     GROUP BY x.ads_account_id, x.target_type, x.target_key, x.country_code
     ORDER BY ads_spend DESC, country_name ASC, target_key ASC`,
    params
  );
  return rows.map((r) => ({
    adsAccountId: r.ads_account_id,
    accountName: r.account_name || r.customer_id || r.ads_account_id,
    targetType: r.target_type,
    targetKey: r.target_key,
    countryCode: String(r.country_code || '').toUpperCase(),
    countryName: String(r.country_name || r.country_code || '').trim(),
    adsSpend: Number(r.ads_spend) || 0,
    clicks: Number(r.clicks) || 0,
    impressions: Number(r.impressions) || 0,
    conversions: Number(r.conversions) || 0,
  }));
}

/** Daily spend by ads account × site/app × country. */
async function loadCountrySpendByTargetDaily(clientId, start, end, {
  accountIds = null,
  campaignIds = null,
  countryCodes = null,
} = {}) {
  const params = [clientId, start, end];
  let extra = '';
  if (accountIds?.length) {
    params.push(accountIds);
    extra += ` AND s.ads_account_id = ANY($${params.length}::uuid[])`;
  }
  if (campaignIds?.length) {
    params.push(campaignIds.map(String));
    extra += ` AND s.campaign_id = ANY($${params.length}::text[])`;
  }
  if (countryCodes?.length) {
    params.push(countryCodes.map((c) => String(c).trim().toUpperCase()));
    extra += ` AND UPPER(TRIM(s.country_code)) = ANY($${params.length}::text[])`;
  }

  const { rows } = await query(
    `SELECT x.report_date,
            x.ads_account_id,
            MAX(a.descriptive_name) AS account_name,
            MAX(a.customer_id) AS customer_id,
            x.target_type,
            x.target_key,
            x.country_code,
            MAX(x.country_name) AS country_name,
            COALESCE(SUM(x.cost), 0)::float8 AS ads_spend,
            COALESCE(SUM(x.clicks), 0)::bigint AS clicks,
            COALESCE(SUM(x.impressions), 0)::bigint AS impressions,
            COALESCE(SUM(x.conversions), 0)::float8 AS conversions
     FROM (
       SELECT s.report_date::text AS report_date,
              s.ads_account_id,
              'app'::text AS target_type,
              LOWER(TRIM(s.app_id)) AS target_key,
              UPPER(TRIM(s.country_code)) AS country_code,
              s.country_name,
              ${SPEND('s')} AS cost,
              s.clicks,
              s.impressions,
              s.conversions
       FROM ads_spend_country_daily s
       WHERE s.client_id = $1
         AND s.report_date BETWEEN $2 AND $3
         AND NULLIF(TRIM(s.app_id), '') IS NOT NULL
         AND NULLIF(TRIM(s.country_code), '') IS NOT NULL
         ${extra}
       UNION ALL
       SELECT s.report_date::text AS report_date,
              s.ads_account_id,
              m.target_type,
              LOWER(TRIM(m.target_key)) AS target_key,
              UPPER(TRIM(s.country_code)) AS country_code,
              s.country_name,
              ${SPEND('s')} AS cost,
              s.clicks,
              s.impressions,
              s.conversions
       FROM ads_spend_country_daily s
       JOIN ads_campaign_map m
         ON m.client_id = s.client_id
        AND m.ads_account_id = s.ads_account_id
        AND m.campaign_id = s.campaign_id
       WHERE s.client_id = $1
         AND s.report_date BETWEEN $2 AND $3
         AND NULLIF(TRIM(s.app_id), '') IS NULL
         AND NULLIF(TRIM(s.country_code), '') IS NOT NULL
         ${extra}
     ) x
     JOIN ads_accounts a ON a.id = x.ads_account_id
     WHERE x.target_key IS NOT NULL
     GROUP BY x.report_date, x.ads_account_id, x.target_type, x.target_key, x.country_code
     ORDER BY x.report_date DESC, ads_spend DESC, country_name ASC, target_key ASC`,
    params
  );
  return rows.map((r) => ({
    date: ymd(r.report_date),
    adsAccountId: r.ads_account_id,
    accountName: r.account_name || r.customer_id || r.ads_account_id,
    targetType: r.target_type,
    targetKey: r.target_key,
    countryCode: String(r.country_code || '').toUpperCase(),
    countryName: String(r.country_name || r.country_code || '').trim(),
    adsSpend: Number(r.ads_spend) || 0,
    clicks: Number(r.clicks) || 0,
    impressions: Number(r.impressions) || 0,
    conversions: Number(r.conversions) || 0,
  }));
}

/** GAM earn by date × site/app target × country name. */
async function loadGamEarnByTargetCountryDaily(clientId, start, end) {
  const { rows } = await query(
    `SELECT report_date, target_type, target_key, country_key,
            COALESCE(SUM(earn), 0)::float8 AS earn
     FROM (
       SELECT g.report_date::text AS report_date,
              'site'::text AS target_type,
              LOWER(TRIM(ds.name)) AS target_key,
              LOWER(TRIM(dc.name)) AS country_key,
              g.revenue AS earn
       FROM report_grain g
       JOIN dim_site ds ON ds.id = g.site_id AND ds.client_id = g.client_id
       JOIN dim_country dc ON dc.id = g.country_id AND dc.id <> 0
       WHERE g.client_id = $1
         AND g.report_date BETWEEN $2 AND $3
         AND g.slice_key = 'inventory_core'
         AND g.site_id > 0
         AND NULLIF(TRIM(ds.name), '') IS NOT NULL
       UNION ALL
       SELECT g.report_date::text AS report_date,
              'app'::text AS target_type,
              LOWER(TRIM(COALESCE(NULLIF(g.app_id, ''), g.app_name))) AS target_key,
              LOWER(TRIM(dc.name)) AS country_key,
              g.revenue AS earn
       FROM report_grain g
       JOIN dim_country dc ON dc.id = g.country_id AND dc.id <> 0
       WHERE g.client_id = $1
         AND g.report_date BETWEEN $2 AND $3
         AND g.slice_key = 'app_id'
         AND NULLIF(TRIM(COALESCE(NULLIF(g.app_id, ''), g.app_name)), '') IS NOT NULL
     ) x
     GROUP BY 1, 2, 3, 4`,
    [clientId, start, end]
  );
  const map = new Map();
  (rows || []).forEach((r) => {
    const type = r.target_type;
    const tKey = String(r.target_key || '').trim().toLowerCase();
    const cKey = String(r.country_key || '').trim().toLowerCase();
    const date = ymd(r.report_date);
    if (!date || !type || !tKey || !cKey) return;
    const k = `${date}:${type}:${tKey}:${cKey}`;
    map.set(k, round2((map.get(k) || 0) + (Number(r.earn) || 0)));
  });
  return map;
}

/** Attribute filtered campaign country spend onto one app/site when no maps exist. */
async function loadFilterAttributedCountrySpend(
  clientId,
  start,
  end,
  {
    accountIds = null,
    campaignIds = null,
    countryCodes = null,
    targetType = null,
    targetKey = null,
  } = {}
) {
  const key = String(targetKey || '').trim().toLowerCase();
  if (!targetType || !key || !['app', 'site'].includes(targetType)) return [];
  if (!campaignIds?.length && !accountIds?.length) return [];

  const params = [clientId, start, end];
  let extra = '';
  if (accountIds?.length) {
    params.push(accountIds);
    extra += ` AND s.ads_account_id = ANY($${params.length}::uuid[])`;
  }
  if (campaignIds?.length) {
    params.push(campaignIds.map(String));
    extra += ` AND s.campaign_id = ANY($${params.length}::text[])`;
  }
  if (countryCodes?.length) {
    params.push(countryCodes.map((c) => String(c).trim().toUpperCase()));
    extra += ` AND UPPER(TRIM(s.country_code)) = ANY($${params.length}::text[])`;
  }
  const { rows } = await query(
    `SELECT s.ads_account_id,
            MAX(a.descriptive_name) AS account_name,
            MAX(a.customer_id) AS customer_id,
            UPPER(TRIM(s.country_code)) AS country_code,
            MAX(s.country_name) AS country_name,
            COALESCE(SUM(${SPEND('s')}), 0)::float8 AS ads_spend
     FROM ads_spend_country_daily s
     JOIN ads_accounts a ON a.id = s.ads_account_id
     WHERE s.client_id = $1
       AND s.report_date BETWEEN $2 AND $3
       AND NULLIF(TRIM(s.country_code), '') IS NOT NULL
       ${extra}
     GROUP BY 1, 3
     ORDER BY ads_spend DESC`,
    params
  );
  return rows.map((r) => ({
    adsAccountId: r.ads_account_id,
    accountName: r.account_name || r.customer_id || r.ads_account_id,
    targetType,
    targetKey: key,
    countryCode: String(r.country_code || '').toUpperCase(),
    countryName: String(r.country_name || r.country_code || '').trim(),
    adsSpend: Number(r.ads_spend) || 0,
  }));
}

/** Build IN-list scope for target×country GAM earn (avoids full report_grain scans). */
function buildTargetCountryEarnScope(countryTargetRows, {
  appKeyFilter = null,
  siteKeyFilter = null,
  countryFilter = null,
  countryNames = null,
} = {}) {
  const appKeys = new Set();
  const siteKeys = new Set();
  const countryKeys = new Set();

  const addCountry = (name) => {
    const k = String(name || '').trim().toLowerCase();
    if (k) countryKeys.add(k);
  };

  for (const row of countryTargetRows || []) {
    const tk = String(row.targetKey || '').trim().toLowerCase();
    if (!tk) continue;
    addCountry(row.countryName);
    if (row.countryCode) addCountry(row.countryCode);
    if (row.targetType === 'app') appKeys.add(tk);
    else if (row.targetType === 'site') siteKeys.add(tk);
  }

  if (countryNames?.length) {
    countryNames.forEach(addCountry);
  }

  // Explicit filters always join the scope (sites selected manually are not Ads packages).
  if (appKeyFilter?.size) appKeyFilter.forEach((k) => appKeys.add(k));
  if (siteKeyFilter?.size) siteKeyFilter.forEach((k) => siteKeys.add(normSiteHost(k)));

  let apps = [...appKeys];
  let sites = [...siteKeys];

  if (appKeyFilter?.size) {
    apps = apps.filter((k) => appKeyFilter.has(k));
  }
  if (siteKeyFilter?.size) {
    sites = [...new Set([...siteKeyFilter].map(normSiteHost))];
  }

  if (countryFilter?.length && !countryKeys.size) {
    countryFilter.forEach((code) => addCountry(code));
  }

  return {
    appKeys: apps,
    siteKeys: sites,
    countryKeys: [...countryKeys],
  };
}

/** Normalize site host for matching (lowercase, strip leading www.). */
function normSiteHost(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');
}

/**
 * Catalog / Dashboard site host — collapse slot & inventory subdomains to the apex.
 * Kept for legacy helpers; ROI site filters use exact hosts (see normSiteHost).
 * d1.arenapro6.com / quiz13.arenapro6.com → arenapro6.com
 */
function toCatalogSiteHost(value) {
  const host = normSiteHost(value);
  if (!host || !host.includes('.')) return host;
  const stripped = host.replace(
    /^(?:d\d+|game\d*|quiz\d*|finance\d*|display|app\d*)\./i,
    ''
  );
  if (stripped && stripped.includes('.') && stripped !== host) return stripped;
  return host;
}

/** Exact host match for ROI site filters (www-insensitive). */
function siteKeyMatchesFilter(siteKey, siteKeyFilter) {
  if (!siteKeyFilter?.size) return false;
  const host = normSiteHost(siteKey);
  if (!host) return false;
  if (siteKeyFilter.has(host)) return true;
  for (const k of siteKeyFilter) {
    if (normSiteHost(k) === host) return true;
  }
  return false;
}

/**
 * Exact country key equality only.
 * Never use substring includes — "united states".includes("us") previously dumped
 * other countries' site earn into the US Ads row.
 */
function countryKeysEqual(a, b) {
  const x = String(a || '').trim().toLowerCase();
  const y = String(b || '').trim().toLowerCase();
  if (!x || !y || x === '—' || y === '—') return false;
  if (x === y) return true;
  // Allow "united states" ↔ "united-states" / underscores
  const nx = x.replace(/[^a-z0-9]+/g, '');
  const ny = y.replace(/[^a-z0-9]+/g, '');
  return Boolean(nx && ny && nx === ny);
}

/** Sum GAM site earn for a site, optionally scoped to an Ads/GAM country label/code. */
function sumSiteEarnFromMap(earnByTargetCountry, siteKey, {
  countryName = null,
  countryCode = null,
  allCountries = false,
} = {}) {
  const host = normSiteHost(siteKey);
  const nameK = String(countryName || '').trim().toLowerCase();
  const codeK = String(countryCode || '').trim().toLowerCase();
  let sum = 0;
  for (const [earnKey, earn] of earnByTargetCountry.entries()) {
    if (!(Number(earn) > 0)) continue;
    const parsed = parseTargetCountryEarnKey(earnKey);
    if (!parsed || parsed.targetType !== 'site') continue;
    if (normSiteHost(parsed.targetKey) !== host) continue;
    if (allCountries) {
      sum += Number(earn) || 0;
      continue;
    }
    const ck = parsed.countryKey;
    if (!ck) continue;
    if (countryKeysEqual(ck, nameK)) {
      sum += Number(earn) || 0;
      continue;
    }
    if (codeK && codeK !== '—' && countryKeysEqual(ck, codeK)) {
      sum += Number(earn) || 0;
    }
  }
  return round2(sum);
}

/**
 * When multiple Ads accounts spend on the same app package in a country,
 * GAM earn is identical for each — claim it once for the top-spend account
 * (stable UUID tie-break). Others keep spend/engagement with earn = 0.
 */
function claimAppPackageEarnWinners(rows = [], { includeDate = false } = {}) {
  const groups = new Map();
  for (const r of rows) {
    if (String(r.targetType || '') !== 'app') continue;
    const pkg = String(r.targetKey || '').trim().toLowerCase();
    if (!pkg) continue;
    const country = String(r.countryCode || r.countryName || '').trim().toUpperCase() || '—';
    const datePart = includeDate ? `${ymd(r.date)}|` : '';
    const gKey = `${datePart}${country}|app|${pkg}`;
    if (!groups.has(gKey)) groups.set(gKey, []);
    groups.get(gKey).push(r);
  }
  const winners = new Set();
  for (const list of groups.values()) {
    list.sort((a, b) =>
      (Number(b.adsSpend) || 0) - (Number(a.adsSpend) || 0)
      || String(a.adsAccountId || '').localeCompare(String(b.adsAccountId || ''))
    );
    const w = list[0];
    const pkg = String(w.targetKey || '').trim().toLowerCase();
    const country = String(w.countryCode || w.countryName || '').trim().toUpperCase() || '—';
    const datePart = includeDate ? `${ymd(w.date)}|` : '';
    winners.add(`${datePart}${w.adsAccountId}|${country}|app|${pkg}`);
  }
  return winners;
}

function appPackageWinnerKey(row, { includeDate = false } = {}) {
  const pkg = String(row.targetKey || '').trim().toLowerCase();
  const country = String(row.countryCode || row.countryName || '').trim().toUpperCase() || '—';
  const datePart = includeDate ? `${ymd(row.date)}|` : '';
  return `${datePart}${row.adsAccountId}|${country}|app|${pkg}`;
}

/** Lookup GAM site engagement (impressions/clicks) with the same country matching as earn. */
function sumSiteEngagementFromMap(engagementByTargetCountry, siteKey, {
  countryName = null,
  countryCode = null,
} = {}) {
  const empty = { impressions: 0, clicks: 0 };
  if (!engagementByTargetCountry?.size) return empty;
  const host = normSiteHost(siteKey);
  const nameK = String(countryName || '').trim().toLowerCase();
  const codeK = String(countryCode || '').trim().toLowerCase();
  let impressions = 0;
  let clicks = 0;
  for (const [key, eng] of engagementByTargetCountry.entries()) {
    const parsed = parseTargetCountryEarnKey(key);
    if (!parsed || parsed.targetType !== 'site') continue;
    if (normSiteHost(parsed.targetKey) !== host) continue;
    const ck = parsed.countryKey;
    if (!ck) continue;
    const match = countryKeysEqual(ck, nameK)
      || (codeK && codeK !== '—' && countryKeysEqual(ck, codeK));
    if (!match) continue;
    impressions += Number(eng?.impressions) || 0;
    clicks += Number(eng?.clicks) || 0;
  }
  return { impressions: Math.round(impressions), clicks: Math.round(clicks) };
}

/** Index Ads countries by name and ISO code for nesting GAM site earn. */
function buildCountryMetaIndex(countrySpendRows = []) {
  const index = new Map();
  for (const r of countrySpendRows || []) {
    const meta = {
      countryCode: String(r.countryCode || '').toUpperCase() || '—',
      countryName: String(r.countryName || r.countryCode || '').trim() || '—',
    };
    const nameKey = String(meta.countryName || '').trim().toLowerCase();
    const codeKey = String(meta.countryCode || '').trim().toLowerCase();
    if (nameKey) index.set(nameKey, meta);
    if (codeKey && codeKey !== '—') index.set(codeKey, meta);
    // Normalized form for "United States" ↔ "united_states"
    const compact = nameKey.replace(/[^a-z0-9]+/g, '');
    if (compact) index.set(compact, meta);
  }
  return index;
}

/**
 * Sites rarely appear in Ads country×target spend. Add zero-spend (earn-only) rows from
 * GAM site revenue so selected sites nest under Country → Ads account → Site.
 * Prefer campaign-map account; else nest under the Ads account with spend in that country.
 */
function buildSiteAccountLookup(maps = [], {
  accountFilter = null,
  campaignFilter = null,
} = {}) {
  const accountFilterSet = accountFilter?.length
    ? new Set(accountFilter.map(String))
    : null;
  const campaignFilterSet = campaignFilter?.length
    ? new Set(campaignFilter.map(String))
    : null;
  const bySite = new Map();
  for (const m of maps || []) {
    const type = m.targetType || m.target_type;
    if (type !== 'site') continue;
    const key = String(m.targetKey || m.target_key || '').trim().toLowerCase();
    if (!key) continue;
    const adsAccountId = String(m.adsAccountId || m.ads_account_id || '');
    const campaignId = String(m.campaignId || m.campaign_id || '');
    if (accountFilterSet && adsAccountId && !accountFilterSet.has(adsAccountId)) continue;
    if (campaignFilterSet && campaignId && !campaignFilterSet.has(campaignId)) continue;
    if (bySite.has(key)) continue;
    bySite.set(key, {
      adsAccountId: adsAccountId || null,
      accountName: m.accountName || m.account_name || adsAccountId || 'Ads account',
      customerId: m.customerId || m.customer_id || null,
    });
  }
  return bySite;
}

/** Pick Ads account to nest a site under for a given country. */
function resolveSiteHostAccount({
  siteKey,
  countryKey,
  countryTargetRows = [],
  siteAccountLookup = null,
  accountFilter = null,
}) {
  const mapped = siteAccountLookup?.get(siteKey);
  if (mapped?.adsAccountId) return mapped;

  const accountFilterSet = accountFilter?.length
    ? new Set(accountFilter.map(String))
    : null;
  const spendByAccount = new Map();
  for (const r of countryTargetRows || []) {
    if (r.targetType === 'site') continue;
    const cKey = String(r.countryName || '').trim().toLowerCase();
    if (countryKey && cKey && cKey !== countryKey) continue;
    const id = String(r.adsAccountId || '');
    if (!id) continue;
    if (accountFilterSet && !accountFilterSet.has(id)) continue;
    const prev = spendByAccount.get(id) || {
      adsAccountId: id,
      accountName: r.accountName || id,
      customerId: r.customerId || null,
      spend: 0,
    };
    prev.spend += Number(r.adsSpend) || 0;
    if (r.accountName) prev.accountName = r.accountName;
    spendByAccount.set(id, prev);
  }
  const best = [...spendByAccount.values()].sort((a, b) => b.spend - a.spend)[0];
  if (best) {
    return {
      adsAccountId: best.adsAccountId,
      accountName: best.accountName,
      customerId: best.customerId,
    };
  }
  if (accountFilter?.length) {
    const id = String(accountFilter[0]);
    return { adsAccountId: id, accountName: 'Ads account', customerId: null };
  }
  return {
    adsAccountId: `sites-earn`,
    accountName: 'Sites (earn only)',
    customerId: null,
  };
}

/**
 * Selected sites are independent of Ads accounts: earn-only rows under a fixed
 * "GAM sites" bucket, keyed by GAM country. Revenue is converted to display
 * currency (INR when ADS_FORCE_CURRENCY=INR) later via metricsFor.
 */
function synthesizeSitePackagesFromEarn({
  countryTargetRows = [],
  earnByTargetCountry,
  siteEngagementByCountry = null,
  siteKeyFilter,
  countrySpendRows = [],
}) {
  if (!siteKeyFilter?.size || !earnByTargetCountry?.size) return countryTargetRows;

  const nameToMeta = buildCountryMetaIndex(countrySpendRows);
  const findMeta = (countryKey) => {
    const k = String(countryKey || '').trim().toLowerCase();
    if (!k) return null;
    if (nameToMeta.has(k)) return nameToMeta.get(k);
    const compact = k.replace(/[^a-z0-9]+/g, '');
    if (compact && nameToMeta.has(compact)) return nameToMeta.get(compact);
    return null;
  };

  const existing = new Set(
    (countryTargetRows || [])
      .filter((r) => r.targetType === 'site')
      .map((r) => `${normSiteHost(r.targetKey)}|${String(r.gamCountryKey || r.countryName || '').toLowerCase()}`)
  );

  const added = [];
  for (const [earnKey, earn] of earnByTargetCountry.entries()) {
    if (!(Number(earn) > 0)) continue;
    const parsed = parseTargetCountryEarnKey(earnKey);
    if (!parsed || parsed.targetType !== 'site') continue;
    if (!siteKeyMatchesFilter(parsed.targetKey, siteKeyFilter)) continue;

    const exactKey = normSiteHost(parsed.targetKey);
    const dedupe = `${exactKey}|${parsed.countryKey}`;
    if (existing.has(dedupe)) continue;
    existing.add(dedupe);

    const meta = findMeta(parsed.countryKey);
    const countryName = meta?.countryName
      || (parsed.countryKey === 'unknown'
        ? 'Unknown'
        : String(parsed.countryKey || '').replace(/\b\w/g, (c) => c.toUpperCase()))
      || '—';
    // Prefer Ads ISO code when names match; otherwise keep a stable GAM country id
    // so site revenue still appears country-wise even with no Ads spend in that geo.
    const countryCode = meta?.countryCode && meta.countryCode !== '—'
      ? meta.countryCode
      : String(parsed.countryKey || 'unknown')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 24) || 'ZZ';

    const eng = siteEngagementByCountry?.get(earnKey)
      || sumSiteEngagementFromMap(siteEngagementByCountry, exactKey, {
        countryName: parsed.countryKey,
        countryCode,
      });

    added.push({
      adsAccountId: 'gam-sites',
      accountName: 'GAM sites',
      customerId: null,
      targetType: 'site',
      targetKey: exactKey,
      countryCode,
      countryName,
      gamCountryKey: parsed.countryKey,
      adsSpend: 0,
      impressions: Number(eng?.impressions) || 0,
      clicks: Number(eng?.clicks) || 0,
      conversions: 0,
      earnOnly: true,
    });
  }

  return added.length ? [...countryTargetRows, ...added] : countryTargetRows;
}

/** Ensure countries that only have site earn still appear in the country tree. */
async function mergeSiteOnlyCountries(countryBreakdown, countryTargetRows, earnByTargetCountry, endDate) {
  const byCode = new Map(
    (countryBreakdown || []).map((c) => [String(c.countryCode || '').toUpperCase(), { ...c }])
  );

  const earnUsdByCode = new Map();
  const nameByCode = new Map();
  for (const row of countryTargetRows || []) {
    if (row.targetType !== 'site') continue;
    const code = String(row.countryCode || '').toUpperCase() || '—';
    if (!code || code === '—') continue;
    nameByCode.set(code, row.countryName || code);
    const usd = sumSiteEarnFromMap(earnByTargetCountry, row.targetKey, {
      countryName: row.gamCountryKey || row.countryName,
      countryCode: row.countryCode,
    });
    earnUsdByCode.set(code, round2((earnUsdByCode.get(code) || 0) + usd));
  }

  for (const [code, earnUsd] of earnUsdByCode.entries()) {
    if (byCode.has(code)) continue; // Ads country already listed; site packages nest under it
    const spendMetrics = await metricsFor(earnUsd, 0, 0, {}, { endDate });
    byCode.set(code, {
      countryCode: code,
      countryName: nameByCode.get(code) || code,
      adsSpend: 0,
      earn: spendMetrics.earn,
      profitSpend: spendMetrics.profitSpend,
      roiSpendPercent: null,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      ctr: null,
      ecpm: null,
    });
  }

  return [...byCode.values()].sort(
    (a, b) => (Number(b.adsSpend) || 0) - (Number(a.adsSpend) || 0)
      || String(a.countryName || '').localeCompare(String(b.countryName || ''))
  );
}


function mapTargetCountryEarnRows(rows) {
  const map = new Map();
  (rows || []).forEach((r) => {
    const type = r.target_type;
    const tKey = String(r.target_key || '').trim().toLowerCase();
    const cKey = String(r.country_key || '').trim().toLowerCase();
    if (!type || !tKey || !cKey) return;
    const k = `${type}:${tKey}:${cKey}`;
    map.set(k, round2((map.get(k) || 0) + (Number(r.earn) || 0)));
  });
  return map;
}

/** Full scan — used only when no target/country scope is available. */
async function loadGamEarnByTargetCountryFull(clientId, start, end, { countryKeys = null } = {}) {
  const params = [clientId, start, end];
  let countryExtra = '';
  if (countryKeys?.length) {
    params.push(countryKeys);
    countryExtra = ` AND LOWER(TRIM(dc.name)) = ANY($${params.length}::text[])`;
  }
  const { rows } = await query(
    `SELECT target_type, target_key, country_key,
            COALESCE(SUM(earn), 0)::float8 AS earn
     FROM (
       SELECT 'site'::text AS target_type,
              LOWER(TRIM(ds.name)) AS target_key,
              LOWER(TRIM(dc.name)) AS country_key,
              g.revenue AS earn
       FROM report_grain g
       JOIN dim_site ds ON ds.id = g.site_id AND ds.client_id = g.client_id
       JOIN dim_country dc ON dc.id = g.country_id AND dc.id <> 0
       WHERE g.client_id = $1
         AND g.report_date BETWEEN $2 AND $3
         AND g.slice_key = 'inventory_core'
         AND g.site_id > 0
         AND NULLIF(TRIM(ds.name), '') IS NOT NULL
         ${countryExtra}
       UNION ALL
       SELECT 'app'::text AS target_type,
              LOWER(TRIM(COALESCE(NULLIF(g.app_id, ''), g.app_name))) AS target_key,
              LOWER(TRIM(dc.name)) AS country_key,
              g.revenue AS earn
       FROM report_grain g
       JOIN dim_country dc ON dc.id = g.country_id AND dc.id <> 0
       WHERE g.client_id = $1
         AND g.report_date BETWEEN $2 AND $3
         AND g.slice_key = 'app_id'
         AND NULLIF(TRIM(COALESCE(NULLIF(g.app_id, ''), g.app_name)), '') IS NOT NULL
         ${countryExtra}
     ) x
     GROUP BY 1, 2, 3`,
    params
  );
  return mapTargetCountryEarnRows(rows);
}

/**
 * Expand site hosts for SQL matching — exact selected host + www variant.
 * Do not collapse finance2/game/quiz subdomains to the apex.
 */
function expandSiteHostKeys(siteKeys = []) {
  const expanded = [];
  const seen = new Set();
  const add = (raw) => {
    const host = normSiteHost(raw);
    if (!host || seen.has(host)) return;
    seen.add(host);
    expanded.push(host);
    const withWww = `www.${host}`;
    if (!seen.has(withWww)) {
      seen.add(withWww);
      expanded.push(withWww);
    }
  };
  for (const raw of siteKeys) add(raw);
  return expanded;
}

/**
 * Selected GAM sites → earn + engagement by country.
 * Exact host match on inventory_core (finance2.x.com ≠ x.com).
 * Returns { earnMap, engagementMap } — engagementMap values are { impressions, clicks }.
 */
async function loadSelectedSitesEarnByCountry(clientId, start, end, siteKeys = []) {
  const hosts = [...new Set(
    (siteKeys instanceof Set ? [...siteKeys] : (siteKeys || []))
      .map((k) => normSiteHost(k))
      .filter(Boolean)
  )];
  if (!hosts.length) return { earnMap: new Map(), engagementMap: new Map() };

  const { rows } = await query(
    `SELECT LOWER(TRIM(REGEXP_REPLACE(ds.name, '^www\\.', '', 'i'))) AS target_key,
            LOWER(TRIM(COALESCE(NULLIF(dc.name, ''), 'unknown'))) AS country_key,
            COALESCE(SUM(g.revenue), 0)::float8 AS revenue,
            COALESCE(SUM(g.impressions), 0)::float8 AS impressions,
            COALESCE(SUM(g.clicks), 0)::float8 AS clicks
     FROM report_grain g
     JOIN dim_site ds
       ON ds.id = g.site_id
      AND ds.client_id = g.client_id
     LEFT JOIN dim_country dc ON dc.id = g.country_id
     WHERE g.client_id = $1::uuid
       AND g.report_date BETWEEN $2::date AND $3::date
       AND g.site_id > 0
       AND g.slice_key = 'inventory_core'
       AND LOWER(TRIM(REGEXP_REPLACE(ds.name, '^www\\.', '', 'i'))) = ANY($4::text[])
     GROUP BY 1, 2`,
    [clientId, start, end, hosts]
  );

  const earnMap = new Map();
  const engagementMap = new Map();
  (rows || []).forEach((r) => {
    const tKey = normSiteHost(r.target_key);
    const cKey = String(r.country_key || '').trim().toLowerCase() || 'unknown';
    if (!tKey) return;
    const impressions = Math.round(Number(r.impressions) || 0);
    const clicks = Math.round(Number(r.clicks) || 0);
    const earn = coerceWarehouseRevenue(r.revenue, impressions);
    const k = `site:${tKey}:${cKey}`;
    if (earn > 0) {
      earnMap.set(k, round2((earnMap.get(k) || 0) + earn));
    }
    if (impressions > 0 || clicks > 0) {
      const prev = engagementMap.get(k) || { impressions: 0, clicks: 0 };
      engagementMap.set(k, {
        impressions: prev.impressions + impressions,
        clicks: prev.clicks + clicks,
      });
    }
  });
  return { earnMap, engagementMap };
}

/** Scoped target×country earn — limits report_grain to known apps/sites/countries. */
async function loadGamEarnByTargetCountryScoped(clientId, start, end, scope = {}) {
  const appKeys = [...(scope.appKeys || [])].filter(Boolean);
  const siteKeys = [...(scope.siteKeys || [])].filter(Boolean);
  const countryKeys = [...(scope.countryKeys || [])].filter(Boolean);

  if (!appKeys.length && !siteKeys.length) {
    if (scope.allowFullScan) {
      return loadGamEarnByTargetCountryFull(clientId, start, end, { countryKeys });
    }
    if (countryKeys.length) {
      return loadGamEarnByTargetCountryFull(clientId, start, end, { countryKeys });
    }
    return new Map();
  }

  const params = [clientId, start, end];
  const parts = [];

  if (siteKeys.length) {
    params.push(siteKeys.map(normSiteHost));
    const siteParam = `$${params.length}`;
    // Intentionally no Ads-country filter on sites: GAM dim_country names often
    // differ from Ads country_name/code, which previously returned zero site earn.
    parts.push(`
      SELECT 'site'::text AS target_type,
             LOWER(TRIM(ds.name)) AS target_key,
             LOWER(TRIM(dc.name)) AS country_key,
             g.revenue AS earn
      FROM report_grain g
      JOIN dim_site ds ON ds.id = g.site_id AND ds.client_id = g.client_id
      JOIN dim_country dc ON dc.id = g.country_id AND dc.id <> 0
      WHERE g.client_id = $1
        AND g.report_date BETWEEN $2 AND $3
        AND g.slice_key = 'inventory_core'
        AND g.site_id > 0
        AND (
          LOWER(TRIM(ds.name)) = ANY(${siteParam}::text[])
          OR LOWER(TRIM(REGEXP_REPLACE(ds.name, '^www\\.', '', 'i'))) = ANY(${siteParam}::text[])
        )
    `);
  }

  if (appKeys.length) {
    params.push(appKeys);
    const appParam = `$${params.length}`;
    let countryExtra = '';
    if (countryKeys.length) {
      params.push(countryKeys);
      countryExtra = ` AND LOWER(TRIM(dc.name)) = ANY($${params.length}::text[])`;
    }
    parts.push(`
      SELECT 'app'::text AS target_type,
             LOWER(TRIM(COALESCE(NULLIF(g.app_id, ''), g.app_name))) AS target_key,
             LOWER(TRIM(dc.name)) AS country_key,
             g.revenue AS earn
      FROM report_grain g
      JOIN dim_country dc ON dc.id = g.country_id AND dc.id <> 0
      WHERE g.client_id = $1
        AND g.report_date BETWEEN $2 AND $3
        AND g.slice_key = 'app_id'
        AND LOWER(TRIM(COALESCE(NULLIF(g.app_id, ''), g.app_name))) = ANY(${appParam}::text[])
        ${countryExtra}
    `);
  }

  const { rows } = await query(
    `SELECT target_type, target_key, country_key,
            COALESCE(SUM(earn), 0)::float8 AS earn
     FROM (${parts.join(' UNION ALL ')}) x
     GROUP BY 1, 2, 3`,
    params
  );
  return mapTargetCountryEarnRows(rows);
}

async function loadGamEarnByTargetCountryDailyScoped(clientId, start, end, scope = {}) {
  const appKeys = [...(scope.appKeys || [])].filter(Boolean);
  const siteKeys = [...(scope.siteKeys || [])].filter(Boolean);
  const countryKeys = [...(scope.countryKeys || [])].filter(Boolean);

  if (!appKeys.length && !siteKeys.length) {
    if (!scope.allowFullScan && !countryKeys.length) return new Map();
    return loadGamEarnByTargetCountryDaily(clientId, start, end);
  }

  const params = [clientId, start, end];
  const parts = [];

  if (siteKeys.length) {
    params.push(siteKeys.map(normSiteHost));
    const siteParam = `$${params.length}`;
    parts.push(`
      SELECT g.report_date::text AS report_date,
             'site'::text AS target_type,
             LOWER(TRIM(ds.name)) AS target_key,
             LOWER(TRIM(dc.name)) AS country_key,
             g.revenue AS earn
      FROM report_grain g
      JOIN dim_site ds ON ds.id = g.site_id AND ds.client_id = g.client_id
      JOIN dim_country dc ON dc.id = g.country_id AND dc.id <> 0
      WHERE g.client_id = $1
        AND g.report_date BETWEEN $2 AND $3
        AND g.slice_key = 'inventory_core'
        AND g.site_id > 0
        AND (
          LOWER(TRIM(ds.name)) = ANY(${siteParam}::text[])
          OR LOWER(TRIM(REGEXP_REPLACE(ds.name, '^www\\.', '', 'i'))) = ANY(${siteParam}::text[])
        )
    `);
  }

  if (appKeys.length) {
    params.push(appKeys);
    const appParam = `$${params.length}`;
    let countryExtra = '';
    if (countryKeys.length) {
      params.push(countryKeys);
      countryExtra = ` AND LOWER(TRIM(dc.name)) = ANY($${params.length}::text[])`;
    }
    parts.push(`
      SELECT g.report_date::text AS report_date,
             'app'::text AS target_type,
             LOWER(TRIM(COALESCE(NULLIF(g.app_id, ''), g.app_name))) AS target_key,
             LOWER(TRIM(dc.name)) AS country_key,
             g.revenue AS earn
      FROM report_grain g
      JOIN dim_country dc ON dc.id = g.country_id AND dc.id <> 0
      WHERE g.client_id = $1
        AND g.report_date BETWEEN $2 AND $3
        AND g.slice_key = 'app_id'
        AND LOWER(TRIM(COALESCE(NULLIF(g.app_id, ''), g.app_name))) = ANY(${appParam}::text[])
        ${countryExtra}
    `);
  }

  const { rows } = await query(
    `SELECT report_date, target_type, target_key, country_key,
            COALESCE(SUM(earn), 0)::float8 AS earn
     FROM (${parts.join(' UNION ALL ')}) x
     GROUP BY 1, 2, 3, 4`,
    params
  );
  const map = new Map();
  (rows || []).forEach((r) => {
    const type = r.target_type;
    const tKey = String(r.target_key || '').trim().toLowerCase();
    const cKey = String(r.country_key || '').trim().toLowerCase();
    const date = ymd(r.report_date);
    if (!date || !type || !tKey || !cKey) return;
    const k = `${date}:${type}:${tKey}:${cKey}`;
    map.set(k, round2((map.get(k) || 0) + (Number(r.earn) || 0)));
  });
  return map;
}

/** GAM earn grouped by site/app target and country name. */
async function loadGamEarnByTargetCountry(clientId, start, end, scope = null) {
  if (scope && typeof scope === 'object') {
    return loadGamEarnByTargetCountryScoped(clientId, start, end, scope);
  }
  return loadGamEarnByTargetCountryFull(clientId, start, end, {});
}

function parseTargetCountryEarnKey(earnKey) {
  const k = String(earnKey || '');
  const countrySep = k.lastIndexOf(':');
  if (countrySep <= 0) return null;
  const countryKey = k.slice(countrySep + 1);
  const rest = k.slice(0, countrySep);
  const typeSep = rest.indexOf(':');
  if (typeSep <= 0) return null;
  return {
    targetType: rest.slice(0, typeSep),
    targetKey: rest.slice(typeSep + 1),
    countryKey,
  };
}

/**
 * Country earn for country tables — scoped to selected apps/sites (and ads-linked targets),
 * not network-wide GAM totals unless no inventory/ads filters are active.
 */
function buildScopedCountryEarnLookup({
  earnByCountry,
  earnByTargetCountry,
  appKeyFilter,
  siteKeyFilter,
  effectiveTargetType,
  mappedKeys,
  countryTargetRows,
  accountFilter,
  campaignFilter,
}) {
  const hasInventoryFilter = Boolean(appKeyFilter?.size || siteKeyFilter?.size);
  const hasAdsScope = Boolean(accountFilter?.length || campaignFilter?.length);
  // When Ads spend is linked to app/site targets, attribute country earn to those
  // packages — never paint full network country revenue on every row.
  const hasAdsLinkedTargets = (countryTargetRows || []).some(
    (r) => r.targetType && r.targetKey && (Number(r.adsSpend) || 0) > 0
  );
  const useNetworkCountryEarn = !hasInventoryFilter
    && !mappedKeys?.size
    && !hasAdsScope
    && !hasAdsLinkedTargets;

  if (useNetworkCountryEarn) {
    return (countryName) => {
      const k = String(countryName || '').trim().toLowerCase();
      return earnByCountry.get(k)?.earn || 0;
    };
  }

  const allowedTargets = new Set(mappedKeys || []);
  if (appKeyFilter) appKeyFilter.forEach((key) => allowedTargets.add(`app:${key}`));
  if (siteKeyFilter) siteKeyFilter.forEach((key) => allowedTargets.add(`site:${key}`));
  (countryTargetRows || []).forEach((r) => {
    if (r.targetType && r.targetKey) {
      allowedTargets.add(`${r.targetType}:${r.targetKey}`);
    }
  });

  const totals = new Map();
  for (const [earnKey, earn] of earnByTargetCountry.entries()) {
    const parsed = parseTargetCountryEarnKey(earnKey);
    if (!parsed) continue;
    const { targetType, targetKey, countryKey } = parsed;

    if (appKeyFilter?.size && targetType === 'app' && !appKeyFilter.has(targetKey)) continue;
    if (siteKeyFilter?.size && targetType === 'site' && !siteKeyMatchesFilter(targetKey, siteKeyFilter)) continue;
    // Do not drop apps when sites are selected (union model). Only skip sites in
    // legacy app-only mode when no site filter is present.
    if (effectiveTargetType === 'app' && targetType === 'site' && !siteKeyFilter?.size) continue;
    if (allowedTargets.size && !allowedTargets.has(`${targetType}:${targetKey}`)) continue;

    totals.set(countryKey, round2((totals.get(countryKey) || 0) + (Number(earn) || 0)));
  }

  return (countryName) => {
    const k = String(countryName || '').trim().toLowerCase();
    return totals.get(k) || 0;
  };
}

function filterCountryTargetRows(rows, {
  appKeyFilter = null,
  siteKeyFilter = null,
  effectiveTargetType = 'all',
} = {}) {
  return (rows || []).filter((r) => {
    // App + site filters are a union. Selecting sites must never drop Ads app packages.
    if (r.targetType === 'app') {
      if (appKeyFilter?.size && !appKeyFilter.has(r.targetKey)) return false;
      if (effectiveTargetType === 'site' && !siteKeyFilter?.size && appKeyFilter?.size) {
        return false;
      }
    } else if (r.targetType === 'site') {
      if (effectiveTargetType === 'app' && !siteKeyFilter?.size) return false;
      if (siteKeyFilter?.size && !siteKeyMatchesFilter(r.targetKey, siteKeyFilter)) return false;
    }
    if ((Number(r.adsSpend) || 0) > 0) return true;
    // Keep selected sites with earn but no Ads spend (synthesized packages).
    return r.targetType === 'site'
      && siteKeyFilter?.size
      && siteKeyMatchesFilter(r.targetKey, siteKeyFilter);
  });
}

async function loadMappedSpendDaily(clientId, start, end, {
  accountIds = null,
  campaignIds = null,
  countryCodes = null,
} = {}) {
  const useCountry = Array.isArray(countryCodes) && countryCodes.length > 0;
  const table = useCountry ? 'ads_spend_country_daily' : 'ads_spend_daily';
  const params = [clientId, start, end];
  let extra = '';
  if (accountIds?.length) {
    params.push(accountIds);
    extra += ` AND s.ads_account_id = ANY($${params.length}::uuid[])`;
  }
  if (campaignIds?.length) {
    params.push(campaignIds.map(String));
    extra += ` AND s.campaign_id = ANY($${params.length}::text[])`;
  }
  if (useCountry) {
    params.push(countryCodes.map((c) => String(c).trim().toUpperCase()));
    extra += ` AND UPPER(TRIM(s.country_code)) = ANY($${params.length}::text[])`;
  }

  // Prefer Google Ads App Campaign app_id on spend rows; fall back to manual campaign maps.
  const { rows } = await query(
    `SELECT report_date, target_type, target_key, ads_account_id,
            SUM(cost)::float8 AS cost,
            SUM(clicks)::bigint AS clicks,
            SUM(impressions)::bigint AS impressions,
            SUM(conversions)::float8 AS conversions
     FROM (
       SELECT s.report_date::text AS report_date,
              'app'::text AS target_type,
              LOWER(TRIM(s.app_id)) AS target_key,
              s.ads_account_id,
              ${SPEND('s')} AS cost,
              s.clicks,
              s.impressions,
              s.conversions
       FROM ${table} s
       WHERE s.client_id = $1
         AND s.report_date BETWEEN $2 AND $3
         AND NULLIF(TRIM(s.app_id), '') IS NOT NULL
         ${extra}
       UNION ALL
       SELECT s.report_date::text AS report_date,
              m.target_type,
              LOWER(TRIM(m.target_key)) AS target_key,
              s.ads_account_id,
              ${SPEND('s')} AS cost,
              s.clicks,
              s.impressions,
              s.conversions
       FROM ${table} s
       JOIN ads_campaign_map m
         ON m.client_id = s.client_id
        AND m.ads_account_id = s.ads_account_id
        AND m.campaign_id = s.campaign_id
       WHERE s.client_id = $1
         AND s.report_date BETWEEN $2 AND $3
         AND NULLIF(TRIM(s.app_id), '') IS NULL
         ${extra}
     ) x
     GROUP BY 1, 2, 3, 4`,
    params
  );
  return rows.map((r) => ({
    date: ymd(r.report_date),
    targetType: r.target_type,
    targetKey: r.target_key,
    adsAccountId: r.ads_account_id,
    cost: Number(r.cost) || 0,
    clicks: Number(r.clicks) || 0,
    impressions: Number(r.impressions) || 0,
    conversions: Number(r.conversions) || 0,
  }));
}

/** Mapped Ads spend totals per target (no daily grain). */
async function loadMappedSpendAggregated(clientId, start, end, {
  accountIds = null,
  campaignIds = null,
  countryCodes = null,
} = {}) {
  const useCountry = Array.isArray(countryCodes) && countryCodes.length > 0;
  const table = useCountry ? 'ads_spend_country_daily' : 'ads_spend_daily';
  const params = [clientId, start, end];
  let extra = '';
  if (accountIds?.length) {
    params.push(accountIds);
    extra += ` AND s.ads_account_id = ANY($${params.length}::uuid[])`;
  }
  if (campaignIds?.length) {
    params.push(campaignIds.map(String));
    extra += ` AND s.campaign_id = ANY($${params.length}::text[])`;
  }
  if (useCountry) {
    params.push(countryCodes.map((c) => String(c).trim().toUpperCase()));
    extra += ` AND UPPER(TRIM(s.country_code)) = ANY($${params.length}::text[])`;
  }

  const { rows } = await query(
    `SELECT target_type, target_key, ads_account_id,
            SUM(cost)::float8 AS cost,
            SUM(clicks)::bigint AS clicks,
            SUM(impressions)::bigint AS impressions,
            SUM(conversions)::float8 AS conversions
     FROM (
       SELECT 'app'::text AS target_type,
              LOWER(TRIM(s.app_id)) AS target_key,
              s.ads_account_id,
              ${SPEND('s')} AS cost,
              s.clicks,
              s.impressions,
              s.conversions
       FROM ${table} s
       WHERE s.client_id = $1
         AND s.report_date BETWEEN $2 AND $3
         AND NULLIF(TRIM(s.app_id), '') IS NOT NULL
         ${extra}
       UNION ALL
       SELECT m.target_type,
              LOWER(TRIM(m.target_key)) AS target_key,
              s.ads_account_id,
              ${SPEND('s')} AS cost,
              s.clicks,
              s.impressions,
              s.conversions
       FROM ${table} s
       JOIN ads_campaign_map m
         ON m.client_id = s.client_id
        AND m.ads_account_id = s.ads_account_id
        AND m.campaign_id = s.campaign_id
       WHERE s.client_id = $1
         AND s.report_date BETWEEN $2 AND $3
         AND NULLIF(TRIM(s.app_id), '') IS NULL
         ${extra}
     ) x
     GROUP BY 1, 2, 3`,
    params
  );
  return rows.map((r) => ({
    targetType: r.target_type,
    targetKey: r.target_key,
    adsAccountId: r.ads_account_id,
    cost: Number(r.cost) || 0,
    clicks: Number(r.clicks) || 0,
    impressions: Number(r.impressions) || 0,
    conversions: Number(r.conversions) || 0,
  }));
}

/**
 * When ROI filters pick campaigns + exactly one app/site (no campaign map needed),
 * attribute those campaigns' spend onto that single inventory target.
 */
async function loadFilterAttributedSpendDaily(
  clientId,
  start,
  end,
  {
    accountIds = null,
    campaignIds = null,
    countryCodes = null,
    targetType = null,
    targetKey = null,
  } = {}
) {
  const key = String(targetKey || '').trim().toLowerCase();
  if (!targetType || !key || !['app', 'site'].includes(targetType)) return [];
  if (!campaignIds?.length && !accountIds?.length) return [];

  const useCountry = Array.isArray(countryCodes) && countryCodes.length > 0;
  const table = useCountry ? 'ads_spend_country_daily' : 'ads_spend_daily';
  const params = [clientId, start, end];
  let extra = '';
  if (accountIds?.length) {
    params.push(accountIds);
    extra += ` AND s.ads_account_id = ANY($${params.length}::uuid[])`;
  }
  if (campaignIds?.length) {
    params.push(campaignIds.map(String));
    extra += ` AND s.campaign_id = ANY($${params.length}::text[])`;
  }
  if (useCountry) {
    params.push(countryCodes.map((c) => String(c).trim().toUpperCase()));
    extra += ` AND UPPER(TRIM(s.country_code)) = ANY($${params.length}::text[])`;
  }
  const { rows } = await query(
    `SELECT s.report_date::text AS report_date,
            s.ads_account_id,
            COALESCE(SUM(${SPEND('s')}), 0)::float8 AS cost,
            COALESCE(SUM(s.clicks), 0)::bigint AS clicks,
            COALESCE(SUM(s.impressions), 0)::bigint AS impressions,
            COALESCE(SUM(s.conversions), 0)::float8 AS conversions
     FROM ${table} s
     WHERE s.client_id = $1
       AND s.report_date BETWEEN $2 AND $3
       ${extra}
     GROUP BY 1, s.ads_account_id`,
    params
  );
  return rows.map((r) => ({
    date: ymd(r.report_date),
    targetType,
    targetKey: key,
    adsAccountId: r.ads_account_id,
    cost: Number(r.cost) || 0,
    clicks: Number(r.clicks) || 0,
    impressions: Number(r.impressions) || 0,
    conversions: Number(r.conversions) || 0,
  }));
}

async function loadUnmappedSpend(clientId, start, end, {
  accountIds = null,
  campaignIds = null,
  countryCodes = null,
} = {}) {
  const useCountry = Array.isArray(countryCodes) && countryCodes.length > 0;
  const table = useCountry ? 'ads_spend_country_daily' : 'ads_spend_daily';
  const params = [clientId, start, end];
  let extra = '';
  if (accountIds?.length) {
    params.push(accountIds);
    extra += ` AND s.ads_account_id = ANY($${params.length}::uuid[])`;
  }
  if (campaignIds?.length) {
    params.push(campaignIds.map(String));
    extra += ` AND s.campaign_id = ANY($${params.length}::text[])`;
  }
  if (useCountry) {
    params.push(countryCodes.map((c) => String(c).trim().toUpperCase()));
    extra += ` AND UPPER(TRIM(s.country_code)) = ANY($${params.length}::text[])`;
  }
  const { rows } = await query(
    `SELECT COALESCE(SUM(${SPEND('s')}), 0)::float8 AS cost
     FROM ${table} s
     LEFT JOIN ads_campaign_map m
       ON m.client_id = s.client_id
      AND m.ads_account_id = s.ads_account_id
      AND m.campaign_id = s.campaign_id
     WHERE s.client_id = $1
       AND s.report_date BETWEEN $2 AND $3
       AND m.id IS NULL
       AND NULLIF(TRIM(s.app_id), '') IS NULL
       ${extra}`,
    params
  );
  return Number(rows[0]?.cost) || 0;
}

/**
 * Build Ads spend WHERE fragments.
 * @param {number} paramOffset - count of bind params already used ($1..$N) before these filters.
 */
function spendFilterSql(spendOpts = {}, tableAlias = 's', paramOffset = 0) {
  const { accountIds = null, campaignIds = null, countryCodes = null } = spendOpts;
  const params = [];
  let extra = '';
  const nextIdx = () => paramOffset + params.length;
  const asList = (v) => (Array.isArray(v) ? v : v != null && v !== '' ? [v] : []);
  const accounts = asList(accountIds).filter(Boolean);
  if (accounts.length) {
    params.push(accounts);
    extra += ` AND ${tableAlias}.ads_account_id = ANY($${nextIdx()}::uuid[])`;
  }
  const campaigns = asList(campaignIds).map(String).filter(Boolean);
  if (campaigns.length) {
    params.push(campaigns);
    extra += ` AND ${tableAlias}.campaign_id = ANY($${nextIdx()}::text[])`;
  }
  const countries = asList(countryCodes).map((c) => String(c).trim().toUpperCase()).filter(Boolean);
  if (countries.length) {
    params.push(countries);
    extra += ` AND UPPER(TRIM(${tableAlias}.country_code)) = ANY($${nextIdx()}::text[])`;
  }
  return { extra, params };
}

/** Total synced Ads spend for ROI cards — all spend rows in scope (includes unmapped). */
async function loadTotalAdsSpend(clientId, start, end, spendOpts = {}) {
  const useCountry = Array.isArray(spendOpts.countryCodes) && spendOpts.countryCodes.length > 0;
  const table = useCountry ? 'ads_spend_country_daily' : 'ads_spend_daily';
  const { extra, params: filterParams } = spendFilterSql(spendOpts, 's', 3);
  const params = [clientId, start, end, ...filterParams];
  const { rows } = await query(
    `SELECT COALESCE(SUM(${SPEND('s')}), 0)::float8 AS cost,
            COALESCE(SUM(s.impressions), 0)::bigint AS impressions,
            COALESCE(SUM(s.clicks), 0)::bigint AS clicks,
            COALESCE(SUM(s.conversions), 0)::float8 AS conversions
     FROM ${table} s
     WHERE s.client_id = $1
       AND s.report_date BETWEEN $2 AND $3
       ${extra}`,
    params
  );
  const row = rows[0] || {};
  return {
    adsSpend: Number(row.cost) || 0,
    impressions: Number(row.impressions) || 0,
    clicks: Number(row.clicks) || 0,
    conversions: Number(row.conversions) || 0,
  };
}

/** Ads spend limited to selected app package IDs (site filters do not affect Ads spend). */
async function loadAppScopedAdsSpend(clientId, start, end, spendOpts = {}, appKeys = []) {
  const keys = [...new Set(
    (appKeys || []).map((k) => String(k).trim().toLowerCase()).filter(Boolean)
  )];
  if (!keys.length) return loadTotalAdsSpend(clientId, start, end, spendOpts);

  const useCountry = Array.isArray(spendOpts.countryCodes) && spendOpts.countryCodes.length > 0;
  const table = useCountry ? 'ads_spend_country_daily' : 'ads_spend_daily';
  const params = [clientId, start, end, keys];
  let extra = '';
  if (spendOpts.accountIds?.length) {
    params.push(spendOpts.accountIds);
    extra += ` AND s.ads_account_id = ANY($${params.length}::uuid[])`;
  }
  if (spendOpts.campaignIds?.length) {
    params.push(spendOpts.campaignIds.map(String));
    extra += ` AND s.campaign_id = ANY($${params.length}::text[])`;
  }
  if (useCountry) {
    params.push(spendOpts.countryCodes.map((c) => String(c).trim().toUpperCase()));
    extra += ` AND UPPER(TRIM(s.country_code)) = ANY($${params.length}::text[])`;
  }
  const { rows } = await query(
    `SELECT COALESCE(SUM(${SPEND('s')}), 0)::float8 AS cost,
            COALESCE(SUM(s.impressions), 0)::bigint AS impressions,
            COALESCE(SUM(s.clicks), 0)::bigint AS clicks,
            COALESCE(SUM(s.conversions), 0)::float8 AS conversions
     FROM ${table} s
     LEFT JOIN ads_campaign_map m
       ON m.client_id = s.client_id
      AND m.ads_account_id = s.ads_account_id
      AND m.campaign_id = s.campaign_id
     WHERE s.client_id = $1
       AND s.report_date BETWEEN $2 AND $3
       AND (
         LOWER(TRIM(s.app_id)) = ANY($4::text[])
         OR (
           NULLIF(TRIM(s.app_id), '') IS NULL
           AND m.target_type = 'app'
           AND LOWER(TRIM(m.target_key)) = ANY($4::text[])
         )
       )
       ${extra}`,
    params
  );
  const row = rows[0] || {};
  return {
    adsSpend: Number(row.cost) || 0,
    impressions: Number(row.impressions) || 0,
    clicks: Number(row.clicks) || 0,
    conversions: Number(row.conversions) || 0,
  };
}

async function resolveAdsSpendTotals(clientId, start, end, spendOpts, appKeyFilter = null) {
  if (appKeyFilter?.size) {
    return loadAppScopedAdsSpend(clientId, start, end, spendOpts, [...appKeyFilter]);
  }
  return loadTotalAdsSpend(clientId, start, end, spendOpts);
}

/** Client Ads accounts that have spend in range (for ROI columns / labels). */
async function listAccountsWithSpend(clientId, start, end, { accountIds = null } = {}) {
  const params = [clientId, start, end];
  let extra = '';
  if (accountIds?.length) {
    params.push(accountIds);
    extra += ` AND a.id = ANY($${params.length}::uuid[])`;
  }
  const { rows } = await query(
    `SELECT a.*, COALESCE(SUM(${SPEND('s')}), 0)::float8 AS spend_cost
     FROM ads_accounts a
     JOIN ads_spend_daily s
       ON s.ads_account_id = a.id
      AND s.client_id = a.client_id
     WHERE a.client_id = $1
       AND a.account_type = 'client'
       AND a.is_active = true
       AND s.report_date BETWEEN $2 AND $3
       ${extra}
     GROUP BY a.id
     HAVING COALESCE(SUM(${SPEND('s')}), 0) > 0
     ORDER BY spend_cost DESC, a.descriptive_name ASC`,
    params
  );
  return rows.map((row) => {
    const pub = {
      id: row.id,
      clientId: row.client_id,
      accountType: row.account_type,
      customerId: row.customer_id || '',
      descriptiveName: row.descriptive_name || '',
      parentMccId: row.parent_mcc_id || null,
      includeInRoi: row.include_in_roi !== false,
      spendCost: Number(row.spend_cost) || 0,
    };
    return pub;
  });
}

function sumEarnList(list) {
  return round2(list.reduce((s, r) => s + (Number(r.earn) || 0), 0));
}

/**
 * Fast KPI cards only — Ads spend + GAM earn totals without country tree queries.
 */
async function buildRoiSummaryCards(clientId, {
  start,
  end,
  effectiveTargetType,
  accountFilter,
  campaignFilter,
  countryFilter,
  appKeyFilter,
  siteKeyFilter,
  spendOpts,
  earnCountryOpts,
  countryNames,
  filterAttrTarget,
}) {
  const hasInventoryFilter = Boolean(appKeyFilter?.size || siteKeyFilter?.size);
  const useAdsLinkedEarn = effectiveTargetType === 'all'
    && !hasInventoryFilter
    && !countryFilter;

  // Default overview: Ads spend totals + GAM earn only for Ads-linked app/site IDs.
  if (useAdsLinkedEarn) {
    const [adsTotals, linkedEarn, expenses] = await Promise.all([
      resolveAdsSpendTotals(clientId, start, end, spendOpts, null),
      loadAdsLinkedGamEarn(clientId, start, end, spendOpts),
      listOtherExpenses(clientId, { start, end }),
    ]);
    let otherExpenses = 0;
    const generalExpenses = [];
    const listedExpenses = [];
    for (const e of expenses) {
      listedExpenses.push(e);
      if (e.targetType === 'general') {
        otherExpenses = round2(otherExpenses + (Number(e.amount) || 0));
        generalExpenses.push(e);
        continue;
      }
      // Site/app expenses count toward overview ROI-on-expenses as well.
      if (e.targetType === 'site' || e.targetType === 'app') {
        otherExpenses = round2(otherExpenses + (Number(e.amount) || 0));
      }
    }
    const adsSpend = round2(adsTotals.adsSpend || 0);
    const summaryMetrics = await metricsFor(linkedEarn, adsSpend, otherExpenses, {
      impressions: Number(adsTotals.impressions) || 0,
      clicks: Number(adsTotals.clicks) || 0,
      conversions: Number(adsTotals.conversions) || 0,
    }, { endDate: end });
    return {
      accounts: [],
      summary: {
        ...summaryMetrics,
        mappedSpend: adsSpend,
        unmappedSpend: 0,
        mappedCampaigns: 0,
        accountsWithSpend: 0,
        adsSpendCurrency: adsSpendDisplayCurrency(),
      },
      rows: [],
      countryBreakdown: [],
      countryTargetBreakdown: [],
      countryTargetDailyBreakdown: [],
      generalExpenses,
      expenses: listedExpenses,
      spendCurrency: adsSpendDisplayCurrency(),
    };
  }

  const [spendRows, expenses, unmappedTotal, maps, adsTotals] = await Promise.all([
    loadMappedSpendAggregated(clientId, start, end, spendOpts),
    listOtherExpenses(clientId, { start, end }),
    loadUnmappedSpend(clientId, start, end, spendOpts),
    listCampaignMaps(clientId),
    resolveAdsSpendTotals(clientId, start, end, spendOpts, appKeyFilter),
  ]);

  let workingSpendRows = spendRows;
  let unmapped = round2(unmappedTotal);
  if (filterAttrTarget && (accountFilter || campaignFilter) && !workingSpendRows.length) {
    workingSpendRows = await loadFilterAttributedSpendDaily(clientId, start, end, {
      ...spendOpts,
      ...filterAttrTarget,
    });
    if (workingSpendRows.length) unmapped = 0;
  }

  const mappedKeys = new Set();
  const accountFilterSet = accountFilter ? new Set(accountFilter.map(String)) : null;
  const campaignFilterSet = campaignFilter ? new Set(campaignFilter.map(String)) : null;
  maps.forEach((m) => {
    const type = m.targetType || m.target_type;
    const key = String(m.targetKey || m.target_key || '').trim().toLowerCase();
    const mapAccountId = String(m.adsAccountId || m.ads_account_id || '');
    const mapCampaignId = String(m.campaignId || m.campaign_id || '');
    if (accountFilterSet && mapAccountId && !accountFilterSet.has(mapAccountId)) return;
    if (campaignFilterSet && mapCampaignId && !campaignFilterSet.has(mapCampaignId)) return;
    if (type === 'app' && appKeyFilter && !appKeyFilter.has(key)) return;
    if (type === 'site' && siteKeyFilter && !siteKeyMatchesFilter(key, siteKeyFilter)) return;
    if (type && key) mappedKeys.add(`${type}:${key}`);
  });
  workingSpendRows.forEach((s) => {
    if (!s.targetType || !s.targetKey) return;
    if (s.targetType === 'app' && appKeyFilter && !appKeyFilter.has(s.targetKey)) return;
    if (s.targetType === 'site' && siteKeyFilter && !siteKeyMatchesFilter(s.targetKey, siteKeyFilter)) return;
    mappedKeys.add(`${s.targetType}:${s.targetKey}`);
  });
  if (appKeyFilter) appKeyFilter.forEach((k) => mappedKeys.add(`app:${k}`));
  if (siteKeyFilter) siteKeyFilter.forEach((k) => mappedKeys.add(`site:${k}`));

  const scopeApps = [];
  const scopeSites = [];
  mappedKeys.forEach((k) => {
    if (k.startsWith('app:')) scopeApps.push(k.slice(4));
    else if (k.startsWith('site:')) scopeSites.push(k.slice(5));
  });

  const needsTargetEarn = !countryFilter && (
    hasInventoryFilter
    || maps.length > 0
    || effectiveTargetType !== 'all'
    || mappedKeys.size > 0
  );

  const [earnMaps, canonicalEarn, countrySpendRows, earnByCountry] = await Promise.all([
    needsTargetEarn
      ? (
        (scopeApps.length || scopeSites.length)
          ? loadGamEarnByTargetAggregatedScoped(clientId, start, end, {
            appKeys: scopeApps,
            siteKeys: scopeSites,
            countryNames: earnCountryOpts?.countryNames || null,
          })
          : loadGamEarnByTargetAggregated(clientId, start, end, earnCountryOpts)
      )
      : Promise.resolve({ sites: [], apps: [] }),
    Promise.resolve(0),
    countryFilter?.length
      ? loadCountrySpendBreakdown(clientId, start, end, spendOpts)
      : Promise.resolve([]),
    countryFilter?.length
      ? loadGamEarnByCountry(clientId, start, end)
      : Promise.resolve(new Map()),
  ]);

  // Sites selected with targetType=all: still include site expenses + app expenses.
  const includeSite = effectiveTargetType !== 'app' || Boolean(siteKeyFilter?.size);
  const includeApp = effectiveTargetType !== 'site' || Boolean(appKeyFilter?.size) || scopeApps.length > 0;

  function isMappedTarget(type, key) {
    if (!mappedKeys.size) return false;
    return mappedKeys.has(`${type}:${String(key || '').trim().toLowerCase()}`);
  }

  let generalOther = 0;
  const generalExpenses = [];
  const listedExpenses = [];
  let otherExpenses = 0;
  for (const e of expenses) {
    listedExpenses.push(e);
    if (e.targetType === 'general') {
      generalOther = round2(generalOther + e.amount);
      generalExpenses.push(e);
      continue;
    }
    if (e.targetType === 'site' && !includeSite) continue;
    if (e.targetType === 'app' && !includeApp) continue;
    if (!isMappedTarget(e.targetType, e.targetKey)) continue;
    otherExpenses = round2(otherExpenses + (Number(e.amount) || 0));
  }
  otherExpenses = round2(otherExpenses + generalOther);

  const mappedSpend = round2(workingSpendRows.reduce((s, r) => {
    if (r.targetType === 'site' && !includeSite) return s;
    if (r.targetType === 'app' && !includeApp) return s;
    if (r.targetType === 'app' && appKeyFilter && !appKeyFilter.has(r.targetKey)) return s;
    if (r.targetType === 'site' && siteKeyFilter && !siteKeyMatchesFilter(r.targetKey, siteKeyFilter)) return s;
    return s + (Number(r.cost) || 0);
  }, 0));

  const countrySpendTotal = round2((countrySpendRows || []).reduce((s, r) => s + (r.adsSpend || 0), 0));
  const adsSpend = countryFilter?.length
    ? countrySpendTotal
    : round2(adsTotals.adsSpend || 0);

  const adsImpressions = countryFilter?.length
    ? (countrySpendRows || []).reduce((s, r) => s + (Number(r.impressions) || 0), 0)
    : (Number(adsTotals.impressions) || 0);
  const adsClicks = countryFilter?.length
    ? (countrySpendRows || []).reduce((s, r) => s + (Number(r.clicks) || 0), 0)
    : (Number(adsTotals.clicks) || 0);
  const adsConversions = countryFilter?.length
    ? (countrySpendRows || []).reduce((s, r) => s + (Number(r.conversions) || 0), 0)
    : (Number(adsTotals.conversions) || 0);

  let earn;
  // Inventory filters (app and/or site) are a union — always sum mapped apps + sites.
  if (mappedKeys.size) {
    earn = round2(
      sumEarnList(earnMaps.sites.filter((r) => isMappedTarget('site', r.targetKey)))
      + sumEarnList(earnMaps.apps.filter((r) => isMappedTarget('app', r.targetKey)))
    );
  } else if (countryFilter?.length && countryNames?.length) {
    earn = round2(
      countryNames.reduce((s, name) => {
        const key = String(name).trim().toLowerCase();
        return s + (earnByCountry.get(key)?.earn || 0);
      }, 0)
    );
  } else if (effectiveTargetType === 'site') {
    earn = sumEarnList(earnMaps.sites);
  } else if (effectiveTargetType === 'app') {
    earn = sumEarnList(earnMaps.apps);
  } else {
    earn = canonicalEarn;
  }

  const summaryMetrics = await metricsFor(earn, adsSpend, otherExpenses, {
    impressions: adsImpressions,
    clicks: adsClicks,
    conversions: adsConversions,
  }, { endDate: end });

  return {
    accounts: [],
    summary: {
      ...summaryMetrics,
      mappedSpend,
      unmappedSpend: unmapped,
      mappedCampaigns: maps.length,
      accountsWithSpend: 0,
      adsSpendCurrency: adsSpendDisplayCurrency(),
    },
    rows: [],
    countryBreakdown: [],
    countryTargetBreakdown: [],
    countryTargetDailyBreakdown: [],
    generalExpenses,
    expenses: listedExpenses,
    spendCurrency: adsSpendDisplayCurrency(),
  };
}

/**
 * Fast country tree breakdown — loads Ads spend first, then scoped GAM earn.
 */
async function buildRoiCountryBreakdown(clientId, {
  start,
  end,
  effectiveTargetType,
  accountFilter,
  campaignFilter,
  countryFilter,
  appKeyFilter,
  siteKeyFilter,
  spendOpts,
  countryNames,
  filterAttrTarget,
  needDaily,
}) {
  const [maps, countrySpendRows, countryTargetRowsRaw, countryTargetDailyRowsRaw, expenses] = await Promise.all([
    listCampaignMaps(clientId),
    loadCountrySpendBreakdown(clientId, start, end, spendOpts),
    loadCountrySpendByTarget(clientId, start, end, spendOpts),
    needDaily
      ? loadCountrySpendByTargetDaily(clientId, start, end, spendOpts)
      : Promise.resolve([]),
    listOtherExpenses(clientId, { start, end }),
  ]);

  let countryTargetRows = filterCountryTargetRows(countryTargetRowsRaw, {
    appKeyFilter,
    siteKeyFilter,
    effectiveTargetType,
  });
  let countryTargetDailyRows = filterCountryTargetRows(countryTargetDailyRowsRaw, {
    appKeyFilter,
    siteKeyFilter,
    effectiveTargetType,
  });

  if (filterAttrTarget && (accountFilter || campaignFilter) && !countryTargetRows.length) {
    countryTargetRows = filterCountryTargetRows(
      await loadFilterAttributedCountrySpend(clientId, start, end, {
        ...spendOpts,
        ...filterAttrTarget,
      }),
      { appKeyFilter, siteKeyFilter, effectiveTargetType }
    );
  }

  // Scope app earn from Ads packages; sites load separately (Dashboard-parity).
  const earnScope = buildTargetCountryEarnScope(countryTargetRows, {
    appKeyFilter,
    siteKeyFilter: null, // sites loaded via loadSelectedSitesEarnByCountry
    countryFilter,
    countryNames,
  });
  const hasScopeKeys = earnScope.appKeys.length > 0;
  const needsNetworkCountryEarn = !hasScopeKeys
    && !appKeyFilter?.size
    && !siteKeyFilter?.size
    && !(accountFilter?.length || campaignFilter?.length)
    && !countryTargetRows.some((r) => r.targetType && r.targetKey && (Number(r.adsSpend) || 0) > 0);

  const [earnByCountry, earnByTargetCountryApps, earnByTargetCountryDaily, siteEarnBundle] = await Promise.all([
    needsNetworkCountryEarn
      ? loadGamEarnByCountry(clientId, start, end)
      : Promise.resolve(new Map()),
    hasScopeKeys || appKeyFilter?.size
      ? loadGamEarnByTargetCountryScoped(clientId, start, end, {
        appKeys: earnScope.appKeys,
        siteKeys: [],
        countryKeys: earnScope.countryKeys,
        allowFullScan: !hasScopeKeys && !earnScope.countryKeys.length,
      })
      : Promise.resolve(new Map()),
    needDaily
      ? loadGamEarnByTargetCountryDailyScoped(clientId, start, end, {
        appKeys: earnScope.appKeys,
        siteKeys: [],
        countryKeys: earnScope.countryKeys,
        allowFullScan: !hasScopeKeys && !earnScope.countryKeys.length,
      })
      : Promise.resolve(new Map()),
    siteKeyFilter?.size
      ? loadSelectedSitesEarnByCountry(clientId, start, end, siteKeyFilter)
      : Promise.resolve({ earnMap: new Map(), engagementMap: new Map() }),
  ]);

  const siteEarnByCountry = siteEarnBundle?.earnMap || new Map();
  const siteEngagementByCountry = siteEarnBundle?.engagementMap || new Map();

  // Merge site×country earn (independent of Ads) into the target earn map.
  const earnByTargetCountry = new Map(earnByTargetCountryApps);
  for (const [k, v] of siteEarnByCountry.entries()) {
    earnByTargetCountry.set(k, round2((earnByTargetCountry.get(k) || 0) + (Number(v) || 0)));
  }

  countryTargetRows = synthesizeSitePackagesFromEarn({
    countryTargetRows,
    earnByTargetCountry: siteEarnByCountry.size ? siteEarnByCountry : earnByTargetCountry,
    siteEngagementByCountry,
    siteKeyFilter,
    countrySpendRows,
  });
  if (needDaily && earnByTargetCountryDaily?.size && siteKeyFilter?.size) {
    // Daily site packages: reuse range rows (date rows come from Ads); site-only earn
    // without Ads spend stays on the package rollup from countryTargetRows.
  }

  const mappedKeys = new Set();
  const accountFilterSet = accountFilter ? new Set(accountFilter.map(String)) : null;
  const campaignFilterSet = campaignFilter ? new Set(campaignFilter.map(String)) : null;
  maps.forEach((m) => {
    const type = m.targetType || m.target_type;
    const key = String(m.targetKey || m.target_key || '').trim().toLowerCase();
    const mapAccountId = String(m.adsAccountId || m.ads_account_id || '');
    const mapCampaignId = String(m.campaignId || m.campaign_id || '');
    if (accountFilterSet && mapAccountId && !accountFilterSet.has(mapAccountId)) return;
    if (campaignFilterSet && mapCampaignId && !campaignFilterSet.has(mapCampaignId)) return;
    if (type === 'app' && appKeyFilter && !appKeyFilter.has(key)) return;
    if (type === 'site' && siteKeyFilter && !siteKeyMatchesFilter(key, siteKeyFilter)) return;
    if (type && key) mappedKeys.add(`${type}:${key}`);
  });
  if (appKeyFilter) appKeyFilter.forEach((k) => mappedKeys.add(`app:${k}`));
  if (siteKeyFilter) siteKeyFilter.forEach((k) => mappedKeys.add(`site:${k}`));

  const includeSite = effectiveTargetType !== 'app' || Boolean(siteKeyFilter?.size);
  const includeApp = effectiveTargetType !== 'site' || Boolean(appKeyFilter?.size)
    || countryTargetRows.some((r) => r.targetType === 'app');
  const { byTarget: expenseByTarget, byTargetDate: expenseByTargetDate } = buildSiteAppExpenseMaps(expenses, {
    includeSite,
    includeApp,
    allowTarget: (t, k) => !mappedKeys.size || mappedKeys.has(targetExpenseKey(t, k)),
  });
  const spendTotalByTarget = sumAdsSpendByTarget(countryTargetRows);
  const spendTotalByTargetDate = sumAdsSpendByTargetDate(countryTargetDailyRows);

  const accountById = new Map();
  countryTargetRows.forEach((r) => {
    if (!r.adsAccountId || accountById.has(r.adsAccountId)) return;
    accountById.set(r.adsAccountId, {
      id: r.adsAccountId,
      descriptiveName: r.accountName,
      customerId: r.customerId,
    });
  });

  const lookupCountryEarn = buildScopedCountryEarnLookup({
    earnByCountry,
    earnByTargetCountry,
    appKeyFilter,
    siteKeyFilter,
    effectiveTargetType,
    mappedKeys,
    countryTargetRows,
    accountFilter,
    campaignFilter,
  });

  let countryBreakdown = await Promise.all((countrySpendRows || []).map(async (row) => {
    const countryEarn = lookupCountryEarn(row.countryName);
    const spendMetrics = await metricsFor(countryEarn, row.adsSpend, 0, {
      impressions: row.impressions,
      clicks: row.clicks,
      conversions: row.conversions,
    }, { endDate: end });
    return {
      countryCode: row.countryCode,
      countryName: row.countryName,
      adsSpend: round2(row.adsSpend),
      earn: spendMetrics.earn,
      profitSpend: spendMetrics.profitSpend,
      roiSpendPercent: spendMetrics.roiSpendPercent,
      impressions: spendMetrics.impressions,
      clicks: spendMetrics.clicks,
      conversions: spendMetrics.conversions,
      ctr: spendMetrics.ctr,
      ecpm: spendMetrics.ecpm,
    };
  }));

  if (countryFilter?.length) {
    const byCode = new Map(countryBreakdown.map((r) => [r.countryCode, r]));
    const { rows: nameRows } = await query(
      `SELECT UPPER(TRIM(country_code)) AS country_code,
              MAX(country_name) AS country_name
       FROM ads_spend_country_daily
       WHERE client_id = $1
         AND UPPER(TRIM(country_code)) = ANY($2::text[])
       GROUP BY 1`,
      [clientId, countryFilter]
    );
    const nameByCode = new Map(
      (nameRows || []).map((r) => [String(r.country_code).toUpperCase(), String(r.country_name || '').trim()])
    );
    countryBreakdown = await Promise.all(countryFilter.map(async (code) => {
      const existing = byCode.get(code);
      if (existing) return existing;
      const countryName = nameByCode.get(code) || code;
      const countryEarn = lookupCountryEarn(countryName);
      const spendMetrics = await metricsFor(countryEarn, 0, 0, {}, { endDate: end });
      return {
        countryCode: code,
        countryName,
        adsSpend: 0,
        earn: spendMetrics.earn,
        profitSpend: spendMetrics.profitSpend,
        roiSpendPercent: spendMetrics.roiSpendPercent,
        impressions: 0,
        clicks: 0,
        conversions: 0,
        ctr: null,
        ecpm: null,
      };
    })).then((list) => list.sort((a, b) => b.adsSpend - a.adsSpend || a.countryName.localeCompare(b.countryName)));
  }

  if (siteKeyFilter?.size) {
    countryBreakdown = await mergeSiteOnlyCountries(
      countryBreakdown,
      countryTargetRows,
      earnByTargetCountry,
      end
    );
  }

  const appEarnWinners = claimAppPackageEarnWinners(countryTargetRows);
  const countryTargetBreakdown = await Promise.all(countryTargetRows.map(async (row) => {
    const countryKey = String(row.gamCountryKey || row.countryName || '').trim().toLowerCase();
    const earnKey = `${row.targetType}:${row.targetKey}:${countryKey}`;
    const isSite = row.targetType === 'site';
    let targetEarn = 0;
    if (isSite) {
      targetEarn = sumSiteEarnFromMap(earnByTargetCountry, row.targetKey, {
        countryName: row.gamCountryKey || row.countryName,
        countryCode: row.countryCode,
      });
      if (!(targetEarn > 0)) {
        targetEarn = earnByTargetCountry.get(`site:${normSiteHost(row.targetKey)}:${countryKey}`)
          || earnByTargetCountry.get(earnKey)
          || 0;
      }
    } else {
      targetEarn = earnByTargetCountry.get(earnKey) || 0;
      if (targetEarn > 0 && !appEarnWinners.has(appPackageWinnerKey(row))) {
        targetEarn = 0;
      }
    }
    const rowSpend = isSite ? 0 : (Number(row.adsSpend) || 0);
    const tk = targetExpenseKey(row.targetType, row.targetKey);
    const otherExpenses = allocateTargetExpense(
      expenseByTarget.get(tk) || 0,
      rowSpend,
      spendTotalByTarget.get(tk) || 0
    );
    let impressions = Number(row.impressions) || 0;
    let clicks = Number(row.clicks) || 0;
    let conversions = Number(row.conversions) || 0;
    if (isSite && !(impressions > 0) && !(clicks > 0)) {
      const eng = sumSiteEngagementFromMap(siteEngagementByCountry, row.targetKey, {
        countryName: row.gamCountryKey || row.countryName,
        countryCode: row.countryCode,
      });
      impressions = eng.impressions;
      clicks = eng.clicks;
    }
    const spendMetrics = await metricsFor(targetEarn, rowSpend, otherExpenses, {
      impressions,
      clicks,
      conversions,
    }, { endDate: end });
    // Sites without Ads spend: show revenue eCPM (earn / imps × 1000) instead of Ads eCPM.
    if (isSite && !(rowSpend > 0) && spendMetrics.impressions > 0 && spendMetrics.earn > 0) {
      spendMetrics.ecpm = round2((spendMetrics.earn / spendMetrics.impressions) * 1000);
    }
    const account = accountById.get(row.adsAccountId);
    return {
      adsAccountId: row.adsAccountId,
      accountName: row.accountName || account?.descriptiveName || account?.customerId || row.adsAccountId,
      targetType: row.targetType,
      targetKey: row.targetKey,
      countryCode: row.countryCode,
      countryName: row.countryName,
      adsSpend: round2(rowSpend),
      earn: spendMetrics.earn,
      otherExpenses: spendMetrics.otherExpenses,
      profitSpend: spendMetrics.profitSpend,
      profitExpense: spendMetrics.profitExpense,
      roiSpendPercent: isSite ? null : spendMetrics.roiSpendPercent,
      roiExpensePercent: spendMetrics.roiExpensePercent,
      impressions: spendMetrics.impressions,
      clicks: spendMetrics.clicks,
      conversions: spendMetrics.conversions,
      ctr: spendMetrics.ctr,
      ecpm: spendMetrics.ecpm,
      earnOnly: isSite,
    };
  }));

  const dailyAppEarnWinners = claimAppPackageEarnWinners(countryTargetDailyRows || [], { includeDate: true });
  const countryTargetDailyBreakdown = await Promise.all((countryTargetDailyRows || [])
    .filter((row) => (Number(row.adsSpend) || 0) > 0)
    .map(async (row) => {
      const countryKey = String(row.countryName || '').trim().toLowerCase();
      const earnKey = `${row.date}:${row.targetType}:${row.targetKey}:${countryKey}`;
      let targetEarn = earnByTargetCountryDaily.get(earnKey) || 0;
      if (
        row.targetType === 'app'
        && targetEarn > 0
        && !dailyAppEarnWinners.has(appPackageWinnerKey(row, { includeDate: true }))
      ) {
        targetEarn = 0;
      }
      const tk = targetExpenseKey(row.targetType, row.targetKey);
      const dayKey = `${ymd(row.date)}:${tk}`;
      const otherExpenses = allocateTargetExpense(
        expenseByTargetDate.get(dayKey) || 0,
        row.adsSpend,
        spendTotalByTargetDate.get(dayKey) || 0
      );
      const spendMetrics = await metricsFor(targetEarn, row.adsSpend, otherExpenses, {
        impressions: row.impressions,
        clicks: row.clicks,
        conversions: row.conversions,
      }, { endDate: end });
      const account = accountById.get(row.adsAccountId);
      return {
        date: row.date,
        adsAccountId: row.adsAccountId,
        accountName: row.accountName || account?.descriptiveName || account?.customerId || row.adsAccountId,
        targetType: row.targetType,
        targetKey: row.targetKey,
        countryCode: row.countryCode,
        countryName: row.countryName,
        adsSpend: round2(row.adsSpend),
        earn: spendMetrics.earn,
        otherExpenses: spendMetrics.otherExpenses,
        profitSpend: spendMetrics.profitSpend,
        profitExpense: spendMetrics.profitExpense,
        roiSpendPercent: spendMetrics.roiSpendPercent,
        roiExpensePercent: spendMetrics.roiExpensePercent,
        impressions: spendMetrics.impressions,
        clicks: spendMetrics.clicks,
        conversions: spendMetrics.conversions,
        ctr: spendMetrics.ctr,
        ecpm: spendMetrics.ecpm,
      };
    }));

  // Roll package expenses up onto country rows (already FX-converted earn — do not re-convert).
  const otherByCountry = new Map();
  for (const r of countryTargetBreakdown) {
    const code = r.countryCode;
    otherByCountry.set(code, round2((otherByCountry.get(code) || 0) + (Number(r.otherExpenses) || 0)));
  }
  countryBreakdown = countryBreakdown.map((row) => {
    const other = otherByCountry.get(row.countryCode) || 0;
    const em = expenseMetricsFromConvertedEarn(row.earn, row.adsSpend, other);
    return {
      ...row,
      otherExpenses: em.otherExpenses,
      profitExpense: em.profitExpense,
      roiExpensePercent: em.roiExpensePercent,
    };
  });

  return {
    countryBreakdown,
    countryTargetBreakdown,
    countryTargetDailyBreakdown,
  };
}

/**
 * Build ROI summary with separate ROI% for Ads spend and for other expenses.
 * Table rows are daily (date × site/app), plus unmapped Ads spend rows by account.
 */
async function getRoiSummary(clientId, {
  start,
  end,
  targetType = 'all',
  accountIds = null,
  campaignIds = null,
  appKeys = null,
  siteKeys = null,
  countryCodes = null,
  includeRows = false,
  summaryOnly = false,
  breakdownOnly = false,
  includeDaily = null,
} = {}) {
  const cacheKey = breakdownOnly
    ? `roi_bd_v17_${clientId}_${JSON.stringify({
      start, end, targetType, accountIds, campaignIds, appKeys, siteKeys, countryCodes, includeDaily,
    })}`
    : `roi_sum_v17_${clientId}_${JSON.stringify({
      start,
      end,
      targetType,
      accountIds,
      campaignIds,
      appKeys,
      siteKeys,
      countryCodes,
      includeRows,
      summaryOnly,
      breakdownOnly,
      includeDaily,
    })}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const MAX_ACCOUNT_COLUMNS = 15;
  const accountFilter = Array.isArray(accountIds) && accountIds.length ? accountIds : null;
  const campaignFilter = Array.isArray(campaignIds) && campaignIds.length ? campaignIds : null;
  const countryFilter = Array.isArray(countryCodes) && countryCodes.length
    ? countryCodes.map((c) => String(c).trim().toUpperCase()).filter(Boolean)
    : null;
  const appKeyFilter = Array.isArray(appKeys) && appKeys.length
    ? new Set(appKeys.map((k) => String(k).trim().toLowerCase()).filter(Boolean))
    : null;
  const siteKeyFilter = Array.isArray(siteKeys) && siteKeys.length
    ? new Set(
      siteKeys
        .map((k) => normSiteHost(k))
        .filter(Boolean)
    )
    : null;
  const spendOpts = {
    accountIds: accountFilter,
    campaignIds: campaignFilter,
    countryCodes: countryFilter,
  };

  const countryNames = countryFilter?.length
    ? await resolveCountryNames(clientId, countryFilter)
    : null;
  const earnCountryOpts = countryNames?.length ? { countryNames } : {};

  // Inventory multi-selects are always a union (Ads apps + GAM sites).
  // Never force site-only / app-only — that hid packages and zeroed earn when
  // sites were picked while App IDs stayed "All selected".
  let effectiveTargetType = targetType || 'all';
  if (appKeyFilter || siteKeyFilter) {
    effectiveTargetType = 'all';
  }

  const singleAppKey = appKeyFilter && appKeyFilter.size === 1 ? [...appKeyFilter][0] : null;
  const singleSiteKey = siteKeyFilter && siteKeyFilter.size === 1 ? [...siteKeyFilter][0] : null;
  const filterAttrTarget = singleAppKey && !siteKeyFilter
    ? { targetType: 'app', targetKey: singleAppKey }
    : (singleSiteKey && !appKeyFilter
      ? { targetType: 'site', targetKey: singleSiteKey }
      : null);

  if (summaryOnly && !breakdownOnly) {
    const cards = await buildRoiSummaryCards(clientId, {
      start,
      end,
      effectiveTargetType,
      accountFilter,
      campaignFilter,
      countryFilter,
      appKeyFilter,
      siteKeyFilter,
      spendOpts,
      earnCountryOpts,
      countryNames,
      filterAttrTarget,
    });
    cache.set(cacheKey, cards, ROI_SUMMARY_CACHE_TTL);
    return cards;
  }

  const multiDay = String(start) !== String(end);
  const needDaily = includeDaily == null ? multiDay : Boolean(includeDaily);

  if (breakdownOnly && !summaryOnly) {
    const breakdown = await buildRoiCountryBreakdown(clientId, {
      start,
      end,
      effectiveTargetType,
      accountFilter,
      campaignFilter,
      countryFilter,
      appKeyFilter,
      siteKeyFilter,
      spendOpts,
      countryNames,
      filterAttrTarget,
      needDaily,
    });
    cache.set(cacheKey, breakdown, ROI_BREAKDOWN_CACHE_TTL);
    return breakdown;
  }

  const needRows = Boolean(includeRows) && !breakdownOnly;
  const needBreakdown = breakdownOnly || !summaryOnly;

  const earnLoader = needRows ? loadGamEarnByTargetDaily : loadGamEarnByTargetAggregated;
  const spendLoader = needRows ? loadMappedSpendDaily : loadMappedSpendAggregated;

  const corePromises = breakdownOnly
    ? [
      Promise.resolve({ sites: [], apps: [] }),
      spendLoader(clientId, start, end, spendOpts),
      Promise.resolve([]),
      Promise.resolve(0),
      listCampaignMaps(clientId),
      Promise.resolve(0),
    ]
    : [
      earnLoader(clientId, start, end, earnCountryOpts),
      spendLoader(clientId, start, end, spendOpts),
      listOtherExpenses(clientId, { start, end }),
      loadUnmappedSpend(clientId, start, end, spendOpts),
      listCampaignMaps(clientId),
      effectiveTargetType === 'all' && !appKeyFilter && !siteKeyFilter && !countryFilter
        ? loadCanonicalGamEarn(clientId, start, end)
        : Promise.resolve(0),
    ];

  const filterEarnScope = buildTargetCountryEarnScope([], {
    appKeyFilter,
    siteKeyFilter,
    countryFilter,
    countryNames,
  });
  const filterEarnScopeOpts = {
    ...filterEarnScope,
    allowFullScan: !filterEarnScope.appKeys.length
      && !filterEarnScope.siteKeys.length
      && !filterEarnScope.countryKeys.length,
  };

  const breakdownPromises = needBreakdown
    ? [
      listAccountsWithSpend(clientId, start, end, { accountIds: accountFilter }),
      listRoiClientAccounts(clientId),
      loadCountrySpendBreakdown(clientId, start, end, spendOpts),
      loadGamEarnByCountry(clientId, start, end),
      loadCountrySpendByTarget(clientId, start, end, spendOpts),
      loadGamEarnByTargetCountryScoped(clientId, start, end, filterEarnScopeOpts),
      ...(needDaily
        ? [
          loadCountrySpendByTargetDaily(clientId, start, end, spendOpts),
          loadGamEarnByTargetCountryDailyScoped(clientId, start, end, filterEarnScopeOpts),
        ]
        : [Promise.resolve([]), Promise.resolve(new Map())]),
    ]
    : [
      Promise.resolve([]),
      Promise.resolve([]),
      countryFilter?.length
        ? loadCountrySpendBreakdown(clientId, start, end, spendOpts)
        : Promise.resolve([]),
      countryFilter?.length
        ? loadGamEarnByCountry(clientId, start, end)
        : Promise.resolve(new Map()),
      Promise.resolve([]),
      Promise.resolve(new Map()),
      Promise.resolve([]),
      Promise.resolve(new Map()),
    ];

  let [earnMaps, spendRows, expenses, unmappedTotal, maps, canonicalEarn, spendAccounts, roiFlagged, countrySpendRows, earnByCountry, countryTargetRows, earnByTargetCountry, countryTargetDailyRows, earnByTargetCountryDaily] =
    await Promise.all([...corePromises, ...breakdownPromises]);

  countryTargetRows = filterCountryTargetRows(countryTargetRows, {
    appKeyFilter,
    siteKeyFilter,
    effectiveTargetType,
  });
  countryTargetDailyRows = filterCountryTargetRows(countryTargetDailyRows, {
    appKeyFilter,
    siteKeyFilter,
    effectiveTargetType,
  });

  if (filterAttrTarget && (accountFilter || campaignFilter) && !countryTargetRows.length) {
    countryTargetRows = filterCountryTargetRows(
      await loadFilterAttributedCountrySpend(clientId, start, end, {
        ...spendOpts,
        ...filterAttrTarget,
      }),
      { appKeyFilter, siteKeyFilter, effectiveTargetType }
    );
  }

  // No campaign maps (or none for this filter): attribute selected Ads spend to one picked app/site.
  if (filterAttrTarget && (accountFilter || campaignFilter) && !spendRows.length) {
    spendRows = await loadFilterAttributedSpendDaily(clientId, start, end, {
      ...spendOpts,
      ...filterAttrTarget,
    });
    if (spendRows.length) unmappedTotal = 0;
  }

  countryTargetRows = synthesizeSitePackagesFromEarn({
    countryTargetRows,
    earnByTargetCountry,
    siteKeyFilter,
    countrySpendRows,
  });

  // Targets that have a campaign map (or mapped spend) — table shows only these.
  const mappedKeys = new Set();
  const accountFilterSet = accountFilter ? new Set(accountFilter.map(String)) : null;
  const campaignFilterSet = campaignFilter ? new Set(campaignFilter.map(String)) : null;
  maps.forEach((m) => {
    const type = m.targetType || m.target_type;
    const key = String(m.targetKey || m.target_key || '').trim().toLowerCase();
    const mapAccountId = String(m.adsAccountId || m.ads_account_id || '');
    const mapCampaignId = String(m.campaignId || m.campaign_id || '');
    if (accountFilterSet && mapAccountId && !accountFilterSet.has(mapAccountId)) return;
    if (campaignFilterSet && mapCampaignId && !campaignFilterSet.has(mapCampaignId)) return;
    if (type === 'app' && appKeyFilter && !appKeyFilter.has(key)) return;
    if (type === 'site' && siteKeyFilter && !siteKeyMatchesFilter(key, siteKeyFilter)) return;
    if (type && key) mappedKeys.add(`${type}:${key}`);
  });
  spendRows.forEach((s) => {
    if (!s.targetType || !s.targetKey) return;
    if (s.targetType === 'app' && appKeyFilter && !appKeyFilter.has(s.targetKey)) return;
    if (s.targetType === 'site' && siteKeyFilter && !siteKeyMatchesFilter(s.targetKey, siteKeyFilter)) return;
    mappedKeys.add(`${s.targetType}:${s.targetKey}`);
  });
  // Explicit inventory picks with no maps yet: still allow earn-only rows for those keys.
  if (appKeyFilter) {
    appKeyFilter.forEach((k) => mappedKeys.add(`app:${k}`));
  }
  if (siteKeyFilter) {
    siteKeyFilter.forEach((k) => mappedKeys.add(`site:${k}`));
  }

  const includeSite = effectiveTargetType !== 'app' || Boolean(siteKeyFilter?.size);
  const includeApp = effectiveTargetType !== 'site' || Boolean(appKeyFilter?.size)
    || countryTargetRows.some((r) => r.targetType === 'app');

  function isMappedTarget(type, key) {
    if (!mappedKeys.size) return false;
    return mappedKeys.has(`${type}:${String(key || '').trim().toLowerCase()}`);
  }

  let generalOther = 0;
  const generalExpenses = [];
  const listedExpenses = [];
  let rows = [];
  let mappedSpend = 0;
  let otherExpenses = 0;
  let adsImpressions = 0;
  let adsClicks = 0;
  let adsConversions = 0;

  if (needRows) {
    const mappedAccountIds = new Set(spendRows.map((s) => s.adsAccountId).filter(Boolean));
    const mappedSpendAccounts = spendAccounts.filter((a) => mappedAccountIds.has(a.id));
    const columnSource = mappedSpendAccounts.length
      ? mappedSpendAccounts
      : (spendAccounts.length ? spendAccounts : roiFlagged);
    const columnAccounts = columnSource.slice(0, MAX_ACCOUNT_COLUMNS);
    const columnAccountIds = columnAccounts.map((a) => a.id);

    const rowMap = new Map();

    function ensureRow(date, type, key) {
      const day = ymd(date);
      const k = `${day}:${type}:${key}`;
      if (!rowMap.has(k)) {
        rowMap.set(k, {
          date: day,
          targetType: type,
          targetKey: key,
          spendByAccount: Object.fromEntries(columnAccountIds.map((id) => [id, 0])),
          adsSpend: 0,
          otherExpenses: 0,
          earn: 0,
          impressions: 0,
          clicks: 0,
          conversions: 0,
        });
      }
      return rowMap.get(k);
    }

    if (includeSite) {
      earnMaps.sites.forEach((row) => {
        if (!row.date || !isMappedTarget('site', row.targetKey)) return;
        if (siteKeyFilter && !siteKeyMatchesFilter(String(row.targetKey || '').trim().toLowerCase(), siteKeyFilter)) return;
        ensureRow(row.date, 'site', row.targetKey).earn = round2(row.earn);
      });
    }
    if (includeApp) {
      earnMaps.apps.forEach((row) => {
        if (!row.date || !isMappedTarget('app', row.targetKey)) return;
        if (appKeyFilter && !appKeyFilter.has(String(row.targetKey || '').trim().toLowerCase())) return;
        ensureRow(row.date, 'app', row.targetKey).earn = round2(row.earn);
      });
    }

    for (const s of spendRows) {
      if (s.targetType === 'site' && !includeSite) continue;
      if (s.targetType === 'app' && !includeApp) continue;
      if (s.targetType === 'app' && appKeyFilter && !appKeyFilter.has(s.targetKey)) continue;
      if (s.targetType === 'site' && siteKeyFilter && !siteKeyMatchesFilter(s.targetKey, siteKeyFilter)) continue;
      if (!s.date) continue;
      const row = ensureRow(s.date, s.targetType, s.targetKey);
      const cost = Number(s.cost) || 0;
      if (row.spendByAccount[s.adsAccountId] != null) {
        row.spendByAccount[s.adsAccountId] = round2(row.spendByAccount[s.adsAccountId] + cost);
      }
      row.adsSpend = round2(row.adsSpend + cost);
      row.impressions += Number(s.impressions) || 0;
      row.clicks += Number(s.clicks) || 0;
      row.conversions += Number(s.conversions) || 0;
    }

    for (const e of expenses) {
      listedExpenses.push(e);
      if (e.targetType === 'general') {
        generalOther = round2(generalOther + e.amount);
        generalExpenses.push(e);
        continue;
      }
      if (e.targetType === 'site' && !includeSite) continue;
      if (e.targetType === 'app' && !includeApp) continue;
      if (!isMappedTarget(e.targetType, e.targetKey)) continue;
      const day = ymd(e.expenseDate);
      if (!day) continue;
      const row = ensureRow(day, e.targetType, e.targetKey);
      row.otherExpenses = round2(row.otherExpenses + e.amount);
    }

    rows = await Promise.all([...rowMap.values()].map(async (r) => {
        const m = await metricsFor(r.earn, r.adsSpend, r.otherExpenses, {
          impressions: r.impressions,
          clicks: r.clicks,
          conversions: r.conversions,
        }, { endDate: end });
        return {
          date: r.date,
          targetType: r.targetType,
          targetKey: r.targetKey,
          spendByAccount: Object.fromEntries(
            Object.entries(r.spendByAccount).map(([k, v]) => [k, round2(v)])
          ),
          ...m,
        };
      }));
    rows = rows
      .filter((r) => r.targetType !== 'unmapped')
      .filter((r) => r.adsSpend > 0 || r.otherExpenses > 0 || r.earn > 0)
      .sort((a, b) => {
        if (a.date !== b.date) return b.date.localeCompare(a.date);
        return (b.adsSpend + b.earn) - (a.adsSpend + a.earn);
      });

    mappedSpend = round2(rows.reduce((s, r) => s + r.adsSpend, 0));
    otherExpenses = round2(rows.reduce((s, r) => s + r.otherExpenses, 0) + generalOther);
    const engagementSource = countryFilter?.length ? (countrySpendRows || []) : rows;
    adsImpressions = engagementSource.reduce((s, r) => s + (Number(r.impressions) || 0), 0);
    adsClicks = engagementSource.reduce((s, r) => s + (Number(r.clicks) || 0), 0);
    adsConversions = engagementSource.reduce((s, r) => s + (Number(r.conversions) || 0), 0);
  } else {
    for (const e of expenses) {
      listedExpenses.push(e);
      if (e.targetType === 'general') {
        generalOther = round2(generalOther + e.amount);
        generalExpenses.push(e);
        continue;
      }
      if (e.targetType === 'site' && !includeSite) continue;
      if (e.targetType === 'app' && !includeApp) continue;
      if (!isMappedTarget(e.targetType, e.targetKey)) continue;
      otherExpenses = round2(otherExpenses + (Number(e.amount) || 0));
    }
    otherExpenses = round2(otherExpenses + generalOther);

    mappedSpend = round2(spendRows.reduce((s, r) => {
      if (r.targetType === 'site' && !includeSite) return s;
      if (r.targetType === 'app' && !includeApp) return s;
      if (r.targetType === 'app' && appKeyFilter && !appKeyFilter.has(r.targetKey)) return s;
      if (r.targetType === 'site' && siteKeyFilter && !siteKeyMatchesFilter(r.targetKey, siteKeyFilter)) return s;
      return s + (Number(r.cost) || 0);
    }, 0));

    const engagementSource = countryFilter?.length ? (countrySpendRows || []) : spendRows;
    adsImpressions = engagementSource.reduce((s, r) => s + (Number(r.impressions) || 0), 0);
    adsClicks = engagementSource.reduce((s, r) => s + (Number(r.clicks) || 0), 0);
    adsConversions = engagementSource.reduce((s, r) => s + (Number(r.conversions) || 0), 0);
  }

  const countrySpendTotal = round2((countrySpendRows || []).reduce((s, r) => s + (r.adsSpend || 0), 0));
  const unmapped = round2(unmappedTotal);
  const adsTotalsResolved = breakdownOnly
    ? { adsSpend: 0, impressions: 0, clicks: 0, conversions: 0 }
    : await resolveAdsSpendTotals(clientId, start, end, spendOpts, appKeyFilter);
  const adsSpend = countryFilter?.length
    ? countrySpendTotal
    : round2(adsTotalsResolved.adsSpend || 0);
  if (!countryFilter?.length && !breakdownOnly) {
    adsImpressions = Number(adsTotalsResolved.impressions) || 0;
    adsClicks = Number(adsTotalsResolved.clicks) || 0;
    adsConversions = Number(adsTotalsResolved.conversions) || 0;
  }

  const mappedAccountIds = new Set(spendRows.map((s) => s.adsAccountId).filter(Boolean));
  const mappedSpendAccounts = spendAccounts.filter((a) => mappedAccountIds.has(a.id));
  const accountById = new Map();
  [...mappedSpendAccounts, ...spendAccounts, ...roiFlagged].forEach((a) => {
    if (!accountById.has(a.id)) accountById.set(a.id, a);
  });
  const columnSource = mappedSpendAccounts.length
    ? mappedSpendAccounts
    : (spendAccounts.length ? spendAccounts : roiFlagged);
  const columnAccounts = columnSource.slice(0, MAX_ACCOUNT_COLUMNS);
  const showAccountColumns = columnAccounts.length > 0 && columnAccounts.length <= MAX_ACCOUNT_COLUMNS;

  let summaryMetrics = {};
  if (!breakdownOnly) {
    const useAdsLinkedEarn = effectiveTargetType === 'all'
      && !appKeyFilter?.size
      && !siteKeyFilter?.size
      && !countryFilter;
    let earn;
    if (useAdsLinkedEarn) {
      // Overview cards: GAM earn only for Ads-connected app/site IDs (not full network).
      earn = await loadAdsLinkedGamEarn(clientId, start, end, spendOpts);
    } else if (effectiveTargetType === 'all') {
      // When maps/filters exist, align earn with mapped inventory.
      if (mappedKeys.size) {
        earn = round2(
          sumEarnList(earnMaps.sites.filter((r) => isMappedTarget('site', r.targetKey)))
          + sumEarnList(earnMaps.apps.filter((r) => isMappedTarget('app', r.targetKey)))
        );
      } else if (countryFilter?.length && countryNames?.length) {
        earn = round2(
          countryNames.reduce((s, name) => {
            const key = String(name).trim().toLowerCase();
            return s + (earnByCountry.get(key)?.earn || 0);
          }, 0)
        );
      } else {
        earn = canonicalEarn;
      }
    } else if (effectiveTargetType === 'site') {
      earn = sumEarnList(earnMaps.sites.filter((r) => isMappedTarget('site', r.targetKey)));
    } else {
      earn = sumEarnList(earnMaps.apps.filter((r) => isMappedTarget('app', r.targetKey)));
    }

    summaryMetrics = await metricsFor(earn, adsSpend, otherExpenses, {
      impressions: adsImpressions,
      clicks: adsClicks,
      conversions: adsConversions,
    }, { endDate: end });
  }

  const lookupCountryEarn = summaryOnly && !breakdownOnly ? null : buildScopedCountryEarnLookup({
    earnByCountry,
    earnByTargetCountry,
    appKeyFilter,
    siteKeyFilter,
    effectiveTargetType,
    mappedKeys,
    countryTargetRows,
    accountFilter,
    campaignFilter,
  });

  let countryBreakdown = [];
  let countryTargetBreakdown = [];
  let countryTargetDailyBreakdown = [];

  if (!summaryOnly || breakdownOnly) {
    countryBreakdown = await Promise.all((countrySpendRows || []).map(async (row) => {
      const countryEarn = lookupCountryEarn(row.countryName);
      const spendMetrics = await metricsFor(countryEarn, row.adsSpend, 0, {
        impressions: row.impressions,
        clicks: row.clicks,
        conversions: row.conversions,
      }, { endDate: end });
      return {
        countryCode: row.countryCode,
        countryName: row.countryName,
        adsSpend: round2(row.adsSpend),
        earn: spendMetrics.earn,
        profitSpend: spendMetrics.profitSpend,
        roiSpendPercent: spendMetrics.roiSpendPercent,
        impressions: spendMetrics.impressions,
        clicks: spendMetrics.clicks,
        conversions: spendMetrics.conversions,
        ctr: spendMetrics.ctr,
        ecpm: spendMetrics.ecpm,
      };
    }));

  // When countries are selected, always list each one (even $0 spend) in the summary table.
  if (countryFilter?.length) {
    const byCode = new Map(countryBreakdown.map((r) => [r.countryCode, r]));
    const { rows: nameRows } = await query(
      `SELECT UPPER(TRIM(country_code)) AS country_code,
              MAX(country_name) AS country_name
       FROM ads_spend_country_daily
       WHERE client_id = $1
         AND UPPER(TRIM(country_code)) = ANY($2::text[])
       GROUP BY 1`,
      [clientId, countryFilter]
    );
    const nameByCode = new Map(
      (nameRows || []).map((r) => [String(r.country_code).toUpperCase(), String(r.country_name || '').trim()])
    );
    countryBreakdown = await Promise.all(countryFilter.map(async (code) => {
      const existing = byCode.get(code);
      if (existing) return existing;
      const countryName = nameByCode.get(code) || code;
      const countryEarn = lookupCountryEarn(countryName);
      const spendMetrics = await metricsFor(countryEarn, 0, 0, {}, { endDate: end });
      return {
        countryCode: code,
        countryName,
        adsSpend: 0,
        earn: spendMetrics.earn,
        profitSpend: spendMetrics.profitSpend,
        roiSpendPercent: spendMetrics.roiSpendPercent,
        impressions: 0,
        clicks: 0,
        conversions: 0,
        ctr: null,
        ecpm: null,
      };
    })).then((list) => list.sort((a, b) => b.adsSpend - a.adsSpend || a.countryName.localeCompare(b.countryName)));
  }

    const inlineSpendByTarget = sumAdsSpendByTarget(countryTargetRows);
    const { byTarget: inlineExpenseByTarget, byTargetDate: inlineExpenseByTargetDate } = buildSiteAppExpenseMaps(expenses, {
      includeSite: effectiveTargetType !== 'app' || Boolean(siteKeyFilter?.size),
      includeApp: effectiveTargetType !== 'site' || Boolean(appKeyFilter?.size)
        || countryTargetRows.some((r) => r.targetType === 'app'),
      allowTarget: (t, k) => !mappedKeys.size || mappedKeys.has(targetExpenseKey(t, k)),
    });
    const inlineSpendByTargetDate = sumAdsSpendByTargetDate(countryTargetDailyRows || []);

    const inlineAppEarnWinners = claimAppPackageEarnWinners(countryTargetRows);
    countryTargetBreakdown = await Promise.all(countryTargetRows.map(async (row) => {
      const countryKey = String(row.gamCountryKey || row.countryName || '').trim().toLowerCase();
      const earnKey = `${row.targetType}:${row.targetKey}:${countryKey}`;
      const isSite = row.targetType === 'site';
      let targetEarn = 0;
      if (isSite) {
        targetEarn = sumSiteEarnFromMap(earnByTargetCountry, row.targetKey, {
          countryName: row.gamCountryKey || row.countryName,
          countryCode: row.countryCode,
        });
        if (!(targetEarn > 0)) {
          targetEarn = earnByTargetCountry.get(`site:${normSiteHost(row.targetKey)}:${countryKey}`)
            || earnByTargetCountry.get(earnKey)
            || 0;
        }
      } else {
        targetEarn = earnByTargetCountry.get(earnKey) || 0;
        if (targetEarn > 0 && !inlineAppEarnWinners.has(appPackageWinnerKey(row))) {
          targetEarn = 0;
        }
      }
      const rowSpend = isSite ? 0 : (Number(row.adsSpend) || 0);
      const tk = targetExpenseKey(row.targetType, row.targetKey);
      const otherExpenses = allocateTargetExpense(
        inlineExpenseByTarget.get(tk) || 0,
        rowSpend,
        inlineSpendByTarget.get(tk) || 0
      );
      const spendMetrics = await metricsFor(targetEarn, rowSpend, otherExpenses, {
        impressions: Number(row.impressions) || 0,
        clicks: Number(row.clicks) || 0,
        conversions: Number(row.conversions) || 0,
      }, { endDate: end });
      if (isSite && !(rowSpend > 0) && spendMetrics.impressions > 0 && spendMetrics.earn > 0) {
        spendMetrics.ecpm = round2((spendMetrics.earn / spendMetrics.impressions) * 1000);
      }
      const account = accountById.get(row.adsAccountId);
      return {
        adsAccountId: row.adsAccountId,
        accountName: row.accountName || account?.descriptiveName || account?.customerId || row.adsAccountId,
        targetType: row.targetType,
        targetKey: row.targetKey,
        countryCode: row.countryCode,
        countryName: row.countryName,
        adsSpend: round2(rowSpend),
        earn: spendMetrics.earn,
        otherExpenses: spendMetrics.otherExpenses,
        profitSpend: spendMetrics.profitSpend,
        profitExpense: spendMetrics.profitExpense,
        roiSpendPercent: isSite ? null : spendMetrics.roiSpendPercent,
        roiExpensePercent: spendMetrics.roiExpensePercent,
        impressions: spendMetrics.impressions,
        clicks: spendMetrics.clicks,
        conversions: spendMetrics.conversions,
        ctr: spendMetrics.ctr,
        ecpm: spendMetrics.ecpm,
        earnOnly: isSite,
      };
    }));

    const inlineDailyWinners = claimAppPackageEarnWinners(countryTargetDailyRows || [], { includeDate: true });
    countryTargetDailyBreakdown = await Promise.all((countryTargetDailyRows || [])
      .filter((row) => (Number(row.adsSpend) || 0) > 0)
      .map(async (row) => {
        const countryKey = String(row.countryName || '').trim().toLowerCase();
        const earnKey = `${row.date}:${row.targetType}:${row.targetKey}:${countryKey}`;
        let targetEarn = earnByTargetCountryDaily.get(earnKey) || 0;
        if (
          row.targetType === 'app'
          && targetEarn > 0
          && !inlineDailyWinners.has(appPackageWinnerKey(row, { includeDate: true }))
        ) {
          targetEarn = 0;
        }
        const tk = targetExpenseKey(row.targetType, row.targetKey);
        const dayKey = `${ymd(row.date)}:${tk}`;
        const otherExpenses = allocateTargetExpense(
          inlineExpenseByTargetDate.get(dayKey) || 0,
          row.adsSpend,
          inlineSpendByTargetDate.get(dayKey) || 0
        );
        const spendMetrics = await metricsFor(targetEarn, row.adsSpend, otherExpenses, {
          impressions: row.impressions,
          clicks: row.clicks,
          conversions: row.conversions,
        }, { endDate: end });
        const account = accountById.get(row.adsAccountId);
        return {
          date: row.date,
          adsAccountId: row.adsAccountId,
          accountName: row.accountName || account?.descriptiveName || account?.customerId || row.adsAccountId,
          targetType: row.targetType,
          targetKey: row.targetKey,
          countryCode: row.countryCode,
          countryName: row.countryName,
          adsSpend: round2(row.adsSpend),
          earn: spendMetrics.earn,
          otherExpenses: spendMetrics.otherExpenses,
          profitSpend: spendMetrics.profitSpend,
          profitExpense: spendMetrics.profitExpense,
          roiSpendPercent: spendMetrics.roiSpendPercent,
          roiExpensePercent: spendMetrics.roiExpensePercent,
          impressions: spendMetrics.impressions,
          clicks: spendMetrics.clicks,
          conversions: spendMetrics.conversions,
          ctr: spendMetrics.ctr,
          ecpm: spendMetrics.ecpm,
        };
      }));
  }

  const accountsOut = (showAccountColumns ? columnAccounts : []).map((a) => ({
    id: a.id,
    name: a.descriptiveName || a.customerId,
    customerId: a.customerId,
    mccLabel: null,
    parentMccId: a.parentMccId,
  }));

  const spendCurrency = adsSpendDisplayCurrency();
  const result = {
    accounts: accountsOut,
    summary: {
      ...summaryMetrics,
      mappedSpend,
      unmappedSpend: unmapped,
      mappedCampaigns: maps.length,
      accountsWithSpend: accountById.size,
      adsSpendCurrency: spendCurrency,
    },
    rows,
    countryBreakdown,
    countryTargetBreakdown,
    countryTargetDailyBreakdown,
    generalExpenses,
    expenses: listedExpenses,
    spendCurrency,
  };
  cache.set(cacheKey, result, ROI_SUMMARY_CACHE_TTL);
  return result;
}

/**
 * Drop cached ROI summaries for a client after expense create/delete
 * so overview cards reload from DB instead of stale NodeCache.
 */
function invalidateRoiSummaryCache(clientId) {
  if (!clientId || !cache?.keys) return 0;
  const id = String(clientId);
  const keys = cache.keys().filter((k) => {
    const s = String(k);
    return s.startsWith(`roi_sum_v17_${id}`) || s.startsWith(`roi_bd_v17_${id}`)
      || s.startsWith(`roi_sum_v16_${id}`) || s.startsWith(`roi_bd_v16_${id}`)
      || s.startsWith(`roi_sum_v14_${id}`) || s.startsWith(`roi_bd_v14_${id}`)
      || s.startsWith(`roi_sum_v13_${id}`) || s.startsWith(`roi_bd_v13_${id}`)
      || s.startsWith(`roi_sum_v12_${id}`) || s.startsWith(`roi_bd_v12_${id}`)
      || s.startsWith(`roi_sum_v11_${id}`) || s.startsWith(`roi_bd_v11_${id}`)
      || s.startsWith(`roi_sum_v10_${id}`) || s.startsWith(`roi_bd_v10_${id}`)
      || s.startsWith(`roi_sum_v9_${id}`) || s.startsWith(`roi_bd_v9_${id}`);
  });
  if (keys.length) cache.del(keys);
  return keys.length;
}

module.exports = {
  getRoiSummary,
  roiPercent,
  metricsFor,
  adsEngagementMetrics,
  loadCanonicalGamEarn,
  invalidateRoiSummaryCache,
};
