require('dotenv').config();
const { initSchema, query } = require('../src/db');

(async () => {
  await initSchema();
  for (const day of ['2026-08-22', '2026-08-23', '2026-08-24']) {
    const { rows } = await query(
      `SELECT slice_key,
              SUM(revenue)::float8 AS sum_rev,
              SUM(impressions)::float8 AS imp,
              MAX(revenue)::float8 AS max_rev,
              AVG(CASE WHEN revenue > 0 THEN revenue END)::float8 AS avg_pos
       FROM report_grain
       WHERE report_date = $1::date AND slice_key IN ('channel','inventory_core')
       GROUP BY 1 ORDER BY 1`,
      [day]
    );
    console.log(day, rows.map((r) => ({
      ...r,
      asDollarsIfMicros: +(r.sum_rev / 1e6).toFixed(2),
      ecpmIfMicros: r.imp > 0 ? +((r.sum_rev / 1e6) / r.imp * 1000).toFixed(2) : 0,
      ecpmIfDollars: r.imp > 0 ? +((r.sum_rev / r.imp) * 1000).toFixed(2) : 0,
    })));
  }

  const { rows: roll } = await query(
    `SELECT report_date::text, SUM(revenue)::float8 AS rev, SUM(impressions)::float8 AS imp
     FROM rollup_kpi_daily
     WHERE report_date BETWEEN '2026-08-22'::date AND '2026-08-24'::date
     GROUP BY 1 ORDER BY 1`
  );
  console.log('rollups', roll);

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
