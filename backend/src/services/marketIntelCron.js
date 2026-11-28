/**
 * Market Intel cron — keeps competitor ads up to date without anyone pressing "Sync now".
 *
 *   MARKET_INTEL_SYNC=true            master switch (off by default)
 *   MARKET_INTEL_CRON                 collection chunk, default every 30 minutes (:00 and :30). Each run spends a small request
 *                                     budget (see marketScraper.js): backfill history, refresh stale advertisers,
 *                                     then look up video ids / app icons. Overlapping runs are skipped.
 *   MARKET_INTEL_ENRICH_CRON          video lookup (YouTube id, app icon, app name), default every 30 minutes at :15 and :45, so
 *                                     it never runs at the same time as collection (short bursts, long pauses)
 *   MARKET_INTEL_ENRICH_PER_RUN       creatives per run, default 20 (spaced 5 s apart)
 *   MARKET_INTEL_DISCOVER_CRON        find new advertisers from keywords, default daily 04:00
 *   MARKET_INTEL_KEYWORDS             comma-separated keywords / domains / developer names to discover from
 *   APP_TIMEZONE                      cron timezone (same variable the other jobs use)
 */
const cron = require('node-cron');
const logger = require('../utils/logger');
const scraper = require('./marketScraper');

const timezone = () => process.env.APP_TIMEZONE || 'Asia/Singapore';

async function collectOnce() {
  try {
    return await scraper.syncTracked();
  } catch (err) {
    logger.warn(`[market-intel] cron collect failed: ${err.message}`);
    return null;
  }
}

async function enrichOnce() {
  try {
    const n = Math.max(1, Math.min(300, parseInt(process.env.MARKET_INTEL_ENRICH_PER_RUN || '', 10) || 20));
    const r = await scraper.enrichBatch(n);
    if (r.done || r.blocked) logger.info(`[market-intel] enrich: ${r.done} done, ${r.found} with video${r.blocked ? ` (${r.blocked})` : ''}`);
    return r;
  } catch (err) {
    logger.warn(`[market-intel] cron enrich failed: ${err.message}`);
    return null;
  }
}

async function discoverOnce() {
  const terms = String(process.env.MARKET_INTEL_KEYWORDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!terms.length) return [];
  try {
    const found = await scraper.discover(terms, { maxNew: 100 });
    logger.info(`[market-intel] discovery from ${terms.length} keyword(s): ${found.length} advertiser(s) tracked`);
    return found;
  } catch (err) {
    logger.warn(`[market-intel] cron discovery failed: ${err.message}`);
    return [];
  }
}

function startMarketIntelCron() {
  if (String(process.env.MARKET_INTEL_SYNC).toLowerCase() !== 'true') return;
  const collectExpr = process.env.MARKET_INTEL_CRON || '0,30 * * * *';
  const discoverExpr = process.env.MARKET_INTEL_DISCOVER_CRON || '20 4 * * *';
  const enrichExpr = process.env.MARKET_INTEL_ENRICH_CRON || '15,45 * * * *';
  for (const expr of [collectExpr, discoverExpr, enrichExpr]) {
    if (!cron.validate(expr)) {
      logger.warn(`[market-intel] invalid cron expression "${expr}", scheduler not started`);
      return;
    }
  }
  const opts = { timezone: timezone(), noOverlap: true };
  cron.schedule(collectExpr, () => { collectOnce(); }, opts);
  cron.schedule(discoverExpr, () => { discoverOnce(); }, opts);
  cron.schedule(enrichExpr, () => { enrichOnce(); }, opts);
  logger.info(`[market-intel] cron on: collect "${collectExpr}", discover "${discoverExpr}", enrich "${enrichExpr}" (${timezone()})`);
  // No run at boot on purpose: restarts must not trigger extra bursts. The first run is the next scheduled slot.
}

module.exports = { startMarketIntelCron, collectOnce, enrichOnce, discoverOnce };
