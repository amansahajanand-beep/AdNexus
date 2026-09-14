const { listActiveClients } = require('../src/models/clientStore');
const { runWithClient } = require('../src/utils/clientContext');
const { fetchReportingBundleFromDB } = require('../src/services/gamSyncService');
const { expandAppFilterAliases, loadCachedAppPackageMaps } = require('../src/utils/appIdentity');

function summarize(label, bundle) {
  const rows = bundle?.rows || [];
  const countries = [...new Set(rows.map((r) => String(r.country || '').trim()).filter(Boolean))];
  const apps = [...new Set(rows.map((r) => String(r.appId || r.appPackage || '').trim()).filter((v) => v && v !== '(Not applicable)'))];
  console.log(JSON.stringify({
    label,
    source: bundle?.source || null,
    rowCount: rows.length,
    countryCount: countries.length,
    appCount: apps.length,
    sampleCountries: countries.slice(0, 8),
    sampleApps: apps.slice(0, 5),
    revenue: bundle?.summary?.revenue,
  }, null, 2));
}

(async () => {
  const maps = loadCachedAppPackageMaps();
  console.log('alias maps', {
    packages: maps.byPackage?.size || 0,
    names: maps.byName?.size || 0,
    ids: maps.byResolvedId?.size || 0,
    expanded284: expandAppFilterAliases(['284815942'], maps).slice(0, 8),
    expandedFb: expandAppFilterAliases(['com.facebook.katana'], maps).slice(0, 8),
  });

  const clients = await listActiveClients();
  await runWithClient(clients[0], async () => {
    const day = '2026-09-14';

    summarize('app×country (no sticky site)', await fetchReportingBundleFromDB(day, day, {
      groupByCountry: true,
      groupByApp: true,
      groupBySite: false,
      tableGrain: 'app',
      tableLimit: 25000,
      reportingFast: true,
      skipCharts: true,
    }));

    summarize('numeric app id + country', await fetchReportingBundleFromDB(day, day, {
      apps: ['284815942'],
      groupByCountry: true,
      groupByApp: true,
      groupBySite: false,
      tableGrain: 'app',
      tableLimit: 25000,
      reportingFast: true,
      skipCharts: true,
    }));

    summarize('package app + country', await fetchReportingBundleFromDB(day, day, {
      apps: ['com.facebook.katana'],
      groupByCountry: true,
      groupByApp: true,
      groupBySite: false,
      tableGrain: 'app',
      tableLimit: 25000,
      reportingFast: true,
      skipCharts: true,
    }));

    summarize('app + site + domain filters + country', await fetchReportingBundleFromDB(day, day, {
      apps: ['com.facebook.katana'],
      sites: ['finance4.quizboltz.com'],
      domains: ['quizboltz.com'],
      groupByCountry: true,
      groupByApp: true,
      groupBySite: true,
      tableGrain: 'site',
      tableLimit: 25000,
      reportingFast: true,
      skipCharts: true,
    }));
  });
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
