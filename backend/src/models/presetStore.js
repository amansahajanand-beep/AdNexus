/**
 * Saved report presets, stored per user and per page as one JSON list.
 * Mirrors the browser-side shape ({ id, name, snapshot, summary, when, pinned, pinnedAt })
 * so the client can keep localStorage as a fast local copy.
 */
const { query } = require('../db');

const PAGES = new Set([
  'dashboard', 'reporting', 'roi',
  'admob', 'admob-reporting', 'admob-roi',
  'adsense', 'adsense-reporting', 'adsense-roi',
]);
const MAX_ITEMS = 50;
const NAME_MAX = 40;
const MAX_ITEM_BYTES = 16 * 1024;

function isValidPage(page) {
  return PAGES.has(String(page || ''));
}

/** Keep only the fields we own, bound sizes, and drop malformed entries. */
function sanitizeItems(items) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || !raw.id || !raw.snapshot || typeof raw.snapshot !== 'object') continue;
    const id = String(raw.id).slice(0, 80);
    if (seen.has(id)) continue;
    const item = {
      id,
      name: String(raw.name || '').trim().slice(0, NAME_MAX) || 'Untitled preset',
      snapshot: raw.snapshot,
      summary: String(raw.summary || '').slice(0, 300),
      when: Number(raw.when) || Date.now(),
      pinned: Boolean(raw.pinned),
      pinnedAt: raw.pinnedAt ? Number(raw.pinnedAt) || null : null,
    };
    if (Buffer.byteLength(JSON.stringify(item), 'utf8') > MAX_ITEM_BYTES) continue;
    seen.add(id);
    out.push(item);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

async function getAll(userId) {
  const { rows } = await query(
    'SELECT page, items, version, updated_at FROM user_report_presets WHERE user_id = $1',
    [String(userId)]
  );
  const pages = {};
  for (const r of rows) {
    pages[r.page] = { items: r.items || [], version: r.version, updatedAt: r.updated_at };
  }
  return pages;
}

/**
 * Replace one page's list. `baseVersion` is the version the client last saw (0 = never synced).
 * Returns { ok: true, version, items } or { ok: false, conflict: { items, version } }.
 */
async function putPage(userId, page, items, baseVersion) {
  const clean = sanitizeItems(items);
  const base = Math.max(0, parseInt(baseVersion, 10) || 0);
  const uid = String(userId);

  if (base === 0) {
    const ins = await query(
      `INSERT INTO user_report_presets (user_id, page, items, version)
       VALUES ($1, $2, $3::jsonb, 1)
       ON CONFLICT (user_id, page) DO NOTHING
       RETURNING version`,
      [uid, page, JSON.stringify(clean)]
    );
    if (ins.rows[0]) return { ok: true, version: ins.rows[0].version, items: clean };
  } else {
    const upd = await query(
      `UPDATE user_report_presets
       SET items = $3::jsonb, version = version + 1, updated_at = now()
       WHERE user_id = $1 AND page = $2 AND version = $4
       RETURNING version`,
      [uid, page, JSON.stringify(clean), base]
    );
    if (upd.rows[0]) return { ok: true, version: upd.rows[0].version, items: clean };
  }

  const cur = await query(
    'SELECT items, version FROM user_report_presets WHERE user_id = $1 AND page = $2',
    [uid, page]
  );
  const row = cur.rows[0];
  return { ok: false, conflict: { items: row?.items || [], version: row?.version || 0 } };
}

module.exports = { isValidPage, sanitizeItems, getAll, putPage, MAX_ITEMS };
