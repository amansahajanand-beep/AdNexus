/** Quick bench: long-range dashboard bundle accuracy + speed. */
require('dotenv').config();
const { runWithClient } = require('../src/utils/clientContext');
const { listActiveClients } = require('../src/models/clientStore');

(async () => {
  const clients = await listActiveClients();
  if (!clients[0]) throw new Error('No client');
  await runWithClient(clients[0], async () => {
    const svc = require('../src/services/gamSyncService');
    const ranges = [
      ['2026-07-28', '2026-08-26'], // ~1m (matches screenshot)
      ['2026-05-26', '2026-08-26'], // ~3m
    ];
    for (const [start, end] of ranges) {
      const t0 = Date.now();
      const b = await svc.fetchLeanDashboardBundleFromDB(start, end, { tableLimit: 15000 });
      const rows = b?.rows || [];
      const dates = [...new Set(rows.map((r) => r.date || r.report_date).filter(Boolean))].sort();
      const sample = rows.slice(0, 3).map((r) => ({
        date: r.date || r.report_date,
        domain: r.domainName || r.domain,
        site: r.siteUrl || r.site,
        rev: r.revenue,
      }));
      console.log(JSON.stringify({
        range: `${start}..${end}`,
        source: b?.source,
        ms: Date.now() - t0,
        rows: rows.length,
        distinctDates: dates.length,
        firstDate: dates[0],
        lastDate: dates[dates.length - 1],
        trendDays: (b?.trend || []).length,
        sample,
      }, null, 2));
    }
  });
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
