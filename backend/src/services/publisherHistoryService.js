/**
 * AdMob / AdSense history maintenance.
 *
 * 1. backfillTick(): walks every account's history BACKWARDS from the regular sync window, a few date chunks per
 *    run, remembering its position in publisher_backfill_state. Cron calls it every few minutes, so it keeps
 *    going (across runs and restarts) until it reaches the beginning of the account's data, then goes idle.
 *    "Beginning" = BACKFILL_EMPTY_STOP consecutive empty chunks (default 6 x 31 days) or the 2015 floor.
 *
 * 2. auditAll(): compares COMPLETE days (before today in the account's reporting timezone) with the LIVE
 *    AdMob / AdSense API and re-syncs any day that differs (or is missing, or whose breakdown / grain layers are
 *    empty or inconsistent), worst day first. Today is partial and is handled by the hourly sync.
 *
 * Env: PUBLISHER_BACKFILL=false disables backfill; PUBLISHER_BACKFILL_CHUNK_DAYS (31); PUBLISHER_BACKFILL_CHUNKS_PER_RUN (2);
 *      PUBLISHER_BACKFILL_EMPTY_STOP (6); PUBLISHER_BACKFILL_FLOOR (2015-01-01);
 *      PUBLISHER_AUDIT=false disables audit; PUBLISHER_AUDIT_DAYS (14); PUBLISHER_AUDIT_MAX_FIX_DAYS (6);
 *      PUBLISHER_AUDIT_TOL_USD (0.02).
 */
const logger = require('../utils/logger');
const { query } = require('../db');
const { getClientById } = require('../models/clientStore');
const { admobAccountStore, adsenseAccountStore } = require('../models/publisherAccountStore');
const { runWithClient } = require('../utils/clientContext');
const { todayInTZ, shiftYMD } = require('../utils/datetime');
const { syncAdMobAccount } = require('./admobSyncService');
const { syncAdSenseAccount } = require('./adsenseSyncService');
const { fetchAdMobNetworkReport } = require('../admob/client');
const { fetchAdSenseReport } = require('../adsense/client');

const PRODUCTS = {
  admob: {
    table: 'admob_accounts',
    store: admobAccountStore,
    sync: syncAdMobAccount,
    daily: 'admob_report_daily',
    layers: [
      { name: 'dim', sql: `SELECT report_date::text AS d, SUM(earnings)::float AS e FROM admob_dim_daily WHERE account_id = $1 AND dim_kind = 'app' AND report_date BETWEEN $2::date AND $3::date GROUP BY report_date` },
      { name: 'grain', sql: `SELECT report_date::text AS d, SUM(earnings)::float AS e FROM admob_grain_daily WHERE account_id = $1 AND report_date BETWEEN $2::date AND $3::date GROUP BY report_date` },
    ],
    tz: (a) => a.reportingTimeZone || undefined,
    live: (client, a, start, end) => fetchAdMobNetworkReport(client, {
      accountId: a.accountId, refreshToken: a.refreshToken, startDate: start, endDate: end,
      currencyCode: a.currencyCode || 'USD',
    }),
    lookback: () => parseInt(process.env.ADMOB_SYNC_LOOKBACK_DAYS || '30', 10) || 30,
  },
  adsense: {
    table: 'adsense_accounts',
    store: adsenseAccountStore,
    sync: syncAdSenseAccount,
    daily: 'adsense_report_daily',
    layers: [
      { name: 'dim', sql: `SELECT report_date::text AS d, SUM(earnings)::float AS e FROM adsense_dim_daily WHERE account_id = $1 AND dim_kind = 'site' AND report_date BETWEEN $2::date AND $3::date GROUP BY report_date` },
      { name: 'grain', sql: `SELECT report_date::text AS d, SUM(earnings)::float AS e FROM adsense_scope_grain_daily WHERE account_id = $1 AND report_date BETWEEN $2::date AND $3::date GROUP BY report_date` },
    ],
    tz: () => undefined,
    live: (client, a, start, end) => fetchAdSenseReport(client, {
      accountId: a.accountId, refreshToken: a.refreshToken, startDate: start, endDate: end,
    }),
    lookback: () => parseInt(process.env.ADSENSE_SYNC_LOOKBACK_DAYS || '30', 10) || 30,
  },
};

