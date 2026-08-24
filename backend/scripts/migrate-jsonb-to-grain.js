#!/usr/bin/env node
/**
 * One-time backfill: report_present + report_daily JSONB → typed report_grain.
 *
 * Usage:
 *   node scripts/migrate-jsonb-to-grain.js --all
 *   node scripts/migrate-jsonb-to-grain.js <client-uuid>
 */
require('dotenv').config();
const { schemaQuery, initSchema, finishTenantBackfill, pool } = require('../src/db');
const { listActiveClients, ensureBootstrapFromEnv } = require('../src/models/clientStore');
const { runWithClient } = require('../src/utils/clientContext');
const { upsertGrainRows, rebuildRollupsFromGrain, ensureGrainPartition } = require('../src/services/reportGrainStore');

const BATCH = 500;

async function migrateClient(client) {
  return runWithClient(client, async () => {
    console.log(`Migrating client ${client.name} (${client.id})…`);

    const { rows } = await schemaQuery(
      `SELECT client_id, report_date, dimensions, metrics, currency, 'present' AS src
       FROM report_present WHERE client_id = $1::uuid
       UNION ALL
       SELECT client_id, report_date, dimensions, metrics, currency, 'daily' AS src
       FROM report_daily WHERE client_id = $1::uuid
       ORDER BY report_date`,
      [client.id]
    );

    if (!rows.length) {
      console.log('  No legacy JSONB rows — skip');
      return 0;
    }

    console.log(`  Found ${rows.length} legacy row(s)`);
    let upserted = 0;
    const dates = new Set();

    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const normalized = [];
      for (const row of chunk) {
        const day = String(row.report_date).slice(0, 10);
        if (!day) continue;
        dates.add(day);
        await ensureGrainPartition(day);
        normalized.push({
          report_date: day,
          dimensions: typeof row.dimensions === 'object' ? row.dimensions : JSON.parse(row.dimensions || '{}'),
          metrics: typeof row.metrics === 'object' ? row.metrics : JSON.parse(row.metrics || '{}'),
          currency: row.currency || 'USD',
        });
      }
      upserted += await upsertGrainRows(normalized, 'migrate-jsonb');
      process.stdout.write(`\r  Upserted ${upserted}/${rows.length}`);
    }
    console.log('');

    const dateList = [...dates].sort();
    if (dateList.length) {
      await rebuildRollupsFromGrain(dateList, 'migrate-jsonb-rollup');
    }
    console.log(`  Done — ${upserted} grain row(s), ${dateList.length} day(s)`);
    return upserted;
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
    total += await migrateClient(client);
  }
  console.log(`Migration complete — ${total} row(s) total`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
