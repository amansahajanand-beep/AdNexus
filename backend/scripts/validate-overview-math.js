/**
 * Validate overview KPI math: rollup vs grain vs manual eCPM/viewability.
 * Usage: node scripts/validate-overview-math.js [startDate] [endDate]
 */
require('dotenv').config();
const { query } = require('../src/db');
const { todayInTZ } = require('../src/utils/datetime');
const { fetchLeanOverviewTotalsFromDB } = require('../src/services/gamSyncService');
const { runWithClient } = require('../src/utils/clientContext');
const { ensureBootstrapFromEnv } = require('../src/models/clientStore');

async function main() {
  const today = todayInTZ();
  const start = process.argv[2] || today;
  const end = process.argv[3] || start;
  const client = await ensureBootstrapFromEnv();

  await runWithClient(client, async () => {
    console.log(`\n=== Overview math validation ${start}..${end} ===\n`);

  // 1. Direct grain aggregate (all rows — may include multi-slice overlap)
    const { rows: [grainAll] } = await query(
      `SELECT
         COUNT(*)::int AS rows,
         COALESCE(SUM(impressions), 0)::bigint AS impressions,
         COALESCE(SUM(revenue), 0)::float8 AS revenue,
         COALESCE(SUM(clicks), 0)::bigint AS clicks,
         COALESCE(SUM(impressions * viewable_pct), 0)::float8 AS viewable_weight
       FROM report_grain
       WHERE client_id = $1::uuid AND report_date BETWEEN $2::date AND $3::date`,
      [client.id, start, end]
    );

  // 2. Grain — canonical KPI slice only (default: channel / programmatic)
    const { kpiSliceFilterSql } = require('../src/services/reportGrainStore');
    const { rows: [grainKpi] } = await query(
      `SELECT
         COUNT(*)::int AS rows,
         COALESCE(SUM(impressions), 0)::bigint AS impressions,
         COALESCE(SUM(revenue), 0)::float8 AS revenue,
         COALESCE(SUM(impressions * viewable_pct), 0)::float8 AS viewable_weight
       FROM report_grain g
       WHERE g.client_id = $1::uuid AND g.report_date BETWEEN $2::date AND $3::date
         AND ${kpiSliceFilterSql('g')}`,
      [client.id, start, end]
    );

  // 3. Rollup KPI sum (what overview SQL path uses)
    const { rows: [rollup] } = await query(
      `SELECT
         COALESCE(SUM(grain_count), 0)::int AS grain_rows,
         COALESCE(SUM(impressions), 0)::float8 AS impressions,
         COALESCE(SUM(revenue), 0)::float8 AS revenue,
         COALESCE(SUM(viewable_weight), 0)::float8 AS viewable_weight
       FROM rollup_kpi_daily
       WHERE client_id = $1::uuid AND report_date BETWEEN $2::date AND $3::date`,
      [client.id, start, end]
    );

  // 4. Service function (production path)
    const totals = await fetchLeanOverviewTotalsFromDB(start, end, {});

    function fmt(label, o) {
      const imp = Number(o.impressions) || 0;
      const rev = Number(o.revenue) || 0;
      const vw = Number(o.viewable_weight ?? o.viewableWeight) || 0;
      const ecpm = imp > 0 ? +((rev / imp) * 1000).toFixed(2) : 0;
      const view = imp > 0 ? +((vw / imp)).toFixed(2) : 0;
      console.log(`${label}:`);
      console.log(`  rows/grain_count: ${o.rows ?? o.grain_rows ?? '—'}`);
      console.log(`  impressions:      ${Math.round(imp).toLocaleString()}`);
      console.log(`  revenue ($):      ${rev.toFixed(2)}`);
      console.log(`  eCPM (calc):      ${ecpm}`);
      console.log(`  viewability (%):  ${view}`);
      console.log('');
    }

    fmt('report_grain (ALL slices — possible overlap)', grainAll);
    fmt(`report_grain (canonical ${process.env.CANONICAL_KPI_SLICE || 'channel'} slice)`, grainKpi);
    fmt('rollup_kpi_daily (overview SQL path)', rollup);
    if (totals) {
      console.log('fetchLeanOverviewTotalsFromDB (API):');
      console.log(`  source:           ${totals.source}`);
      console.log(`  rowCount:         ${totals.rowCount}`);
      console.log(`  impressions:      ${totals.impressions?.toLocaleString()}`);
      console.log(`  revenue ($):      ${totals.revenue}`);
      console.log(`  eCPM (calc):      ${totals.impressions > 0 ? +((totals.revenue / totals.impressions) * 1000).toFixed(2) : 0}`);
      console.log(`  viewability (%):  ${totals.viewability}`);
      console.log('');
    }

    const ratio = grainKpi.impressions > 0
      ? (Number(grainAll.impressions) / Number(grainKpi.impressions)).toFixed(2)
      : 'n/a';
    console.log(`Overlap check: ALL slices / canonical KPI slice = ${ratio}x`);
    const rollupImp = Number(rollup.impressions) || 0;
    const kpiImp = Number(grainKpi.impressions) || 0;
    if (rollupImp > 0 && kpiImp > 0 && Math.abs(rollupImp - kpiImp) / kpiImp < 0.02) {
      console.log('✓  Rollup KPI totals match canonical grain slice.');
    } else if (rollupImp > 0 && kpiImp > 0) {
      console.log(`⚠️  Rollup vs canonical grain mismatch: rollup=${rollupImp} grain=${kpiImp}`);
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
