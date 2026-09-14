/**
 * Diagnose App ID × Country and App+Site+Domain × Country reporting paths.
 */
const { listActiveClients } = require('../src/models/clientStore');
const { runWithClient } = require('../src/utils/clientContext');
const { fetchReportingBundleFromDB } = require('../src/services/gamSyncService');
const { query } = require('../src/db');

function summarize(label, bundle) {
  const rows = bundle?.rows || [];
  const countries = [...new Set(rows.map((r) => String(r.country || '').trim()).filter(Boolean))];
  const apps = [...new Set(rows.map((r) => String(r.appId || r.appPackage || '').trim()).filter(Boolean))];
  const sites = [...new Set(rows.map((r) => String(r.siteName || r.site || r.siteUrl || '').trim()).filter(Boolean))];
  console.log(JSON.stringify({
    label,
    source: bundle?.source || null,
    rowCount: rows.length,
    countryCount: countries.length,
    appCount: apps.length,
    siteCount: sites.length,
    sampleCountries: countries.slice(0, 8),
    sampleApps: apps.slice(0, 5),
    sampleSites: sites.slice(0, 5),
    revenue: bundle?.summary?.revenue,
  }, null, 2));
}

(async () => {
  const clients = await listActiveClients();
  await runWithClient(clients[0], async () => {
    const day = '2026-09-14';

    const appSample = await query(`
      SELECT DISTINCT NULLIF(TRIM(COALESCE(NULLIF(g.app_id,''), g.app_name)), '') AS app
      FROM report_grain g
      WHERE g.slice_key='app_id' AND g.report_date=$1::date
        AND g.country_id <> 0
        AND NULLIF(TRIM(COALESCE(NULLIF(g.app_id,''), g.app_name)), '') IS NOT NULL
      ORDER BY 1 LIMIT 3
    `, [day]);
    const apps = appSample.rows.map((r) => r.app).filter(Boolean);
    console.log('sample apps', apps);

    // 1) App ID column + Country
    summarize('app+country dims', await fetchReportingBundleFromDB(day, day, {
      groupByCountry: true,
      groupByApp: true,
      groupBySite: false,
      tableGrain: 'app',
      tableLimit: 25000,
      reportingFast: true,
      skipCharts: true,
    }));

    // 2) App filter + Country
    if (apps[0]) {
      summarize('app filter+country', await fetchReportingBundleFromDB(day, day, {
        apps: [apps[0]],
        groupByCountry: true,
        groupByApp: true,
        groupBySite: false,
        tableGrain: 'app',
        tableLimit: 25000,
        reportingFast: true,
        skipCharts: true,
      }));
    }

    // 3) Default site+domain + App ID + Country (union case)
    summarize('site+domain+app+country', await fetchReportingBundleFromDB(day, day, {
      groupByCountry: true,
      groupByApp: true,
      groupBySite: true,
      tableGrain: 'site',
      tableLimit: 25000,
      reportingFast: true,
      skipCharts: true,
    }));

    // 4) App filter + site/domain columns + country
    if (apps[0]) {
      summarize('app filter + site dims + country', await fetchReportingBundleFromDB(day, day, {
        apps: [apps[0]],
        groupByCountry: true,
        groupByApp: true,
        groupBySite: true,
        tableGrain: 'site',
        tableLimit: 25000,
        reportingFast: true,
        skipCharts: true,
      }));
    }

    const cnt = await query(`
      SELECT
        COUNT(*) FILTER (WHERE country_id<>0)::int AS with_country,
        COUNT(DISTINCT country_id) FILTER (WHERE country_id<>0)::int AS countries,
        COUNT(DISTINCT NULLIF(TRIM(COALESCE(NULLIF(app_id,''), app_name)), ''))::int AS apps
      FROM report_grain
      WHERE slice_key='app_id' AND report_date=$1::date
    `, [day]);
    console.log('app_id grain', cnt.rows[0]);
  });
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
