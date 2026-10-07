/**
 * Hourly GAM sync — feeds the Dashboard timezone switch.
 *
 * GAM reports are bucketed by day in the network's timezone, so a different timezone's "day" cannot be rebuilt from
 * daily rows. This stores revenue / impressions / clicks per hour (network, domain × site, app) in rollup_hourly,
 * which the timezone view regroups into days.
 *
 * GAM rejects HOUR together with the Total-line-item columns for any inventory dimension, but accepts the Ad
 * Exchange columns, so the inventory and app slices use those; the network total uses the Total columns.
 */
const { query, withTransaction } = require('../db');
const logger = require('../utils/logger');
const { runWithClient } = require('../utils/clientContext');
const { parseGamRawColumnValue } = require('../utils/gamReportMetrics');
const { todayInTZ, shiftYMD } = require('../utils/datetime');
const { getNetworkTz } = require('./networkTimezone');

const TOTAL_COLS = {
  imp: 'TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS',
  clicks: 'TOTAL_LINE_ITEM_LEVEL_CLICKS',
  rev: 'TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE',
};
const ADX_COLS = {
  imp: 'AD_EXCHANGE_LINE_ITEM_LEVEL_IMPRESSIONS',
  clicks: 'AD_EXCHANGE_LINE_ITEM_LEVEL_CLICKS',
  rev: 'AD_EXCHANGE_LINE_ITEM_LEVEL_REVENUE',
};

/** `chunkDays` keeps each GAM report small (inventory slices are ~10k rows per day). */
const SLICES = [
  { kind: 'network', dims: ['DATE', 'HOUR'], cols: TOTAL_COLS, chunkDays: 31, a: null, b: null },
  { kind: 'inventory', dims: ['DATE', 'HOUR', 'DOMAIN', 'SITE_NAME'], cols: ADX_COLS, chunkDays: 2, a: 'DOMAIN', b: 'SITE_NAME' },
  { kind: 'app', dims: ['DATE', 'HOUR', 'MOBILE_APP_RESOLVED_ID'], cols: ADX_COLS, chunkDays: 2, a: null, b: 'MOBILE_APP_RESOLVED_ID' },
];
// Resolved id is not always allowed with HOUR; the app name is a safe fallback.
const APP_FALLBACK = { kind: 'app', dims: ['DATE', 'HOUR', 'MOBILE_APP_NAME'], cols: ADX_COLS, chunkDays: 2, a: null, b: 'MOBILE_APP_NAME' };

const clean = (v) => {
  const s = String(v == null ? '' : v).trim();
  return s === '-' || s === '—' ? '' : s;
};

function dateChunks(start, end, size) {
  const out = [];
  for (let d = start; d <= end; d = shiftYMD(d, size)) {
    const chunkEnd = shiftYMD(d, size - 1);
    out.push([d, chunkEnd < end ? chunkEnd : end]);
  }
  return out;
}

async function pullSlice(token, slice, start, end) {
  const { buildDateXML, runReportAndDownload } = require('../gam/reportTransport');
  const cols = [slice.cols.imp, slice.cols.rev, slice.cols.clicks];
  const xml = `${slice.dims.map((d) => `<dimensions>${d}</dimensions>`).join('')}`
    + `${cols.map((c) => `<columns>${c}</columns>`).join('')}`
    + `${buildDateXML(start, end)}<dateRangeType>CUSTOM_DATE</dateRangeType>`;
  return runReportAndDownload(xml, token);
}

