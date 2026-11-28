/**
 * Market Intel — competitor ads (Google Ads Transparency Center via SerpApi), read from our own tables.
 * Reading needs the same access as Ad Insights; adding advertisers / syncing is admin-only.
 */
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { query } = require('../db');
const { hasFlag, isAdmin } = require('../utils/permissions');
const market = require('../services/marketIntelService');
const scraper = require('../services/marketScraper');
// Default source is the direct Transparency Center collector; MARKET_INTEL_SOURCE=serpapi keeps the paid API.
const SERPAPI = String(process.env.MARKET_INTEL_SOURCE || '').toLowerCase() === 'serpapi';
const logger = require('../utils/logger');

router.use(requireAuth);

router.use((req, res, next) => {
  if (!isAdmin(req.user) && !hasFlag(req.user, 'canAccessMyAds')) {
    return res.status(403).json({ error: 'You do not have access to Market Intel.' });
  }
  return next();
});

const adminOnly = (req, res, next) => (isAdmin(req.user) ? next() : res.status(403).json({ error: 'Admins only.' }));

// Best Apps, Websites, Other assets, Explorer, Match Videos, App Lookup, Compare, Groups (same auth as above).
router.use(require('./marketIntelExtra'));

const DAY = "interval '1 day'";
const WINDOWS = { today: 1, '24h': 1, '3d': 3, '7d': 7, '30d': 30, '90d': 90 };

/** WHERE clause + params from the filters the Ads Viewer sends. */
function buildWhere(q) {
  const where = [];
  const params = [];
  // Every "?" in a clause refers to the same single parameter.
  const add = (sql, value) => { params.push(value); where.push(sql.replace(/\?/g, `$${params.length}`)); };
  const text = String(q.q || '').trim();
  if (text) add('(advertiser_name ILIKE ? OR target_domain ILIKE ? OR ad_creative_id ILIKE ? OR app_name ILIKE ?)', `%${text}%`);
  if (WINDOWS[q.seen]) where.push(`last_shown >= now() - ${WINDOWS[q.seen]} * ${DAY}`);
  if (WINDOWS[q.first]) where.push(`first_shown >= now() - ${WINDOWS[q.first]} * ${DAY}`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(q.firstDate || ''))) {
    params.push(q.firstDate);
    where.push(`first_shown >= $${params.length}::date AND first_shown < $${params.length}::date + interval '1 day'`);
  }
  if (['video', 'image', 'text'].includes(q.format)) add('format = ?', q.format);
  if (q.advertiser) add('(advertiser_name ILIKE ? OR advertiser_id ILIKE ?)', `%${String(q.advertiser).trim()}%`);
  if (q.domain) add('target_domain ILIKE ?', `%${String(q.domain).trim()}%`);
  if (q.status === 'active') where.push(`last_shown >= now() - 3 * ${DAY}`);
  if (q.status === 'inactive') where.push(`(last_shown IS NULL OR last_shown < now() - 3 * ${DAY})`);
  const minDays = parseInt(q.minDays, 10);
  if (minDays > 0) add('total_days_shown >= ?', minDays);
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

const SORTS = {
  new: 'first_shown DESC NULLS LAST',
  recent: 'last_shown DESC NULLS LAST',
  longest: 'total_days_shown DESC',
};

