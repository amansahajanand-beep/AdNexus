/**
 * Market Intel collector — reads competitor ads from the Google Ads Transparency Center's public RPC
 * (no SerpApi) and stores them in market_advertisers / market_creatives.
 *
 * It collects in small, resumable pieces:
 *  - Backfill: every advertiser keeps a pagination cursor (backfill_token). Pages come newest-first, so each
 *    run walks one step further into the past until MARKET_INTEL_BACKFILL_DAYS is reached, then the
 *    advertiser is "done" and is only refreshed (first page) every MARKET_INTEL_REFRESH_HOURS.
 *  - Budget: a run spends at most MARKET_INTEL_REQUESTS_PER_RUN requests, then stops.
 *  - Rate limit: Google publishes none, so pacing is adaptive. One request at a time, a gap between requests,
 *    and on HTTP 429/403 we honour Retry-After (or back off 5→10→…→60 min), slow the gap down, and stop the
 *    run. The gap speeds back up after a streak of successes. We never retry through a block.
 *
 * Transport is the system `curl` (Google answers Node's own HTTP client with 429).
 *
 * Scheduling lives in marketIntelCron.js. Env (all optional):
 *   MARKET_INTEL_REQUESTS_PER_RUN=50, MARKET_INTEL_PAGES_PER_VISIT=2, MARKET_INTEL_DELAY_MS=4000,
 *   MARKET_INTEL_BACKFILL_DAYS=90, MARKET_INTEL_REFRESH_HOURS=6, MARKET_INTEL_CURL=<path to curl>
 */
const { execFile } = require('child_process');
const { query } = require('../db');
const logger = require('../utils/logger');

const BASE = 'https://adstransparency.google.com/anji/_/rpc/SearchService';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const FORMAT = { 1: 'text', 2: 'image', 3: 'video' };

const num = (name, dflt, min, max) => Math.min(max, Math.max(min, parseInt(process.env[name] || '', 10) || dflt));
const cfg = () => ({
  budget: num('MARKET_INTEL_REQUESTS_PER_RUN', 50, 1, 500),
  pagesPerVisit: num('MARKET_INTEL_PAGES_PER_VISIT', 2, 1, 50),
  baseDelay: num('MARKET_INTEL_DELAY_MS', 4000, 1000, 60000),
  backfillDays: num('MARKET_INTEL_BACKFILL_DAYS', 90, 1, 3650),
  refreshHours: num('MARKET_INTEL_REFRESH_HOURS', 6, 1, 720),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class BlockedError extends Error {}

/* ---------------- adaptive rate governor ---------------- */
const gov = { delay: 0, cooldownUntil: 0, strikes: 0, okStreak: 0, lastAt: 0 };
const MIN = 60 * 1000;

/** Wait for our turn; refuse outright while cooling down after a block. */
async function gate() {
  const base = cfg().baseDelay;
  if (!gov.delay) gov.delay = base;
  const cool = gov.cooldownUntil - Date.now();
  if (cool > 0) throw new BlockedError(`cooling down after a block, ${Math.ceil(cool / MIN)} min left`);
  const wait = gov.lastAt + gov.delay + Math.floor(Math.random() * 800) - Date.now();
  if (wait > 0) await sleep(wait);
  gov.lastAt = Date.now();
}

function onSuccess() {
  gov.okStreak += 1;
  if (gov.okStreak >= 5) gov.strikes = 0;
  if (gov.okStreak >= 20 && gov.delay > cfg().baseDelay) {
    gov.delay = Math.max(cfg().baseDelay, Math.round(gov.delay * 0.75));
    gov.okStreak = 0;
  }
}

function onBlocked(retryAfterSec) {
  gov.strikes += 1;
  gov.okStreak = 0;
  gov.delay = Math.min(30000, (gov.delay || cfg().baseDelay) * 2);
  const backoff = Math.min(60 * MIN, 5 * MIN * 2 ** (gov.strikes - 1));
  const wait = Math.max(backoff, (Number(retryAfterSec) || 0) * 1000);
  gov.cooldownUntil = Date.now() + wait;
  return Math.ceil(wait / MIN);
}

function collectorStatus() {
  const cool = gov.cooldownUntil - Date.now();
  return { cooldownMinutes: cool > 0 ? Math.ceil(cool / MIN) : 0, delayMs: gov.delay || cfg().baseDelay, strikes: gov.strikes };
}

/* ---------------- transport ---------------- */
function post(method, body) {
  const args = [
    '-sS', '-m', '30', '-X', 'POST', '-A', UA,
    '-w', '\n%{header{retry-after}}\n%{http_code}',
    '--data-urlencode', `f.req=${JSON.stringify(body)}`, `${BASE}/${method}?authuser=`,
  ];
  return new Promise((resolve, reject) => {
    execFile(process.env.MARKET_INTEL_CURL || 'curl', args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(`curl failed: ${String(stderr || err.message).trim().slice(0, 200)}`));
      const lines = stdout.split('\n');
      const status = Number(lines.pop()) || 0;
      const retryAfter = lines.pop();
      resolve({ status, retryAfter, text: lines.join('\n') });
    });
  });
}

