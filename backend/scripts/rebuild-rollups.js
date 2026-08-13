/**
 * Rebuild dashboard rollups from grain tables (fixes revenue after metric normalization).
 * Usage:
 *   node scripts/rebuild-rollups.js --all
 *   node scripts/rebuild-rollups.js 2026-08-01 2026-08-11
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { query } = require('../src/db');
const { runWithClient } = require('../src/utils/clientContext');
const { ensureBootstrapFromEnv } = require('../src/models/clientStore');
const { historicalRangeForPresets, todayInTZ, shiftYMD } = require('../src/utils/datetime');

function dateRange(start, end) {
  const out = [];
  let d = start;
  while (d <= end) {
    out.push(d);
    d = shiftYMD(d, 1);
  }
  return out;
}

async function main() {
  const hist = historicalRangeForPresets();
  const today = todayInTZ();
  let startDate;
  let endDate;

  if (process.argv[2] === '--all') {
    startDate = hist.startDate;
    endDate = hist.endDate;
  } else {
    endDate = process.argv[3] || process.argv[2] || hist.endDate;
    startDate = process.argv[3] ? process.argv[2] : shiftYMD(endDate, -30);
  }

  if (endDate >= today) endDate = hist.endDate;

  const client = await ensureBootstrapFromEnv();
  if (!client?.id) throw new Error('No GAM client configured');

  const dates = dateRange(startDate, endDate);
  console.log(`Rebuilding rollups for ${dates.length} day(s): ${startDate} .. ${endDate}`);

  const { rebuildRollupsForDates, invalidateCacheForDate } = require('../src/services/gamSyncService');

  await runWithClient(client, async () => {
    const CHUNK = 7;
    let total = 0;
    for (let i = 0; i < dates.length; i += CHUNK) {
      const chunk = dates.slice(i, i + CHUNK);
      const n = await rebuildRollupsForDates(chunk, 'manual-rebuild');
      total += n;
      for (const d of chunk) {
        try { await invalidateCacheForDate(d); } catch (_) { /* ignore */ }
      }
      console.log(`  ${chunk[0]}..${chunk[chunk.length - 1]} → ${n} KPI row(s)`);
    }
    console.log(`Done — ${total} KPI rollup row(s) written.`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
