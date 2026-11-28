/**
 * App Building — the rest of the section: Best Apps, Websites, Other assets, Creative Explorer, Match Videos,
 * App Lookup, Ad Compare, and user-defined App Groups / Video Groups. Mounted inside marketIntel.js, so the
 * same auth + access check applies. Everything is computed from market_creatives / market_advertisers.
 */
const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { isAdmin } = require('../utils/permissions');
const logger = require('../utils/logger');

const DAY = "interval '1 day'";
const adminOnly = (req, res, next) => (isAdmin(req.user) ? next() : res.status(403).json({ error: 'Admins only.' }));
const fail = (res, tag, err) => { logger.error(`Market Intel ${tag}: ${err.message}`); res.status(500).json({ error: err.message }); };
const esc = (s) => String(s || '').trim().slice(0, 120).replace(/[%_\\]/g, '\\$&');

const COLS = `ad_creative_id, advertiser_id, advertiser_name, format, target_domain, image_url, preview_url, width, height,
  total_days_shown, first_shown, last_shown, details_link, youtube_id, app_icon, app_name, (last_shown >= now() - 3 * ${DAY}) AS active`;
const mapCreative = (r) => ({
  id: r.ad_creative_id, advertiserId: r.advertiser_id, advertiser: r.advertiser_name, format: r.format, domain: r.target_domain,
  imageUrl: r.image_url, previewUrl: r.preview_url, width: r.width, height: r.height, daysShown: r.total_days_shown,
  firstShown: r.first_shown, lastShown: r.last_shown, link: r.details_link, youtubeId: r.youtube_id, appIcon: r.app_icon,
  appName: r.app_name, active: r.active === true,
});

/* Apps: an app = an identified app name under one advertiser. */
const APP_SELECT = `
  SELECT max(app_name) AS name, advertiser_id, max(advertiser_name) AS advertiser_name,
         (array_agg(app_icon ORDER BY first_shown DESC NULLS LAST) FILTER (WHERE app_icon IS NOT NULL))[1] AS icon,
         count(*)::int AS ads,
         count(*) FILTER (WHERE last_shown >= now() - 3 * ${DAY})::int AS live_ads,
         count(*) FILTER (WHERE first_shown >= now() - 7 * ${DAY})::int AS new_7d,
         count(*) FILTER (WHERE first_shown >= now() - 30 * ${DAY})::int AS new_30d,
         count(*) FILTER (WHERE format = 'video')::int AS video_ads,
         coalesce(max(total_days_shown), 0)::int AS longest_days,
         min(first_shown) AS first_seen, max(last_shown) AS last_seen
    FROM market_creatives
   WHERE app_name IS NOT NULL AND app_name <> ''`;

router.get('/best-apps', async (req, res) => {
  try {
    const params = [];
    let extra = '';
    const q = String(req.query.q || '').trim();
    if (q) { params.push(`%${esc(q)}%`); extra = ` AND (app_name ILIKE $1 OR advertiser_name ILIKE $1)`; }
    const { rows } = await query(`${APP_SELECT}${extra} GROUP BY lower(app_name), advertiser_id`, params);
    const mx = (k) => Math.max(1, ...rows.map((r) => r[k]));
    const mLive = mx('live_ads'); const mNew = mx('new_30d'); const mLong = mx('longest_days');
    let apps = rows.map((r) => ({ ...r, score: Math.round((40 * r.live_ads) / mLive + (30 * r.new_30d) / mNew + (30 * r.longest_days) / mLong) }));
    const key = { score: 'score', live: 'live_ads', new: 'new_7d', longest: 'longest_days' }[req.query.sort] || 'score';
    if (req.query.status === 'active') apps = apps.filter((a) => a.live_ads > 0);
    apps.sort((a, b) => b[key] - a[key] || b.live_ads - a.live_ads);
    res.json({
      total: apps.length, active: apps.filter((a) => a.live_ads > 0).length,
      avg_days: apps.length ? Math.round(apps.reduce((n, a) => n + a.longest_days, 0) / apps.length) : 0,
      apps: apps.slice(0, 60),
    });
  } catch (err) { fail(res, 'best-apps', err); }
});

