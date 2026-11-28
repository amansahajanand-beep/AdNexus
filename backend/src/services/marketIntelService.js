/**
 * Market Intel — competitor ads from the Google Ads Transparency Center, fetched through SerpApi
 * (engine=google_ads_transparency_center) and stored in market_advertisers / market_creatives.
 *
 * Why stored: "new this week", "first shown" and launch-per-day views need history; the API is a snapshot.
 * Cost control: every SerpApi call counts against the plan (free plan = 250/month). Syncs are therefore
 * capped per run (MARKET_INTEL_MAX_CALLS_PER_RUN, default 20) and never run on a schedule unless
 * MARKET_INTEL_SYNC=true.
 *
 * Env: SERPAPI_API_KEY (required), MARKET_INTEL_MAX_CALLS_PER_RUN, MARKET_INTEL_PAGE_SIZE (default 40),
 *      MARKET_INTEL_PLATFORM (default PLAY — app ads), MARKET_INTEL_SYNC=true to enable the daily cron.
 */
const { query } = require('../db');
const logger = require('../utils/logger');

const ENDPOINT = 'https://serpapi.com/search.json';

function apiKey() {
  const k = String(process.env.SERPAPI_API_KEY || '').trim();
  if (!k) throw new Error('SERPAPI_API_KEY is not set');
  return k;
}

const cfg = () => ({
  maxCalls: Math.max(1, parseInt(process.env.MARKET_INTEL_MAX_CALLS_PER_RUN || '20', 10) || 20),
  pageSize: Math.min(100, Math.max(1, parseInt(process.env.MARKET_INTEL_PAGE_SIZE || '40', 10) || 40)),
  platform: String(process.env.MARKET_INTEL_PLATFORM || 'PLAY').trim().toUpperCase(),
});

