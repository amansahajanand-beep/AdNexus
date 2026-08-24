require('dotenv').config();
const { query } = require('../src/db');
const { ensureBootstrapFromEnv } = require('../src/models/clientStore');
const { runWithClient } = require('../src/utils/clientContext');
const { invalidateCacheForDate } = require('../src/services/gamSyncService');
const { shiftYMD, todayInTZ } = require('../src/utils/datetime');

async function main() {
  const days = Math.max(1, parseInt(process.argv[2] || '7', 10) || 7);
  const client = await ensureBootstrapFromEnv();
  const today = todayInTZ();
  await runWithClient(client, async () => {
    for (let i = 0; i < days; i += 1) {
      const d = shiftYMD(today, -i);
      await invalidateCacheForDate(d);
      console.log(`Invalidated cache for ${d}`);
    }
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
