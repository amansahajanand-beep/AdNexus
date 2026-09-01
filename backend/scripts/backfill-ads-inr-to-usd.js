/**
 * Re-price ads_spend_daily.cost from cost_native using today's live FX (INR→USD).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const { getUnitsPerUsd, refreshFxRates } = require('../src/utils/adsCurrency');

(async () => {
  const pool = new Pool({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT || 5432),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL row_security = off');

    await refreshFxRates();
    const inrPerUsd = await getUnitsPerUsd('INR');
    console.log('Live INR per USD =', inrPerUsd);

    // Rows never converted: treat current cost as INR native
    await client.query(`
      UPDATE ads_spend_daily
      SET cost_native = cost, native_currency = 'INR'
      WHERE cost_native IS NULL
    `);

    const upd = await client.query(
      `UPDATE ads_spend_daily
       SET
         cost = ROUND((cost_native / $1::float8)::numeric, 6)::float8,
         currency = 'USD',
         native_currency = COALESCE(NULLIF(TRIM(native_currency), ''), 'INR')
       WHERE cost_native IS NOT NULL AND cost_native > 0`,
      [inrPerUsd]
    );
    console.log('Repriced rows', upd.rowCount);

    const after = await client.query(`
      SELECT ROUND(SUM(cost)::numeric, 2) AS usd_sum,
             ROUND(SUM(cost_native)::numeric, 2) AS inr_sum
      FROM ads_spend_daily
      WHERE report_date = (now() AT TIME ZONE 'Asia/Singapore')::date
    `);
    console.log('Today', after.rows[0]);

    await client.query('COMMIT');
    console.log('Done');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error(e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
