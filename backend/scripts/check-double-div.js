require('dotenv').config();
const { initSchema, query } = require('../src/db');

(async () => {
  await initSchema();
  // Rows that look double-divided: tiny revenue, meaningful impressions
  const { rows } = await query(
    `SELECT report_date::text AS d, slice_key,
            COUNT(*)::int AS n,
            SUM(impressions)::float8 AS imp,
            SUM(revenue)::float8 AS rev
     FROM report_grain
     WHERE report_date >= CURRENT_DATE - 2
       AND impressions >= 100
       AND revenue > 0 AND revenue < 0.01
     GROUP BY 1, 2 ORDER BY 1 DESC, 2`
  );
  console.log('suspect tiny revenue', rows);

  const { rows: whole } = await query(
    `SELECT report_date::text AS d, slice_key,
            COUNT(*)::int AS n,
            SUM(revenue)::float8 AS rev
     FROM report_grain
     WHERE report_date >= CURRENT_DATE - 2
       AND revenue > 0
       AND revenue = FLOOR(revenue)
       AND revenue < 1000
     GROUP BY 1, 2 ORDER BY 1 DESC`
  );
  console.log('whole-dollar revenue rows', whole);

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
