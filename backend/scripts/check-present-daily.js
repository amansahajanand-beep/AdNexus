require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PG_HOST,
  port: parseInt(process.env.PG_PORT, 10) || 5432,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE,
  ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function run() {
  const q = async (sql) => {
    const { rows } = await pool.query(sql);
    console.log(JSON.stringify(rows, null, 2));
  };
  console.log('--- columns ---');
  await q(`SELECT table_name, column_name FROM information_schema.columns
           WHERE table_name IN ('report_present','report_daily','gam_clients')
             AND column_name IN ('client_id','report_date')
           ORDER BY 1,2`);
  console.log('--- report_present counts ---');
  await q(`SELECT COUNT(*)::int AS n,
                  MIN(report_date)::text AS min_d, MAX(report_date)::text AS max_d
           FROM report_present`);
  console.log('--- report_daily last 4 days ---');
  await q(`SELECT report_date::text AS d, COUNT(*)::int AS n
           FROM report_daily
           WHERE report_date >= CURRENT_DATE - 4
           GROUP BY 1 ORDER BY 1 DESC`);
  console.log('--- report_full_present ---');
  await q(`SELECT report_date::text AS d, COUNT(*)::int AS n
           FROM report_full_present GROUP BY 1 ORDER BY 1 DESC LIMIT 5`);
  console.log('--- report_full_daily last 4 days ---');
  await q(`SELECT report_date::text AS d, COUNT(*)::int AS n
           FROM report_full_daily
           WHERE report_date >= CURRENT_DATE - 4
           GROUP BY 1 ORDER BY 1 DESC`);
  await pool.end();
}

run().catch((e) => { console.error(e.message); process.exit(1); });
