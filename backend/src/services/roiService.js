const { query } = require('../db');
const {
  listRoiClientAccounts,
  listOtherExpenses,
  listCampaignMaps,
} = require('../models/adsAccountStore');
const { coerceWarehouseRevenue } = require('../utils/gamReportMetrics');
const { kpiSliceFilterSql } = require('./reportGrainStore');

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
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

function metricsFor(earn, adsSpend, otherExpenses) {
  const e = Number(earn) || 0;
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
  };
}

/**
 * Network-wide GAM earn — same source as Dashboard Overview cards
 * (rollup_kpi_daily from the canonical KPI / channel slice).
 * Do NOT sum inventory_core + app_id (those overlap and ~2× Overview).
 */
async function loadCanonicalGamEarn(clientId, start, end) {
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
            COALESCE(SUM(s.cost), 0)::float8 AS ads_spend
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
            COALESCE(SUM(x.cost), 0)::float8 AS ads_spend
     FROM (
       SELECT s.ads_account_id,
              'app'::text AS target_type,
              LOWER(TRIM(s.app_id)) AS target_key,
              UPPER(TRIM(s.country_code)) AS country_code,
              s.country_name,
              s.cost
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
              s.cost
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
            COALESCE(SUM(x.cost), 0)::float8 AS ads_spend
     FROM (
       SELECT s.report_date::text AS report_date,
              s.ads_account_id,
              'app'::text AS target_type,
              LOWER(TRIM(s.app_id)) AS target_key,
              UPPER(TRIM(s.country_code)) AS country_code,
              s.country_name,
              s.cost
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
              s.cost
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
  }));
}

