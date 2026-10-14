/**
 * One-off / manual backfill of the Reporting summary tables:
 *   - rollup_unit_country_daily, rollup_unit_country_fill (fill rate by ad unit x country)
 *   - rollup_fill_daily (app / ad unit fill rate)
 *   - rollup_unit_country_fill.ad_requests / matched_requests (Ad Exchange requests, from GAM)
 *
 * Runs with NO pauses and NO "wait for a quiet moment" gate, so run it when reports are idle
 * (night). Safe to re-run: it only builds days that are still missing.
 *
 *   node scripts/backfill-summaries.js            # 180 days, every active network
 *   node scripts/backfill-summaries.js 90         # last 90 days
 *   node scripts/backfill-summaries.js 180 c7f026e5   # one network (id prefix)
 *   node scripts/backfill-summaries.js 180 all requests   # only the GAM ad-request backfill
 *   node scripts/backfill-summaries.js 180 all fill       # only the fill-rate / country backfill
 */
process.env.FILL_BACKFILL_PAUSE_MS = '0';
process.env.REQUEST_BACKFILL_PAUSE_MS = '0';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { runWithClient } = require('../src/utils/clientContext');
const { listActiveClients } = require('../src/models/clientStore');
const { backfillFillRollups, backfillRoiEarnRollups } = require('../src/services/reportGrainStore');
const { backfillRequestRollups } = require('../src/services/requestRollupStore');
const { query } = require('../src/db');

const days = parseInt(process.argv[2] || '180', 10) || 180;
const only = process.argv[3] && process.argv[3] !== 'all' ? String(process.argv[3]) : null;
const what = ['fill', 'requests'].includes(process.argv[4]) ? process.argv[4] : 'both';

async function progress(clientId) {
  const { rows } = await query(
    `SELECT
       (SELECT COUNT(DISTINCT report_date) FROM rollup_unit_country_daily WHERE client_id = $1::uuid) AS summary_days,
       (SELECT COUNT(DISTINCT report_date) FROM rollup_unit_country_fill
         WHERE client_id = $1::uuid AND unfilled IS NOT NULL) AS fill_days,
       (SELECT COUNT(DISTINCT report_date) FROM rollup_unit_country_fill
         WHERE client_id = $1::uuid AND ad_requests IS NOT NULL) AS request_days`,
    [clientId]
  );
  return rows[0];
}

(async () => {
  const clients = (await listActiveClients()).filter((c) => !only || String(c.id).startsWith(only));
  console.log(`Backfilling ${days} day(s) for ${clients.length} network(s)`);
  for (const client of clients) {
    const tag = String(client.id).slice(0, 8);
    const t0 = Date.now();
    console.log(`[${tag}] start`, JSON.stringify(await runWithClient(client, () => progress(client.id))));
    await runWithClient(client, () => Promise.all([
      what !== 'requests' ? backfillFillRollups(days) : null,
      what !== 'fill' ? backfillRequestRollups(days) : null,
      what !== 'requests' && what !== 'fill' ? backfillRoiEarnRollups(days) : null,
    ]));
    console.log(
      `[${tag}] done in ${Math.round((Date.now() - t0) / 1000)}s`,
      JSON.stringify(await runWithClient(client, () => progress(client.id)))
    );
  }
  console.log('ALL DONE');
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