async function rpc(method, body) {
  await gate();
  const res = await post(method, body);
  // 302 = Google redirecting to its "unusual traffic"/consent page: treat it as a block, not a per-advertiser error.
  if (res.status === 429 || res.status === 403 || res.status === 302 || res.status === 303) {
    const mins = onBlocked(res.retryAfter);
    throw new BlockedError(`Transparency Center answered HTTP ${res.status}; pausing ${mins} min`);
  }
  if (res.status < 200 || res.status >= 300) throw new Error(`Transparency Center HTTP ${res.status}`);
  try {
    const json = JSON.parse(res.text);
    onSuccess();
    return json;
  } catch {
    const mins = onBlocked(0);
    throw new BlockedError(`Transparency Center returned a non-JSON page; pausing ${mins} min`);
  }
}

/* ---------------- parsing / storage ---------------- */
const epoch = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
};

function parseCreative(c) {
  const content = c['3'] || {};
  const img = content['3']?.['2'] ? String(content['3']['2']) : '';
  return {
    id: c['2'],
    advertiserId: c['1'],
    advertiser: c['12'] || '',
    format: FORMAT[c['4']] || 'text',
    imageUrl: (img.match(/src="([^"]+)"/) || [])[1] || null,
    previewUrl: content['1']?.['4'] || null,
    width: parseInt((img.match(/width="([\d.]+)"/) || [])[1], 10) || null,
    height: parseInt((img.match(/height="([\d.]+)"/) || [])[1], 10) || null,
    days: Number(c['13']) || 0,
    first: epoch(c['6']?.['1']),
    last: epoch(c['7']?.['1']),
  };
}

/** One page of creatives. filter: { advertiserId } or { text }. Returns { creatives, next, total }. */
async function fetchCreatives({ advertiserId, text, token, size = 40 }) {
  const filter = {};
  if (advertiserId) filter['13'] = { '1': [advertiserId] };
  if (text) filter['12'] = { '1': text, '2': true };
  const body = { '2': size, '3': filter, '7': { '1': 1 } };
  if (token) body['4'] = token;
  const j = await rpc('SearchCreatives', body);
  return { creatives: (j['1'] || []).map(parseCreative).filter((c) => c.id && c.advertiserId), next: j['2'] || null, total: j['4'] ?? null };
}

async function upsert(list, domain = '') {
  let saved = 0;
  for (const c of list) {
    await query(
      `INSERT INTO market_creatives
         (ad_creative_id, advertiser_id, advertiser_name, format, target_domain, image_url, preview_url,
          width, height, total_days_shown, first_shown, last_shown, details_link)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (ad_creative_id) DO UPDATE SET
         advertiser_name = EXCLUDED.advertiser_name, format = EXCLUDED.format,
         target_domain = COALESCE(NULLIF(EXCLUDED.target_domain,''), market_creatives.target_domain),
         image_url = COALESCE(EXCLUDED.image_url, market_creatives.image_url),
         preview_url = COALESCE(EXCLUDED.preview_url, market_creatives.preview_url),
         width = COALESCE(EXCLUDED.width, market_creatives.width),
         height = COALESCE(EXCLUDED.height, market_creatives.height),
         total_days_shown = EXCLUDED.total_days_shown,
         first_shown = COALESCE(market_creatives.first_shown, EXCLUDED.first_shown),
         last_shown = EXCLUDED.last_shown, updated_at = now()`,
      [
        c.id, c.advertiserId, c.advertiser, c.format, domain, c.imageUrl, c.previewUrl, c.width, c.height, c.days, c.first, c.last,
        `https://adstransparency.google.com/advertiser/${c.advertiserId}/creative/${c.id}`,
      ]
    );
    saved += 1;
  }
  return saved;
}

