/**
 * Safe OAuth/client diagnostic — prints match flags only (no secrets).
 * Usage: node scripts/diag-oauth-client.js
 */
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

  const envId = String(process.env.GOOGLE_CLIENT_ID || '').trim();
  const envNet = String(process.env.GAM_NETWORK_CODE || '').trim();
  const envHasSecret = String(process.env.GOOGLE_CLIENT_SECRET || '').length > 5;
  const envHasRefresh = String(process.env.GOOGLE_REFRESH_TOKEN || '').length > 10;

  console.log('=== ENV ===');
  console.log({
    has_client_id: !!envId,
    has_secret: envHasSecret,
    has_refresh: envHasRefresh,
    network_code: envNet || null,
  });

  const { rows: clients } = await pool.query(
    `SELECT id, name, network_code, google_client_id, is_active,
            (google_refresh_token_enc IS NOT NULL AND length(google_refresh_token_enc) > 5) AS has_token,
            (google_client_secret_enc IS NOT NULL AND length(google_client_secret_enc) > 5) AS has_secret
     FROM gam_clients ORDER BY created_at`
  );

  console.log('=== GAM_CLIENTS (no secrets) ===');
  for (const r of clients) {
    console.log({
      name: r.name,
      network_code: r.network_code,
      is_active: r.is_active,
      has_token: r.has_token,
      has_secret: r.has_secret,
      client_id_matches_env: r.google_client_id === envId,
      network_matches_env: String(r.network_code) === envNet,
    });
  }

  const { rows: users } = await pool.query(
    `SELECT u.username, u.role, u.is_active AS user_active,
            (u.client_id IS NOT NULL) AS linked,
            c.name AS client_name,
            c.network_code,
            (c.google_client_id = $1) AS client_id_matches_env
     FROM users u
     LEFT JOIN gam_clients c ON c.id = u.client_id
     ORDER BY u.username`,
    [envId]
  );

  console.log('=== USERS → CLIENT LINK ===');
  for (const u of users) console.log(u);

  await pool.end();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