/** Raw GAM rows → merged hourly rows keyed by date/hour/dims. */
function toHourlyRows(raw, slice) {
  const merged = new Map();
  for (const r of raw) {
    const date = clean(r['Dimension.DATE']);
    const hour = parseInt(r['Dimension.HOUR'], 10);
    if (!date || !Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    const a = slice.a ? clean(r[`Dimension.${slice.a}`]).toLowerCase() : '';
    const b = slice.b ? clean(r[`Dimension.${slice.b}`]) : '';
    if (slice.kind !== 'network' && !a && !b) continue;
    const key = `${date}|${hour}|${a}|${b}`;
    const cur = merged.get(key) || {
      date, hour, a, b: slice.kind === 'inventory' ? b.toLowerCase() : b, imp: 0, clicks: 0, rev: 0,
    };
    cur.imp += parseGamRawColumnValue(slice.cols.imp, r[`Column.${slice.cols.imp}`]);
    cur.clicks += parseGamRawColumnValue(slice.cols.clicks, r[`Column.${slice.cols.clicks}`]);
    cur.rev += parseGamRawColumnValue(slice.cols.rev, r[`Column.${slice.cols.rev}`]);
    merged.set(key, cur);
  }
  return [...merged.values()];
}

async function replaceHourly(clientId, kind, start, end, rows) {
  await withTransaction(async (q) => {
    await q(
      'DELETE FROM rollup_hourly WHERE client_id = $1::uuid AND kind = $2 AND report_date BETWEEN $3::date AND $4::date',
      [clientId, kind, start, end]
    );
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000);
      const values = [];
      const params = [];
      chunk.forEach((r, n) => {
        const o = n * 9;
        values.push(`($${o + 1}::uuid,$${o + 2}::date,$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9})`);
        params.push(clientId, r.date, r.hour, kind, r.a, r.b, Math.round(r.imp), Math.round(r.clicks), +r.rev.toFixed(6));
      });
      await q(
        `INSERT INTO rollup_hourly (client_id, report_date, hour, kind, dim_a, dim_b, impressions, clicks, revenue)
         VALUES ${values.join(',')}
         ON CONFLICT (client_id, report_date, hour, kind, dim_a, dim_b) DO UPDATE SET
           impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks, revenue = EXCLUDED.revenue`,
        params
      );
    }
  });
}

/** One slice over a date range, chunked. Returns rows written. */
async function syncSlice(client, token, slice, start, end) {
  let written = 0;
  for (const [from, to] of dateChunks(start, end, slice.chunkDays)) {
    let raw;
    let used = slice;
    try {
      raw = await pullSlice(token, slice, from, to);
    } catch (err) {
      if (slice.kind !== 'app') throw err;
      used = APP_FALLBACK;
      raw = await pullSlice(token, APP_FALLBACK, from, to);
    }
    const rows = toHourlyRows(raw, used);
    await replaceHourly(client.id, slice.kind, from, to, rows);
    written += rows.length;
  }
  return written;
}

/** Sync every slice for one client over [start, end]. A failing slice is logged and skipped. */
async function syncHourlyForClient(client, { startDate, endDate }) {
  return runWithClient(client, async () => {
    const { getToken } = require('../gam/reportTransport');
    const token = await getToken();
    const result = {};
    for (const slice of SLICES) {
      try {
        result[slice.kind] = await syncSlice(client, token, slice, startDate, endDate);
      } catch (err) {
        result[slice.kind] = `error: ${String(err.message || err).slice(0, 120)}`;
        logger.warn(`Hourly sync ${slice.kind} client=${String(client.id).slice(0, 8)} ${startDate}..${endDate}: ${err.message}`);
      }
    }
    logger.info(`Hourly sync client=${String(client.id).slice(0, 8)} ${startDate}..${endDate} ${JSON.stringify(result)}`);
    return result;
  });
}

/**
 * Refresh the network total (the Dashboard cards) straight from GAM. The full today-sync pulls six large reports
 * and writes this total last, so on a busy network the cards can lag by an hour or more; this is one 5-second
 * report. Same code path as the queued `sync-network-kpi` job, just not waiting behind the queue.
 */
async function refreshNetworkKpi(client, dates) {
  const { streamSyncFromGAM } = require('./gamSyncService');
  const out = {};
  for (const day of dates) {
    try {
      await runWithClient(client, () => streamSyncFromGAM(day, day, 'sync-network-kpi'));
      out[day] = 'ok';
    } catch (err) {
      out[day] = `error: ${String(err.message || err).slice(0, 80)}`;
      logger.warn(`Network total refresh ${day} client=${String(client.id).slice(0, 8)}: ${err.message}`);
    }
  }
  return out;
}

const quickRefresh = new Map(); // client id -> { at, promise }
const QUICK_COOLDOWN_MS = 3 * 60 * 1000;

