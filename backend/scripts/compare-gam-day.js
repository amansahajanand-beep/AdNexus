/**
 * Compare DB network rollup vs live GAM for a past date.
 * Usage: node scripts/compare-gam-day.js 2026-08-11
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { runWithClient } = require('../src/utils/clientContext');
const { ensureBootstrapFromEnv } = require('../src/models/clientStore');
const { compareDay } = require('../src/services/gamReconciliationService');
const { fetchNetworkDayRow } = require('../src/services/networkRollupStore');

async function main() {
  const day = process.argv[2];
  if (!day) {
    console.error('Usage: node scripts/compare-gam-day.js <YYYY-MM-DD>');
    process.exit(1);
  }

  const client = await ensureBootstrapFromEnv();
  await runWithClient(client, async () => {
    const row = await fetchNetworkDayRow(day);
    console.log('DB rollup_network_daily:', row ? {
      rev: row.revenue,
      imp: row.impressions,
      gam_rev: row.gam_revenue,
      delta_pct: row.delta_pct,
      reconciled_at: row.reconciled_at,
    } : null);

    console.log('Fetching live GAM network total…');
    const cmp = await compareDay(day);
    console.log('Compare:', cmp);
    if (cmp.gamRev != null && cmp.dbRev != null) {
      const gap = +(cmp.gamRev - cmp.dbRev).toFixed(2);
      console.log(`Gap: $${gap} (${cmp.deltaPct}% vs GAM)`);
    }
  });
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
}).then(() => process.exit(0));
