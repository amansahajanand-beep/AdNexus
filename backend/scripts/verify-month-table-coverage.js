require('dotenv').config();
const { initSchema, query } = require('../src/db');
const { runWithClient } = require('../src/utils/clientContext');
const { fetchBundleTableRows } = require('../src/services/gamSyncService');

(async () => {
  await initSchema();
  const clientId = (await query(
    `SELECT DISTINCT client_id AS id FROM rollup_kpi_daily WHERE client_id IS NOT NULL LIMIT 1`
  )).rows[0]?.id;
  if (!clientId) throw new Error('no client');

  await runWithClient({ id: clientId }, async () => {
    const t0 = Date.now();
    // Direct export — fetchBundleTableRows may not be exported; use bundle instead
    const { fetchLeanDashboardBundleFromDB } = require('../src/services/gamSyncService');
    console.log('fetching…');
    const b = await fetchLeanDashboardBundleFromDB('2026-08-01', '2026-08-24', {
      skipAdUnitLike: true,
      tableLimit: 2500,
    });
    const dates = [...new Set((b?.rows || []).map((r) => String(r.date || r.report_date).slice(0, 10)))].sort();
    const miss = [];
    for (let d = 1; d <= 24; d += 1) {
      const ymd = `2026-08-${String(d).padStart(2, '0')}`;
      if (!dates.includes(ymd)) miss.push(ymd);
    }
    console.log(JSON.stringify({
      ms: Date.now() - t0,
      source: b?.source,
      rows: b?.rows?.length,
      days: dates.length,
      first: dates[0],
      last: dates[dates.length - 1],
      missingDays: miss,
      trendDays: (b?.trend || []).length,
    }, null, 2));
  });
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
