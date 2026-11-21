/**
 * Per-app and per-site / per-day audit of report_grain (slices app_id + inventory_core) against LIVE GAM, with auto-repair.
 *
 * Why this exists: the existing reconcile job only compares the NETWORK total, and when that differs it
 * re-pulls only the network_kpi slice. Per-app rows could therefore stay wrong for days (GAM revises
 * recent days for invalid traffic; syncs run before the GAM day ends; queued re-syncs get pre-empted).
 *
 * Each run, per client:
 *   1. window = last AUDIT_DAYS complete days in the client's GAM (network) timezone — never "today",
 *      which is partial and handled by the hourly sync.
 *   2. one live GAM report: DATE x MOBILE_APP_RESOLVED_ID (CPM+CPC revenue, impressions).
 *   3. compare to SUM(revenue) per day/app in report_grain.
 *   4. days that differ get a full `sync-day` (same job the nightly resync uses), worst day first,
 *      capped at AUDIT_MAX_FIX_DAYS per run.
 *
 * Env: APP_GRAIN_AUDIT=false disables; APP_GRAIN_AUDIT_DAYS (default 14); APP_GRAIN_AUDIT_MAX_FIX_DAYS (default 6);
 *      APP_GRAIN_AUDIT_TOL_USD (default 0.05 per app/day).
 */
const logger = require('../utils/logger');
const { query } = require('../db');
const { todayInTZ, shiftYMD } = require('../utils/datetime');
const { getNetworkTz } = require('./networkTimezone');
const { getToken, buildDateXML, runReportAndDownload } = require('../gam/reportTransport');

const micros = (raw) => (parseFloat(raw) || 0) / 1e6;

function cfg() {
  return {
    days: Math.min(400, Math.max(2, parseInt(process.env.APP_GRAIN_AUDIT_DAYS || '14', 10) || 14)),
    maxFix: Math.max(1, parseInt(process.env.APP_GRAIN_AUDIT_MAX_FIX_DAYS || '6', 10) || 6),
    tol: Math.max(0.01, parseFloat(process.env.APP_GRAIN_AUDIT_TOL_USD || '0.05') || 0.05),
  };
}

/** Live GAM revenue per DATE x <gamDim>; keys are "YYYY-MM-DD|value" (lower-cased, trimmed). */
async function liveGamByDayDim(gamDim, start, end) {
  const token = await getToken();
  const xml = `
    <dimensions>DATE</dimensions>
    <dimensions>${gamDim}</dimensions>
    <columns>TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE</columns>
    ${buildDateXML(start, end)}
    <dateRangeType>CUSTOM_DATE</dateRangeType>`;
  const raw = await runReportAndDownload(xml, token);
  const out = new Map();
  for (const row of raw || []) {
    const day = String(row['Dimension.DATE'] || '').slice(0, 10);
    if (!day) continue;
    const val = String(row[`Dimension.${gamDim}`] || '').trim().toLowerCase();
    const key = `${day}|${val}`;
    out.set(key, (out.get(key) || 0) + micros(row['Column.TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE']));
  }
  return out;
}

/** What is checked: every app (app_id slice) and every site (inventory_core slice) of the network. */
const CHECKS = [
  {
    key: 'app',
    gamDim: 'MOBILE_APP_RESOLVED_ID',
    sql: `SELECT to_char(g.report_date, 'YYYY-MM-DD') AS day, lower(COALESCE(g.app_id, '')) AS k, SUM(g.revenue) AS revenue
            FROM report_grain g
           WHERE g.client_id = $1::uuid AND g.slice_key = 'app_id' AND g.report_date BETWEEN $2::date AND $3::date
           GROUP BY 1, 2`,
  },
  {
    key: 'site',
    gamDim: 'SITE_NAME',
    sql: `SELECT to_char(g.report_date, 'YYYY-MM-DD') AS day, lower(COALESCE(ds.name, '')) AS k, SUM(g.revenue) AS revenue
            FROM report_grain g
            LEFT JOIN dim_site ds ON ds.id = g.site_id AND ds.client_id = g.client_id
           WHERE g.client_id = $1::uuid AND g.slice_key = 'inventory_core' AND g.report_date BETWEEN $2::date AND $3::date
           GROUP BY 1, 2`,
  },
];

async function storedByDayKey(check, clientId, start, end) {
  const { rows } = await query(check.sql, [clientId, start, end]);
  const out = new Map();
  for (const r of rows) out.set(`${r.day}|${r.k}`, Number(r.revenue) || 0);
  return out;
}

