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
async function loadGamEarnByTargetDaily(clientId, start, end) {
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
     GROUP BY 1, 2`,
    [clientId, start, end]
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
     GROUP BY 1, 2`,
    [clientId, start, end]
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

async function loadMappedSpendDaily(clientId, start, end) {
  const { rows } = await query(
    `SELECT s.report_date::text AS report_date,
            m.target_type,
            LOWER(TRIM(m.target_key)) AS target_key,
            s.ads_account_id,
            COALESCE(SUM(s.cost), 0)::float8 AS cost
     FROM ads_spend_daily s
     JOIN ads_campaign_map m
       ON m.client_id = s.client_id
      AND m.ads_account_id = s.ads_account_id
      AND m.campaign_id = s.campaign_id
     WHERE s.client_id = $1
       AND s.report_date BETWEEN $2 AND $3
     GROUP BY 1, m.target_type, LOWER(TRIM(m.target_key)), s.ads_account_id`,
    [clientId, start, end]
  );
  return rows.map((r) => ({
    date: ymd(r.report_date),
    targetType: r.target_type,
    targetKey: r.target_key,
    adsAccountId: r.ads_account_id,
    cost: Number(r.cost) || 0,
  }));
}

async function loadUnmappedSpend(clientId, start, end) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(s.cost), 0)::float8 AS cost
     FROM ads_spend_daily s
     LEFT JOIN ads_campaign_map m
       ON m.client_id = s.client_id
      AND m.ads_account_id = s.ads_account_id
      AND m.campaign_id = s.campaign_id
     WHERE s.client_id = $1
       AND s.report_date BETWEEN $2 AND $3
       AND m.id IS NULL`,
    [clientId, start, end]
  );
  return Number(rows[0]?.cost) || 0;
}

function sumEarnList(list) {
  return round2(list.reduce((s, r) => s + (Number(r.earn) || 0), 0));
}

/**
 * Build ROI summary with separate ROI% for Ads spend and for other expenses.
 * Table rows are daily (date × site/app).
 */
async function getRoiSummary(clientId, { start, end, targetType = 'all' } = {}) {
  const accounts = await listRoiClientAccounts(clientId);
  const accountIds = accounts.map((a) => a.id);

  const [earnMaps, spendRows, expenses, unmappedSpend, maps, canonicalEarn] = await Promise.all([
    loadGamEarnByTargetDaily(clientId, start, end),
    loadMappedSpendDaily(clientId, start, end),
    listOtherExpenses(clientId, { start, end }),
    loadUnmappedSpend(clientId, start, end),
    listCampaignMaps(clientId),
    targetType === 'all' ? loadCanonicalGamEarn(clientId, start, end) : Promise.resolve(0),
  ]);

  const rowMap = new Map();

  function ensureRow(date, type, key) {
    const day = ymd(date);
    const k = `${day}:${type}:${key}`;
    if (!rowMap.has(k)) {
      rowMap.set(k, {
        date: day,
        targetType: type,
        targetKey: key,
        spendByAccount: Object.fromEntries(accountIds.map((id) => [id, 0])),
        adsSpend: 0,
        otherExpenses: 0,
        earn: 0,
      });
    }
    return rowMap.get(k);
  }

  const includeSite = targetType === 'all' || targetType === 'site';
  const includeApp = targetType === 'all' || targetType === 'app';

  if (includeSite) {
    earnMaps.sites.forEach((row) => {
      if (!row.date) return;
      ensureRow(row.date, 'site', row.targetKey).earn = round2(row.earn);
    });
  }
  if (includeApp) {
    earnMaps.apps.forEach((row) => {
      if (!row.date) return;
      ensureRow(row.date, 'app', row.targetKey).earn = round2(row.earn);
    });
  }

  for (const s of spendRows) {
    if (s.targetType === 'site' && !includeSite) continue;
    if (s.targetType === 'app' && !includeApp) continue;
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
  for (const e of expenses) {
    if (e.targetType === 'general') {
      generalOther = round2(generalOther + e.amount);
      generalExpenses.push(e);
      continue;
    }
    if (e.targetType === 'site' && !includeSite) continue;
    if (e.targetType === 'app' && !includeApp) continue;
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
    .filter((r) => r.adsSpend > 0 || r.otherExpenses > 0 || r.earn > 0)
    .sort((a, b) => {
      if (a.date !== b.date) return b.date.localeCompare(a.date);
      return (b.adsSpend + b.earn) - (a.adsSpend + a.earn);
    });

  const adsSpend = round2(rows.reduce((s, r) => s + r.adsSpend, 0));
  const otherExpenses = round2(rows.reduce((s, r) => s + r.otherExpenses, 0) + generalOther);

  let earn;
  if (targetType === 'all') {
    earn = canonicalEarn;
  } else if (targetType === 'site') {
    earn = sumEarnList(earnMaps.sites);
  } else {
    earn = sumEarnList(earnMaps.apps);
  }

  const summaryMetrics = metricsFor(earn, adsSpend, otherExpenses);

  const accountsOut = accounts.map((a) => ({
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
      unmappedSpend: round2(unmappedSpend),
      mappedCampaigns: maps.length,
    },
    rows,
    generalExpenses,
  };
}

module.exports = { getRoiSummary, roiPercent, metricsFor, loadCanonicalGamEarn };
