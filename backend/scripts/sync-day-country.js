/**
 * Sync lean country grain for a single day (inventory_core + app_id).
 * Usage: node scripts/sync-day-country.js 2026-09-13
 */
const day = process.argv[2];
if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) {
  console.error('Usage: node scripts/sync-day-country.js YYYY-MM-DD');
  process.exit(1);
}

const { listActiveClients } = require('../src/models/clientStore');
const { runWithClient } = require('../src/utils/clientContext');
const { streamSyncFromGAM } = require('../src/services/gamSyncService');

(async () => {
  const clients = await listActiveClients();
  if (!clients.length) throw new Error('no active clients');
  await runWithClient(clients[0], async () => {
    console.log(`Syncing country grain for ${day}…`);
    const result = await streamSyncFromGAM(day, day, 'sync-day-country-fix', {
      sliceKeys: ['inventory_core', 'app_id'],
    });
    console.log('Done:', result);
  });
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
