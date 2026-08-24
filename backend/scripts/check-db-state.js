require('dotenv').config();
const { schemaQuery, pool } = require('../src/db');

async function main() {
  const { rows } = await schemaQuery(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
  );
  console.log('Tables:', rows.length ? rows.map((r) => r.tablename).join(', ') : '(none)');

  if (rows.some((r) => r.tablename === 'report_grain')) {
    const { rows: [grain] } = await schemaQuery(
      `SELECT COUNT(*)::int AS rows FROM report_grain`
    );
    const { rows: cols } = await schemaQuery(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'report_grain' AND column_name = 'slice_key'`
    );
    console.log('report_grain rows:', grain.rows);
    console.log('slice_key column:', cols.length ? 'yes' : 'no');
  }

  if (rows.some((r) => r.tablename === 'gam_clients')) {
    const { rows: clients } = await schemaQuery(`SELECT id, name, is_active FROM gam_clients`);
    console.log('gam_clients:', clients);
  }
  if (rows.some((r) => r.tablename === 'users')) {
    const { rows: users } = await schemaQuery(`SELECT COUNT(*)::int AS n FROM users`);
    console.log('users:', users[0].n);
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());
