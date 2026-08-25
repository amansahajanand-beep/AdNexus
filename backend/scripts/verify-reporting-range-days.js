#!/usr/bin/env node
require('dotenv').config();
const { runWithClient } = require('../src/utils/clientContext');
const { listActiveClients } = require('../src/models/clientStore');
const { todayInTZ, shiftYMD } = require('../src/utils/datetime');

(async () => {
  const clients = await listActiveClients();
  const end = todayInTZ();
  const start30 = shiftYMD(end, -29);
  const start90 = shiftYMD(end, -89);
  await runWithClient(clients[0], async () => {
    const svc = require('../src/services/gamSyncService');
    const sites = ['quiz9.quickplayhub.in', 'quiz10.quickplayhub.in', 'game2.gamebolte.com'];
    for (const [label, start] of [['30d', start30], ['90d', start90]]) {
      const bundle = await svc.fetchLeanDashboardBundleFromDB(start, end, {
        sites,
        countryNames: ['india', 'united states'],
        tableLimit: 5000,
        skipAdUnitLike: true,
      });
      const dates = new Set((bundle?.rows || []).map((r) => r.date || r.report_date));
      const trendDays = (bundle?.trend || []).length;
      console.log({
        label,
        range: `${start}..${end}`,
        source: bundle?.source,
        rowDays: dates.size,
        trendDays,
        rows: bundle?.rows?.length,
        truncated: bundle?.pagination?.truncated,
        revenue: bundle?.summary?.revenue,
        firstDates: [...dates].sort().slice(0, 3),
        lastDates: [...dates].sort().slice(-3),
      });
    }
  });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
