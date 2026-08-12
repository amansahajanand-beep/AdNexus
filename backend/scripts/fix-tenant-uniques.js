/**
 * One-shot: swap report table unique keys to include client_id so
 * ON CONFLICT (client_id, report_date, dim_hash) works.
 *
 * Usage: node scripts/fix-tenant-uniques.js
 */
require('dotenv').config();
const { Pool } = require('pg');
const logger = require('../src/utils/logger');

const pool = new Pool({
  host: process.env.PG_HOST,
  port: process.env.PG_PORT,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE,
});

const uniqueSwaps = [
  ['report_daily', 'report_daily_client_date_hash', '(client_id, report_date, dim_hash)'],
  ['report_present', 'report_present_client_date_hash', '(client_id, report_date, dim_hash)'],
  ['report_full_present', 'report_full_present_client_slice_hash', '(client_id, report_date, slice_key, dim_hash)'],
  ['report_full_daily', 'report_full_daily_client_slice_hash', '(client_id, report_date, slice_key, dim_hash)'],
  ['report_adhoc', 'report_adhoc_client_query_hash', '(client_id, report_date, query_hash, dim_hash)'],
];

async function listUniques(client, table) {
  const { rows } = await client.query(
    `SELECT c.conname
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = $1 AND c.contype = 'u'`,
    [table]
  );
  return rows.map((r) => r.conname);
}

async function constraintIncludesClientId(client, table, conname) {
  const { rows } = await client.query(
    `SELECT 1
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord) ON true
     JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = u.attnum
     WHERE t.relname = $1 AND c.conname = $2 AND a.attname = 'client_id'
     LIMIT 1`,
    [table, conname]
  );
  return rows.length > 0;
}

(async () => {
  const client = await pool.connect();
  try {
    await client.query('SET lock_timeout = \'30s\'');
    await client.query('SET statement_timeout = \'0\'');

    for (const [table, newName, cols] of uniqueSwaps) {
      console.log(`\n--- ${table} ---`);
      const uniques = await listUniques(client, table);
      for (const name of uniques) {
        if (name === newName) continue;
        const hasClient = await constraintIncludesClientId(client, table, name);
        if (!hasClient) {
          console.log(`Dropping old unique ${name}`);
          await client.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name}`);
        }
      }
      console.log(`Ensuring ${newName} UNIQUE ${cols}`);
      await client.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${newName}`);
      await client.query(`ALTER TABLE ${table} ADD CONSTRAINT ${newName} UNIQUE ${cols}`);
      console.log(`OK ${table}`);
    }
    console.log('\nAll tenant unique constraints updated.');
  } finally {
    client.release();
    await pool.end();
  }
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
