/**
 * Create rollup_inventory_kpi_daily (if needed) and rebuild from inventory_core.
 * Usage: node scripts/backfill-inventory-rollups.js [days=120|all]
 */
require('dotenv').config();
const { query, schemaQuery } = require('../src/db');
const { runWithClient } = require('../src/utils/clientContext');
const { ensureBootstrapFromEnv, listActiveClients } = require('../src/models/clientStore');
const { todayInTZ, shiftYMD } = require('../src/utils/datetime');
const { rebuildInventoryRollupsFromGrain } = require('../src/services/reportGrainStore');
const logger = require('../src/utils/logger');

async function main() {
  const arg = process.argv[2] || '120';

  await schemaQuery(`
    CREATE TABLE IF NOT EXISTS rollup_inventory_kpi_daily (
      client_id       UUID        NOT NULL REFERENCES gam_clients(id),
      report_date     DATE        NOT NULL,
      inv_domain      TEXT        NOT NULL DEFAULT '',
      inv_site        TEXT        NOT NULL DEFAULT '',
      inv_ad_unit     TEXT        NOT NULL DEFAULT '',
      inv_app         TEXT        NOT NULL DEFAULT '',
      impressions     DOUBLE PRECISION NOT NULL DEFAULT 0,
      revenue         DOUBLE PRECISION NOT NULL DEFAULT 0,
      viewable_weight DOUBLE PRECISION NOT NULL DEFAULT 0,
      clicks          DOUBLE PRECISION NOT NULL DEFAULT 0,
      grain_count     INT         NOT NULL DEFAULT 0,
      currency        CHAR(3)     NOT NULL DEFAULT 'USD',
      PRIMARY KEY (client_id, report_date, inv_domain, inv_site, inv_ad_unit, inv_app)
    )
  `);
  await schemaQuery(`
    CREATE INDEX IF NOT EXISTS idx_rollup_inv_kpi_date
      ON rollup_inventory_kpi_daily (report_date DESC)
  `);
  await schemaQuery(`
    CREATE INDEX IF NOT EXISTS idx_rollup_inv_kpi_site
      ON rollup_inventory_kpi_daily (report_date, LOWER(inv_site))
  `);

  const client = (await ensureBootstrapFromEnv()) || (await listActiveClients())[0];
  if (!client?.id) {
    throw new Error('No active GAM client found — cannot rebuild inventory rollups');
  }
  const today = todayInTZ();
  let dates = [];

  await runWithClient(client, async () => {
    if (String(arg).toLowerCase() === 'all') {
      const { rows } = await query(
        `SELECT DISTINCT to_char(report_date, 'YYYY-MM-DD') AS d
         FROM report_grain
         WHERE client_id = $1::uuid AND slice_key = 'inventory_core'
         ORDER BY 1`,
        [client.id]
      );
      dates = rows.map((r) => r.d).filter(Boolean);
    } else {
      const days = Math.max(1, parseInt(arg, 10) || 120);
      for (let i = 0; i < days; i += 1) dates.push(shiftYMD(today, -i));
    }

    logger.info(`Rebuilding inventory rollups for ${dates.length} day(s)…`);
    const t0 = Date.now();
    let n = 0;
    for (const day of dates.sort()) {
      n += await rebuildInventoryRollupsFromGrain([day], 'inv-backfill');
      if (dates.indexOf(day) % 10 === 0) {
        logger.info(`  … ${day} cumulative rows≈${n}`);
      }
    }
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n,
              COUNT(DISTINCT report_date)::int AS days,
              ROUND(SUM(revenue)::numeric, 2) AS rev
       FROM rollup_inventory_kpi_daily
       WHERE client_id = $1::uuid`,
      [client.id]
    );
    logger.info(`Done in ${Date.now() - t0}ms — ${JSON.stringify(rows[0])}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
