/**
 * Network-wide daily totals — one row per client × date (GAM Totals only).
 * Primary source for dashboard overview KPIs across any date range.
 */
const { query } = require('../db');
const logger = require('../utils/logger');
const { requireClientId } = require('../utils/clientContext');

async function rebuildNetworkRollupsFromGrain(dates, syncType = 'network-rollup') {
  const uniq = [...new Set((dates || []).map((d) => String(d).slice(0, 10)).filter(Boolean))];
  if (!uniq.length) return 0;

  const clientId = requireClientId();
  let total = 0;

  for (const day of uniq) {
    try {
      await query(
        `DELETE FROM rollup_network_daily WHERE client_id = $2::uuid AND report_date = $1::date`,
        [day, clientId]
      );

      const res = await query(
        `INSERT INTO rollup_network_daily (
           client_id, report_date, impressions, revenue, ecpm, viewability, currency, synced_at
         )
         SELECT
           $2::uuid,
           g.report_date,
           COALESCE(SUM(g.impressions), 0)::bigint,
           COALESCE(SUM(g.revenue), 0)::float8,
           CASE WHEN COALESCE(SUM(g.impressions), 0) > 0
             THEN (COALESCE(SUM(g.revenue), 0) / COALESCE(SUM(g.impressions), 0) * 1000)::real
             ELSE NULL END,
           CASE WHEN COALESCE(SUM(g.impressions), 0) > 0
             THEN (COALESCE(SUM(g.impressions * COALESCE(g.viewable_pct, 0)), 0)
                   / COALESCE(SUM(g.impressions), 0))::real
             ELSE NULL END,
           COALESCE(MAX(g.currency), 'USD'),
           NOW()
         FROM report_grain g
         WHERE g.client_id = $2::uuid AND g.report_date = $1::date
           AND g.slice_key = 'network_kpi'
         GROUP BY g.report_date
         HAVING COALESCE(SUM(g.impressions), 0) > 0 OR COALESCE(SUM(g.revenue), 0) > 0`,
        [day, clientId]
      );
      if (res.rowCount > 0) {
        total += res.rowCount;
        continue;
      }

      // Fallback: aggregate inventory_core when network_kpi slice not yet synced.
      const fallback = await query(
        `INSERT INTO rollup_network_daily (
           client_id, report_date, impressions, revenue, ecpm, viewability, currency, synced_at
         )
         SELECT
           $2::uuid,
           g.report_date,
           COALESCE(SUM(g.impressions), 0)::bigint,
           COALESCE(SUM(g.revenue), 0)::float8,
           CASE WHEN COALESCE(SUM(g.impressions), 0) > 0
             THEN (COALESCE(SUM(g.revenue), 0) / COALESCE(SUM(g.impressions), 0) * 1000)::real
             ELSE NULL END,
           CASE WHEN COALESCE(SUM(g.impressions), 0) > 0
             THEN (COALESCE(SUM(g.impressions * COALESCE(g.viewable_pct, 0)), 0)
                   / COALESCE(SUM(g.impressions), 0))::real
             ELSE NULL END,
           COALESCE(MAX(g.currency), 'USD'),
           NOW()
         FROM report_grain g
         WHERE g.client_id = $2::uuid AND g.report_date = $1::date
           AND g.slice_key = 'inventory_core'
         GROUP BY g.report_date
         HAVING COALESCE(SUM(g.impressions), 0) > 0 OR COALESCE(SUM(g.revenue), 0) > 0`,
        [day, clientId]
      );
      total += fallback.rowCount || 0;
    } catch (e) {
      logger.warn(`[${syncType}] network rollup rebuild failed for ${day}:`, e.message);
    }
  }

  if (total > 0) {
    logger.info(`[${syncType}] Rebuilt rollup_network_daily for ${uniq.length} day(s); rows≈${total}`);
  }
  return total;
}

async function fetchNetworkTotalsFromDB(startDate, endDate) {
  const clientId = requireClientId();
  const { splitDateRange, fetchArchivedNetworkRollup } = require('./reportArchiveService');
  const split = splitDateRange(startDate, endDate);

  let dayCount = 0;
  let impressions = 0;
  let revenue = 0;
  let viewableWeight = 0;

  if (split.hotStart && split.hotEnd) {
    const { rows } = await query(
      `SELECT
         COUNT(*)::int AS day_count,
         COALESCE(SUM(impressions), 0)::float8 AS impressions,
         COALESCE(SUM(revenue), 0)::float8 AS revenue,
         COALESCE(SUM(impressions * COALESCE(viewability, 0)), 0)::float8 AS viewable_weight
       FROM rollup_network_daily
       WHERE client_id = $1::uuid
         AND report_date BETWEEN $2::date AND $3::date`,
      [clientId, split.hotStart, split.hotEnd]
    );
    const hot = rows[0] || {};
    dayCount += Number(hot.day_count) || 0;
    impressions += Number(hot.impressions) || 0;
    revenue += Number(hot.revenue) || 0;
    viewableWeight += Number(hot.viewable_weight) || 0;
  }

  if (split.coldStart && split.coldEnd) {
    const archived = await fetchArchivedNetworkRollup(clientId, split.coldStart, split.coldEnd);
    for (const row of archived) {
      const imp = Number(row.impressions) || 0;
      const rev = Number(row.revenue) || 0;
      if (imp > 0 || rev > 0) dayCount += 1;
      impressions += imp;
      revenue += rev;
      viewableWeight += imp * (Number(row.viewability) || 0);
    }
  }

  return { day_count: dayCount, impressions, revenue, viewable_weight: viewableWeight };
}