async function trackAdvertiser(id, name = '') {
  await query(
    `INSERT INTO market_advertisers (advertiser_id, name) VALUES ($1,$2)
     ON CONFLICT (advertiser_id) DO UPDATE SET tracked = true, name = COALESCE(NULLIF(EXCLUDED.name,''), market_advertisers.name)`,
    [id, name]
  );
}

/* ---------------- backfill / refresh ---------------- */
/**
 * Spend up to `budget` requests on one advertiser. Unfinished backfill resumes from its saved cursor;
 * a finished one just re-reads the newest page. Returns { calls, saved, finished }.
 */
async function advance(adv, budget) {
  const cutoff = Date.now() - cfg().backfillDays * 86400000;
  let calls = 0;
  let saved = 0;
  try {
    if (adv.backfill_done) {
      const page = await fetchCreatives({ advertiserId: adv.advertiser_id });
      calls += 1;
      saved += await upsert(page.creatives);
      await query('UPDATE market_advertisers SET last_synced_at = now(), last_error = NULL WHERE advertiser_id = $1', [adv.advertiser_id]);
      return { calls, saved, finished: false };
    }
    let token = adv.backfill_token || null;
    let pages = adv.backfill_pages || 0;
    let finished = false;
    // Spread the budget: a few pages per advertiser per visit, then move on (the cursor resumes next time).
    const visitLimit = Math.min(budget, cfg().pagesPerVisit);
    while (calls < visitLimit && !finished) {
      const page = await fetchCreatives({ advertiserId: adv.advertiser_id, token });
      calls += 1;
      pages += 1;
      saved += await upsert(page.creatives);
      const oldest = Math.min(...page.creatives.map((c) => new Date(c.last || c.first || Date.now()).getTime()));
      token = page.next;
      finished = !token || !page.creatives.length || oldest < cutoff;
      await query(
        `UPDATE market_advertisers
            SET backfill_token = $2, backfill_pages = $3, backfill_done = $4,
                name = COALESCE(NULLIF($5,''), name), last_synced_at = now(), last_error = NULL
          WHERE advertiser_id = $1`,
        [adv.advertiser_id, finished ? null : token, pages, finished, page.creatives[0]?.advertiser || '']
      );
    }
    return { calls, saved, finished };
  } catch (e) {
    if (!(e instanceof BlockedError)) {
      // A generic failure (e.g. an expired cursor): restart this advertiser's backfill next time.
      await query('UPDATE market_advertisers SET last_error = $2, backfill_token = NULL WHERE advertiser_id = $1', [adv.advertiser_id, String(e.message).slice(0, 300)]);
    }
    e.partial = { calls, saved };
    throw e;
  }
}

/* ---------------- enrichment: YouTube id, app icon and app name ---------------- */
/**
 * A video ad's preview script (googleusercontent) embeds its YouTube video id, the app icon and the app name.
 * One small request per creative, paced separately from the search RPC, and paused after any block.
 */
const enrich = { cooldownUntil: 0, lastAt: 0 };

function fetchText(url) {
  const args = ['-sS', '-m', '20', '-A', UA, '-e', 'https://adstransparency.google.com/', '-w', '\n%{http_code}', url];
  return new Promise((resolve, reject) => {
    execFile(process.env.MARKET_INTEL_CURL || 'curl', args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(`curl failed: ${String(stderr || err.message).trim().slice(0, 160)}`));
      const i = stdout.lastIndexOf('\n');
      resolve({ status: Number(stdout.slice(i + 1)) || 0, text: stdout.slice(0, i) });
    });
  });
}

