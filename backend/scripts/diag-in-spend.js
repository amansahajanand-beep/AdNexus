require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { schemaQuery } = require('../src/db');

(async () => {
  const date = '2026-09-01';
  const r = await schemaQuery(
    `SELECT UPPER(s.country_code) AS cc,
            COALESCE(SUM(s.cost), 0)::float8 AS usd,
            COALESCE(SUM(s.cost_native), 0)::float8 AS inr,
            COALESCE(SUM(s.clicks), 0)::bigint AS clicks
     FROM ads_spend_country_daily s
     JOIN ads_accounts a ON a.id = s.ads_account_id
     WHERE a.customer_id = '5628422125' AND s.report_date = $1 AND UPPER(s.country_code) = 'IN'
     GROUP BY 1`,
    [date]
  );
  console.log('IN country total', r.rows[0]);
  const p = await schemaQuery(
    `SELECT LOWER(TRIM(s.app_id)) AS app_id,
            COALESCE(SUM(s.cost), 0)::float8 AS usd
     FROM ads_spend_country_daily s
     JOIN ads_accounts a ON a.id = s.ads_account_id
     WHERE a.customer_id = '5628422125' AND s.report_date = $1 AND UPPER(s.country_code) = 'IN'
     GROUP BY 1 ORDER BY usd DESC LIMIT 5`,
    [date]
  );
  console.log('IN by app', p.rows);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