/** Pure comparison: returns [{ day, apps, absDelta }] for days whose per-app revenue disagrees with GAM. */
function findDivergentDays(gam, db, tol) {
  const byDay = new Map();
  for (const key of new Set([...gam.keys(), ...db.keys()])) {
    const delta = (db.get(key) || 0) - (gam.get(key) || 0);
    if (Math.abs(delta) < tol) continue;
    const day = key.slice(0, 10);
    const cur = byDay.get(day) || { day, apps: 0, absDelta: 0 };
    cur.apps += 1;
    cur.absDelta += Math.abs(delta);
    byDay.set(day, cur);
  }
  return [...byDay.values()].sort((a, b) => b.absDelta - a.absDelta);
}

async function repairDay(client, day, inline = false) {
  const { gamSyncQueue, isSyncQueueEnabled } = require('../queues/gamSync');
  if (!inline && isSyncQueueEnabled()) {
    try {
      await gamSyncQueue.add('sync-day', { date: day, includeFull: false, clientId: client.id }, {
        // One repair per client/day per 3h bucket so a stuck day is retried, not stacked up.
        jobId: `app-audit-${String(client.id).slice(0, 8)}-${day}-${Math.floor(Date.now() / (3 * 3600 * 1000))}`,
        priority: 3,
        attempts: 2,
        backoff: { type: 'exponential', delay: 60000 },
      });
      return 'queued';
    } catch (e) {
      if (/JobId|already exists|duplicat/i.test(e.message || '')) return 'already-queued';
      throw e;
    }
  }
  const { streamSyncFromGAM } = require('./gamSyncService');
  await streamSyncFromGAM(day, day, 'sync-day');
  return 'resynced-inline';
}

/** Must run inside runWithClient(client). */
async function auditClient(client, opts = {}) {
  const { days, maxFix, tol } = { ...cfg(), ...opts };
  const tz = await getNetworkTz(client);
  // Explicit range (deep audit / CLI) or the default rolling window of complete days.
  const end = opts.end || shiftYMD(todayInTZ(tz), -1);
  const start = opts.start || shiftYMD(end, -(days - 1));
  // GAM reports in <=32-day chunks so a 6-month audit stays small per request. Apps and sites are both checked;
  // a day is divergent if either differs.
  const dayMap = new Map();
  const perCheck = {};
  for (const check of CHECKS) {
    const gam = new Map();
    for (let from = start; from <= end; from = shiftYMD(from, 32)) {
      const chunkEnd = shiftYMD(from, 31);
      for (const [k, v] of await liveGamByDayDim(check.gamDim, from, chunkEnd < end ? chunkEnd : end)) gam.set(k, v);
    }
    const db = await storedByDayKey(check, client.id, start, end);
    perCheck[check.key] = findDivergentDays(gam, db, tol);
    for (const d of perCheck[check.key]) {
      const cur = dayMap.get(d.day) || { day: d.day, apps: 0, sites: 0, absDelta: 0 };
      cur[`${check.key}s`] += d.apps;
      cur.absDelta += d.absDelta;
      dayMap.set(d.day, cur);
    }
  }
  const divergent = [...dayMap.values()].sort((a, b) => b.absDelta - a.absDelta);
  const toFix = divergent.slice(0, maxFix);
  const actions = [];
  if (!opts.dryRun) {
    for (const d of toFix) actions.push({ day: d.day, action: await repairDay(client, d.day, opts.inline === true) });
  }
  logger.info(
    `[app-audit] client=${String(client.id).slice(0, 8)} tz=${tz} ${start}..${end} divergentDays=${divergent.length}`
    + (toFix.length ? ` fixing=[${toFix.map((d) => `${d.day}(±$${d.absDelta.toFixed(2)})`).join(', ')}]` : ' all match')
  );
  return { start, end, tz, divergent, actions };
}

async function auditAllClients(opts = {}) {
  if (process.env.APP_GRAIN_AUDIT === 'false') return [];
  const { listActiveClients } = require('../models/clientStore');
  const { runWithClient } = require('../utils/clientContext');
  const results = [];
  for (const client of await listActiveClients()) {
    try {
      results.push({ client: client.name, ...(await runWithClient(client, () => auditClient(client, opts))) });
    } catch (e) {
      logger.warn(`[app-audit] client=${String(client.id).slice(0, 8)} failed: ${e.message}`);
    }
  }
  return results;
}

module.exports = { auditClient, auditAllClients, findDivergentDays };
