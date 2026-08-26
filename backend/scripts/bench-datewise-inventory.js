/** Verify datewise inventory rows (unfiltered + site filter). */
require('dotenv').config();
const { runWithClient } = require('../src/utils/clientContext');
const { listActiveClients } = require('../src/models/clientStore');

(async () => {
  const clients = await listActiveClients();
  if (!clients[0]) throw new Error('No client');
  await runWithClient(clients[0], async () => {
    const svc = require('../src/services/gamSyncService');
    const cases = [
      { label: '7d', start: '2026-08-20', end: '2026-08-26', opts: {} },
      { label: '30d', start: '2026-07-28', end: '2026-08-26', opts: {} },
      {
        label: '7d+4sites',
        start: '2026-08-20',
        end: '2026-08-26',
        opts: {
          sites: [
            'quiz13.arenapro6.com',
            'finance1.zoplayy.com',
            'finance1.gamioo5.com',
            'www.gamisco.com',
          ],
        },
      },
    ];
    for (const c of cases) {
      const t0 = Date.now();
      const b = await svc.fetchLeanDashboardBundleFromDB(c.start, c.end, {
        ...c.opts,
        tableLimit: 15000,
      });
      const rows = b?.rows || [];
      const dates = [...new Set(rows.map((r) => r.date || r.report_date).filter(Boolean))].sort();
      const allSameEnd = dates.length === 1 && dates[0] === c.end;
      console.log(JSON.stringify({
        label: c.label,
        source: b?.source,
        ms: Date.now() - t0,
        rows: rows.length,
        distinctDates: dates.length,
        firstDate: dates[0],
        lastDate: dates[dates.length - 1],
        wronglyCollapsedToEndDate: allSameEnd && c.start !== c.end,
        sample: rows.slice(0, 3).map((r) => ({
          date: r.date || r.report_date,
          site: r.siteUrl || r.site,
          rev: r.revenue,
        })),
      }, null, 2));
    }
  });
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
