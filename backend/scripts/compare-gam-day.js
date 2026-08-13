/**
 * Compare DB rollup vs live GAM for a past date.
 * Usage: node scripts/compare-gam-day.js 2026-08-11
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { query } = require('../src/db');
const { runWithClient } = require('../src/utils/clientContext');
const { ensureBootstrapFromEnv } = require('../src/models/clientStore');
const { parseGamMetricValue } = require('../src/utils/gamReportMetrics');

async function gamSiteTotals(day) {
  require('../src/routes/reports');
  const helpers = require('../src/routes/reports').__gamHelpers;
  const { getToken, runReportAndDownload, buildDateXML } = helpers;
  const token = await getToken();
  const xml = `
    <dimensions>DATE</dimensions>
    <dimensions>SITE_NAME</dimensions>
    <columns>TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS</columns>
    <columns>TOTAL_LINE_ITEM_LEVEL_ALL_REVENUE</columns>
    ${buildDateXML(day, day)}
    <dateRangeType>CUSTOM_DATE</dateRangeType>`;
  const raw = await runReportAndDownload(xml, token);
  let imp = 0;
  let rev = 0;
  for (const row of raw) {
    imp += Number(row['Column.TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS'] || 0);
    rev += parseGamMetricValue('TOTAL_LINE_ITEM_LEVEL_ALL_REVENUE', row['Column.TOTAL_LINE_ITEM_LEVEL_ALL_REVENUE']);
  }
  return { imp, rev: +rev.toFixed(2), rows: raw.length };
}

async function main() {
  const day = process.argv[2] || '2026-08-11';
  const client = await ensureBootstrapFromEnv();
  await runWithClient(client, async () => {
    const r1 = await query(
      `SELECT COALESCE(SUM(revenue),0)::float8 AS rev, COALESCE(SUM(impressions),0)::float8 AS imp,
              COUNT(*)::int AS kpi_rows
       FROM rollup_kpi_daily WHERE report_date = $1::date`,
      [day]
    );
    const r2 = await query(
      `SELECT COUNT(*)::int AS cnt FROM report_daily WHERE report_date = $1::date`,
      [day]
    );
    const m = require('../src/services/gamSyncService');
    const bundle = await m.fetchLeanDashboardBundleFromDB(day, day, { tableLimit: 1 });
    console.log('DB rollup:', r1.rows[0]);
    console.log('report_daily rows:', r2.rows[0]?.cnt);
    console.log('Dashboard bundle:', bundle?.summary ? {
      rev: bundle.summary.revenue,
      imp: bundle.summary.impressions,
      ecpm: bundle.summary.ecpm,
    } : null);
    console.log('Fetching live GAM…');
    const gam = await gamSiteTotals(day);
    console.log('Live GAM SITE:', gam);
  });
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
}).then(() => process.exit(0));
