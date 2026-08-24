require('dotenv').config();
const { query, pool } = require('../src/db');
const { ensureBootstrapFromEnv } = require('../src/models/clientStore');
const { runWithClient } = require('../src/utils/clientContext');
const { todayInTZ, shiftYMD } = require('../src/utils/datetime');

async function main() {
  const client = await ensureBootstrapFromEnv();
  const today = todayInTZ();
  await runWithClient(client, async () => {
    const { rows } = await query(
      `SELECT report_date::text AS d, COUNT(*)::int AS rows,
              COALESCE(SUM(impressions),0)::bigint AS imps
       FROM report_grain WHERE client_id = $1::uuid
       GROUP BY report_date ORDER BY d DESC LIMIT 40`,
      [client.id]
    );
    console.log('\nreport_grain by date:\n');
    console.table(rows);

    const { rows: rollups } = await query(
      `SELECT report_date::text AS d,
              COALESCE(SUM(impressions),0)::bigint AS imps,
              COALESCE(SUM(grain_count),0)::int AS rows
       FROM rollup_kpi_daily WHERE client_id = $1::uuid
       GROUP BY report_date ORDER BY d DESC LIMIT 40`,
      [client.id]
    );
    console.log('\nrollup_kpi_daily by date:\n');
    console.table(rollups);

    const last30 = shiftYMD(today, -29);
    const { rows: [cov] } = await query(
      `SELECT COUNT(DISTINCT report_date)::int AS days_with_data
       FROM report_grain
       WHERE client_id = $1::uuid AND report_date BETWEEN $2::date AND $3::date`,
      [client.id, last30, today]
    );
    console.log(`\nLast 30 days (${last30}..${today}): ${cov.days_with_data} day(s) with grain data`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());
