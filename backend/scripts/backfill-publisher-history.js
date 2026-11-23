/**
 * Backfill AdMob and/or AdSense history (facts + dims + grain + rollups) in date chunks.
 *
 * Usage: node scripts/backfill-publisher-history.js [product] [startDate] [endDate] [chunkDays]
 *   product    admob | adsense | both        (default both)
 *   startDate  YYYY-MM-DD                    (default 2018-01-01; before an account existed = empty, harmless)
 *   endDate    YYYY-MM-DD                    (default today)
 *   chunkDays  days per API call             (default 31)
 * Env: PUBLISHER_BACKFILL_PAUSE_MS (default 1500) delay between chunks to respect API quotas.
 * Safe to re-run: all writes are upserts. A failed chunk is logged and skipped, then listed at the end.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { initSchema } = require('../src/db');
const { admobAccountStore, adsenseAccountStore } = require('../src/models/publisherAccountStore');
const { getClientById } = require('../src/models/clientStore');
const { runWithClient } = require('../src/utils/clientContext');
const { query } = require('../src/db');
const { syncAdMobAccount } = require('../src/services/admobSyncService');
const { syncAdSenseAccount } = require('../src/services/adsenseSyncService');
const { todayInTZ, shiftYMD } = require('../src/utils/datetime');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function backfill(label, table, store, syncFn, startDate, endDate, chunkDays, pauseMs) {
  const { rows: ids } = await query(`SELECT id, client_id FROM ${table} WHERE is_active = true`);
  const failures = [];
  for (const row of ids) {
    const account = await store.getAccountById(row.id);
    if (!account?.refreshToken || !account?.accountId) {
      console.log(`[${label}] skip ${row.id}: no token/account id`);
      continue;
    }
    const client = await getClientById(account.clientId || row.client_id);
    if (!client) {
      console.log(`[${label}] skip ${account.accountId}: no client`);
      continue;
    }
    await runWithClient(client, async () => {
      let from = startDate;
      let total = 0;
      while (from <= endDate) {
        const to = shiftYMD(from, chunkDays - 1) > endDate ? endDate : shiftYMD(from, chunkDays - 1);
        try {
          const r = await syncFn(account, {
            startDate: from, endDate: to, gamClient: client, fullDims: true,
          });
          total += r.rows || 0;
          console.log(`[${label}] ${account.accountId} ${from}→${to}: ${r.rows} fact, ${r.dimRows} dim, ${r.grainRows} grain`);
        } catch (e) {
          failures.push(`${label} ${account.accountId} ${from}→${to}: ${e.message}`);
          console.warn(`[${label}] ${account.accountId} ${from}→${to} FAILED: ${e.message}`);
        }
        from = shiftYMD(to, 1);
        await sleep(pauseMs);
      }
      console.log(`[${label}] ${account.accountId} done — ${total} fact rows`);
    });
  }
  return failures;
}

(async () => {
  const product = (process.argv[2] || 'both').toLowerCase();
  const startDate = process.argv[3] || '2018-01-01';
  const endDate = process.argv[4] || todayInTZ();
  const chunkDays = parseInt(process.argv[5] || '31', 10) || 31;
  const pauseMs = parseInt(process.env.PUBLISHER_BACKFILL_PAUSE_MS || '1500', 10);

  await initSchema();
  const failures = [];
  if (product === 'admob' || product === 'both') {
    failures.push(...await backfill('admob', 'admob_accounts', admobAccountStore, syncAdMobAccount, startDate, endDate, chunkDays, pauseMs));
  }
  if (product === 'adsense' || product === 'both') {
    failures.push(...await backfill('adsense', 'adsense_accounts', adsenseAccountStore, syncAdSenseAccount, startDate, endDate, chunkDays, pauseMs));
  }
  console.log(failures.length ? `\n${failures.length} chunk(s) failed:\n${failures.join('\n')}` : '\nAll chunks OK');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
