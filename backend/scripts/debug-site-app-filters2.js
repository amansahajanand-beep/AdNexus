require('dotenv').config();
const { initSchema, query } = require('../src/db');
const { runWithClient } = require('../src/utils/clientContext');

(async () => {
  await initSchema();
  const { rows: clients } = await query(`SELECT id FROM gam_clients LIMIT 1`);
  const clientId = clients[0]?.id
    || (await query(`SELECT DISTINCT client_id AS id FROM report_grain WHERE client_id IS NOT NULL LIMIT 1`)).rows[0]?.id;
  if (!clientId) throw new Error('no client');
  console.log('clientId', clientId);

  await runWithClient({ id: clientId }, async () => {
    // Compare rollup inv_site vs inventory_core site dim for same day
    const { rows: coreSites } = await query(
      `SELECT LOWER(TRIM(ds.name)) AS s, SUM(g.revenue)::float8 AS rev, COUNT(*)::int AS n
       FROM report_grain g
       LEFT JOIN dim_site ds ON ds.id = g.site_id
       WHERE g.client_id = $1::uuid
         AND g.report_date = '2026-08-22'::date
         AND g.slice_key = 'inventory_core'
         AND COALESCE(TRIM(ds.name), '') <> ''
         AND (
           LOWER(ds.name) LIKE '%quickplayhub%'
           OR LOWER(ds.name) LIKE '%gamebolte%'
         )
       GROUP BY 1 ORDER BY rev DESC LIMIT 20`,
      [clientId]
    );
    console.log('inventory_core dim_site', coreSites);

    const { rows: channelSites } = await query(
      `SELECT LOWER(TRIM(ds.name)) AS s, SUM(g.revenue)::float8 AS rev
       FROM report_grain g
       LEFT JOIN dim_site ds ON ds.id = g.site_id
       WHERE g.client_id = $1::uuid
         AND g.report_date = '2026-08-22'::date
         AND g.slice_key = 'channel'
         AND COALESCE(TRIM(ds.name), '') <> ''
         AND (
           LOWER(ds.name) LIKE '%quickplayhub%'
           OR LOWER(ds.name) LIKE '%gamebolte%'
         )
       GROUP BY 1 ORDER BY rev DESC LIMIT 20`,
      [clientId]
    );
    console.log('channel dim_site', channelSites);

    // Catalog sites that look like gameN.
    const { rows: cat } = await query(
      `SELECT DISTINCT LOWER(TRIM(site_url)) AS s
       FROM inventory_catalog
       WHERE site_url ILIKE '%quickplayhub%' OR site_url ILIKE '%gamebolte%'
       ORDER BY 1 LIMIT 40`
    ).catch(async () => {
      // try alternate table names
      const r = await query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema='public' AND table_name ILIKE '%catalog%' OR table_name ILIKE '%site%'`
      );
      console.log('tables', r.rows);
      return { rows: [] };
    });
    console.log('catalog sites sample', cat);

    // Simulate site-only for game10.quickplayhub.in vs d1.quickplayhub.in
    const { fetchLeanDashboardBundleFromDB } = require('../src/services/gamSyncService');
    for (const site of ['game10.quickplayhub.in', 'd1.quickplayhub.in', 'game15.gamebolte.com', 'd1.gamebolte.com']) {
      const b = await fetchLeanDashboardBundleFromDB('2026-08-22', '2026-08-22', {
        sites: [site],
        skipAdUnitLike: true,
        tableLimit: 100,
      });
      console.log('bundle', site, b ? { source: b.source, rev: b.summary?.revenue, rows: b.rows?.length } : null);
    }

    // App probe
    const { rows: apps } = await query(
      `SELECT app_id, SUM(revenue)::float8 AS rev
       FROM report_grain
       WHERE client_id = $1::uuid AND report_date = '2026-08-22'::date AND slice_key = 'app_id'
         AND COALESCE(app_id,'') <> '' AND LOWER(app_id) NOT LIKE '%not applicable%'
       GROUP BY 1 ORDER BY rev DESC LIMIT 5`,
      [clientId]
    );
    console.log('top apps', apps);
    if (apps[0]) {
      const b = await fetchLeanDashboardBundleFromDB('2026-08-22', '2026-08-22', {
        apps: [apps[0].app_id],
        skipAdUnitLike: true,
        tableLimit: 100,
      });
      console.log('app bundle', {
        app: apps[0].app_id,
        source: b?.source,
        rev: b?.summary?.revenue,
        rows: b?.rows?.length,
        sample: b?.rows?.slice(0, 2),
      });
    }
  });

  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
