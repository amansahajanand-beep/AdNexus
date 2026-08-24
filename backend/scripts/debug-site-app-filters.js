require('dotenv').config();
const { initSchema, query } = require('../src/db');
const { fetchLeanDashboardBundleFromDB } = require('../src/services/gamSyncService');
const { normalizeReportRows } = require('../src/utils/rowNormalize');

(async () => {
  await initSchema();
  const day = '2026-08-22';
  const exact = { skipAdUnitLike: true, webInventoryOr: false };

  const { rows: sites } = await query(
    `SELECT DISTINCT LOWER(TRIM(inv_site)) AS s, SUM(revenue)::float8 AS rev
     FROM rollup_kpi_daily
     WHERE report_date = $1::date AND COALESCE(TRIM(inv_site), '') <> ''
     GROUP BY 1 ORDER BY rev DESC LIMIT 12`,
    [day]
  );
  console.log('top rollup sites', sites);

  const sampleSite = sites[0]?.s;
  if (sampleSite) {
    const b = await fetchLeanDashboardBundleFromDB(day, day, {
      ...exact,
      sites: [sampleSite],
      tableLimit: 5000,
    });
    console.log('site-only bundle', {
      site: sampleSite,
      source: b?.source,
      rev: b?.summary?.revenue,
      imp: b?.summary?.impressions,
      rows: b?.rows?.length,
      sample: normalizeReportRows(b?.rows || []).slice(0, 3).map((r) => ({
        d: r.domainName, s: r.siteUrl || r.siteName, rev: r.revenue,
      })),
    });
  }

  // Sites that look like GAM image (quickplayhub / gamebolte)
  for (const host of ['game10.quickplayhub.in', 'game15.gamebolte.com', 'quickplayhub.in']) {
    const b = await fetchLeanDashboardBundleFromDB(day, day, {
      ...exact,
      sites: [host],
      tableLimit: 500,
    });
    console.log('probe', host, {
      source: b?.source,
      rev: b?.summary?.revenue,
      rows: b?.rows?.length,
    });
  }

  const { rows: apps } = await query(
    `SELECT app_id, SUM(revenue)::float8 AS rev, SUM(impressions)::float8 AS imp
     FROM report_grain
     WHERE report_date = $1::date AND slice_key = 'app_id'
       AND COALESCE(app_id, '') <> ''
       AND LOWER(app_id) NOT LIKE '%not applicable%'
     GROUP BY 1 ORDER BY rev DESC LIMIT 8`,
    [day]
  );
  console.log('top apps', apps);

  const appId = apps[0]?.app_id;
  if (appId) {
    const b = await fetchLeanDashboardBundleFromDB(day, day, {
      ...exact,
      apps: [appId],
      tableLimit: 500,
    });
    console.log('app-only bundle', {
      appId,
      source: b?.source,
      rev: b?.summary?.revenue,
      imp: b?.summary?.impressions,
      rows: b?.rows?.length,
    });
  }

  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
