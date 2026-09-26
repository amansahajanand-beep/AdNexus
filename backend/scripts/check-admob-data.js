require('dotenv').config();
const { Pool } = require('pg');

const p = new Pool({
  host: process.env.PG_HOST || '127.0.0.1',
  port: +process.env.PG_PORT || 5432,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE,
});

(async () => {
  const a = await p.query(
    `SELECT id, account_id, currency_code, last_sync_at, last_sync_error, descriptive_name
     FROM admob_accounts LIMIT 5`
  );
  console.log('accounts', JSON.stringify(a.rows, null, 2));
  if (!a.rows[0]) {
    await p.end();
    return;
  }
  const id = a.rows[0].id;
  const r = await p.query(
    `SELECT report_date::text AS d, earnings, impressions, clicks
     FROM admob_report_daily WHERE account_id = $1
     ORDER BY report_date DESC LIMIT 14`,
    [id]
  );
  console.log('facts_last14', JSON.stringify(r.rows, null, 2));
  const s = await p.query(
    `SELECT COALESCE(SUM(earnings),0)::float AS e, COALESCE(SUM(impressions),0)::bigint AS i
     FROM admob_report_daily
     WHERE account_id = $1 AND report_date >= '2026-09-15' AND report_date <= '2026-09-21'`,
    [id]
  );
  console.log('sep15_21', s.rows[0]);
  const t = await p.query(
    `SELECT report_date::text AS d, earnings, impressions
     FROM admob_report_daily
     WHERE account_id = $1 AND report_date >= '2026-09-21'
     ORDER BY report_date`,
    [id]
  );
  console.log('from_sep21', t.rows);
  const d = await p.query(
    `SELECT dim_kind, COUNT(*)::int AS n, COALESCE(SUM(earnings),0)::float AS e
     FROM admob_dim_daily WHERE account_id = $1 GROUP BY 1 ORDER BY 1`,
    [id]
  );
  console.log('dims', d.rows);
  const roll = await p.query(
    `SELECT report_date::text AS d, earnings, impressions
     FROM admob_rollup_daily WHERE account_id = $1
     ORDER BY report_date DESC LIMIT 10`,
    [id]
  );
  console.log('rollups', roll.rows);
  await p.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
