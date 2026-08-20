/**
 * Drop retired report_full_* warehouse tables (no longer written or read by the app).
 *
 *   cd backend && node scripts/drop-retired-full-tables.js
 */
require('dotenv').config();
const { schemaQuery, pool } = require('../src/db');

async function tableSizeMb(table) {
  const { rows } = await schemaQuery(
    `SELECT
       to_regclass($1) AS reg,
       CASE WHEN to_regclass($1) IS NULL THEN NULL
            ELSE round(pg_total_relation_size($1::regclass) / 1024.0 / 1024.0, 1)
       END AS mb`,
    [`public.${table}`]
  );
  return rows[0];
}

async function main() {
  for (const table of ['report_full_present', 'report_full_daily']) {
    const info = await tableSizeMb(table);
    if (!info.reg) {
      console.log(`${table}: already gone`);
      continue;
    }
    console.log(`Dropping ${table} (${info.mb} MB) ...`);
    await schemaQuery(`DROP TABLE IF EXISTS ${table} CASCADE`);
    console.log(`${table}: dropped`);
  }
  console.log('Done. Restart the API so initSchema stays aligned.');
  await pool.end();
}

main().catch(async (e) => {
  console.error('FAILED:', e.message);
  try { await pool.end(); } catch (_) { /* ignore */ }
  process.exit(1);
});
