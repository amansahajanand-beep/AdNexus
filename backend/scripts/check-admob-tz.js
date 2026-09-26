require('dotenv').config();
const { initSchema } = require('../src/db');
const { admobAccountStore } = require('../src/models/publisherAccountStore');
const { getClientById } = require('../src/models/clientStore');
const { runWithClient } = require('../src/utils/clientContext');
const { listAdMobAccounts } = require('../src/admob/client');
const { todayInTZ } = require('../src/utils/datetime');

(async () => {
  await initSchema();
  const account = await admobAccountStore.getAccountById('abe418cd-0468-4a8b-ab03-bc91e79f4cc4');
  const client = await getClientById(account.clientId);
  await runWithClient(client, async () => {
    const list = await listAdMobAccounts(client, account.refreshToken);
    console.log('APP_TIMEZONE today', todayInTZ());
    console.log('accounts', JSON.stringify(list, null, 2));
  });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
