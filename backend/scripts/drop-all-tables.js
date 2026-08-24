/**
 * Drop ALL tables in the configured PostgreSQL database (public schema reset).
 * Usage: node scripts/drop-all-tables.js
 */
require('dotenv').config();
const { schemaQuery, pool } = require('../src/db');

async function main() {
  const db = process.env.PG_DATABASE || 'gam_dashboard_db';
  const { rows } = await schemaQuery(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
  );
  console.log(`Database: ${db}`);
  console.log(`Tables before drop (${rows.length}):`, rows.map((r) => r.tablename).join(', ') || '(none)');

  await schemaQuery('DROP SCHEMA public CASCADE');
  await schemaQuery('CREATE SCHEMA public');
  await schemaQuery('GRANT ALL ON SCHEMA public TO postgres');
  await schemaQuery('GRANT ALL ON SCHEMA public TO public');

  const { rows: after } = await schemaQuery(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
  );
  console.log(`Tables after drop: ${after.length}`);
  console.log('Done — public schema reset.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => pool.end());
