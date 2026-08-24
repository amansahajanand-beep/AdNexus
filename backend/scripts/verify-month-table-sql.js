require('dotenv').config();
const { Pool } = require('pg');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL || undefined });
  // Use env from .env manually if needed
  require('dotenv').config();
  const { Client } = require('pg');
  const c = new Client({
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE || 'AdNexus',
  });
  await c.connect();
  const startDate = '2026-08-01';
  const endDate = '2026-08-24';
  const limit = 2500;
  const dayCount = 24;
  const perDay = Math.max(15, Math.min(400, Math.ceil(limit / dayCount)));
  console.log({ perDay, dayCount });

  const t0 = Date.now();
  const { rows } = await c.query(
    `WITH agg AS (
       SELECT
         report_date,
         LOWER(TRIM(COALESCE(NULLIF(inv_domain, ''), ''))) AS domain_name,
         COALESCE(SUM(impressions), 0)::float8 AS impression,
         COALESCE(SUM(revenue), 0)::float8 AS revenue_raw
       FROM rollup_kpi_daily
       WHERE report_date BETWEEN $1::date AND $2::date
         AND COALESCE(NULLIF(TRIM(inv_domain), ''), '') <> ''
       GROUP BY report_date, LOWER(TRIM(COALESCE(NULLIF(inv_domain, ''), '')))
       HAVING COALESCE(SUM(impressions), 0) > 0 OR COALESCE(SUM(revenue), 0) > 0
     ),
     ranked AS (
       SELECT *,
         ROW_NUMBER() OVER (
           PARTITION BY report_date
           ORDER BY revenue_raw DESC, impression DESC
         ) AS day_rank
       FROM agg
     )
     SELECT to_char(report_date, 'YYYY-MM-DD') AS report_date, domain_name, impression, revenue_raw
     FROM ranked
     WHERE day_rank <= $3
     ORDER BY report_date DESC, revenue_raw DESC
     LIMIT $4`,
    [startDate, endDate, perDay, limit]
  );
  const dates = [...new Set(rows.map((r) => r.report_date))].sort();
  console.log({
    ms: Date.now() - t0,
    rows: rows.length,
    days: dates.length,
    first: dates[0],
    last: dates[dates.length - 1],
  });
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
