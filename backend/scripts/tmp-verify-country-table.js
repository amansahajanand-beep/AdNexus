/**
 * Quick check: reporting id-grain country table for today should return many countries.
 */
const { listActiveClients } = require('../src/models/clientStore');
const { runWithClient } = require('../src/utils/clientContext');
const { fetchReportingBundleFromDB } = require('../src/services/gamSyncService');

(async () => {
  const clients = await listActiveClients();
  if (!clients.length) throw new Error('no clients');
  await runWithClient(clients[0], async () => {
    const bundle = await fetchReportingBundleFromDB('2026-09-14', '2026-09-14', {
      groupByCountry: true,
      groupBySite: true,
      tableGrain: 'site',
      tableLimit: 25000,
      reportingFast: true,
      skipCharts: true,
    });
    const rows = bundle?.rows || [];
    const countries = new Set(rows.map((r) => String(r.country || '').trim()).filter(Boolean));
    console.log(JSON.stringify({
      source: bundle?.source,
      rowCount: rows.length,
      countryCount: countries.size,
      sampleCountries: [...countries].slice(0, 15),
      revenue: bundle?.summary?.revenue,
    }, null, 2));
  });
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