/**
 * Pull just the network's hourly totals for yesterday and today (one small Ad Manager report) so a timezone view
 * is not left waiting for the next cron tick. Shared between concurrent callers and rate-limited per network.
 * The heavier site and app hours follow in the background. Resolves true when fresh hours were stored.
 */
function refreshNetworkHours(client) {
  const prev = quickRefresh.get(client.id);
  if (prev && (prev.promise.pending || Date.now() - prev.at < QUICK_COOLDOWN_MS)) return prev.promise;
  const promise = (async () => {
    const { getToken } = require('../gam/reportTransport');
    const end = todayInTZ(await getNetworkTz(client));
    const start = shiftYMD(end, -1);
    const wrote = await runWithClient(client, async () => syncSlice(client, await getToken(), SLICES[0], start, end));
    // Site and app hours: not needed for the totals, so they must not block the response.
    setImmediate(() => syncHourlyForClient(client, { startDate: start, endDate: end }).catch(() => {}));
    return wrote > 0;
  })().catch((err) => {
    logger.warn(`Quick hourly refresh failed client=${String(client.id).slice(0, 8)}: ${err.message}`);
    return false;
  }).finally(() => { promise.pending = false; });
  promise.pending = true;
  quickRefresh.set(client.id, { at: Date.now(), promise });
  return promise;
}

let running = false;

/** Today + yesterday for every active network (hourly cron). */
async function syncHourlyRecent({ days = 2 } = {}) {
  if (running) return { skipped: true };
  running = true;
  try {
    const { listActiveClients } = require('../models/clientStore');
    let last = null;
    for (const client of await listActiveClients()) {
      // Ad Manager's days and hours follow the network's own timezone, so "today" is that zone's date.
      const end = todayInTZ(await getNetworkTz(client));
      const start = shiftYMD(end, -(days - 1));
      await refreshNetworkKpi(client, [end, ...(days > 1 ? [shiftYMD(end, -1)] : [])]);
      await syncHourlyForClient(client, { startDate: start, endDate: end });
      last = { start, end };
    }
    return { ok: true, ...(last || {}) };
  } finally {
    running = false;
  }
}

/** Dates in the window that have fewer than 24 network hours stored (today is allowed to be partial). */
async function missingDates(clientId, start, end) {
  const { rows } = await query(
    `SELECT to_char(d::date, 'YYYY-MM-DD') AS day
     FROM generate_series($2::date, $3::date, interval '1 day') d
     LEFT JOIN (
       SELECT report_date, COUNT(DISTINCT hour) AS hrs FROM rollup_hourly
       WHERE client_id = $1::uuid AND kind = 'network' AND report_date BETWEEN $2::date AND $3::date
       GROUP BY report_date
     ) h ON h.report_date = d::date
     WHERE COALESCE(h.hrs, 0) < 24
     ORDER BY d`,
    [clientId, start, end]
  );
  return rows.map((r) => r.day);
}

/**
 * Backfill the last `days` days, newest first, at most `maxDays` per call so a restart never floods GAM.
 * Safe to call repeatedly: only days without a full 24 hours are fetched.
 */
async function ensureHourlyCoverage({ days = 30, maxDays = 6, clientId = null } = {}) {
  if (running) return { skipped: true };
  running = true;
  try {
    const { listActiveClients } = require('../models/clientStore');
    const out = {};
    for (const client of await listActiveClients()) {
      if (clientId && client.id !== clientId) continue;
      const today = todayInTZ(await getNetworkTz(client));
      const yesterday = shiftYMD(today, -1);
      const missing = (await missingDates(client.id, shiftYMD(yesterday, -(days - 1)), yesterday)).reverse().slice(0, maxDays);
      if (!missing.length) { out[client.id] = 0; continue; }
      const sorted = [...missing].sort();
      await syncHourlyForClient(client, { startDate: sorted[0], endDate: sorted[sorted.length - 1] });
      out[client.id] = missing.length;
    }
    return out;
  } finally {
    running = false;
  }
}

module.exports = {
  syncHourlyForClient, syncHourlyRecent, ensureHourlyCoverage, refreshNetworkKpi, refreshNetworkHours, SLICES,
};
