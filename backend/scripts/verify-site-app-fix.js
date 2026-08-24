require('dotenv').config();
const { initSchema, query } = require('../src/db');
const { runWithClient } = require('../src/utils/clientContext');
const { fetchLeanDashboardBundleFromDB, fetchLeanOverviewTotalsFromDB } = require('../src/services/gamSyncService');

(async () => {
  await initSchema();
  const clientId = (await query(
    `SELECT id FROM gam_clients LIMIT 1`
  )).rows[0]?.id
    || (await query(`SELECT DISTINCT client_id AS id FROM report_grain WHERE client_id IS NOT NULL LIMIT 1`)).rows[0]?.id;

  await runWithClient({ id: clientId }, async () => {
    const day = '2026-08-22';
    const exact = { skipAdUnitLike: true, webInventoryOr: false, tableLimit: 500 };

    for (const site of ['game10.quickplayhub.in', 'quiz10.gamebolte.com', 'game12.gamebolte.com']) {
      const [ov, b] = await Promise.all([
        fetchLeanOverviewTotalsFromDB(day, day, { ...exact, sites: [site] }),
        fetchLeanDashboardBundleFromDB(day, day, { ...exact, sites: [site] }),
      ]);
      console.log('SITE', site, {
        overview: ov && { source: ov.source, rev: ov.revenue, imp: ov.impressions },
        bundle: b && {
          source: b.source,
          rev: b.summary?.revenue,
          rows: b.rows?.length,
          sample: b.rows?.slice(0, 2).map((r) => ({
            d: r.domainName, s: r.siteUrl, rev: r.revenue,
          })),
        },
      });
    }

    // Site-only all quickplayhub sites for day — compare to GAM-ish total
    const { rows: topSites } = await query(
      `SELECT LOWER(TRIM(ds.name)) AS s
       FROM report_grain g
       LEFT JOIN dim_site ds ON ds.id = g.site_id AND ds.client_id = g.client_id
       WHERE g.client_id = $1::uuid AND g.report_date = $2::date
         AND g.slice_key = 'inventory_core'
         AND COALESCE(TRIM(ds.name), '') <> ''
         AND LOWER(ds.name) LIKE '%.quickplayhub.in'
       GROUP BY 1 ORDER BY SUM(g.revenue) DESC LIMIT 48`,
      [clientId, day]
    );
    const sites = topSites.map((r) => r.s);
    const multi = await fetchLeanDashboardBundleFromDB(day, day, {
      ...exact,
      sites,
      tableLimit: 5000,
    });
    console.log('multi site quickplayhub', {
      nSites: sites.length,
      source: multi?.source,
      rev: multi?.summary?.revenue,
      imp: multi?.summary?.impressions,
      rows: multi?.rows?.length,
    });

    const appId = 'com.allmedia.fastsave.quickvideohub';
    const appB = await fetchLeanDashboardBundleFromDB(day, day, { ...exact, apps: [appId] });
    console.log('APP', {
      source: appB?.source,
      rev: appB?.summary?.revenue,
      rows: appB?.rows?.length,
      appId: appB?.rows?.[0]?.appId,
    });
  });

  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