router.get('/creatives', async (req, res) => {
  try {
    const { sql, params } = buildWhere(req.query);
    const pageSize = Math.min(60, Math.max(6, parseInt(req.query.pageSize, 10) || 24));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const order = SORTS[req.query.sort] || SORTS.new;
    const total = (await query(`SELECT count(*)::int n FROM market_creatives ${sql}`, params)).rows[0].n;
    const { rows } = await query(
      `SELECT ad_creative_id, advertiser_id, advertiser_name, format, target_domain, image_url, preview_url,
              width, height, total_days_shown, first_shown, last_shown, details_link,
              youtube_id, app_icon, app_name,
              (last_shown >= now() - 3 * ${DAY}) AS active
         FROM market_creatives ${sql}
        ORDER BY ${order}
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params
    );
    res.json({
      total, page, pageSize,
      creatives: rows.map((r) => ({
        id: r.ad_creative_id,
        advertiserId: r.advertiser_id,
        advertiser: r.advertiser_name,
        format: r.format,
        domain: r.target_domain,
        imageUrl: r.image_url,
        previewUrl: r.preview_url,
        width: r.width,
        height: r.height,
        daysShown: r.total_days_shown,
        firstShown: r.first_shown,
        lastShown: r.last_shown,
        link: r.details_link,
        youtubeId: r.youtube_id,
        appIcon: r.app_icon,
        appName: r.app_name,
        active: r.active === true,
      })),
    });
  } catch (err) {
    logger.error(`Market Intel creatives: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/summary', async (req, res) => {
  try {
    const { sql, params } = buildWhere(req.query);
    const { rows } = await query(
      `SELECT count(*)::int AS results,
              count(*) FILTER (WHERE last_shown >= now() - 3 * ${DAY})::int AS live_now,
              count(*) FILTER (WHERE first_shown >= now() - 7 * ${DAY})::int AS new_7d,
              count(DISTINCT advertiser_id)::int AS advertisers,
              COALESCE(round(avg(total_days_shown))::int, 0) AS avg_days,
              count(*) FILTER (WHERE format = 'video')::int AS video,
              count(*) FILTER (WHERE format = 'image')::int AS image,
              count(*) FILTER (WHERE format = 'text')::int AS text
         FROM market_creatives ${sql}`,
      params
    );
    const adv = (await query(
      `SELECT count(*)::int AS tracked, max(last_synced_at) AS last_synced FROM market_advertisers WHERE tracked = true`
    )).rows[0];
    res.json({ ...rows[0], trackedAdvertisers: adv.tracked, lastSynced: adv.last_synced });
  } catch (err) {
    logger.error(`Market Intel summary: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/** Market Pulse: one call for the overview page (KPIs vs previous week, launches per day, bursts, new apps, feed). */
router.get('/pulse', async (req, res) => {
  try {
    const kpi = (await query(
      `SELECT count(*) FILTER (WHERE first_shown >= now() - 7 * ${DAY})::int AS new_7d,
              count(*) FILTER (WHERE first_shown >= now() - 14 * ${DAY} AND first_shown < now() - 7 * ${DAY})::int AS new_prev_7d,
              count(*) FILTER (WHERE first_shown >= date_trunc('day', now()))::int AS new_today,
              count(*) FILTER (WHERE last_shown >= now() - 3 * ${DAY})::int AS live,
              count(*) FILTER (WHERE first_shown <= now() - 7 * ${DAY} AND last_shown >= now() - 10 * ${DAY})::int AS live_week_ago,
              count(DISTINCT advertiser_id) FILTER (WHERE last_shown >= now() - 3 * ${DAY})::int AS active_advertisers,
              count(*) FILTER (WHERE last_shown >= now() - 3 * ${DAY} AND format = 'video')::int AS live_video,
              count(*) FILTER (WHERE last_shown >= now() - 3 * ${DAY} AND format = 'image')::int AS live_image,
              count(*) FILTER (WHERE last_shown >= now() - 3 * ${DAY} AND format = 'text')::int AS live_text
         FROM market_creatives`
    )).rows[0];
    const tracked = (await query(
      `SELECT count(*)::int AS tracked, max(last_synced_at) AS last_synced FROM market_advertisers WHERE tracked = true`
    )).rows[0];
    const daily = (await query(
      `SELECT to_char(d::date, 'YYYY-MM-DD') AS date,
              count(c.*) FILTER (WHERE c.format = 'video')::int AS video,
              count(c.*) FILTER (WHERE c.format = 'image')::int AS image,
              count(c.*) FILTER (WHERE c.format NOT IN ('video','image'))::int AS text
         FROM generate_series(date_trunc('day', now()) - interval '29 days', date_trunc('day', now()), interval '1 day') d
         LEFT JOIN market_creatives c ON c.first_shown >= d AND c.first_shown < d + interval '1 day'
        GROUP BY d ORDER BY d`
    )).rows.map((r) => ({ ...r, total: r.video + r.image + r.text }));
    const bursts = (await query(
      `SELECT advertiser_id, max(advertiser_name) AS name,
              count(*) FILTER (WHERE first_shown >= now() - 7 * ${DAY})::int AS new_7d,
              count(*) FILTER (WHERE first_shown >= now() - 14 * ${DAY} AND first_shown < now() - 7 * ${DAY})::int AS prev_7d,
              count(*) FILTER (WHERE first_shown >= now() - 7 * ${DAY} AND format = 'video')::int AS video_7d,
              max(first_shown) AS last_launch,
              (SELECT m.app_icon FROM market_creatives m WHERE m.advertiser_id = market_creatives.advertiser_id AND m.app_icon IS NOT NULL ORDER BY m.first_shown DESC NULLS LAST LIMIT 1) AS top_app_icon,
              (SELECT m.app_name FROM market_creatives m WHERE m.advertiser_id = market_creatives.advertiser_id AND m.app_name IS NOT NULL ORDER BY m.first_shown DESC NULLS LAST LIMIT 1) AS top_app_name
         FROM market_creatives GROUP BY advertiser_id
       HAVING count(*) FILTER (WHERE first_shown >= now() - 7 * ${DAY}) > 0
        ORDER BY new_7d DESC LIMIT 40`
    )).rows.map((r) => ({
      ...r, changePct: r.prev_7d > 0 ? Math.round(((r.new_7d - r.prev_7d) / r.prev_7d) * 1000) / 10 : null,
    }));
    // New advertisers: their very first ad appeared in the last 7 days.
    const newApps = (await query(
      `SELECT advertiser_id, max(advertiser_name) AS advertiser, min(first_shown) AS first_ad, count(*)::int AS ads,
              (SELECT m.app_icon FROM market_creatives m WHERE m.advertiser_id = market_creatives.advertiser_id AND m.app_icon IS NOT NULL ORDER BY m.first_shown DESC NULLS LAST LIMIT 1) AS top_app_icon,
              (SELECT m.app_name FROM market_creatives m WHERE m.advertiser_id = market_creatives.advertiser_id AND m.app_name IS NOT NULL ORDER BY m.first_shown DESC NULLS LAST LIMIT 1) AS top_app_name
         FROM market_creatives GROUP BY advertiser_id
       HAVING min(first_shown) >= now() - 7 * ${DAY}
        ORDER BY ads DESC, first_ad DESC LIMIT 12`
    )).rows;
    // Most live ads right now, per advertiser.
    const topDomains = (await query(
      `SELECT advertiser_id, max(advertiser_name) AS advertiser, count(*)::int AS ads,
              count(*) FILTER (WHERE format = 'video')::int AS video,
              (SELECT m.app_icon FROM market_creatives m WHERE m.advertiser_id = market_creatives.advertiser_id AND m.app_icon IS NOT NULL ORDER BY m.first_shown DESC NULLS LAST LIMIT 1) AS top_app_icon,
              (SELECT m.app_name FROM market_creatives m WHERE m.advertiser_id = market_creatives.advertiser_id AND m.app_name IS NOT NULL ORDER BY m.first_shown DESC NULLS LAST LIMIT 1) AS top_app_name
         FROM market_creatives WHERE last_shown >= now() - 3 * ${DAY}
        GROUP BY advertiser_id ORDER BY ads DESC LIMIT 10`
    )).rows;
    res.json({
      ...kpi, trackedAdvertisers: tracked.tracked, lastSynced: tracked.last_synced,
      daily, bursts, newApps, topDomains,
    });
  } catch (err) {
    logger.error(`Market Intel pulse: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});


/* ---------------- What to build ----------------
 * An "app" is an app name identified on the ads we collected (video preview lookup), per advertiser.
 * A niche is a word many app names share. Score (0-100) weighs new apps (35), apps with a winner ad (30)
 * and new ads this week (20), each relative to the strongest niche; YouTube views are not collected.
 */
const STOP = new Set(['app', 'apps', 'the', 'and', 'for', 'with', 'free', 'pro', 'new', 'best', 'plus', 'lite', 'mod', 'your', 'you',
  'get', 'all', 'one', 'are', 'not', 'can', 'will', 'game', 'games', 'online', 'android', 'ios', 'mobile', 'official']);
const WINNER_DAYS = 30;
const NEW_DAYS = 14;

function nameWords(name) {
  const found = String(name || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return [...new Set(found.filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !STOP.has(w)))];
}

async function loadApps() {
  const { rows } = await query(
    `SELECT lower(app_name) AS key, max(app_name) AS name, advertiser_id, max(advertiser_name) AS advertiser_name,
            (array_agg(app_icon ORDER BY first_shown DESC NULLS LAST) FILTER (WHERE app_icon IS NOT NULL))[1] AS icon,
            count(*)::int AS ads,
            count(*) FILTER (WHERE last_shown >= now() - 3 * ${DAY})::int AS live_ads,
            count(*) FILTER (WHERE first_shown >= now() - 7 * ${DAY})::int AS new_7d,
            count(*) FILTER (WHERE last_shown >= now() - 3 * ${DAY} AND total_days_shown >= ${WINNER_DAYS})::int AS winner_ads,
            coalesce(max(total_days_shown), 0)::int AS longest_days,
            min(first_shown) AS first_seen
       FROM market_creatives
      WHERE app_name IS NOT NULL AND app_name <> ''
      GROUP BY lower(app_name), advertiser_id`
  );
  const cut = Date.now() - NEW_DAYS * 86400000;
  return rows.map((r) => ({ ...r, product_id: `${r.advertiser_id}|${r.key}`, is_new: r.first_seen ? new Date(r.first_seen).getTime() >= cut : false }));
}

const rankApps = (a, b) => (b.is_new - a.is_new) || (b.winner_ads - a.winner_ads) || (b.new_7d - a.new_7d) || (b.live_ads - a.live_ads);

function buildNiches(apps) {
  const map = new Map();
  for (const a of apps) for (const w of nameWords(a.name)) { if (!map.has(w)) map.set(w, []); map.get(w).push(a); }
  const raw = [];
  for (const [word, list] of map) {
    if (list.length < 2) continue;
    raw.push({
      word, list, apps: list.length, advertisers: new Set(list.map((a) => a.advertiser_id)).size,
      new_apps: list.filter((a) => a.is_new).length, winner_apps: list.filter((a) => a.winner_ads > 0).length,
      new_ads_7d: list.reduce((n, a) => n + a.new_7d, 0),
    });
  }
  const max = (k) => Math.max(1, ...raw.map((x) => x[k]));
  const mNew = max('new_apps'); const mWin = max('winner_apps'); const mAds = max('new_ads_7d');
  return raw.map((x) => {
    const score = Math.round(((35 * x.new_apps) / mNew + (30 * x.winner_apps) / mWin + (20 * x.new_ads_7d) / mAds) / 85 * 100);
    const why = [];
    if (x.new_apps) why.push(`${x.new_apps} new app${x.new_apps === 1 ? '' : 's'} started advertising in ${NEW_DAYS} days`);
    if (x.winner_apps) why.push(`${x.winner_apps} app${x.winner_apps === 1 ? ' has' : 's have'} an ad still running after ${WINNER_DAYS}+ days`);
    if (x.new_ads_7d) why.push(`${x.new_ads_7d} new ad${x.new_ads_7d === 1 ? '' : 's'} this week`);
    return {
      word: x.word, apps: x.apps, advertisers: x.advertisers, new_apps: x.new_apps, winner_apps: x.winner_apps, new_ads_7d: x.new_ads_7d,
      score, crowd: x.advertisers <= 3 ? 'open' : x.advertisers <= 8 ? 'busy' : 'crowded', why,
      examples: [...x.list].sort(rankApps).slice(0, 6),
    };
  }).sort((a, b) => b.score - a.score || b.apps - a.apps).slice(0, 40);
}

router.get('/opps', async (req, res) => {
  try {
    const apps = await loadApps();
    const cov = (await query(
      `SELECT count(*) FILTER (WHERE format = 'video')::int AS videos, count(*) FILTER (WHERE app_name IS NOT NULL AND app_name <> '')::int AS identified FROM market_creatives`
    )).rows[0];
    res.json({
      generated_at: new Date().toISOString(), new_days: NEW_DAYS, winner_days: WINNER_DAYS,
      live_apps: apps.filter((a) => a.live_ads > 0).length,
      new_apps: apps.filter((a) => a.is_new).length,
      winner_apps: apps.filter((a) => a.winner_ads > 0).length,
      coverage: { videos: cov.videos, identified: cov.identified },
      niches: buildNiches(apps),
      rising: apps.filter((a) => a.is_new && a.new_7d > 0 && a.live_ads >= 2).sort((a, b) => b.new_7d - a.new_7d).slice(0, 30),
    });
  } catch (err) {
    logger.error(`Market Intel opps: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/** Closest competitors of an app (matched on the words of its name) and what they launched this week. */
router.get('/opps/mine', async (req, res) => {
  try {
    const words = nameWords(req.query.q);
    if (!words.length) return res.json({ words: [], competitors: [], newAds: [] });
    const apps = await loadApps();
    const competitors = apps
      .map((a) => ({ ...a, overlap: nameWords(a.name).filter((w) => words.includes(w)).length }))
      .filter((a) => a.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap || b.live_ads - a.live_ads)
      .slice(0, 24);
    let newAds = [];
    if (competitors.length) {
      const names = [...new Set(competitors.map((c) => c.key))];
      const { rows } = await query(
        `SELECT ad_creative_id, advertiser_id, advertiser_name, format, target_domain, image_url, preview_url, total_days_shown, first_shown, last_shown, details_link, youtube_id, app_icon, app_name, (last_shown >= now() - 3 * ${DAY}) AS active FROM market_creatives WHERE lower(app_name) = ANY($1) AND first_shown >= now() - 7 * ${DAY} ORDER BY first_shown DESC LIMIT 24`,
        [names]
      );
      newAds = rows.map((r) => ({
        id: r.ad_creative_id, advertiserId: r.advertiser_id, advertiser: r.advertiser_name, format: r.format, domain: r.target_domain,
        imageUrl: r.image_url, previewUrl: r.preview_url, daysShown: r.total_days_shown, firstShown: r.first_shown, lastShown: r.last_shown,
        link: r.details_link, active: r.active === true, youtubeId: r.youtube_id, appIcon: r.app_icon, appName: r.app_name,
      }));
    }
    res.json({ words, competitors, newAds });
  } catch (err) {
    logger.error(`Market Intel opps/mine: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/* ---------------- Marketing Intel ----------------
 * Who is pushing hardest, launching or sustaining. Kpeworld also shows Google's EU impression ranges and
 * country footprint; the public search results we collect carry neither, so those panels are not built.
 */
const CREATIVE_COLS = `ad_creative_id, advertiser_id, advertiser_name, format, target_domain, image_url, preview_url, width, height,
  total_days_shown, first_shown, last_shown, details_link, youtube_id, app_icon, app_name, (last_shown >= now() - 3 * ${DAY}) AS active`;

const mapCreative = (r) => ({
  id: r.ad_creative_id, advertiserId: r.advertiser_id, advertiser: r.advertiser_name, format: r.format, domain: r.target_domain,
  imageUrl: r.image_url, previewUrl: r.preview_url, width: r.width, height: r.height, daysShown: r.total_days_shown,
  firstShown: r.first_shown, lastShown: r.last_shown, link: r.details_link, youtubeId: r.youtube_id, appIcon: r.app_icon,
  appName: r.app_name, active: r.active === true,
});

/** Advertiser-level activity inside the last `days` days (an ad counts when it was shown in the window). */
async function advertiserActivity(days) {
  const { rows } = await query(
    `SELECT advertiser_id, max(advertiser_name) AS advertiser_name,
            count(*) FILTER (WHERE last_shown >= now() - $1 * ${DAY})::int AS live_ads,
            count(*) FILTER (WHERE first_shown >= now() - $1 * ${DAY})::int AS new_ads,
            count(*) FILTER (WHERE first_shown >= now() - 2 * $1 * ${DAY} AND first_shown < now() - $1 * ${DAY})::int AS prev_new_ads,
            count(*) FILTER (WHERE format = 'video' AND last_shown >= now() - $1 * ${DAY})::int AS video_ads,
            coalesce(max(CASE WHEN last_shown >= now() - $1 * ${DAY}
                 THEN extract(day FROM last_shown - greatest(first_shown, now() - $1 * ${DAY})) + 1 END), 0)::int AS days_active,
            coalesce(max(total_days_shown) FILTER (WHERE last_shown >= now() - $1 * ${DAY}), 0)::int AS longest_days,
            (array_agg(app_name ORDER BY first_shown DESC NULLS LAST) FILTER (WHERE app_name IS NOT NULL AND app_name <> ''))[1] AS app_name,
            (array_agg(app_icon ORDER BY first_shown DESC NULLS LAST) FILTER (WHERE app_icon IS NOT NULL))[1] AS app_icon
       FROM market_creatives
      GROUP BY advertiser_id
     HAVING count(*) FILTER (WHERE last_shown >= now() - $1 * ${DAY}) > 0`,
    [days]
  );
  return rows;
}

router.get('/intel', async (req, res) => {
  try {
    const days = Math.min(30, Math.max(1, parseInt(req.query.days, 10) || 7));
    const act = await advertiserActivity(days);
    const max = (k) => Math.max(1, ...act.map((r) => r[k]));
    const mLive = max('live_ads'); const mNew = max('new_ads');

    const recommendations = act.map((r) => {
      const score = (40 * r.new_ads) / mNew + (35 * r.live_ads) / mLive + (25 * Math.min(r.days_active, days)) / days;
      return { ...r, score: Math.round(score * 10) / 10 };
    }).sort((a, b) => b.score - a.score).slice(0, 25);

    const best = [...act].sort((a, b) => b.live_ads - a.live_ads || b.new_ads - a.new_ads).slice(0, 25);

    const surging = act
      .filter((r) => r.new_ads >= 3)
      .map((r) => ({ ...r, growth: r.prev_new_ads ? Math.round(((r.new_ads - r.prev_new_ads) / r.prev_new_ads) * 100) : null }))
      .sort((a, b) => (b.new_ads - b.prev_new_ads) - (a.new_ads - a.prev_new_ads))
      .slice(0, 25);

    // Consistency: share of the last 30 days on which an advertiser had at least one ad running.
    const consistent = (await query(
      `SELECT advertiser_id, max(advertiser_name) AS advertiser_name, count(DISTINCT d)::int AS days_with_ads,
              count(DISTINCT c.ad_creative_id)::int AS ads,
              (array_agg(c.app_name ORDER BY c.first_shown DESC NULLS LAST) FILTER (WHERE c.app_name IS NOT NULL AND c.app_name <> ''))[1] AS app_name,
              (array_agg(c.app_icon ORDER BY c.first_shown DESC NULLS LAST) FILTER (WHERE c.app_icon IS NOT NULL))[1] AS app_icon
         FROM market_creatives c
         CROSS JOIN LATERAL generate_series(greatest(c.first_shown, now() - 30 * ${DAY})::date, least(c.last_shown, now())::date, interval '1 day') AS d
        WHERE c.last_shown >= now() - 30 * ${DAY} AND c.first_shown IS NOT NULL AND c.last_shown >= c.first_shown
        GROUP BY advertiser_id
        ORDER BY days_with_ads DESC, ads DESC
        LIMIT 25`
    )).rows;

    const mix = (await query(
      `SELECT format, count(*)::int AS n FROM market_creatives WHERE last_shown >= now() - $1 * ${DAY} GROUP BY format`, [days]
    )).rows;
    const names = (await query(
      `SELECT app_name FROM market_creatives WHERE app_name IS NOT NULL AND app_name <> '' AND last_shown >= now() - $1 * ${DAY}`, [days]
    )).rows;
    const wc = new Map();
    for (const { app_name: n } of names) for (const w of nameWords(n)) wc.set(w, (wc.get(w) || 0) + 1);
    const topics = [...wc].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([word, ads]) => ({ word, ads }));

    res.json({
      days, advertisers: act.length,
      totals: {
        live_ads: act.reduce((n, r) => n + r.live_ads, 0),
        new_ads: act.reduce((n, r) => n + r.new_ads, 0),
        surging: act.filter((r) => r.new_ads >= 3 && r.new_ads > r.prev_new_ads).length,
      },
      recommendations, best, surging, consistent, formats: mix, topics,
    });
  } catch (err) {
    logger.error(`Market Intel intel: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/* ---------------- Universal search ----------------
 * One box over ads, advertisers, apps and videos. Understands words, AR…/CR… ids, YouTube links and domains/packages.
 */
function parseSearchTerm(raw) {
  let text = String(raw || '').trim().slice(0, 200);
  let kind = 'text';
  const yt = text.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{11})/i);
  if (yt) { text = yt[1]; kind = 'youtube'; }
  else if (/^AR\d{10,}$/i.test(text)) { text = text.toUpperCase(); kind = 'advertiser'; }
  else if (/^CR\d{10,}$/i.test(text)) { text = text.toUpperCase(); kind = 'creative'; }
  else if (/^[a-z][\w]*(\.[\w-]+){2,}$/i.test(text)) kind = 'package';
  else if (/^https?:\/\//i.test(text)) {
    try { text = new URL(text).hostname.replace(/^www\./, ''); kind = 'domain'; } catch { /* keep text */ }
  }
  return { text, kind };
}

router.get('/search', async (req, res) => {
  try {
    const { text, kind } = parseSearchTerm(req.query.q);
    const type = ['all', 'ads', 'advertisers', 'apps', 'videos'].includes(req.query.type) ? req.query.type : 'all';
    const suggest = req.query.mode === 'suggest';
    if (text.length < 2) return res.json({ q: text, kind, counts: {}, ads: [], advertisers: [], apps: [], videos: [] });
    const like = `%${text.replace(/[%_\\]/g, '\\$&')}%`;
    const per = suggest ? 5 : Math.min(48, Math.max(6, parseInt(req.query.perPage, 10) || 24));
    const want = (t) => type === 'all' || type === t;

    const adSql = `(advertiser_name ILIKE $1 OR target_domain ILIKE $1 OR ad_creative_id ILIKE $1 OR app_name ILIKE $1 OR youtube_id ILIKE $1 OR details_link ILIKE $1)`;
    const out = { q: text, kind, counts: {}, ads: [], advertisers: [], apps: [], videos: [] };

    const adCount = (await query(`SELECT count(*)::int n, count(*) FILTER (WHERE youtube_id IS NOT NULL)::int v FROM market_creatives WHERE ${adSql}`, [like])).rows[0];
    out.counts.ads = adCount.n;
    out.counts.videos = adCount.v;

    if (want('ads')) {
      out.ads = (await query(`SELECT ${CREATIVE_COLS} FROM market_creatives WHERE ${adSql} ORDER BY last_shown DESC NULLS LAST LIMIT ${per}`, [like])).rows.map(mapCreative);
    }
    if (want('videos')) {
      out.videos = (await query(`SELECT ${CREATIVE_COLS} FROM market_creatives WHERE youtube_id IS NOT NULL AND ${adSql} ORDER BY last_shown DESC NULLS LAST LIMIT ${per}`, [like])).rows.map(mapCreative);
    }

    const advWhere = `(a.name ILIKE $1 OR a.advertiser_id ILIKE $1)`;
    out.counts.advertisers = (await query(`SELECT count(*)::int n FROM market_advertisers a WHERE ${advWhere}`, [like])).rows[0].n;
    if (want('advertisers')) {
      out.advertisers = (await query(
        `SELECT a.advertiser_id, a.name, coalesce(s.total_ads, 0) AS total_ads, coalesce(s.live_ads, 0) AS live_ads,
                coalesce(s.new_7d, 0) AS new_7d, s.last_ad,
                (SELECT m.app_icon FROM market_creatives m WHERE m.advertiser_id = a.advertiser_id AND m.app_icon IS NOT NULL ORDER BY m.first_shown DESC NULLS LAST LIMIT 1) AS top_app_icon,
                (SELECT m.app_name FROM market_creatives m WHERE m.advertiser_id = a.advertiser_id AND m.app_name IS NOT NULL ORDER BY m.first_shown DESC NULLS LAST LIMIT 1) AS top_app_name
           FROM market_advertisers a
           LEFT JOIN (SELECT advertiser_id, count(*)::int AS total_ads,
                             count(*) FILTER (WHERE last_shown >= now() - 3 * ${DAY})::int AS live_ads,
                             count(*) FILTER (WHERE first_shown >= now() - 7 * ${DAY})::int AS new_7d, max(last_shown) AS last_ad
                        FROM market_creatives GROUP BY advertiser_id) s ON s.advertiser_id = a.advertiser_id
          WHERE ${advWhere}
          ORDER BY s.live_ads DESC NULLS LAST, s.total_ads DESC NULLS LAST LIMIT ${per}`, [like]
      )).rows;
    }

    const appWhere = `app_name IS NOT NULL AND app_name <> '' AND (app_name ILIKE $1 OR advertiser_name ILIKE $1)`;
    out.counts.apps = (await query(`SELECT count(DISTINCT (lower(app_name), advertiser_id))::int n FROM market_creatives WHERE ${appWhere}`, [like])).rows[0].n;
    if (want('apps')) {
      out.apps = (await query(
        `SELECT max(app_name) AS name, advertiser_id, max(advertiser_name) AS advertiser_name,
                (array_agg(app_icon ORDER BY first_shown DESC NULLS LAST) FILTER (WHERE app_icon IS NOT NULL))[1] AS icon,
                count(*)::int AS ads, count(*) FILTER (WHERE last_shown >= now() - 3 * ${DAY})::int AS live_ads,
                count(*) FILTER (WHERE first_shown >= now() - 7 * ${DAY})::int AS new_7d,
                coalesce(max(total_days_shown), 0)::int AS longest_days, min(first_shown) AS first_seen
           FROM market_creatives WHERE ${appWhere}
          GROUP BY lower(app_name), advertiser_id
          ORDER BY live_ads DESC, ads DESC LIMIT ${per}`, [like]
      )).rows;
    }
    res.json(out);
  } catch (err) {
    logger.error(`Market Intel search: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/advertisers', async (req, res) => {
  try {
    // Filters: q, status (active|inactive), onlyNew (first ad in 30 days), hasAds, minAds, sort
    const where = [];
    const params = [];
    const q = String(req.query.q || '').trim();
    if (q) { params.push(`%${q}%`); where.push(`(a.name ILIKE $${params.length} OR a.advertiser_id ILIKE $${params.length})`); }
    const minAds = parseInt(req.query.minAds, 10);
    if (minAds > 0) { params.push(minAds); where.push(`coalesce(s.total_ads, 0) >= $${params.length}`); }
    if (req.query.status === 'active') where.push('coalesce(s.live_ads, 0) > 0');
    if (req.query.status === 'inactive') where.push('coalesce(s.live_ads, 0) = 0');
    if (req.query.onlyNew === '1') where.push(`s.first_ad >= now() - 30 * ${DAY}`);
    if (req.query.hasAds === '1') where.push('coalesce(s.total_ads, 0) > 0');
    const sorts = {
      live: 's.live_ads DESC NULLS LAST', total: 's.total_ads DESC NULLS LAST', new: 's.new_7d DESC NULLS LAST',
      recent: 's.last_ad DESC NULLS LAST', name: 'a.name ASC',
    };
    const { rows } = await query(
      `SELECT a.advertiser_id, a.name, a.tracked, a.last_synced_at, a.last_error, a.backfill_done,
              coalesce(s.total_ads, 0) AS total_ads, coalesce(s.live_ads, 0) AS live_ads, coalesce(s.new_7d, 0) AS new_7d,
              coalesce(s.video, 0) AS video, coalesce(s.avg_days, 0) AS avg_days, s.first_ad, s.last_ad,
              (SELECT m.app_icon FROM market_creatives m WHERE m.advertiser_id = a.advertiser_id AND m.app_icon IS NOT NULL ORDER BY m.first_shown DESC NULLS LAST LIMIT 1) AS top_app_icon,
              (SELECT m.app_name FROM market_creatives m WHERE m.advertiser_id = a.advertiser_id AND m.app_name IS NOT NULL ORDER BY m.first_shown DESC NULLS LAST LIMIT 1) AS top_app_name
         FROM market_advertisers a
         LEFT JOIN (
           SELECT advertiser_id, count(*)::int AS total_ads,
                  count(*) FILTER (WHERE last_shown >= now() - 3 * ${DAY})::int AS live_ads,
                  count(*) FILTER (WHERE first_shown >= now() - 7 * ${DAY})::int AS new_7d,
                  count(*) FILTER (WHERE format = 'video')::int AS video,
                  round(avg(total_days_shown))::int AS avg_days,
                  min(first_shown) AS first_ad, max(last_shown) AS last_ad
             FROM market_creatives GROUP BY advertiser_id
         ) s ON s.advertiser_id = a.advertiser_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY ${sorts[req.query.sort] || sorts.live}, a.added_at DESC LIMIT 500`,
      params
    );
    res.json({ advertisers: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Body: { advertiserIds: ["AR…"], domains: ["example.com"] } — a domain costs 1 SerpApi call each. */
router.post('/advertisers', adminOnly, async (req, res) => {
  try {
    const advertiserIds = Array.isArray(req.body?.advertiserIds) ? req.body.advertiserIds.slice(0, 100) : [];
    const domains = Array.isArray(req.body?.domains) ? req.body.domains.slice(0, 20) : [];
    if (!advertiserIds.length && !domains.length) return res.status(400).json({ error: 'Send advertiserIds and/or domains.' });
    if (SERPAPI) return res.json({ added: await market.trackAdvertisers({ advertiserIds, domains }) });
    // Direct collector: ids are tracked as-is, anything else is searched (names, keywords, domains).
    const added = [];
    for (const id of advertiserIds) { await scraper.trackAdvertiser(String(id).trim()); added.push({ advertiserId: id, name: '' }); }
    if (domains.length) added.push(...(await scraper.discover(domains)));
    res.json({ added });
  } catch (err) {
    logger.error(`Market Intel add advertisers: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/** Backfill progress + rate-limit state of the direct collector. */
router.get('/collector', async (req, res) => {
  try {
    res.json(await scraper.progress());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sync', adminOnly, async (req, res) => {
  try {
    if (SERPAPI) {
      const maxCalls = Math.min(100, parseInt(req.body?.maxCalls, 10) || 0) || undefined;
      return res.json(await market.syncTracked({ maxCalls }));
    }
    const requestBudget = Math.min(60, parseInt(req.body?.requestBudget, 10) || 0) || undefined;
    res.json(await scraper.syncTracked({ requestBudget }));
  } catch (err) {
    logger.error(`Market Intel sync: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
