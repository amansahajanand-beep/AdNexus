require('dotenv').config();
const { initSchema, query } = require('../src/db');

(async () => {
  await initSchema();
  const { rows: users } = await query(
    `SELECT id, username, role, permissions
     FROM users
     WHERE username ILIKE '%mediamonetix%' OR username ILIKE '%dashboard%'
     LIMIT 15`
  );
  for (const u of users) {
    const p = u.permissions || {};
    console.log({
      username: u.username,
      role: u.role,
      domains: (p.allowedDomains || []).slice(0, 8),
      domainCount: (p.allowedDomains || []).length,
      sites: (p.allowedSites || []).slice(0, 12),
      siteCount: (p.allowedSites || []).length,
      apps: (p.allowedAppIds || []).slice(0, 8),
      appCount: (p.allowedAppIds || []).length,
    });
  }

  // What sites exist for Aug 22 that look like GAM screenshot?
  const { rows: siteMatch } = await query(
    `SELECT LOWER(TRIM(inv_site)) AS s, SUM(revenue)::float8 AS rev, SUM(impressions)::float8 AS imp
     FROM rollup_kpi_daily
     WHERE report_date = '2026-08-22'::date
       AND (
         LOWER(inv_site) LIKE '%quickplay%'
         OR LOWER(inv_site) LIKE '%gamebolte%'
         OR LOWER(inv_site) LIKE '%game10%'
       )
     GROUP BY 1 ORDER BY rev DESC LIMIT 20`
  );
  console.log('rollup quickplay/gamebolte sites', siteMatch);

  const { rows: grainSites } = await query(
    `SELECT slice_key, COUNT(*)::int AS n,
            SUM(revenue)::float8 AS rev
     FROM report_grain
     WHERE report_date = '2026-08-22'::date
     GROUP BY 1 ORDER BY n DESC`
  );
  console.log('grain by slice', grainSites);

  const { rows: invSites } = await query(
    `SELECT LOWER(TRIM(site_name)) AS s, SUM(revenue)::float8 AS rev
     FROM report_grain g
     LEFT JOIN dim_site ds ON ds.id = g.site_id
     WHERE g.report_date = '2026-08-22'::date
       AND g.slice_key IN ('inventory_core', 'channel')
       AND (
         LOWER(COALESCE(ds.name, g.site_name, '')) LIKE '%quickplay%'
         OR LOWER(COALESCE(ds.name, g.site_name, '')) LIKE '%gamebolte%'
       )
     GROUP BY 1 ORDER BY rev DESC LIMIT 15`
  );
  console.log('grain site_name matches', invSites);

  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
