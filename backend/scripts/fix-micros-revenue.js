/**
 * Fix days where report_grain.revenue was stored as GAM micros instead of dollars.
 * Detect: avg positive revenue >= 1000 with impressions present.
 */
require('dotenv').config();
const { initSchema, query } = require('../src/db');
const { runWithClient } = require('../src/utils/clientContext');
const { rebuildRollupsForDates } = require('../src/services/gamSyncService');
const { bumpCacheGeneration } = require('../src/redisClient');
const { tenantKey } = require('../src/utils/clientContext');

(async () => {
  await initSchema();
  const clientId = (await query(`SELECT id FROM gam_clients LIMIT 1`)).rows[0]?.id
    || (await query(`SELECT DISTINCT client_id AS id FROM report_grain WHERE client_id IS NOT NULL LIMIT 1`)).rows[0]?.id;
  if (!clientId) throw new Error('no client');

  const { rows: badDays } = await query(
    `SELECT report_date::text AS d,
            SUM(revenue)::float8 AS sum_rev,
            SUM(impressions)::float8 AS imp,
            AVG(CASE WHEN revenue > 0 THEN revenue END)::float8 AS avg_pos
     FROM report_grain
     WHERE client_id = $1::uuid AND slice_key = 'channel'
     GROUP BY 1
     HAVING AVG(CASE WHEN revenue > 0 THEN revenue END) >= 1000
     ORDER BY 1`,
    [clientId]
  );
  console.log('bad days', badDays);

  await runWithClient({ id: clientId }, async () => {
    for (const day of badDays) {
      const d = day.d;
      const grain = await query(
        `UPDATE report_grain
         SET revenue = ROUND((revenue / 1000000.0)::numeric, 4),
             ecpm = CASE
               WHEN ecpm IS NULL THEN NULL
               WHEN ABS(ecpm) >= 1000 THEN ROUND((ecpm / 1000000.0)::numeric, 4)
               WHEN impressions > 0 AND revenue > 0
                 AND (revenue / NULLIF(impressions, 0)) * 1000 > 100
                 THEN ROUND(((revenue / 1000000.0) / NULLIF(impressions, 0) * 1000)::numeric, 4)
               ELSE ecpm
             END
         WHERE client_id = $1::uuid
           AND report_date = $2::date
           AND ABS(revenue) >= 1000`,
        [clientId, d]
      );
      console.log('fixed grain', d, 'rows', grain.rowCount);

      const n = await rebuildRollupsForDates([d], 'fix-micros');
      console.log('rebuilt rollups', d, n);
    }

    try {
      await bumpCacheGeneration(tenantKey(''));
      console.log('cache generation bumped');
    } catch (e) {
      console.warn('cache bump skipped', e.message);
    }

    const { rows: check } = await query(
      `SELECT report_date::text AS d, SUM(revenue)::float8 AS rev, SUM(impressions)::float8 AS imp
       FROM rollup_kpi_daily
       WHERE client_id = $1::uuid
         AND report_date = ANY($2::date[])
       GROUP BY 1 ORDER BY 1`,
      [clientId, badDays.map((x) => x.d)]
    );
    console.log('rollup after fix', check);
  });

  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
