require('dotenv').config();
const { query } = require('../src/db');

(async () => {
  const sample = await query(
    `SELECT dimensions FROM report_daily WHERE report_date = '2026-08-07' LIMIT 1`
  );
  console.log('sample keys', Object.keys(sample.rows[0]?.dimensions || {}));
  console.log('sample dimensions', JSON.stringify(sample.rows[0]?.dimensions, null, 2));

  const counts = await query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE dimensions ? 'country')::int AS k_country,
      COUNT(*) FILTER (WHERE dimensions ? 'COUNTRY_NAME')::int AS k_COUNTRY_NAME,
      COUNT(*) FILTER (WHERE dimensions ? 'country_name')::int AS k_country_name,
      COUNT(*) FILTER (WHERE dimensions ? 'device')::int AS k_device,
      COUNT(*) FILTER (WHERE dimensions ? 'DEVICE_CATEGORY_NAME')::int AS k_DEVICE_CATEGORY_NAME,
      COUNT(*) FILTER (WHERE dimensions ? 'device_category_name')::int AS k_device_category_name
    FROM report_daily
    WHERE report_date = '2026-08-07'
  `);
  console.log('aug7 key counts', counts.rows[0]);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
