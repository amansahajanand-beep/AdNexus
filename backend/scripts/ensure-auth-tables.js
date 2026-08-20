/**
 * Ensure auth tables exist (users + user_sessions) and seed default admin if needed.
 *
 * Run on production when login fails / those tables are missing:
 *   cd backend && node scripts/ensure-auth-tables.js
 *
 * Requires USE_PG_USERS=true and valid PG_* env (same as the API).
 */
require('dotenv').config();

async function main() {
  if (process.env.USE_PG_USERS !== 'true') {
    console.error('USE_PG_USERS must be true to create Postgres auth tables.');
    process.exit(1);
  }

  const { initUsersSchema } = require('../src/models/userStorePg');
  const { query } = require('../src/db');

  console.log(`Connecting to ${process.env.PG_DATABASE}@${process.env.PG_HOST}:${process.env.PG_PORT} ...`);
  await initUsersSchema();

  const check = await query(`
    SELECT
      to_regclass('public.users') AS users,
      to_regclass('public.user_sessions') AS user_sessions,
      (SELECT COUNT(*)::int FROM users) AS user_count,
      (SELECT COUNT(*)::int FROM user_sessions) AS session_count
  `);
  console.log('OK:', check.rows[0]);
  console.log('Auth tables ready. Restart the API if it was already running, then sign in again.');
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED to ensure auth tables:', e.message);
  if (/no space left/i.test(e.message)) {
    console.error('Disk is full — free space on the Postgres host, then re-run this script.');
  }
  process.exit(1);
});
