require('dotenv').config();
const { Pool } = require('pg');
const p = new Pool({
  host: process.env.PG_HOST,
  port: parseInt(process.env.PG_PORT || '5432', 10),
  user: process.env.PG_USER,
  password: String(process.env.PG_PASSWORD ?? ''),
  database: process.env.PG_DATABASE,
});
(async () => {
  const c = await p.query('SELECT LEFT(id::text,8) AS cid, network_code, name, is_active FROM gam_clients ORDER BY created_at');
  console.log('CLIENTS');
  console.table(c.rows);
  const r = await p.query(`
    SELECT LEFT(client_id::text,8) AS cid, status,
           finished_at AT TIME ZONE 'Asia/Kolkata' AS finished_ist,
           rows_upserted,
           LEFT(COALESCE(error_msg,''),120) AS err
    FROM sync_log
    WHERE sync_type = 'sync-today'
      AND finished_at > NOW() - INTERVAL '10 hours'
    ORDER BY finished_at DESC
    LIMIT 40
  `);
  console.log('SYNC_TODAY LAST 10H');
  console.table(r.rows);
  const last = await p.query(`
    SELECT LEFT(client_id::text,8) AS cid, MAX(finished_at) AS last_success
    FROM sync_log
    WHERE sync_type='sync-today' AND status='success'
    GROUP BY client_id
  `);
  console.log('LAST SUCCESS BY CLIENT');
  console.table(last.rows);
  await p.end();
})().catch((e) => { console.error(e); process.exit(1); });