const toDate = (epochSeconds) => {
  const n = Number(epochSeconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
};

/** One SerpApi call. Returns { creatives, nextToken, total, empty }. Throws on real errors. */
async function fetchPage({ advertiserId, text, platform, format, region, token, num }) {
  const params = new URLSearchParams({ engine: 'google_ads_transparency_center', api_key: apiKey() });
  if (advertiserId) params.set('advertiser_id', advertiserId);
  if (text) params.set('text', text);
  if (platform) params.set('platform', platform);
  if (format) params.set('creative_format', format);
  if (region) params.set('region', region);
  if (token) params.set('next_page_token', token);
  params.set('num', String(num || cfg().pageSize));
  const res = await fetch(`${ENDPOINT}?${params.toString()}`);
  const body = await res.json().catch(() => ({}));
  if (body.error) {
    // SerpApi reports "no results" as an error string with HTTP 200 — that is an empty page, not a failure.
    if (/hasn't returned any results/i.test(body.error)) return { creatives: [], nextToken: null, total: 0, empty: true };
    throw new Error(String(body.error).replace(params.get('api_key'), '***'));
  }
  if (!res.ok) throw new Error(`SerpApi HTTP ${res.status}`);
  return {
    creatives: body.ad_creatives || [],
    nextToken: body.serpapi_pagination?.next_page_token || null,
    total: body.search_information?.total_results ?? null,
    empty: false,
  };
}

async function upsertCreatives(list) {
  let saved = 0;
  for (const c of list) {
    if (!c.ad_creative_id || !c.advertiser_id) continue;
    await query(
      `INSERT INTO market_creatives
         (ad_creative_id, advertiser_id, advertiser_name, format, target_domain, image_url, preview_url,
          width, height, total_days_shown, first_shown, last_shown, details_link)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (ad_creative_id) DO UPDATE SET
         advertiser_name = EXCLUDED.advertiser_name,
         format = EXCLUDED.format,
         target_domain = COALESCE(NULLIF(EXCLUDED.target_domain, ''), market_creatives.target_domain),
         image_url = COALESCE(EXCLUDED.image_url, market_creatives.image_url),
         preview_url = COALESCE(EXCLUDED.preview_url, market_creatives.preview_url),
         width = COALESCE(EXCLUDED.width, market_creatives.width),
         height = COALESCE(EXCLUDED.height, market_creatives.height),
         total_days_shown = EXCLUDED.total_days_shown,
         first_shown = COALESCE(market_creatives.first_shown, EXCLUDED.first_shown),
         last_shown = EXCLUDED.last_shown,
         details_link = COALESCE(EXCLUDED.details_link, market_creatives.details_link),
         updated_at = now()`,
      [
        c.ad_creative_id, c.advertiser_id, c.advertiser || '', c.format || '', c.target_domain || '',
        c.image || null, c.link || null, c.width || null, c.height || null,
        Number(c.total_days_shown) || 0, toDate(c.first_shown), toDate(c.last_shown), c.details_link || null,
      ]
    );
    saved += 1;
  }
  return saved;
}

/** Track advertisers found for a domain (text search) or given directly by id. Returns what was added. */
async function trackAdvertisers({ advertiserIds = [], domains = [] } = {}) {
  const added = [];
  for (const id of advertiserIds.map((s) => String(s).trim()).filter(Boolean)) {
    await query(
      `INSERT INTO market_advertisers (advertiser_id) VALUES ($1) ON CONFLICT (advertiser_id) DO UPDATE SET tracked = true`,
      [id]
    );
    added.push({ advertiserId: id, name: '' });
  }
  for (const domain of domains.map((s) => String(s).trim().toLowerCase()).filter(Boolean)) {
    // A domain (text) search returns nothing when combined with the platform filter, so look the
    // advertiser up unfiltered; the platform filter is applied when its creatives are synced by id.
    const page = await fetchPage({ text: domain });
    const seen = new Map();
    for (const c of page.creatives) if (c.advertiser_id) seen.set(c.advertiser_id, c.advertiser || '');
    for (const [id, name] of seen) {
      await query(
        `INSERT INTO market_advertisers (advertiser_id, name, last_synced_at) VALUES ($1,$2,now())
         ON CONFLICT (advertiser_id) DO UPDATE SET name = COALESCE(NULLIF(EXCLUDED.name,''), market_advertisers.name), tracked = true`,
        [id, name]
      );
      added.push({ advertiserId: id, name });
    }
  }
  return added;
}

/** Pull one advertiser's creatives (newest page(s) first). Returns { calls, saved }. */
async function syncAdvertiser(adv, { maxPages = 1 } = {}) {
  const { platform } = cfg();
  let token = null;
  let calls = 0;
  let saved = 0;
  try {
    for (let p = 0; p < maxPages; p += 1) {
      const page = await fetchPage({ advertiserId: adv.advertiser_id, platform, token });
      calls += 1;
      saved += await upsertCreatives(page.creatives);
      const name = page.creatives[0]?.advertiser;
      if (name) await query('UPDATE market_advertisers SET name = $2 WHERE advertiser_id = $1', [adv.advertiser_id, name]);
      token = page.nextToken;
      if (!token) break;
    }
    await query('UPDATE market_advertisers SET last_synced_at = now(), last_error = NULL WHERE advertiser_id = $1', [adv.advertiser_id]);
  } catch (e) {
    await query('UPDATE market_advertisers SET last_error = $2 WHERE advertiser_id = $1', [adv.advertiser_id, String(e.message).slice(0, 300)]);
    throw e;
  }
  return { calls, saved };
}

/** Refresh the least-recently-synced tracked advertisers within the per-run call budget. */
async function syncTracked({ maxCalls } = {}) {
  const budget = maxCalls || cfg().maxCalls;
  const { rows } = await query(
    `SELECT advertiser_id, name FROM market_advertisers WHERE tracked = true
      ORDER BY last_synced_at ASC NULLS FIRST, added_at ASC LIMIT $1`,
    [budget]
  );
  let calls = 0;
  let saved = 0;
  let failed = 0;
  for (const adv of rows) {
    if (calls >= budget) break;
    try {
      const r = await syncAdvertiser(adv, { maxPages: 1 });
      calls += r.calls;
      saved += r.saved;
    } catch (e) {
      calls += 1;
      failed += 1;
      logger.warn(`[market-intel] ${adv.advertiser_id} failed: ${e.message}`);
    }
  }
  logger.info(`[market-intel] synced ${rows.length} advertiser(s): calls=${calls} creatives=${saved} failed=${failed}`);
  return { advertisers: rows.length, calls, saved, failed };
}

module.exports = { fetchPage, trackAdvertisers, syncAdvertiser, syncTracked, upsertCreatives };
