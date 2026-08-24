require('dotenv').config();
const { query } = require('../src/db');
const { ensureBootstrapFromEnv } = require('../src/models/clientStore');
const { runWithClient } = require('../src/utils/clientContext');
const { kpiSliceFilterSql } = require('../src/services/reportGrainStore');

async function main() {
  const date = process.argv[2] || '2026-08-22';
  const client = await ensureBootstrapFromEnv();
  await runWithClient(client, async () => {
    const { rows } = await query(
      `SELECT slice_key, COUNT(*)::int AS cnt,
              COALESCE(SUM(impressions),0)::bigint AS imps,
              ROUND(COALESCE(SUM(revenue),0)::numeric,2) AS rev
       FROM report_grain
       WHERE client_id = $1::uuid AND report_date = $2::date
       GROUP BY slice_key ORDER BY imps DESC`,
      [client.id, date]
    );
    console.log(`\nSlice totals for ${date}:\n`);
    console.table(rows);

    const { rows: [kpi] } = await query(
      `SELECT COUNT(*)::int AS cnt,
              COALESCE(SUM(impressions),0)::bigint AS imps,
              ROUND(COALESCE(SUM(revenue),0)::numeric,2) AS rev
       FROM report_grain g
       WHERE g.client_id = $1::uuid AND g.report_date = $2::date
         AND ${kpiSliceFilterSql('g')}`,
      [client.id, date]
    );
    console.log(`\nCanonical KPI filter (${process.env.CANONICAL_KPI_SLICE || 'channel'}):`, kpi);

    const { rows: [rollup] } = await query(
      `SELECT COALESCE(SUM(impressions),0)::bigint AS imps,
              ROUND(COALESCE(SUM(revenue),0)::numeric,2) AS rev,
              COALESCE(SUM(grain_count),0)::int AS rows
       FROM rollup_kpi_daily
       WHERE client_id = $1::uuid AND report_date = $2::date`,
      [client.id, date]
    );
    console.log('rollup_kpi_daily (current):', rollup);

    const { rows: channels } = await query(
      `SELECT channel_name,
              COALESCE(SUM(impressions),0)::bigint AS imps,
              ROUND(COALESCE(SUM(revenue),0)::numeric,2) AS rev
       FROM report_grain
       WHERE client_id = $1::uuid AND report_date = $2::date AND slice_key = 'channel'
       GROUP BY channel_name ORDER BY imps DESC`,
      [client.id, date]
    );
    console.log('\nChannel slice by programmatic channel:');
    console.table(channels);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