const num = (v) => Number(v) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cfg() {
  return {
    chunkDays: Math.min(92, Math.max(7, parseInt(process.env.PUBLISHER_BACKFILL_CHUNK_DAYS || '31', 10) || 31)),
    chunksPerRun: Math.max(1, parseInt(process.env.PUBLISHER_BACKFILL_CHUNKS_PER_RUN || '2', 10) || 2),
    emptyStop: Math.max(1, parseInt(process.env.PUBLISHER_BACKFILL_EMPTY_STOP || '6', 10) || 6),
    floor: process.env.PUBLISHER_BACKFILL_FLOOR || '2015-01-01',
    auditDays: Math.min(400, Math.max(2, parseInt(process.env.PUBLISHER_AUDIT_DAYS || '14', 10) || 14)),
    maxFix: Math.max(1, parseInt(process.env.PUBLISHER_AUDIT_MAX_FIX_DAYS || '6', 10) || 6),
    tol: Math.max(0.005, parseFloat(process.env.PUBLISHER_AUDIT_TOL_USD || '0.02') || 0.02),
    pauseMs: Math.max(0, parseInt(process.env.PUBLISHER_BACKFILL_PAUSE_MS || '1500', 10) || 0),
  };
}

async function ensureStateTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS publisher_backfill_state (
      product TEXT NOT NULL,
      account_id UUID NOT NULL,
      cursor_date DATE NOT NULL,
      empty_streak INT NOT NULL DEFAULT 0,
      fail_streak INT NOT NULL DEFAULT 0,
      rows_total BIGINT NOT NULL DEFAULT 0,
      done BOOLEAN NOT NULL DEFAULT false,
      last_error TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (product, account_id)
    )`);
}

async function listAccounts(product) {
  const { rows } = await query(
    `SELECT id, client_id FROM ${PRODUCTS[product].table}
     WHERE is_active = true AND google_refresh_token_enc IS NOT NULL AND NULLIF(TRIM(account_id), '') IS NOT NULL
     ORDER BY created_at ASC`
  );
  return rows;
}

/** Load a runnable account + its tenant client, or null. */
async function load(product, row) {
  const account = await PRODUCTS[product].store.getAccountById(row.id);
  if (!account?.refreshToken || !account?.accountId) return null;
  const client = await getClientById(account.clientId || row.client_id);
  return client ? { account, client } : null;
}

// ─── 1. continuous backfill ──────────────────────────────────────────────────────────────────────────────────

async function backfillAccount(product, row, c) {
  const P = PRODUCTS[product];
  const loaded = await load(product, row);
  if (!loaded) return { skipped: true };
  const { account, client } = loaded;

  let st = (await query(`SELECT * FROM publisher_backfill_state WHERE product = $1 AND account_id = $2`, [product, row.id])).rows[0];
  if (!st) {
    // Start just before the window the regular syncs already keep fresh.
    const today = todayInTZ(P.tz(account));
    const cursor = shiftYMD(today, -P.lookback() - 1);
    await query(
      `INSERT INTO publisher_backfill_state (product, account_id, cursor_date) VALUES ($1, $2, $3::date)
       ON CONFLICT DO NOTHING`, [product, row.id, cursor]);
    st = (await query(`SELECT * FROM publisher_backfill_state WHERE product = $1 AND account_id = $2`, [product, row.id])).rows[0];
  }
  if (st.done) return { done: true };

  let cursor = String(st.cursor_date).slice(0, 10);
  let empty = st.empty_streak;
  let fails = st.fail_streak;
  let total = Number(st.rows_total) || 0;
  let done = false;
  let lastError = null;

  await runWithClient(client, async () => {
    for (let i = 0; i < c.chunksPerRun && !done; i += 1) {
      const from = shiftYMD(cursor, -(c.chunkDays - 1));
      try {
        const r = await P.sync(account, { startDate: from, endDate: cursor, gamClient: client, fullDims: true });
        const n = r.rows || 0;
        total += n;
        empty = n === 0 ? empty + 1 : 0;
        fails = 0;
        lastError = null;
        logger.info(`[publisher-backfill] ${product} ${account.accountId} ${from}→${cursor}: ${n} fact rows (empty streak ${empty})`);
      } catch (e) {
        fails += 1;
        lastError = String(e.message || e).slice(0, 300);
        logger.warn(`[publisher-backfill] ${product} ${account.accountId} ${from}→${cursor} failed (${fails}): ${lastError}`);
        if (fails < 5) break; // retry the same chunk next run
        fails = 0; // give up on this chunk and move on (counted as empty so a permanent API limit ends the walk)
        empty += 1;
      }
      cursor = shiftYMD(from, -1);
      if (empty >= c.emptyStop || cursor < c.floor) done = true;
      if (!done) await sleep(c.pauseMs);
    }
  });

  await query(
    `UPDATE publisher_backfill_state
        SET cursor_date = $3::date, empty_streak = $4, fail_streak = $5, rows_total = $6, done = $7,
            last_error = $8, updated_at = now()
      WHERE product = $1 AND account_id = $2`,
    [product, row.id, cursor, empty, fails, total, done, lastError]);
  if (done) logger.info(`[publisher-backfill] ${product} ${account.accountId} COMPLETE — reached start of data (${total} fact rows)`);
  return { done, cursor };
}

let backfillRunning = false;
/** One pass over every account of both products. Cheap no-op once everything is complete. */
async function backfillTick() {
  if (process.env.PUBLISHER_BACKFILL === 'false' || backfillRunning) return;
  backfillRunning = true;
  const c = cfg();
  try {
    await ensureStateTable();
    for (const product of Object.keys(PRODUCTS)) {
      for (const row of await listAccounts(product)) {
        try {
          await backfillAccount(product, row, c);
        } catch (e) {
          logger.warn(`[publisher-backfill] ${product} ${row.id}: ${e.message}`);
        }
      }
    }
  } finally {
    backfillRunning = false;
  }
}

/** Restart the walk for an account (or all) — e.g. after connecting a new account. */
async function resetBackfill(product = null) {
  await ensureStateTable();
  await query(`DELETE FROM publisher_backfill_state WHERE ($1::text IS NULL OR product = $1)`, [product]);
}

// ─── 2. audit vs live API + auto-repair ──────────────────────────────────────────────────────────────────────

function mergeRanges(days) {
  const sorted = [...days].sort();
  const out = [];
  for (const d of sorted) {
    const last = out[out.length - 1];
    if (last && shiftYMD(last.end, 1) === d) last.end = d;
    else out.push({ start: d, end: d });
  }
  return out;
}

async function dbDaily(product, accountId, start, end) {
  const P = PRODUCTS[product];
  const { rows } = await query(
    `SELECT report_date::text AS d, SUM(earnings)::float AS e, SUM(impressions)::float AS i, SUM(clicks)::float AS k
       FROM ${P.daily} WHERE account_id = $1 AND report_date BETWEEN $2::date AND $3::date GROUP BY report_date`,
    [accountId, start, end]);
  return new Map(rows.map((r) => [r.d, r]));
}

/** Days (with a severity score) where the stored data disagrees with live. */
async function findBadDays(product, account, client, start, end, tol) {
  const P = PRODUCTS[product];
  const live = new Map();
  for (const r of await P.live(client, account, start, end)) {
    const d = String(r.reportDate || '').slice(0, 10);
    if (!d) continue;
    const cur = live.get(d) || { e: 0, i: 0, k: 0 };
    cur.e += num(r.earnings); cur.i += num(r.impressions); cur.k += num(r.clicks);
    live.set(d, cur);
  }
  const stored = await dbDaily(product, account.id, start, end);
  const layers = [];
  for (const l of P.layers) {
    const { rows } = await query(l.sql, [account.id, start, end]);
    layers.push({ name: l.name, map: new Map(rows.map((r) => [r.d, num(r.e)])) });
  }

  const bad = new Map();
  const flag = (d, score, why) => {
    const prev = bad.get(d);
    if (!prev || score > prev.score) bad.set(d, { score, why });
  };
  for (const d of new Set([...live.keys(), ...stored.keys()])) {
    const L = live.get(d) || { e: 0, i: 0, k: 0 };
    const S = stored.get(d);
    if (!S) { if (L.e > 0 || L.i > 0) flag(d, L.e + 1, 'missing'); continue; }
    const dE = Math.abs(num(S.e) - L.e);
    if (dE > Math.max(tol, L.e * 0.001)) flag(d, dE, `earnings ${num(S.e).toFixed(2)} vs live ${L.e.toFixed(2)}`);
    else if (Math.abs(num(S.i) - L.i) > Math.max(5, L.i * 0.001)) flag(d, 0.5, `impressions ${num(S.i)} vs live ${L.i}`);
    else if (Math.abs(num(S.k) - L.k) > Math.max(5, L.k * 0.001)) flag(d, 0.4, `clicks ${num(S.k)} vs live ${L.k}`);
    else if (L.e > 0) {
      // Fact row is right; make sure the breakdown / grain layers behind the other screens agree with it.
      for (const l of layers) {
        const v = l.map.get(d);
        if (v === undefined) flag(d, L.e * 0.5, `${l.name} layer empty`);
        else if (Math.abs(v - L.e) > Math.max(tol, L.e * 0.05)) flag(d, Math.abs(v - L.e) * 0.5, `${l.name} layer ${v.toFixed(2)} vs ${L.e.toFixed(2)}`);
      }
    }
  }
  return bad;
}

async function auditAccount(product, row, { days, maxFix } = {}) {
  const c = cfg();
  const P = PRODUCTS[product];
  const loaded = await load(product, row);
  if (!loaded) return { skipped: true };
  const { account, client } = loaded;
  const end = shiftYMD(todayInTZ(P.tz(account)), -1); // last COMPLETE day in the account's timezone
  const start = shiftYMD(end, -((days || c.auditDays) - 1));
  const result = { product, account: account.accountId, checked: `${start}→${end}`, bad: 0, fixed: 0, remaining: 0 };

  await runWithClient(client, async () => {
    const bad = await findBadDays(product, account, client, start, end, c.tol);
    result.bad = bad.size;
    if (!bad.size) return;
    const worst = [...bad.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, maxFix || c.maxFix);
    for (const [d, info] of worst) logger.warn(`[publisher-audit] ${product} ${account.accountId} ${d}: ${info.why} — re-syncing`);
    for (const r of mergeRanges(worst.map(([d]) => d))) {
      try {
        await P.sync(account, { startDate: r.start, endDate: r.end, gamClient: client, fullDims: true });
      } catch (e) {
        logger.warn(`[publisher-audit] ${product} ${account.accountId} repair ${r.start}→${r.end} failed: ${e.message}`);
      }
    }
    // Verify the repair against live again.
    const after = await findBadDays(product, account, client, start, end, c.tol);
    result.remaining = worst.filter(([d]) => after.has(d)).length;
    result.fixed = worst.length - result.remaining;
    if (result.remaining) {
      logger.warn(`[publisher-audit] ${product} ${account.accountId}: ${result.remaining} day(s) still differ after repair (live data may still be settling)`);
    }
  });
  logger.info(`[publisher-audit] ${product} ${account.accountId} ${result.checked}: ${result.bad} divergent, ${result.fixed} repaired, ${result.remaining} remaining`);
  return result;
}

let auditRunning = false;
async function auditAll(opts = {}) {
  if (process.env.PUBLISHER_AUDIT === 'false' || auditRunning) return [];
  auditRunning = true;
  const results = [];
  try {
    for (const product of Object.keys(PRODUCTS)) {
      for (const row of await listAccounts(product)) {
        try {
          results.push(await auditAccount(product, row, opts));
        } catch (e) {
          logger.warn(`[publisher-audit] ${product} ${row.id}: ${e.message}`);
        }
      }
    }
  } finally {
    auditRunning = false;
  }
  return results;
}

module.exports = { backfillTick, resetBackfill, auditAll, auditAccount, findBadDays };
