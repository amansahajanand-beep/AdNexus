require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { schemaQuery } = require('../src/db');

(async () => {
  console.log('devTokenSet', Boolean(String(process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '').trim()));
  console.log('adsOAuthEnv', {
    clientIdSet: Boolean(String(process.env.GOOGLE_ADS_CLIENT_ID || '').trim()),
    clientSecretSet: Boolean(String(process.env.GOOGLE_ADS_CLIENT_SECRET || '').trim()),
    redirectUri: process.env.GOOGLE_ADS_REDIRECT_URI || '(derived from PORT)',
  });
  const a = await schemaQuery(`
    SELECT account_type, customer_id, descriptive_name, include_in_roi,
           google_refresh_token_enc IS NOT NULL AS has_token,
           last_sync_at,
           left(coalesce(last_sync_error,''), 160) AS err
    FROM ads_accounts
    ORDER BY created_at
  `);
  console.log('accounts', JSON.stringify(a.rows, null, 2));
  const s = await schemaQuery('SELECT COUNT(*)::int AS n, COALESCE(SUM(cost),0)::float AS cost FROM ads_spend_daily');
  console.log('spend', s.rows[0]);
  const m = await schemaQuery('SELECT COUNT(*)::int AS n FROM ads_campaign_map');
  console.log('maps', m.rows[0]);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
