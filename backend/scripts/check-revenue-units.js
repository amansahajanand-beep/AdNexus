require('dotenv').config();
const { initSchema, query } = require('../src/db');

(async () => {
  await initSchema();
  const day = '2026-08-24';
  const { rows } = await query(
    `SELECT slice_key,
            COUNT(*)::int AS n,
            SUM(revenue)::float8 AS sum_rev,
            AVG(revenue)::float8 AS avg_rev,
            MIN(revenue)::float8 AS min_rev,
            MAX(revenue)::float8 AS max_rev,
            SUM(impressions)::float8 AS imp
     FROM report_grain
     WHERE report_date = $1::date
     GROUP BY 1 ORDER BY 1`,
    [day]
  );
  console.log('by slice', rows);

  const { rows: sample } = await query(
    `SELECT slice_key, revenue, impressions, app_id
     FROM report_grain
     WHERE report_date = $1::date AND slice_key = 'inventory_core' AND revenue > 0
     ORDER BY revenue DESC LIMIT 5`,
    [day]
  );
  console.log('top inventory_core rows', sample);

  const { rows: ch } = await query(
    `SELECT slice_key, revenue, impressions
     FROM report_grain
     WHERE report_date = $1::date AND slice_key = 'channel' AND revenue > 0
     ORDER BY revenue DESC LIMIT 5`,
    [day]
  );
  console.log('top channel rows', ch);

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
