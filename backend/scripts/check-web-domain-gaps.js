require('dotenv').config();
const { initSchema, query } = require('../src/db');

(async () => {
  await initSchema();
  const day = '2026-08-23';
  // Web-looking sites (have a dot, not unknown)
  const { rows } = await query(
    `SELECT
       COUNT(*)::int AS n,
       SUM(impressions)::float8 AS imp,
       SUM(revenue)::float8 AS rev,
       SUM(CASE WHEN g.domain_id IS NULL OR g.domain_id = 0 THEN 1 ELSE 0 END)::int AS no_domain_rows,
       SUM(CASE WHEN g.domain_id IS NULL OR g.domain_id = 0 THEN impressions ELSE 0 END)::float8 AS no_domain_imp,
       SUM(CASE WHEN g.domain_id IS NULL OR g.domain_id = 0 THEN revenue ELSE 0 END)::float8 AS no_domain_rev
     FROM report_grain g
     JOIN dim_site ds ON ds.id = g.site_id AND ds.client_id = g.client_id
     WHERE g.report_date = $1::date AND g.slice_key = 'inventory_core'
       AND ds.name LIKE '%.%'
       AND LOWER(ds.name) NOT LIKE '%unknown%'
       AND LOWER(ds.name) NOT LIKE '%not applicable%'`,
    [day]
  );
  console.log('web sites', rows[0]);

  const { rows: miss } = await query(
    `SELECT ds.name AS site, da.name AS ad_unit, SUM(g.impressions)::float8 AS imp, SUM(g.revenue)::float8 AS rev
     FROM report_grain g
     JOIN dim_site ds ON ds.id = g.site_id AND ds.client_id = g.client_id
     LEFT JOIN dim_ad_unit da ON da.id = g.ad_unit_id AND da.client_id = g.client_id
     WHERE g.report_date = $1::date AND g.slice_key = 'inventory_core'
       AND ds.name LIKE '%.%'
       AND LOWER(ds.name) NOT LIKE '%unknown%'
       AND (g.domain_id IS NULL OR g.domain_id = 0)
     GROUP BY 1, 2
     ORDER BY rev DESC LIMIT 15`,
    [day]
  );
  console.log('web missing domain_id', miss);

  // Compare site-filter total vs channel total for a known domain's sites
  const { rows: siteTot } = await query(
    `SELECT SUM(g.revenue)::float8 AS rev, SUM(g.impressions)::float8 AS imp
     FROM report_grain g
     JOIN dim_site ds ON ds.id = g.site_id AND ds.client_id = g.client_id
     WHERE g.report_date = $1::date AND g.slice_key = 'inventory_core'
       AND LOWER(ds.name) LIKE '%.gamisco.com'`,
    [day]
  );
  const { rows: rollDom } = await query(
    `SELECT SUM(revenue)::float8 AS rev, SUM(impressions)::float8 AS imp
     FROM rollup_kpi_daily
     WHERE report_date = $1::date AND LOWER(inv_domain) = 'gamisco.com'`,
    [day]
  );
  console.log('gamisco sites inventory_core', siteTot[0], 'vs rollup domain', rollDom[0]);

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
