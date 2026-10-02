/**
 * Nightly pre-warm: analyze each user's pinned presets for "Yesterday" and "Last 7 days" so the
 * analysis is already stored when they open the Presets page. The stored result is keyed by the
 * content of the fact sheet, so it is used whenever the data is unchanged.
 */
const cron = require('node-cron');
const { query } = require('../../db');
const { getUserById } = require('../../models/userStore');
const { mintInternalToken } = require('../../middleware/auth');
const { resolveAiAccess } = require('../flags');
const { todayInTZ, shiftYMD } = require('../../utils/datetime');
const logger = require('../../utils/logger');
const { analyzePreset } = require('./index');

// Preset page -> what to analyze. GAM Reporting is left out: it reads live reports and is slow.
const TARGETS = {
  dashboard: { product: 'gam', kind: 'dashboard' },
  roi: { product: 'gam', kind: 'roi' },
  admob: { product: 'admob', kind: 'dashboard' },
  'admob-reporting': { product: 'admob', kind: 'reporting' },
  'admob-roi': { product: 'admob', kind: 'roi' },
  adsense: { product: 'adsense', kind: 'dashboard' },
  'adsense-reporting': { product: 'adsense', kind: 'reporting' },
  'adsense-roi': { product: 'adsense', kind: 'roi' },
};

const ACTIVE_WITHIN_MS = 14 * 24 * 3600 * 1000;
const PAUSE_MS = 200;

function ranges() {
  const yesterday = shiftYMD(todayInTZ(), -1);
  return [
    { startDate: yesterday, endDate: yesterday },
    { startDate: shiftYMD(yesterday, -6), endDate: yesterday },
  ];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pinnedByUser() {
  const { rows } = await query(
    `SELECT user_id, page, items FROM user_report_presets WHERE page = ANY($1::text[]) AND items <> '[]'::jsonb`,
    [Object.keys(TARGETS)]
  );
  const users = new Map();
  for (const r of rows) {
    const pinned = (r.items || []).filter((p) => p && p.pinned && p.snapshot);
    if (!pinned.length) continue;
    if (!users.has(r.user_id)) users.set(r.user_id, []);
    users.get(r.user_id).push(...pinned.map((p) => ({ page: r.page, snapshot: p.snapshot, pinnedAt: p.pinnedAt || 0 })));
  }
  return users;
}

/**
 * @param {{maxAnalyses?: number, maxPerUser?: number}} [opts]
 * @returns {Promise<{users: number, analyses: number, failed: number, skipped: number}>}
 */
async function prewarmPinnedPresets({ maxAnalyses = 100, maxPerUser = 4 } = {}) {
  const stats = { users: 0, analyses: 0, failed: 0, skipped: 0 };
  const byUser = await pinnedByUser();
  const windows = ranges();

  for (const [userId, presets] of byUser) {
    if (stats.analyses >= maxAnalyses) break;
    let user;
    try { user = await getUserById(userId); } catch { user = null; }
    const recentLogin = user?.lastLogin && Date.now() - Date.parse(user.lastLogin) < ACTIVE_WITHIN_MS;
    if (!user || !user.isActive || !recentLogin) { stats.skipped += 1; continue; }
    const token = mintInternalToken(user);
    if (!token) { stats.skipped += 1; continue; }
    const access = await resolveAiAccess(user);
    if (!access.enabled) { stats.skipped += 1; continue; }

    stats.users += 1;
    const chosen = presets.sort((a, b) => b.pinnedAt - a.pinnedAt).slice(0, maxPerUser);
    for (const preset of chosen) {
      for (const w of windows) {
        if (stats.analyses >= maxAnalyses) break;
        stats.analyses += 1;
        try {
          await analyzePreset({
            authorization: `Bearer ${token}`,
            ctx: { userId: user.id, clientId: user.clientId || null },
            body: { ...TARGETS[preset.page], ...w, filters: preset.snapshot, depth: 'fast' },
          });
        } catch (err) {
          stats.failed += 1;
          logger.warn(`ai prewarm ${preset.page} for ${user.id}: ${err.message}`);
        }
        await sleep(PAUSE_MS);
      }
    }
  }
  logger.info(`ai prewarm done: ${JSON.stringify(stats)}`);
  return stats;
}

function startPrewarmCron() {
  if (process.env.AI_PREWARM_ENABLED !== 'true') return;
  const expr = process.env.AI_PREWARM_CRON || '30 6 * * *';
  cron.schedule(expr, () => {
    prewarmPinnedPresets({
      maxAnalyses: parseInt(process.env.AI_PREWARM_MAX, 10) || 100,
    }).catch((err) => logger.error('ai prewarm failed:', err.message));
  }, { timezone: process.env.APP_TIMEZONE || 'Asia/Singapore' });
  logger.info(`ai prewarm scheduled (${expr})`);
}

module.exports = { prewarmPinnedPresets, startPrewarmCron };