router.get('/websites', async (req, res) => {
  try {
    const params = [];
    const where = [`target_domain <> ''`];
    const q = String(req.query.q || '').trim();
    if (q) { params.push(`%${esc(q)}%`); where.push(`(target_domain ILIKE $1 OR advertiser_name ILIKE $1)`); }
    const having = req.query.status === 'active' ? `HAVING count(*) FILTER (WHERE last_shown >= now() - 3 * ${DAY}) > 0` : '';
    const { rows } = await query(
      `SELECT target_domain AS domain, count(DISTINCT advertiser_id)::int AS advertisers, max(advertiser_name) AS advertiser_name,
              count(*)::int AS ads, count(*) FILTER (WHERE last_shown >= now() - 3 * ${DAY})::int AS running,
              count(*) FILTER (WHERE first_shown >= now() - 7 * ${DAY})::int AS new_7d,
              count(*) FILTER (WHERE format = 'video')::int AS video_ads, count(*) FILTER (WHERE format = 'image')::int AS image_ads,
              (array_agg(youtube_id ORDER BY first_shown DESC NULLS LAST) FILTER (WHERE youtube_id IS NOT NULL))[1] AS youtube_id,
              min(first_shown) AS first_seen, max(last_shown) AS last_seen
         FROM market_creatives WHERE ${where.join(' AND ')}
        GROUP BY target_domain ${having}
        ORDER BY running DESC, ads DESC LIMIT 200`, params
    );
    const adv = (await query(`SELECT count(DISTINCT advertiser_id)::int n, count(DISTINCT target_domain)::int d FROM market_creatives WHERE target_domain <> ''`)).rows[0];
    res.json({ websites: adv.d, advertisers: adv.n, rows });
  } catch (err) { fail(res, 'websites', err); }
});

/** Ads whose app we could not identify (no video lookup yet, image/text ads), per advertiser. */
router.get('/other-assets', async (req, res) => {
  try {
    const days = [7, 30, 90].includes(parseInt(req.query.days, 10)) ? parseInt(req.query.days, 10) : 30;
    const params = [days];
    let extra = '';
    const q = String(req.query.q || '').trim();
    if (q) { params.push(`%${esc(q)}%`); extra = ` AND (advertiser_name ILIKE $2 OR advertiser_id ILIKE $2)`; }
    const { rows } = await query(
      `SELECT advertiser_id, max(advertiser_name) AS advertiser_name, count(*)::int AS ads,
              count(*) FILTER (WHERE last_shown >= now() - 3 * ${DAY})::int AS running,
              count(*) FILTER (WHERE format = 'video')::int AS video, count(*) FILTER (WHERE format = 'image')::int AS image,
              count(*) FILTER (WHERE format = 'text')::int AS text,
              count(*) FILTER (WHERE format = 'video' AND enriched_at IS NULL)::int AS unchecked
         FROM market_creatives
        WHERE (app_name IS NULL OR app_name = '') AND last_shown >= now() - $1 * ${DAY}${extra}
        GROUP BY advertiser_id ORDER BY ads DESC LIMIT 500`, params
    );
    const total = (await query(`SELECT count(*)::int AS n FROM market_creatives WHERE (app_name IS NULL OR app_name = '') AND last_shown >= now() - $1 * ${DAY}`, [days])).rows[0].n;
    res.json({ days, total, advertisers: rows });
  } catch (err) { fail(res, 'other-assets', err); }
});

router.get('/explorer', async (req, res) => {
  try {
    const top = (await query(
      `SELECT advertiser_id, max(advertiser_name) AS advertiser_name, count(*)::int AS ads,
              count(*) FILTER (WHERE last_shown >= now() - 3 * ${DAY})::int AS active
         FROM market_creatives GROUP BY advertiser_id ORDER BY ads DESC LIMIT 40`
    )).rows;
    const formats = (await query(`SELECT format, count(*)::int AS ads, count(*) FILTER (WHERE last_shown >= now() - 3 * ${DAY})::int AS active, round(avg(total_days_shown))::int AS avg_days FROM market_creatives GROUP BY format ORDER BY ads DESC`)).rows;
    const sizes = (await query(`SELECT width, height, count(*)::int AS ads FROM market_creatives WHERE width IS NOT NULL AND height IS NOT NULL GROUP BY 1, 2 ORDER BY ads DESC LIMIT 12`)).rows;
    const longevity = (await query(
      `SELECT CASE WHEN total_days_shown < 7 THEN '< 1 week' WHEN total_days_shown < 30 THEN '1–4 weeks'
                   WHEN total_days_shown < 90 THEN '1–3 months' ELSE '3+ months' END AS bucket,
              count(*)::int AS ads, min(total_days_shown) AS lo
         FROM market_creatives GROUP BY 1 ORDER BY lo`
    )).rows;
    const monthly = (await query(
      `SELECT to_char(date_trunc('month', first_shown), 'YYYY-MM') AS month, count(*)::int AS ads
         FROM market_creatives WHERE first_shown >= now() - interval '12 months' GROUP BY 1 ORDER BY 1`
    )).rows;
    res.json({ top, formats, sizes, longevity, monthly });
  } catch (err) { fail(res, 'explorer', err); }
});

