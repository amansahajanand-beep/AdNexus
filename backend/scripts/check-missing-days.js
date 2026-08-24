require('dotenv').config();
const { query, pool } = require('../src/db');
const { ensureBootstrapFromEnv } = require('../src/models/clientStore');
const { runWithClient } = require('../src/utils/clientContext');
const { todayInTZ, shiftYMD } = require('../src/utils/datetime');
const { kpiSliceFilterSql } = require('../src/services/reportGrainStore');

async function main() {
  const days = Math.max(1, parseInt(process.argv[2] || '30', 10) || 30);
  const today = todayInTZ();
  const start = shiftYMD(today, -(days - 1));
  const client = await ensureBootstrapFromEnv();

  await runWithClient(client, async () => {
    const missing = [];
    for (let i = 0; i < days; i++) {
      const d = shiftYMD(today, -i);
      const { rows: [g] } = await query(
        `SELECT COUNT(*)::int AS cnt FROM report_grain
         WHERE client_id = $1::uuid AND report_date = $2::date`,
        [client.id, d]
      );
      const { rows: [k] } = await query(
        `SELECT COALESCE(SUM(impressions),0)::bigint AS imps,
                COALESCE(SUM(revenue),0)::float8 AS rev
         FROM report_grain g
         WHERE g.client_id = $1::uuid AND g.report_date = $2::date
           AND ${kpiSliceFilterSql('g')}`,
        [client.id, d]
      );
      const { rows: [r] } = await query(
        `SELECT COALESCE(SUM(impressions),0)::bigint AS imps
         FROM rollup_kpi_daily
         WHERE client_id = $1::uuid AND report_date = $2::date`,
        [client.id, d]
      );
      if (!g.cnt) missing.push({ d, issue: 'no grain' });
      else if (!Number(k.imps)) missing.push({ d, issue: 'zero channel-slice imps', grain: g.cnt });
      else if (!Number(r.imps)) missing.push({ d, issue: 'no rollup', channelImps: k.imps });
    }
    console.log(`\nRange ${start}..${today} (${days} days)`);
    if (!missing.length) {
      console.log('All days have grain + channel KPI + rollups.');
    } else {
      console.log(`Missing/incomplete (${missing.length}):`);
      console.table(missing);
    }
  });
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());
