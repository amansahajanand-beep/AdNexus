require('dotenv').config();
const { query, initSchema } = require('../src/db');

(async () => {
  await initSchema();
  const { rows } = await query(`
    SELECT 'report_full_present' AS tbl, COUNT(*)::int AS n,
           MIN(report_date)::text AS min_d, MAX(report_date)::text AS max_d
    FROM report_full_present
    UNION ALL
    SELECT 'report_full_daily', COUNT(*)::int,
           MIN(report_date)::text, MAX(report_date)::text
    FROM report_full_daily
    UNION ALL
    SELECT 'report_present', COUNT(*)::int,
           MIN(report_date)::text, MAX(report_date)::text
    FROM report_present
    UNION ALL
    SELECT 'report_daily', COUNT(*)::int,
           MIN(report_date)::text, MAX(report_date)::text
    FROM report_daily
  `);
  console.log(JSON.stringify(rows, null, 2));
  console.log('FULL_SYNC_DISABLED=', process.env.FULL_SYNC_DISABLED);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
