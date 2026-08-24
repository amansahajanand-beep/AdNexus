require('dotenv').config();
const { initSchema, query } = require('../src/db');
const { runWithClient } = require('../src/utils/clientContext');
const { fetchLeanOverviewTotalsFromDB, fetchLeanDashboardBundleFromDB } = require('../src/services/gamSyncService');

(async () => {
  await initSchema();
  const clientId = (await query(`SELECT id FROM gam_clients LIMIT 1`)).rows[0]?.id
    || (await query(`SELECT DISTINCT client_id AS id FROM report_grain WHERE client_id IS NOT NULL LIMIT 1`)).rows[0]?.id;

  await runWithClient({ id: clientId }, async () => {
    const day = '2026-08-24';
    const ov = await fetchLeanOverviewTotalsFromDB(day, day, {});
    console.log('unfiltered overview', ov);

    const { rows: sites } = await query(
      `SELECT LOWER(TRIM(ds.name)) AS s
       FROM report_grain g
       JOIN dim_site ds ON ds.id = g.site_id AND ds.client_id = g.client_id
       WHERE g.client_id = $1::uuid AND g.report_date = $2::date
         AND g.slice_key = 'inventory_core' AND COALESCE(TRIM(ds.name),'') <> ''
       GROUP BY 1 ORDER BY SUM(g.revenue) DESC LIMIT 48`,
      [clientId, day]
    );
    const b = await fetchLeanDashboardBundleFromDB(day, day, {
      sites: sites.map((r) => r.s),
      skipAdUnitLike: true,
      tableLimit: 5000,
    });
    console.log('top48 sites', {
      source: b?.source,
      rev: b?.summary?.revenue,
      imp: b?.summary?.impressions,
      ecpm: b?.summary?.ecpm,
      rows: b?.rows?.length,
      sample: b?.rows?.slice(0, 3).map((r) => ({
        s: r.siteUrl, rev: r.revenue, imp: r.impression, ecpm: r.ecpm,
      })),
    });
  });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
