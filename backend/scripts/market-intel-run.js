#!/usr/bin/env node
/**
 * Run one Market Intel chunk and exit — for an OS scheduler (Windows Task Scheduler, system cron, pm2 cron_restart)
 * when you do not want the collector tied to the API process.
 *
 *   node scripts/market-intel-run.js            collect one chunk (backfill / refresh / enrich)
 *   node scripts/market-intel-run.js enrich     look up YouTube id / app icon / app name for one batch of videos
 *   node scripts/market-intel-run.js discover   discover advertisers from MARKET_INTEL_KEYWORDS, then exit
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { collectOnce, enrichOnce, discoverOnce } = require('../src/services/marketIntelCron');

(async () => {
  const mode = process.argv[2];
  const result = mode === 'discover' ? await discoverOnce() : mode === 'enrich' ? await enrichOnce() : await collectOnce();
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
