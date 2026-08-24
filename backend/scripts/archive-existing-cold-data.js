#!/usr/bin/env node
/**
 * Archive existing Postgres rows older than HISTORICAL_DAYS to S3, then purge.
 *
 * Usage:
 *   node scripts/archive-existing-cold-data.js --all
 *   node scripts/archive-existing-cold-data.js <client-uuid>
 */
require('dotenv').config();
const { initSchema, finishTenantBackfill, pool } = require('../src/db');
const { listActiveClients, ensureBootstrapFromEnv } = require('../src/models/clientStore');
const { runWithClient } = require('../src/utils/clientContext');
const { archiveColdDaysForClient, isArchiveEnabled } = require('../src/services/reportArchiveService');

async function archiveClient(client) {
  return runWithClient(client, async () => {
    if (!isArchiveEnabled()) {
      console.error('ARCHIVE_ENABLED must be true with S3 credentials configured');
      process.exit(1);
    }
    console.log(`Archiving cold data for ${client.name} (${client.id})…`);
    const n = await archiveColdDaysForClient(client.id);
    console.log(`  Archived ${n} day(s)`);
    return n;
  });
}

async function main() {
  await initSchema();
  await finishTenantBackfill();

  const arg = process.argv[2];
  let clients = [];
  if (arg === '--all') {
    clients = await listActiveClients();
  } else if (arg) {
    clients = [{ id: arg, name: arg }];
  } else {
    const boot = await ensureBootstrapFromEnv();
    if (boot) clients = [boot];
  }

  if (!clients.length) {
    console.error('No clients found');
    process.exit(1);
  }

  let total = 0;
  for (const client of clients) {
    total += await archiveClient(client);
  }
  console.log(`Archive complete — ${total} day(s) total`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