/** Same YouTube video used by several ads / several advertisers (shared agencies, networks, copycats). */
router.get('/match-videos', async (req, res) => {
  try {
    const min = Math.max(1, parseInt(req.query.minAdvertisers, 10) || 2);
    const { rows } = await query(
      `SELECT youtube_id, count(*)::int AS ads, count(DISTINCT advertiser_id)::int AS advertisers,
              count(*) FILTER (WHERE last_shown >= now() - 3 * ${DAY})::int AS running,
              max(app_name) AS app_name, (array_agg(app_icon) FILTER (WHERE app_icon IS NOT NULL))[1] AS app_icon,
              array_agg(DISTINCT advertiser_name) AS advertiser_names, min(first_shown) AS first_seen, max(last_shown) AS last_seen
         FROM market_creatives WHERE youtube_id IS NOT NULL
        GROUP BY youtube_id
       HAVING count(DISTINCT advertiser_id) >= $1 ${min < 2 ? 'AND count(*) >= 2' : ''}
        ORDER BY advertisers DESC, ads DESC LIMIT 100`, [min]
    );
    const cov = (await query(`SELECT count(*)::int AS videos, count(*) FILTER (WHERE youtube_id IS NOT NULL)::int AS identified FROM market_creatives WHERE format = 'video'`)).rows[0];
    res.json({ coverage: cov, groups: rows.map((r) => ({ ...r, advertiser_names: (r.advertiser_names || []).slice(0, 6) })) });
  } catch (err) { fail(res, 'match-videos', err); }
});

/** Who advertises this app? Accepts a name, package id or a Play/App Store link. */
router.get('/lookup', async (req, res) => {
  try {
    const raw = String(req.query.q || '').trim().slice(0, 300);
    if (raw.length < 2) return res.json({ term: '', kind: 'text', apps: [], ads: [] });
    let term = raw; let kind = 'name';
    const play = raw.match(/play\.google\.com\/.*[?&]id=([\w.]+)/i);
    const apple = raw.match(/apps\.apple\.com\/.*?\/id(\d+)/i);
    if (play) { term = play[1]; kind = 'package'; }
    else if (apple) { term = apple[1]; kind = 'appstore'; }
    else if (/^[a-z][\w]*(\.[\w]+){2,}$/i.test(raw)) kind = 'package';
    const last = kind === 'package' ? term.split('.').pop() : '';
    const words = last.length >= 6 ? [term, last] : [term]; // short last segments ("app", "pro") match far too much
    const likes = words.map((w) => `%${esc(w)}%`);
    const cond = likes.map((_, i) => `(app_name ILIKE $${i + 1} OR details_link ILIKE $${i + 1} OR target_domain ILIKE $${i + 1})`).join(' OR ');
    const apps = (await query(`${APP_SELECT} AND (${cond}) GROUP BY lower(app_name), advertiser_id ORDER BY live_ads DESC, ads DESC LIMIT 40`, likes)).rows;
    const ads = (await query(`SELECT ${COLS} FROM market_creatives WHERE (${cond}) ORDER BY last_shown DESC NULLS LAST LIMIT 24`, likes)).rows.map(mapCreative);
    res.json({ term, kind, apps, ads });
  } catch (err) { fail(res, 'lookup', err); }
});

/** Ad Compare: 2–4 ads side by side (CR ids). */
router.get('/compare', async (req, res) => {
  try {
    const ids = [...new Set(String(req.query.ids || '').split(/[\s,]+/).map((s) => (s.match(/CR\d{10,}/i) || [])[0]).filter(Boolean).map((s) => s.toUpperCase()))].slice(0, 4);
    if (!ids.length) return res.json({ ids: [], ads: [] });
    const { rows } = await query(`SELECT ${COLS} FROM market_creatives WHERE ad_creative_id = ANY($1)`, [ids]);
    const by = new Map(rows.map((r) => [r.ad_creative_id, mapCreative(r)]));
    res.json({ ids, ads: ids.map((i) => by.get(i)).filter(Boolean), missing: ids.filter((i) => !by.has(i)) });
  } catch (err) { fail(res, 'compare', err); }
});

