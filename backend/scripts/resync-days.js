/**
 * Re-pull GAM data for specific days, directly (no queue), newest day first.
 * Same code path as the queue's `sync-day` job: pulls every lean slice, upserts report_grain,
 * deletes stale rows of refreshed slices, rebuilds rollups and rollup_network_daily.
 *
 * Usage (on a server with GAM credentials in .env):
 *   node scripts/resync-days.js --client mediamonetix --start 2026-11-03 --end 2026-11-14
 *
 * Safe to re-run. Run it in the background for long ranges:
 *   nohup node scripts/resync-days.js --client mediamonetix --start 2026-09-18 --end 2026-11-14 > /root/resync.log 2>&1 &
 */
require('dotenv').config();
const { listActiveClients } = require('../src/models/clientStore');
const { runWithClient } = require('../src/utils/clientContext');
const { shiftYMD } = require('../src/utils/datetime');
const { streamSyncFromGAM } = require('../src/services/gamSyncService');

function arg(name, def = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}

const START = arg('start');
const END = arg('end');
const ONLY = arg('client').toLowerCase();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function syncDay(day) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const n = await streamSyncFromGAM(day, day, 'sync-day');
      return n;
    } catch (e) {
      const yielded = e && (e.yieldToToday || /today[- ]priority/i.test(String(e.message)));
      if (!yielded || attempt === 5) throw e;
      console.log(`  ${day}: paused for today's sync, retrying in 60s (attempt ${attempt})`);
      await sleep(60000);
    }
  }
  return 0;
}

async function main() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(START) || !/^\d{4}-\d{2}-\d{2}$/.test(END) || !ONLY) {
    console.error('Usage: node scripts/resync-days.js --client <name part> --start YYYY-MM-DD --end YYYY-MM-DD');
    process.exit(1);
  }
  const clients = (await listActiveClients()).filter((c) => String(c.name || '').toLowerCase().includes(ONLY));
  if (!clients.length) { console.error(`No active client matches "${ONLY}"`); process.exit(1); }

  const days = [];
  for (let d = END; d >= START; d = shiftYMD(d, -1)) days.push(d);

  for (const client of clients) {
    console.log(`\n== ${client.name} (${String(client.id).slice(0, 8)}) ${days.length} day(s), newest first`);
    await runWithClient(client, async () => {
      let ok = 0; let failed = 0;
      for (const day of days) {
        const t0 = Date.now();
        try {
          const n = await syncDay(day);
          ok += 1;
          console.log(`  ${day}: ok, ${n} rows in ${Math.round((Date.now() - t0) / 1000)}s`);
        } catch (e) {
          failed += 1;
          console.log(`  ${day}: FAILED ${String(e.message || e).slice(0, 200)}`);
        }
      }
      console.log(`  done: ${ok} ok, ${failed} failed`);
    });
  }
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
