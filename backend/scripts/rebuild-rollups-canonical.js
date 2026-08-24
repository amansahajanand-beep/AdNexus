/**
 * Apply slice_key migration + rebuild rollups from canonical KPI slice only.
 * Usage: node scripts/rebuild-rollups-canonical.js [days=7]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { schemaQuery, query } = require('../src/db');
const { runWithClient } = require('../src/utils/clientContext');
const { ensureBootstrapFromEnv } = require('../src/models/clientStore');
const { todayInTZ, shiftYMD } = require('../src/utils/datetime');
const { rebuildRollupsFromGrain } = require('../src/services/reportGrainStore');
const logger = require('../src/utils/logger');

async function main() {
  const arg = process.argv[2] || '7';
  const sqlPath = path.join(__dirname, '../migrations/013_report_grain_slice_key.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  logger.info('Applying migration 013 (slice_key)…');
  for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
    await schemaQuery(stmt);
  }

  const client = await ensureBootstrapFromEnv();
  const today = todayInTZ();
  let dates = [];

  await runWithClient(client, async () => {
    if (String(arg).toLowerCase() === 'all') {
      const { rows } = await query(
        `SELECT DISTINCT to_char(report_date, 'YYYY-MM-DD') AS d
         FROM report_grain WHERE client_id = $1::uuid ORDER BY 1`,
        [client.id]
      );
      dates = rows.map((r) => r.d).filter(Boolean);
      logger.info(`Rebuilding rollups for ALL ${dates.length} grain date(s)…`);
    } else {
      const days = Math.max(1, parseInt(arg, 10) || 7);
      for (let i = 0; i < days; i += 1) dates.push(shiftYMD(today, -i));
    }

    for (const day of dates.sort()) {
      logger.info(`Rebuilding rollups for ${day} (${process.env.CANONICAL_KPI_SLICE || 'channel'} slice only)…`);
      await rebuildRollupsFromGrain([day], 'rebuild-canonical');
    }

    const { rows } = await query(
      `SELECT report_date::text AS d,
              SUM(impressions)::bigint AS imp,
              ROUND(SUM(revenue)::numeric, 2) AS rev
       FROM rollup_kpi_daily
       WHERE client_id = $1::uuid AND report_date = ANY($2::date[])
       GROUP BY report_date ORDER BY 1`,
      [client.id, dates]
    );
    logger.info('Rollup totals after rebuild:');
    rows.forEach((r) => logger.info(`  ${r.d}: impressions=${r.imp} revenue=${r.rev}`));
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
