/**
 * Re-pull recent days from GAM into report_grain (fixes rows synced before metricsFromRow bug).
 * Usage: node scripts/resync-recent-days.js [days=3]
 */
require('dotenv').config();
const { runWithClient } = require('../src/utils/clientContext');
const { ensureBootstrapFromEnv } = require('../src/models/clientStore');
const { todayInTZ, shiftYMD } = require('../src/utils/datetime');
const { query } = require('../src/db');
const logger = require('../src/utils/logger');

async function main() {
  const days = Math.max(1, parseInt(process.argv[2] || '3', 10) || 3);
  const client = await ensureBootstrapFromEnv();
  const today = todayInTZ();
  const dates = [];
  for (let i = 0; i < days; i += 1) {
    dates.push(shiftYMD(today, -i));
  }

  const { streamSyncFromGAM, rebuildRollupsForDates } = require('../src/services/gamSyncService');
  const { deleteGrainForDate } = require('../src/services/reportGrainStore');

  await runWithClient(client, async () => {
    for (const day of dates.sort()) {
      logger.info(`Clearing report_grain + rollups for ${day}…`);
      await deleteGrainForDate(day);
      await query(
        `DELETE FROM rollup_kpi_daily WHERE client_id = $1::uuid AND report_date = $2::date`,
        [client.id, day]
      );
      await query(
        `DELETE FROM rollup_dim_daily WHERE client_id = $1::uuid AND report_date = $2::date`,
        [client.id, day]
      );
      logger.info(`Re-syncing ${day} from GAM…`);
      const n = await streamSyncFromGAM(day, day, 'resync-recent');
      await rebuildRollupsForDates([day], 'resync-recent');
      logger.info(`Done ${day} — ${n} grain rows`);
    }

    const { rows } = await query(
      `SELECT report_date::text AS d,
              COUNT(*)::int AS rows,
              SUM(impressions)::bigint AS impressions,
              ROUND(SUM(revenue)::numeric, 2) AS revenue
       FROM report_grain
       WHERE client_id = $1::uuid AND report_date = ANY($2::date[])
       GROUP BY report_date ORDER BY 1`,
      [client.id, dates]
    );
    logger.info('Post-resync summary:');
    rows.forEach((r) => logger.info(`  ${r.d}: rows=${r.rows} impressions=${r.impressions} revenue=${r.revenue}`));
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
