/**
 * One-shot: fill inv_domain / inv_site / inv_ad_unit / inv_app from JSONB dimensions.
 * New cron syncs write these columns automatically going forward.
 *
 *   node scripts/backfill-inventory-cols.js
 */
require('dotenv').config();
const { initSchema, query } = require('../src/db');
const logger = require('../src/utils/logger');

async function backfill(table) {
  const result = await query(`
    UPDATE ${table} SET
      inv_domain = NULLIF(LOWER(TRIM(COALESCE(
        dimensions->>'domainName', dimensions->>'domain', dimensions->>'DOMAIN', ''
      ))), ''),
      inv_site = NULLIF(LOWER(TRIM(COALESCE(
        dimensions->>'siteUrl', dimensions->>'gamSite', dimensions->>'siteName',
        dimensions->>'SITE_NAME', dimensions->>'URL_NAME', ''
      ))), ''),
      inv_ad_unit = NULLIF(TRIM(COALESCE(
        dimensions->>'AD_UNIT_NAME', dimensions->>'ad_unit_name', dimensions->>'site', ''
      )), ''),
      inv_app = NULLIF(TRIM(COALESCE(
        NULLIF(dimensions->>'appPackage',''),
        NULLIF(dimensions->>'appId',''),
        NULLIF(dimensions->>'MOBILE_APP_RESOLVED_ID',''),
        ''
      )), '')
    WHERE inv_ad_unit IS NULL OR inv_ad_unit = ''
  `);
  logger.info(`Backfilled ${table}: ${result.rowCount} rows`);

  // Derive domain from ad-unit prefix when still missing (thin cron rows).
  const derived = await query(`
    UPDATE ${table} SET
      inv_domain = LOWER(split_part(regexp_replace(inv_ad_unit, '\\s*\\(\\d+\\)\\s*$', ''), '_', 1))
    WHERE (inv_domain IS NULL OR inv_domain = '')
      AND inv_ad_unit IS NOT NULL
      AND inv_ad_unit LIKE '%.%_%'
  `);
  logger.info(`Derived domains on ${table}: ${derived.rowCount} rows`);
}

(async () => {
  await initSchema();
  await backfill('report_present');
  await backfill('report_daily');
  process.exit(0);
})().catch((e) => {
  logger.error(e);
  process.exit(1);
});
