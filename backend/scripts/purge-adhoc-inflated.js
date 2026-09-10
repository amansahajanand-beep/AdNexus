/**
 * One-off cleanup for the micros bug: report_adhoc rows written before the fix hold
 * revenue inflated 1e6x (5764 micros stored as $5,764).
 *
 * Inflated rows are identifiable: the buggy parser only mangled money values in the
 * 1000..999999 micros band, which it stored as whole numbers >= 1000. Correctly parsed
 * revenue is fractional dollars. Because a cached query must be complete to be served,
 * this deletes every row of an affected query_hash (not just its inflated rows) plus
 * that query's coverage marker, so the next request re-fetches it from GAM.
 *
 * Usage: node scripts/purge-adhoc-inflated.js [--apply]
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { query } = require('../src/db');
const { listActiveClients } = require('../src/models/clientStore');
const { runWithClient, tenantKey } = require('../src/utils/clientContext');

const MONEY_KEYS = [
  'total_line_item_level_all_revenue',
  'total_line_item_level_cpm_and_cpc_revenue',
  'total_line_item_level_without_cpd_average_ecpm',
  'revenue',
];

// A money metric stored as a whole number >= 1000 can only be un-divided micros.
const INFLATED_PREDICATE = MONEY_KEYS.map((k) => `(
  (metrics ? '${k}')
  AND NULLIF(metrics->>'${k}', '') ~ '^[0-9]+(\\.0+)?$'
  AND (metrics->>'${k}')::double precision >= 1000
)`).join(' OR ');

async function main() {
  const apply = process.argv.includes('--apply');
  const [client] = await listActiveClients();
  await runWithClient(client, async () => {
    const { rows: affected } = await query(
      `SELECT query_hash,
              MIN(to_char(report_date,'YYYY-MM-DD')) AS first_date,
              MAX(to_char(report_date,'YYYY-MM-DD')) AS last_date,
              COUNT(*)::int AS inflated_rows
         FROM report_adhoc
        WHERE ${INFLATED_PREDICATE}
        GROUP BY query_hash
        ORDER BY inflated_rows DESC`
    );

    if (!affected.length) {
      console.log('No inflated report_adhoc rows found — nothing to purge.');
      return;
    }

    const hashes = affected.map((r) => r.query_hash);
    const { rows: totals } = await query(
      `SELECT COUNT(*)::int AS n FROM report_adhoc WHERE query_hash = ANY($1::text[])`,
      [hashes]
    );

    console.log(`Affected cached queries: ${affected.length}`);
    for (const a of affected) {
      console.log(`  ${a.query_hash.slice(0, 12)}…  ${a.first_date}..${a.last_date}  inflated=${a.inflated_rows}`);
    }
    console.log(`Rows to delete (all rows of those queries): ${totals[0].n}`);

    if (!apply) {
      console.log('\nDry run. Re-run with --apply to delete.');
      return;
    }

    const del = await query(
      'DELETE FROM report_adhoc WHERE query_hash = ANY($1::text[])', [hashes]
    );
    const delCov = await query(
      'DELETE FROM report_adhoc_coverage WHERE query_hash = ANY($1::text[])', [hashes]
    );
    console.log(`Deleted ${del.rowCount} rows and ${delCov.rowCount} coverage markers.`);

    try {
      const { bumpCacheGeneration } = require('../src/redisClient');
      const gen = await bumpCacheGeneration(tenantKey(''));
      console.log(`Cache generation bumped to ${gen} (Redis/API response caches now miss).`);
    } catch (e) {
      console.log('Cache generation bump skipped:', e.message);
    }
  });
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
