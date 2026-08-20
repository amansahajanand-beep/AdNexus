require('dotenv').config();
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({
    host: process.env.PG_HOST,
    port: process.env.PG_PORT,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
  });
  try {
    const tables = await pool.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`
    );
    console.log('Tables:');
    tables.rows.forEach((r) => console.log(' -', r.tablename));
    const check = await pool.query(
      `SELECT to_regclass('public.users') AS users,
              to_regclass('public.user_sessions') AS user_sessions,
              to_regclass('public.gam_clients') AS gam_clients`
    );
    console.log('CHECK:', check.rows[0]);
    console.log('USE_PG_USERS=', process.env.USE_PG_USERS);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
