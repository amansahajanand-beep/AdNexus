/**
 * Compare DB network rollup sum vs live GAM for a date range.
 * Usage: node scripts/compare-gam-range.js 2026-08-25 2026-08-31
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { runWithClient } = require('../src/utils/clientContext');
const { ensureBootstrapFromEnv } = require('../src/models/clientStore');
const {
  compareRange,
  fetchLiveGamNetworkTotal,
} = require('../src/services/gamReconciliationService');
const { fetchNetworkTotalsFromDB } = require('../src/services/networkRollupStore');

async function main() {
  const startDate = process.argv[2];
  const endDate = process.argv[3] || startDate;
  if (!startDate) {
    console.error('Usage: node scripts/compare-gam-range.js <start> [end]');
    process.exit(1);
  }

  const client = await ensureBootstrapFromEnv();
  await runWithClient(client, async () => {
    const db = await fetchNetworkTotalsFromDB(startDate, endDate);
    const dbRev = +Number(db.revenue || 0).toFixed(2);
    const dbImp = Math.round(Number(db.impressions) || 0);

    console.log(`Range: ${startDate} → ${endDate}`);
    console.log(`DB rollup_network_daily: revenue=${dbRev} impressions=${dbImp} days=${db.day_count || 0}`);

    const { results, divergent } = await compareRange(startDate, endDate);
    let gamRev = 0;
    let gamImp = 0;
    for (const row of results) {
      if (row.gamRev != null) gamRev += row.gamRev;
      if (row.gamImp != null) gamImp += row.gamImp;
    }
    gamRev = +gamRev.toFixed(2);
    gamImp = Math.round(gamImp);

    console.log(`Live GAM (per-day sum): revenue=${gamRev} impressions=${gamImp}`);
    const deltaPct = gamRev > 0 ? +((Math.abs(dbRev - gamRev) / gamRev) * 100).toFixed(2) : null;
    console.log(`Range delta: ${deltaPct != null ? `${deltaPct}%` : 'n/a'}`);
    console.log(`Divergent days: ${divergent.length}`);
    if (divergent.length) {
      for (const d of divergent.slice(0, 10)) {
        console.log(`  ${d.day}: db=${d.dbRev} gam=${d.gamRev} delta=${d.deltaPct}%`);
      }
      if (divergent.length > 10) console.log(`  … and ${divergent.length - 10} more`);
    }

    // Single-shot GAM range total (when range is small)
    if (startDate === endDate) {
      const single = await fetchLiveGamNetworkTotal(startDate);
      console.log(`Live GAM (single day): revenue=${single.revenue} impressions=${single.impressions}`);
    }
  });
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
}).then(() => process.exit(0));
