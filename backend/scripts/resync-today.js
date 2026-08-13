/**
 * Re-pull today from GAM and rebuild rollups (applies normalized revenue in DB).
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { runWithClient } = require('../src/utils/clientContext');
const { ensureBootstrapFromEnv } = require('../src/models/clientStore');
const { todayInTZ } = require('../src/utils/datetime');

async function main() {
  const client = await ensureBootstrapFromEnv();
  const today = todayInTZ();
  const svc = require('../src/services/gamSyncService');

  await runWithClient(client, async () => {
    console.log('Fetching from GAM for', today);
    const raw = await svc.fetchFromGAM(today, today);
    const normalized = svc.normalizeGAMRows(raw);
    console.log('GAM rows:', normalized.length);
    const n = await svc.replacePresentRows(normalized, 'manual-resync');
    console.log('Upserted present rows:', n);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
