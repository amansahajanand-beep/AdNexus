require('dotenv').config();
const { initSchema, query } = require('../src/db');

(async () => {
  await initSchema();
  const day = '2026-08-23';
  const { rows } = await query(
    `SELECT
       COUNT(*)::int AS n,
       SUM(CASE WHEN site_id IS NULL OR site_id = 0 THEN 1 ELSE 0 END)::int AS no_site,
       SUM(CASE WHEN domain_id IS NULL OR domain_id = 0 THEN 1 ELSE 0 END)::int AS no_domain,
       SUM(CASE WHEN ad_unit_id IS NULL OR ad_unit_id = 0 THEN 1 ELSE 0 END)::int AS no_adunit,
       SUM(impressions)::float8 AS imp,
       SUM(CASE WHEN site_id IS NULL OR site_id = 0 THEN impressions ELSE 0 END)::float8 AS imp_no_site,
       SUM(CASE WHEN domain_id IS NULL OR domain_id = 0 THEN impressions ELSE 0 END)::float8 AS imp_no_domain,
       SUM(revenue)::float8 AS rev,
       SUM(CASE WHEN site_id IS NULL OR site_id = 0 THEN revenue ELSE 0 END)::float8 AS rev_no_site,
       SUM(CASE WHEN domain_id IS NULL OR domain_id = 0 THEN revenue ELSE 0 END)::float8 AS rev_no_domain
     FROM report_grain
     WHERE report_date = $1::date AND slice_key = 'inventory_core'`,
    [day]
  );
  console.log('inventory_core coverage', day, rows[0]);

  const { rows: ch } = await query(
    `SELECT
       COUNT(*)::int AS n,
       SUM(CASE WHEN site_id IS NULL OR site_id = 0 THEN 1 ELSE 0 END)::int AS no_site,
       SUM(CASE WHEN domain_id IS NULL OR domain_id = 0 THEN 1 ELSE 0 END)::int AS no_domain,
       SUM(impressions)::float8 AS imp,
       SUM(revenue)::float8 AS rev
     FROM report_grain
     WHERE report_date = $1::date AND slice_key = 'channel'`,
    [day]
  );
  console.log('channel coverage', day, ch[0]);

  // How many distinct sites vs domains in inventory_core
  const { rows: dists } = await query(
    `SELECT
       COUNT(DISTINCT site_id)::int AS sites,
       COUNT(DISTINCT domain_id)::int AS domains,
       COUNT(DISTINCT ad_unit_id)::int AS ad_units
     FROM report_grain
     WHERE report_date = $1::date AND slice_key = 'inventory_core'`,
    [day]
  );
  console.log('distinct dims', dists[0]);

  // Sample rows with site but no domain
  const { rows: sample } = await query(
    `SELECT ds.name AS site, dm.name AS domain, da.name AS ad_unit,
            g.impressions, g.revenue
     FROM report_grain g
     LEFT JOIN dim_site ds ON ds.id = g.site_id AND ds.client_id = g.client_id
     LEFT JOIN dim_domain dm ON dm.id = g.domain_id AND dm.client_id = g.client_id
     LEFT JOIN dim_ad_unit da ON da.id = g.ad_unit_id AND da.client_id = g.client_id
     WHERE g.report_date = $1::date AND g.slice_key = 'inventory_core'
       AND g.site_id > 0 AND (g.domain_id IS NULL OR g.domain_id = 0)
       AND g.revenue > 1
     ORDER BY g.revenue DESC LIMIT 8`,
    [day]
  );
  console.log('site without domain samples', sample);

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