async function fetchNetworkDayRow(reportDate) {
  const clientId = requireClientId();
  const { rows } = await query(
    `SELECT report_date, impressions, revenue, ecpm, viewability, currency,
            gam_revenue, delta_pct, reconciled_at
     FROM rollup_network_daily
     WHERE client_id = $1::uuid AND report_date = $2::date`,
    [clientId, reportDate]
  );
  return rows[0] || null;
}

async function updateNetworkReconciliation(reportDate, { gamRevenue, deltaPct, impressions = 0, revenue = 0 }) {
  const clientId = requireClientId();
  const rev = Number(revenue) || Number(gamRevenue) || 0;
  const imp = Number(impressions) || 0;
  await query(
    `INSERT INTO rollup_network_daily (
       client_id, report_date, impressions, revenue, currency, gam_revenue, delta_pct, synced_at, reconciled_at
     )
     VALUES ($1::uuid, $2::date, $5, $6, 'USD', $3, $4, NOW(), NOW())
     ON CONFLICT (client_id, report_date) DO UPDATE SET
       gam_revenue = EXCLUDED.gam_revenue,
       delta_pct = EXCLUDED.delta_pct,
       reconciled_at = NOW()`,
    [clientId, reportDate, gamRevenue, deltaPct, imp, rev]
  );
}

async function listNetworkCoverageDates(startDate, endDate) {
  const clientId = requireClientId();
  const { rows } = await query(
    `WITH days AS (
       SELECT d::date AS d
       FROM generate_series($2::date, $3::date, '1 day'::interval) AS d
     )
     SELECT to_char(days.d, 'YYYY-MM-DD') AS report_date
     FROM days
     LEFT JOIN rollup_network_daily n
       ON n.client_id = $1::uuid AND n.report_date = days.d
          AND (COALESCE(n.impressions, 0) > 0 OR COALESCE(n.revenue, 0) > 0)
     WHERE n.report_date IS NULL
     ORDER BY 1`,
    [clientId, startDate, endDate]
  );
  return rows.map((r) => r.report_date);
}

async function writeReconciliationLog(reportDate, dbRevenue, gamRevenue, deltaPct, action) {
  const clientId = requireClientId();
  await query(
    `INSERT INTO reconciliation_log
       (client_id, report_date, db_revenue, gam_revenue, delta_pct, action)
     VALUES ($1::uuid, $2::date, $3, $4, $5, $6)`,
    [clientId, reportDate, dbRevenue, gamRevenue, deltaPct, action]
  );
}

async function getLastReconciliationSummary() {
  const clientId = requireClientId();
  const { rows: [last] } = await query(
    `SELECT MAX(checked_at) AS last_at FROM reconciliation_log WHERE client_id = $1::uuid`,
    [clientId]
  );
  const { rows: [stats] } = await query(
    `SELECT COUNT(*) FILTER (WHERE action = 'fix' AND checked_at > NOW() - INTERVAL '24 hours')::int AS fixes_24h,
            COUNT(*) FILTER (WHERE action = 'divergent' AND checked_at > NOW() - INTERVAL '24 hours')::int AS divergent_24h,
            MAX(ABS(delta_pct)) FILTER (WHERE checked_at > NOW() - INTERVAL '24 hours')::float8 AS worst_delta_24h
     FROM reconciliation_log WHERE client_id = $1::uuid`,
    [clientId]
  );
  const { rows: [sync] } = await query(
    `SELECT MAX(finished_at) AS last_sync
     FROM sync_log WHERE client_id = $1::uuid AND sync_type = 'sync-today' AND status = 'success'`,
    [clientId]
  );
  return {
    lastReconciliationAt: last?.last_at || null,
    gamLastSyncedAt: sync?.last_sync || null,
    recentFixes: Number(stats?.fixes_24h) || 0,
    recentDivergent: Number(stats?.divergent_24h) || 0,
    worstDeltaPct: stats?.worst_delta_24h != null ? +Number(stats.worst_delta_24h).toFixed(2) : null,
  };
}

module.exports = {
  rebuildNetworkRollupsFromGrain,
  fetchNetworkTotalsFromDB,
  fetchNetworkDayRow,
  updateNetworkReconciliation,
  listNetworkCoverageDates,
  writeReconciliationLog,
  getLastReconciliationSummary,
};
