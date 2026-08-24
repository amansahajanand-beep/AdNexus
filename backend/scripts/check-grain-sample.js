require('dotenv').config();
const { query } = require('../src/db');

(async () => {
  const { rows: sample } = await query(`
    SELECT g.impressions, g.clicks, g.revenue, g.viewable_pct, g.ecpm,
           dc.name AS country, dd.name AS device
    FROM report_grain g
    LEFT JOIN dim_country dc ON dc.id = g.country_id
    LEFT JOIN dim_device dd ON dd.id = g.device_id
    WHERE g.revenue > 0
    LIMIT 5
  `);
  console.log('sample:', JSON.stringify(sample, null, 2));
  const { rows: stats } = await query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE impressions > 0)::int AS imp_rows,
      COUNT(*) FILTER (WHERE viewable_pct > 0)::int AS view_rows,
      COUNT(*) FILTER (WHERE clicks > 0)::int AS click_rows
    FROM report_grain
  `);
  console.log('stats:', stats[0]);
  process.exit(0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