/** Pull what we need out of a preview script. */
function parsePreview(js) {
  const text = String(js || '');
  const yt = (text.match(/ytimg\.com\/vi\/([A-Za-z0-9_-]{11})\//) || text.match(/youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?v=)([A-Za-z0-9_-]{11})/) || [])[1] || null;
  const iconRaw = (text.match(/\/\/(lh3\.googleusercontent\.com\/[A-Za-z0-9_-]+)(?:\\x3d|=)w\d+-h\d+/) || [])[1];
  const name = (text.match(/ochAppName[^>]*?\\x3e([^\\<]{1,80})\\x3c/) || [])[1];
  return { youtubeId: yt, appIcon: iconRaw ? `https://${iconRaw}=w96-h96` : null, appName: name ? name.trim() : null };
}

/** Enrich up to `limit` not-yet-enriched video creatives, newest first. Returns { done, found, blocked? }. */
let enriching = false;
async function enrichBatch(limit = 30) {
  if (enriching) return { done: 0, found: 0, skipped: 'enrichment already running' };
  enriching = true;
  try {
    return await enrichBatchInner(limit);
  } finally {
    enriching = false;
  }
}

async function enrichBatchInner(limit) {
  // Stage 1: one video per advertiser that has no app icon yet (the lists show one icon per advertiser),
  // skipping advertisers whose recent ads were already checked without finding an app (web/non-app ads).
  const stage1 = await query(
    `SELECT ad_creative_id, preview_url FROM (
       SELECT DISTINCT ON (c.advertiser_id) c.ad_creative_id, c.preview_url, c.first_shown
         FROM market_creatives c
        WHERE c.format = 'video' AND c.preview_url IS NOT NULL AND c.enriched_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM market_creatives m WHERE m.advertiser_id = c.advertiser_id AND m.app_icon IS NOT NULL)
          AND (SELECT count(*) FROM market_creatives m WHERE m.advertiser_id = c.advertiser_id AND m.enriched_at IS NOT NULL) < 3
        ORDER BY c.advertiser_id, c.first_shown DESC NULLS LAST
     ) t ORDER BY first_shown DESC NULLS LAST LIMIT $1`,
    [limit]
  );
  const rows = stage1.rows;
  if (rows.length < limit) {
    // Stage 2: remaining videos newest first (thumbnails / playback).
    const more = await query(
      `SELECT ad_creative_id, preview_url FROM market_creatives
        WHERE format = 'video' AND preview_url IS NOT NULL AND enriched_at IS NULL
          AND ad_creative_id <> ALL($2::text[])
        ORDER BY first_shown DESC NULLS LAST LIMIT $1`,
      [limit - rows.length, rows.map((r) => r.ad_creative_id)]
    );
    rows.push(...more.rows);
  }
  let done = 0; let found = 0;
  for (const r of rows) {
    const cool = enrich.cooldownUntil - Date.now();
    if (cool > 0) return { done, found, blocked: `enrichment cooling down, ${Math.ceil(cool / MIN)} min left` };
    const wait = enrich.lastAt + num('MARKET_INTEL_ENRICH_DELAY_MS', 5000, 1500, 60000) - Date.now();
    if (wait > 0) await sleep(wait);
    enrich.lastAt = Date.now();
    let res;
    try {
      res = await fetchText(r.preview_url);
    } catch (e) {
      logger.warn(`[market-intel] enrich failed: ${e.message}`);
      continue;
    }
    if (res.status === 429 || res.status === 403 || res.status === 302 || res.status === 303) {
enrich.cooldownUntil = Date.now() + 10 * MIN;
      return { done, found, blocked: `preview host answered HTTP ${res.status}; pausing 10 min` };
    }
    if (res.status !== 200) {
      // Expired/invalid preview link: mark it so we do not retry forever.
      await query('UPDATE market_creatives SET enriched_at = now() WHERE ad_creative_id = $1', [r.ad_creative_id]);
      continue;
    }
    const info = parsePreview(res.text);
    await query(
      `UPDATE market_creatives SET youtube_id = $2, app_icon = $3, app_name = $4, enriched_at = now() WHERE ad_creative_id = $1`,
      [r.ad_creative_id, info.youtubeId, info.appIcon, info.appName]
    );
    done += 1;
    if (info.youtubeId) found += 1;
  }
  return { done, found };
}

let running = false;

/** One bounded chunk of work: finish backfills first, then refresh stale advertisers. */
async function syncTracked({ requestBudget } = {}) {
  if (running) return { calls: 0, saved: 0, skipped: 'a sync is already running', ...(await progress()) };
  running = true;
  const budget = requestBudget || cfg().budget;
  let calls = 0; let saved = 0; let failed = 0; let advertisers = 0; let completed = 0; let blocked = null;
  try {
    const { rows } = await query(
      `SELECT advertiser_id, backfill_token, backfill_pages, backfill_done FROM market_advertisers
        WHERE tracked = true
          AND (NOT backfill_done OR last_synced_at IS NULL OR last_synced_at < now() - ($1 || ' hours')::interval)
        ORDER BY backfill_done ASC, last_synced_at ASC NULLS FIRST, added_at ASC LIMIT 200`,
      [String(cfg().refreshHours)]
    );
    for (const adv of rows) {
      if (calls >= budget) break;
      try {
        const r = await advance(adv, budget - calls);
        calls += r.calls; saved += r.saved; advertisers += 1;
        if (r.finished) completed += 1;
      } catch (e) {
        calls += e.partial?.calls || 0; saved += e.partial?.saved || 0;
        failed += 1;
        logger.warn(`[market-intel] ${adv.advertiser_id}: ${e.message}`);
        if (e instanceof BlockedError) { blocked = e.message; break; }
      }
    }
    logger.info(`[market-intel] chunk: advertisers=${advertisers} calls=${calls} creatives=${saved} backfills-finished=${completed} failed=${failed}${blocked ? ` BLOCKED: ${blocked}` : ''}`);
    return { advertisers, calls, saved, completed, failed, ...(blocked ? { blocked } : {}), ...(await progress()) };
  } finally {
    running = false;
  }
}

async function progress() {
  const { rows } = await query(
    `SELECT count(*) FILTER (WHERE tracked)::int AS tracked,
            count(*) FILTER (WHERE tracked AND backfill_done)::int AS backfilled
       FROM market_advertisers`
  );
  return { ...rows[0], pending: rows[0].tracked - rows[0].backfilled, ...collectorStatus() };
}

/**
 * Find advertisers for keywords / domains / names: suggestions give advertisers + domains directly;
 * each domain is then searched to learn who advertises it. Adds everything found to the tracked set.
 */
async function discover(terms, { maxNew = 100 } = {}) {
  const found = new Map();
  const add = (id, name) => { if (id && found.size < maxNew) found.set(id, name || found.get(id) || ''); };
  try {
    for (const term of terms.map((t) => String(t).trim()).filter(Boolean).slice(0, 10)) {
      const s = await rpc('SearchSuggestions', { '1': term, '2': 10, '3': 10 });
      const domains = [];
      for (const item of s['1'] || []) {
        if (item['1']) add(item['1']['2'], item['1']['1']);
        else if (item['2']?.['1']) domains.push(item['2']['1']);
      }
      for (const domain of domains.slice(0, 4)) {
        const page = await fetchCreatives({ text: domain });
        await upsert(page.creatives, domain);
        for (const c of page.creatives) add(c.advertiserId, c.advertiser);
      }
    }
  } catch (e) {
    // Keep whatever was found before a block; the caller still gets a useful result.
    if (!(e instanceof BlockedError) || !found.size) throw e;
    logger.warn(`[market-intel] discovery stopped early: ${e.message}`);
  }
  for (const [id, name] of found) await trackAdvertiser(id, name);
  return [...found].map(([advertiserId, name]) => ({ advertiserId, name }));
}

module.exports = { enrichBatch, parsePreview, fetchCreatives, syncTracked, discover, trackAdvertiser, progress, collectorStatus, BlockedError };
