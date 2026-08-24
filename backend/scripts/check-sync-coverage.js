require('dotenv').config();
const { initSchema, query } = require('../src/db');

(async () => {
  await initSchema();
  const { rows } = await query(
    `SELECT report_date::text AS d,
            slice_key,
            COUNT(*)::int AS n,
            SUM(impressions)::float8 AS imp,
            SUM(revenue)::float8 AS rev,
            SUM(CASE WHEN revenue > 0 THEN 1 ELSE 0 END)::int AS rev_rows,
            MAX(revenue)::float8 AS max_rev,
            AVG(CASE WHEN revenue > 0 THEN revenue END)::float8 AS avg_rev
     FROM report_grain
     WHERE report_date >= CURRENT_DATE - 7
     GROUP BY 1, 2
     ORDER BY 1 DESC, 2`
  );
  console.log(JSON.stringify(rows, null, 2));

  const { rows: roll } = await query(
    `SELECT report_date::text AS d,
            SUM(impressions)::float8 AS imp,
            SUM(revenue)::float8 AS rev,
            COUNT(*)::int AS n
     FROM rollup_kpi_daily
     WHERE report_date >= CURRENT_DATE - 7
     GROUP BY 1 ORDER BY 1 DESC`
  );
  console.log('rollups', roll);

  // Zero-revenue high-impression rows (possible over-conversion)
  const { rows: tiny } = await query(
    `SELECT report_date::text AS d, slice_key,
            COUNT(*)::int AS n,
            SUM(impressions)::float8 AS imp,
            SUM(revenue)::float8 AS rev
     FROM report_grain
     WHERE report_date >= CURRENT_DATE - 3
       AND impressions > 100
       AND revenue > 0 AND revenue < 0.0001
     GROUP BY 1, 2 ORDER BY 1 DESC`
  );
  console.log('tiny revenue rows', tiny);

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
