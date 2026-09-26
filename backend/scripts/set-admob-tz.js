require('dotenv').config();
const { initSchema, query } = require('../src/db');

(async () => {
  await initSchema();
  await query(
    `UPDATE admob_accounts
     SET reporting_time_zone = 'Asia/Calcutta'
     WHERE account_id = 'pub-9765906064975653'`
  );
  const r = await query(
    `SELECT account_id, reporting_time_zone, currency_code FROM admob_accounts`
  );
  console.log(r.rows);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
