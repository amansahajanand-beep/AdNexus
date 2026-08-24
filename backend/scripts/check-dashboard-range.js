require('dotenv').config();
const { ensureBootstrapFromEnv } = require('../src/models/clientStore');
const { runWithClient } = require('../src/utils/clientContext');
const { todayInTZ, shiftYMD } = require('../src/utils/datetime');
const { fetchLeanDashboardBundleFromDB } = require('../src/services/gamSyncService');

async function main() {
  const today = todayInTZ();
  const ranges = [
    ['last7', shiftYMD(today, -6), today],
    ['last30', shiftYMD(today, -29), today],
  ];
  const client = await ensureBootstrapFromEnv();
  await runWithClient(client, async () => {
    for (const [label, start, end] of ranges) {
      const bundle = await fetchLeanDashboardBundleFromDB(start, end, { tableLimit: 2500 });
      const trendDates = (bundle?.trend || []).map((t) => t.date);
      const rowDates = [...new Set((bundle?.rows || []).map((r) => r.report_date || r.date))].sort();
      console.log(`\n=== ${label} ${start}..${end} source=${bundle?.source} ===`);
      console.log(`trend days (${trendDates.length}):`, trendDates.join(', ') || '(none)');
      console.log(`table unique dates (${rowDates.length}):`, rowDates.slice(0, 10).join(', '), rowDates.length > 10 ? '...' : '');
      console.log(`table rows: ${bundle?.rows?.length || 0}, impressions summary: ${bundle?.summary?.impressions}`);
    }
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