/** GAM earn by date × site/app target × country name. */
async function loadGamEarnByTargetCountryDaily(clientId, start, end) {
  const siteRes = await query(
    `SELECT g.report_date::text AS report_date,
            'site'::text AS target_type,
            LOWER(TRIM(ds.name)) AS target_key,
            LOWER(TRIM(dc.name)) AS country_key,
            COALESCE(SUM(g.revenue), 0)::float8 AS earn
     FROM report_grain g
     JOIN dim_site ds ON ds.id = g.site_id AND ds.client_id = g.client_id
     JOIN dim_country dc ON dc.id = g.country_id AND dc.id <> 0
     WHERE g.client_id = $1
       AND g.report_date BETWEEN $2 AND $3
       AND g.slice_key = 'inventory_core'
       AND g.site_id > 0
       AND NULLIF(TRIM(ds.name), '') IS NOT NULL
     GROUP BY 1, 2, 3, 4`,
    [clientId, start, end]
  );
  const appRes = await query(
    `SELECT g.report_date::text AS report_date,
            'app'::text AS target_type,
            LOWER(TRIM(COALESCE(NULLIF(g.app_id, ''), g.app_name))) AS target_key,
            LOWER(TRIM(dc.name)) AS country_key,
            COALESCE(SUM(g.revenue), 0)::float8 AS earn
     FROM report_grain g
     JOIN dim_country dc ON dc.id = g.country_id AND dc.id <> 0
     WHERE g.client_id = $1
       AND g.report_date BETWEEN $2 AND $3
       AND g.slice_key = 'app_id'
       AND NULLIF(TRIM(COALESCE(NULLIF(g.app_id, ''), g.app_name)), '') IS NOT NULL
     GROUP BY 1, 2, 3, 4`,
    [clientId, start, end]
  );
  const map = new Map();
  [...siteRes.rows, ...appRes.rows].forEach((r) => {
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
            COALESCE(SUM(s.cost), 0)::float8 AS ads_spend
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

/** GAM earn grouped by site/app target and country name. */
async function loadGamEarnByTargetCountry(clientId, start, end) {
  const siteRes = await query(
    `SELECT 'site'::text AS target_type,
            LOWER(TRIM(ds.name)) AS target_key,
            LOWER(TRIM(dc.name)) AS country_key,
            COALESCE(SUM(g.revenue), 0)::float8 AS earn
     FROM report_grain g
     JOIN dim_site ds ON ds.id = g.site_id AND ds.client_id = g.client_id
     JOIN dim_country dc ON dc.id = g.country_id AND dc.id <> 0
     WHERE g.client_id = $1
       AND g.report_date BETWEEN $2 AND $3
       AND g.slice_key = 'inventory_core'
       AND g.site_id > 0
       AND NULLIF(TRIM(ds.name), '') IS NOT NULL
     GROUP BY 1, 2, 3`,
    [clientId, start, end]
  );
  const appRes = await query(
    `SELECT 'app'::text AS target_type,
            LOWER(TRIM(COALESCE(NULLIF(g.app_id, ''), g.app_name))) AS target_key,
            LOWER(TRIM(dc.name)) AS country_key,
            COALESCE(SUM(g.revenue), 0)::float8 AS earn
     FROM report_grain g
     JOIN dim_country dc ON dc.id = g.country_id AND dc.id <> 0
     WHERE g.client_id = $1
       AND g.report_date BETWEEN $2 AND $3
       AND g.slice_key = 'app_id'
       AND NULLIF(TRIM(COALESCE(NULLIF(g.app_id, ''), g.app_name)), '') IS NOT NULL
     GROUP BY 1, 2, 3`,
    [clientId, start, end]
  );
  const map = new Map();
  [...siteRes.rows, ...appRes.rows].forEach((r) => {
    const type = r.target_type;
    const tKey = String(r.target_key || '').trim().toLowerCase();
    const cKey = String(r.country_key || '').trim().toLowerCase();
    if (!type || !tKey || !cKey) return;
    const k = `${type}:${tKey}:${cKey}`;
    map.set(k, round2((map.get(k) || 0) + (Number(r.earn) || 0)));
  });
  return map;
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
  const useNetworkCountryEarn = !hasInventoryFilter && !mappedKeys?.size && !hasAdsScope;

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

    if (effectiveTargetType === 'app' && targetType !== 'app') continue;
    if (effectiveTargetType === 'site' && targetType !== 'site') continue;
    if (appKeyFilter?.size && targetType === 'app' && !appKeyFilter.has(targetKey)) continue;
    if (siteKeyFilter?.size && targetType === 'site' && !siteKeyFilter.has(targetKey)) continue;
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
    if (r.targetType === 'site' && effectiveTargetType === 'app') return false;
    if (r.targetType === 'app' && effectiveTargetType === 'site') return false;
    if (r.targetType === 'app' && appKeyFilter && !appKeyFilter.has(r.targetKey)) return false;
    if (r.targetType === 'site' && siteKeyFilter && !siteKeyFilter.has(r.targetKey)) return false;
    return (Number(r.adsSpend) || 0) > 0;
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
            SUM(cost)::float8 AS cost
     FROM (
       SELECT s.report_date::text AS report_date,
              'app'::text AS target_type,
              LOWER(TRIM(s.app_id)) AS target_key,
              s.ads_account_id,
              s.cost
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
              s.cost
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
            COALESCE(SUM(s.cost), 0)::float8 AS cost
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
    `SELECT COALESCE(SUM(s.cost), 0)::float8 AS cost
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

/** Client Ads accounts that have spend in range (for ROI columns / labels). */
async function listAccountsWithSpend(clientId, start, end, { accountIds = null } = {}) {
  const params = [clientId, start, end];
  let extra = '';
  if (accountIds?.length) {
    params.push(accountIds);
    extra += ` AND a.id = ANY($${params.length}::uuid[])`;
  }
  const { rows } = await query(
    `SELECT a.*, COALESCE(SUM(s.cost), 0)::float8 AS spend_cost
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
     HAVING COALESCE(SUM(s.cost), 0) > 0
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
} = {}) {
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
    ? new Set(siteKeys.map((k) => String(k).trim().toLowerCase()).filter(Boolean))
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

  // Derive scope from inventory multi-selects when provided.
  let effectiveTargetType = targetType;
  if (appKeyFilter || siteKeyFilter) {
    if (appKeyFilter && siteKeyFilter) effectiveTargetType = 'all';
    else if (appKeyFilter) effectiveTargetType = 'app';
    else effectiveTargetType = 'site';
  }

  const singleAppKey = appKeyFilter && appKeyFilter.size === 1 ? [...appKeyFilter][0] : null;
  const singleSiteKey = siteKeyFilter && siteKeyFilter.size === 1 ? [...siteKeyFilter][0] : null;
  const filterAttrTarget = singleAppKey && !siteKeyFilter
    ? { targetType: 'app', targetKey: singleAppKey }
    : (singleSiteKey && !appKeyFilter
      ? { targetType: 'site', targetKey: singleSiteKey }
      : null);

  let [earnMaps, spendRows, expenses, unmappedTotal, maps, canonicalEarn, spendAccounts, roiFlagged, countrySpendRows, earnByCountry, countryTargetRows, earnByTargetCountry, countryTargetDailyRows, earnByTargetCountryDaily] =
    await Promise.all([
      loadGamEarnByTargetDaily(clientId, start, end, earnCountryOpts),
      loadMappedSpendDaily(clientId, start, end, spendOpts),
      listOtherExpenses(clientId, { start, end }),
      loadUnmappedSpend(clientId, start, end, spendOpts),
      listCampaignMaps(clientId),
      effectiveTargetType === 'all' && !appKeyFilter && !siteKeyFilter && !countryFilter
        ? loadCanonicalGamEarn(clientId, start, end)
        : Promise.resolve(0),
      listAccountsWithSpend(clientId, start, end, { accountIds: accountFilter }),
      listRoiClientAccounts(clientId),
      loadCountrySpendBreakdown(clientId, start, end, spendOpts),
      loadGamEarnByCountry(clientId, start, end),
      loadCountrySpendByTarget(clientId, start, end, spendOpts),
      loadGamEarnByTargetCountry(clientId, start, end),
      loadCountrySpendByTargetDaily(clientId, start, end, spendOpts),
      loadGamEarnByTargetCountryDaily(clientId, start, end),
    ]);

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
    if (type === 'site' && siteKeyFilter && !siteKeyFilter.has(key)) return;
    if (type && key) mappedKeys.add(`${type}:${key}`);
  });
  spendRows.forEach((s) => {
    if (!s.targetType || !s.targetKey) return;
    if (s.targetType === 'app' && appKeyFilter && !appKeyFilter.has(s.targetKey)) return;
    if (s.targetType === 'site' && siteKeyFilter && !siteKeyFilter.has(s.targetKey)) return;
    mappedKeys.add(`${s.targetType}:${s.targetKey}`);
  });
  // Explicit inventory picks with no maps yet: still allow earn-only rows for those keys.
  if (appKeyFilter) {
    appKeyFilter.forEach((k) => mappedKeys.add(`app:${k}`));
  }
  if (siteKeyFilter) {
    siteKeyFilter.forEach((k) => mappedKeys.add(`site:${k}`));
  }

  // Prefer accounts with mapped spend for columns; fall back to Include-in-ROI flags.
  const mappedAccountIds = new Set(spendRows.map((s) => s.adsAccountId).filter(Boolean));
  const mappedSpendAccounts = spendAccounts.filter((a) => mappedAccountIds.has(a.id));
  const accountById = new Map();
  [...mappedSpendAccounts, ...spendAccounts, ...roiFlagged].forEach((a) => {
    if (!accountById.has(a.id)) accountById.set(a.id, a);
  });
  const allAccounts = [...accountById.values()];
  const columnSource = mappedSpendAccounts.length
    ? mappedSpendAccounts
    : (spendAccounts.length ? spendAccounts : roiFlagged);
  const columnAccounts = columnSource.slice(0, MAX_ACCOUNT_COLUMNS);
  const columnAccountIds = columnAccounts.map((a) => a.id);
  const showAccountColumns = columnAccounts.length > 0 && columnAccounts.length <= MAX_ACCOUNT_COLUMNS;

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
      });
    }
    return rowMap.get(k);
  }

  const includeSite = effectiveTargetType === 'all' || effectiveTargetType === 'site';
  const includeApp = effectiveTargetType === 'all' || effectiveTargetType === 'app';

  function isMappedTarget(type, key) {
    if (!mappedKeys.size) return false;
    return mappedKeys.has(`${type}:${String(key || '').trim().toLowerCase()}`);
  }

  // GAM earn only for mapped site/app targets (not every inventory row).
  if (includeSite) {
    earnMaps.sites.forEach((row) => {
      if (!row.date || !isMappedTarget('site', row.targetKey)) return;
      if (siteKeyFilter && !siteKeyFilter.has(String(row.targetKey || '').trim().toLowerCase())) return;
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
    if (s.targetType === 'site' && siteKeyFilter && !siteKeyFilter.has(s.targetKey)) continue;
    if (!s.date) continue;
    const row = ensureRow(s.date, s.targetType, s.targetKey);
    const cost = Number(s.cost) || 0;
    if (row.spendByAccount[s.adsAccountId] != null) {
      row.spendByAccount[s.adsAccountId] = round2(row.spendByAccount[s.adsAccountId] + cost);
    }
    row.adsSpend = round2(row.adsSpend + cost);
  }

  let generalOther = 0;
  const generalExpenses = [];
  const listedExpenses = [];
  for (const e of expenses) {
    listedExpenses.push(e);
    if (e.targetType === 'general') {
      generalOther = round2(generalOther + e.amount);
      generalExpenses.push(e);
      continue;
    }
    if (e.targetType === 'site' && !includeSite) continue;
    if (e.targetType === 'app' && !includeApp) continue;
    // Other expenses only on mapped targets (same rule as Ads campaign maps).
    if (!isMappedTarget(e.targetType, e.targetKey)) continue;
    const day = ymd(e.expenseDate);
    if (!day) continue;
    const row = ensureRow(day, e.targetType, e.targetKey);
    row.otherExpenses = round2(row.otherExpenses + e.amount);
  }

  const rows = [...rowMap.values()]
    .map((r) => {
      const m = metricsFor(r.earn, r.adsSpend, r.otherExpenses);
      return {
        date: r.date,
        targetType: r.targetType,
        targetKey: r.targetKey,
        spendByAccount: Object.fromEntries(
          Object.entries(r.spendByAccount).map(([k, v]) => [k, round2(v)])
        ),
        ...m,
      };
    })
    .filter((r) => r.targetType !== 'unmapped')
    .filter((r) => r.adsSpend > 0 || r.otherExpenses > 0 || r.earn > 0)
    .sort((a, b) => {
      if (a.date !== b.date) return b.date.localeCompare(a.date);
      return (b.adsSpend + b.earn) - (a.adsSpend + a.earn);
    });

  const mappedSpend = round2(rows.reduce((s, r) => s + r.adsSpend, 0));
  const countrySpendTotal = round2((countrySpendRows || []).reduce((s, r) => s + (r.adsSpend || 0), 0));
  const unmapped = round2(unmappedTotal);
  // Cards / ROI% use mapped Ads spend only (unmapped is excluded from the table).
  const adsSpend = countryFilter?.length ? countrySpendTotal : mappedSpend;
  const otherExpenses = round2(rows.reduce((s, r) => s + r.otherExpenses, 0) + generalOther);

  let earn;
  if (effectiveTargetType === 'all') {
    // When maps exist, align earn with mapped inventory; otherwise keep network Overview.
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

  const summaryMetrics = metricsFor(earn, adsSpend, otherExpenses);

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

  let countryBreakdown = (countrySpendRows || []).map((row) => {
    const countryEarn = lookupCountryEarn(row.countryName);
    const spendMetrics = metricsFor(countryEarn, row.adsSpend, 0);
    return {
      countryCode: row.countryCode,
      countryName: row.countryName,
      adsSpend: round2(row.adsSpend),
      earn: round2(countryEarn),
      profitSpend: spendMetrics.profitSpend,
      roiSpendPercent: spendMetrics.roiSpendPercent,
    };
  });

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
    countryBreakdown = countryFilter.map((code) => {
      const existing = byCode.get(code);
      if (existing) return existing;
      const countryName = nameByCode.get(code) || code;
      const countryEarn = lookupCountryEarn(countryName);
      const spendMetrics = metricsFor(countryEarn, 0, 0);
      return {
        countryCode: code,
        countryName,
        adsSpend: 0,
        earn: round2(countryEarn),
        profitSpend: spendMetrics.profitSpend,
        roiSpendPercent: spendMetrics.roiSpendPercent,
      };
    }).sort((a, b) => b.adsSpend - a.adsSpend || a.countryName.localeCompare(b.countryName));
  }

  const countryTargetBreakdown = countryTargetRows.map((row) => {
    const countryKey = String(row.countryName || '').trim().toLowerCase();
    const earnKey = `${row.targetType}:${row.targetKey}:${countryKey}`;
    const targetEarn = earnByTargetCountry.get(earnKey) || 0;
    const spendMetrics = metricsFor(targetEarn, row.adsSpend, 0);
    const account = accountById.get(row.adsAccountId);
    return {
      adsAccountId: row.adsAccountId,
      accountName: row.accountName || account?.descriptiveName || account?.customerId || row.adsAccountId,
      targetType: row.targetType,
      targetKey: row.targetKey,
      countryCode: row.countryCode,
      countryName: row.countryName,
      adsSpend: round2(row.adsSpend),
      earn: round2(targetEarn),
      profitSpend: spendMetrics.profitSpend,
      roiSpendPercent: spendMetrics.roiSpendPercent,
    };
  });

  const countryTargetDailyBreakdown = (countryTargetDailyRows || [])
    .filter((row) => (Number(row.adsSpend) || 0) > 0)
    .map((row) => {
      const countryKey = String(row.countryName || '').trim().toLowerCase();
      const earnKey = `${row.date}:${row.targetType}:${row.targetKey}:${countryKey}`;
      const targetEarn = earnByTargetCountryDaily.get(earnKey) || 0;
      const spendMetrics = metricsFor(targetEarn, row.adsSpend, 0);
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
        earn: round2(targetEarn),
        profitSpend: spendMetrics.profitSpend,
        roiSpendPercent: spendMetrics.roiSpendPercent,
      };
    });

  const accountsOut = (showAccountColumns ? columnAccounts : []).map((a) => ({
    id: a.id,
    name: a.descriptiveName || a.customerId,
    customerId: a.customerId,
    mccLabel: null,
    parentMccId: a.parentMccId,
  }));

  return {
    accounts: accountsOut,
    summary: {
      ...summaryMetrics,
      mappedSpend,
      unmappedSpend: unmapped,
      mappedCampaigns: maps.length,
      accountsWithSpend: allAccounts.length,
    },
    rows,
    countryBreakdown,
    countryTargetBreakdown,
    countryTargetDailyBreakdown,
    generalExpenses,
    expenses: listedExpenses,
  };
}

module.exports = {
  getRoiSummary,
  roiPercent,
  metricsFor,
  loadCanonicalGamEarn,
};
