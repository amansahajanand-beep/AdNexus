/**
 * Compare DB vs live GAM and enqueue resync for divergent days.
 * Usage: node scripts/reconcile-gam-totals.js [start] [end] [--dry-run]
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { runWithClient } = require('../src/utils/clientContext');
const { ensureBootstrapFromEnv } = require('../src/models/clientStore');
const { historicalRangeForPresets } = require('../src/utils/datetime');
const { fixRange, compareRange } = require('../src/services/gamReconciliationService');

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const dryRun = process.argv.includes('--dry-run');
  const hist = historicalRangeForPresets();
  const startDate = args[0] || hist.startDate;
  const endDate = args[1] || hist.yesterday;

  const client = await ensureBootstrapFromEnv();
  await runWithClient(client, async () => {
    console.log(`Reconciling ${startDate} → ${endDate}${dryRun ? ' (dry-run)' : ''}…`);
    const preview = await compareRange(startDate, endDate);
    console.log(`Checked ${preview.results.length} days, divergent=${preview.divergent.length}`);
    const res = await fixRange(startDate, endDate, { dryRun });
    console.log(`Done: checked=${res.checked} divergent=${res.divergent} actions=${res.fixed?.length || 0}`);
    for (const row of (res.fixed || []).slice(0, 20)) {
      console.log(`  ${row.day}: ${row.action} delta=${row.deltaPct}% db=${row.dbRev} gam=${row.gamRev}`);
    }
  });
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
}).then(() => process.exit(0));