/* ---------------- App Groups / Video Groups (your own keyword categories) ---------------- */
let groupsReady = null;
function ensureGroups() {
  if (!groupsReady) {
    groupsReady = query(
      `CREATE TABLE IF NOT EXISTS market_groups (
         id SERIAL PRIMARY KEY,
         kind TEXT NOT NULL CHECK (kind IN ('app', 'video')),
         name TEXT NOT NULL,
         keywords TEXT[] NOT NULL DEFAULT '{}',
         created_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`
    ).catch((e) => { groupsReady = null; throw e; });
  }
  return groupsReady;
}

const kwCond = (kws) => kws.map((_, i) => `(app_name ILIKE $${i + 1} OR advertiser_name ILIKE $${i + 1})`).join(' OR ');
const kwParams = (kws) => kws.map((k) => `%${esc(k)}%`);

async function groupStats(g) {
  const kws = g.keywords;
  if (!kws.length) return { ...g, apps: 0, ads: 0, live: 0, new_7d: 0, members: [] };
  const p = kwParams(kws);
  if (g.kind === 'app') {
    const apps = (await query(`${APP_SELECT} AND (${kwCond(kws)}) GROUP BY lower(app_name), advertiser_id ORDER BY live_ads DESC, ads DESC LIMIT 200`, p)).rows;
    return {
      ...g, apps: apps.length, ads: apps.reduce((n, a) => n + a.ads, 0), live: apps.reduce((n, a) => n + a.live_ads, 0),
      new_7d: apps.reduce((n, a) => n + a.new_7d, 0), members: apps.slice(0, 8),
    };
  }
  const vids = (await query(
    `SELECT youtube_id, count(*)::int AS ads, count(*) FILTER (WHERE last_shown >= now() - 3 * ${DAY})::int AS live,
            count(*) FILTER (WHERE first_shown >= now() - 7 * ${DAY})::int AS new_7d, max(app_name) AS app_name,
            (array_agg(app_icon) FILTER (WHERE app_icon IS NOT NULL))[1] AS app_icon, max(advertiser_name) AS advertiser_name
       FROM market_creatives WHERE youtube_id IS NOT NULL AND (${kwCond(kws)}) GROUP BY youtube_id ORDER BY live DESC, ads DESC LIMIT 200`, p
  )).rows;
  return {
    ...g, apps: vids.length, ads: vids.reduce((n, v) => n + v.ads, 0), live: vids.reduce((n, v) => n + v.live, 0),
    new_7d: vids.reduce((n, v) => n + v.new_7d, 0), members: vids.slice(0, 8),
  };
}

router.get('/groups', async (req, res) => {
  try {
    await ensureGroups();
    const kind = req.query.kind === 'video' ? 'video' : 'app';
    const { rows } = await query(`SELECT id, kind, name, keywords, created_at FROM market_groups WHERE kind = $1 ORDER BY name`, [kind]);
    res.json({ kind, groups: await Promise.all(rows.map(groupStats)) });
  } catch (err) { fail(res, 'groups', err); }
});

router.post('/groups', adminOnly, async (req, res) => {
  try {
    await ensureGroups();
    const kind = req.body?.kind === 'video' ? 'video' : 'app';
    const name = String(req.body?.name || '').trim().slice(0, 80);
    const keywords = [...new Set((Array.isArray(req.body?.keywords) ? req.body.keywords : String(req.body?.keywords || '').split(','))
      .map((k) => String(k).trim().toLowerCase().slice(0, 60)).filter((k) => k.length >= 2))].slice(0, 20);
    if (!name) return res.status(400).json({ error: 'Give the group a name.' });
    if (!keywords.length) return res.status(400).json({ error: 'Add at least one keyword (2+ characters).' });
    const { rows } = await query(`INSERT INTO market_groups (kind, name, keywords) VALUES ($1, $2, $3) RETURNING id, kind, name, keywords, created_at`, [kind, name, keywords]);
    res.json(await groupStats(rows[0]));
  } catch (err) { fail(res, 'groups.create', err); }
});

router.delete('/groups/:id', adminOnly, async (req, res) => {
  try {
    await ensureGroups();
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Bad id.' });
    await query(`DELETE FROM market_groups WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) { fail(res, 'groups.delete', err); }
});

module.exports = router;
