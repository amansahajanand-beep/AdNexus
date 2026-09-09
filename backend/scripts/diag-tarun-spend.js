require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { schemaQuery } = require('../src/db');

(async () => {
  const date = process.argv[2] || '2026-09-01';
  const acc = await schemaQuery(`
    SELECT id, customer_id, descriptive_name, include_in_roi, last_sync_at,
           left(coalesce(last_sync_error,''), 200) AS err
    FROM ads_accounts
    WHERE descriptive_name ILIKE '%tarun%' OR descriptive_name ILIKE '%message%'
    ORDER BY descriptive_name
  `);
  console.log('accounts', JSON.stringify(acc.rows, null, 2));

  for (const a of acc.rows) {
    const s = await schemaQuery(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(cost),0)::float8 AS cost,
              COALESCE(SUM(cost_native),0)::float8 AS native, MAX(native_currency) AS cur
       FROM ads_spend_daily WHERE ads_account_id = $1 AND report_date = $2`,
      [a.id, date]
    );
    const c = await schemaQuery(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(cost),0)::float8 AS cost
       FROM ads_spend_country_daily WHERE ads_account_id = $1 AND report_date = $2`,
      [a.id, date]
    );
    const top = await schemaQuery(
      `SELECT campaign_id, campaign_name, cost, cost_native, native_currency, clicks, impressions
       FROM ads_spend_daily WHERE ads_account_id = $1 AND report_date = $2
       ORDER BY cost DESC LIMIT 5`,
      [a.id, date]
    );
    console.log('\n', a.descriptive_name, a.customer_id);
    console.log('  daily', s.rows[0], 'country', c.rows[0]);
    console.log('  top campaigns', top.rows);
  }

  const tot = await schemaQuery(
    'SELECT COALESCE(SUM(cost),0)::float8 AS cost, COUNT(DISTINCT ads_account_id)::int AS accounts FROM ads_spend_daily WHERE report_date = $1',
    [date]
  );
  console.log('\ntotal spend', date, tot.rows[0]);

  const byAcc = await schemaQuery(
    `SELECT a.descriptive_name, a.customer_id, COALESCE(SUM(s.cost),0)::float8 AS cost
     FROM ads_spend_daily s
     JOIN ads_accounts a ON a.id = s.ads_account_id
     WHERE s.report_date = $1
     GROUP BY a.id, a.descriptive_name, a.customer_id
     ORDER BY cost DESC`,
    [date]
  );
  console.log('\nby account', byAcc.rows);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
