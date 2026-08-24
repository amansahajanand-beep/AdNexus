require('dotenv').config();
const { initSchema, query } = require('../src/db');

(async () => {
  await initSchema();
  const day = '2026-08-23';

  const { rows: coreSites } = await query(
    `SELECT LOWER(TRIM(ds.name)) AS s, SUM(g.revenue)::float8 AS rev, SUM(g.impressions)::float8 AS imp
     FROM report_grain g
     JOIN dim_site ds ON ds.id = g.site_id AND ds.client_id = g.client_id
     WHERE g.report_date = $1::date AND g.slice_key = 'inventory_core'
       AND (LOWER(ds.name) LIKE '%gamisco%' OR LOWER(dm_name(ds.name)) LIKE '%gamisco%')
     GROUP BY 1 ORDER BY rev DESC LIMIT 30`,
    [day]
  ).catch(async () => {
    const r = await query(
      `SELECT LOWER(TRIM(ds.name)) AS s, SUM(g.revenue)::float8 AS rev, SUM(g.impressions)::float8 AS imp
       FROM report_grain g
       JOIN dim_site ds ON ds.id = g.site_id AND ds.client_id = g.client_id
       WHERE g.report_date = $1::date AND g.slice_key = 'inventory_core'
         AND LOWER(ds.name) LIKE '%gamisco%'
       GROUP BY 1 ORDER BY rev DESC LIMIT 30`,
      [day]
    );
    return r;
  });
  console.log('inventory_core gamisco sites', coreSites);

  const { rows: rollSites } = await query(
    `SELECT LOWER(TRIM(inv_site)) AS s, SUM(revenue)::float8 AS rev, SUM(impressions)::float8 AS imp
     FROM rollup_kpi_daily
     WHERE report_date = $1::date AND LOWER(inv_domain) = 'gamisco.com'
     GROUP BY 1 ORDER BY rev DESC LIMIT 20`,
    [day]
  );
  console.log('rollup gamisco inv_site', rollSites);

  // Ad units for gamisco in inventory_core — what SITE_NAME do they have?
  const { rows: aus } = await query(
    `SELECT LOWER(TRIM(ds.name)) AS site, LOWER(TRIM(da.name)) AS ad_unit,
            SUM(g.revenue)::float8 AS rev, SUM(g.impressions)::float8 AS imp
     FROM report_grain g
     JOIN dim_ad_unit da ON da.id = g.ad_unit_id AND da.client_id = g.client_id
     LEFT JOIN dim_site ds ON ds.id = g.site_id AND ds.client_id = g.client_id
     WHERE g.report_date = $1::date AND g.slice_key = 'inventory_core'
       AND LOWER(da.name) LIKE '%gamisco%'
     GROUP BY 1, 2
     ORDER BY rev DESC LIMIT 20`,
    [day]
  );
  console.log('inventory_core gamisco ad units', aus);

  const { rows: auSum } = await query(
    `SELECT SUM(g.revenue)::float8 AS rev, SUM(g.impressions)::float8 AS imp, COUNT(*)::int AS n
     FROM report_grain g
     JOIN dim_ad_unit da ON da.id = g.ad_unit_id AND da.client_id = g.client_id
     WHERE g.report_date = $1::date AND g.slice_key = 'inventory_core'
       AND LOWER(da.name) LIKE '%gamisco%'`,
    [day]
  );
  console.log('inventory_core all gamisco adunit total', auSum[0]);

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
