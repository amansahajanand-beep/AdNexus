/**
 * Compare DB network totals vs live GAM and auto-fix divergent days.
 * Used by npm start boot, cron schedules, BullMQ workers, and debug scripts.
 */
const logger = require('../utils/logger');
const { parseGamMetricValue } = require('../utils/gamReportMetrics');
const { todayInTZ, shiftYMD, historicalRangeForPresets } = require('../utils/datetime');
const {
  fetchNetworkDayRow,
  fetchNetworkTotalsFromDB,
  updateNetworkReconciliation,
  writeReconciliationLog,
  getLastReconciliationSummary,
  rebuildNetworkRollupsFromGrain,
} = require('./networkRollupStore');
const { gamSyncQueue, isSyncQueueEnabled } = require('../queues/gamSync');

/** Float noise only — pass/fail is cent-exact, not a 1% band. */
const CENT_EPS = 0.005;

function roundCents(value) {
  return +Number(value || 0).toFixed(2);
}

function revenuesMatchCents(dbRev, gamRev) {
  return Math.abs(roundCents(dbRev) - roundCents(gamRev)) < CENT_EPS;
}

/** @deprecated Kept for status JSON; matching is cent-exact (0). */
function reconcileDeltaPct() {
  return 0;
}

function reconcileOnBoot() {
  return process.env.RECONCILE_ON_BOOT !== 'false';
}

function reconcileBootDays() {
  return Math.max(1, parseInt(process.env.RECONCILE_BOOT_DAYS || '30', 10) || 30);
}

function reconcileBatchDays() {
  return Math.max(1, parseInt(process.env.RECONCILE_GAM_BATCH_DAYS || '7', 10) || 7);
}

function listDaysBetween(startDate, endDate) {
  const out = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    out.push(cursor);
    cursor = shiftYMD(cursor, 1);
  }
  return out;
}

function computeDeltaPct(dbRev, gamRev) {
  const db = roundCents(dbRev);
  const gam = roundCents(gamRev);
  if (gam <= 0 && db <= 0) return 0;
  if (gam <= 0) return 100;
  return Math.abs((db - gam) / gam) * 100;
}

async function fetchLiveGamNetworkTotal(day) {
  const { getToken, buildDateXML, runReportAndDownload } = require('../gam/reportTransport');
  const token = await getToken();
  const xml = `
    <dimensions>DATE</dimensions>
    <columns>TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS</columns>
    <columns>TOTAL_LINE_ITEM_LEVEL_ALL_REVENUE</columns>
    ${buildDateXML(day, day)}
    <dateRangeType>CUSTOM_DATE</dateRangeType>`;
  const raw = await runReportAndDownload(xml, token);
  let impressions = 0;
  let revenue = 0;
  for (const row of raw || []) {
    impressions += parseInt(row['Column.TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS'] || 0, 10) || 0;
    revenue += parseGamMetricValue(
      'TOTAL_LINE_ITEM_LEVEL_ALL_REVENUE',
      row['Column.TOTAL_LINE_ITEM_LEVEL_ALL_REVENUE']
    );
  }
  return {
    impressions: Math.round(impressions),
    revenue: +Number(revenue).toFixed(2),
  };
}

async function fetchLiveGamNetworkRange(startDate, endDate) {
  const { getToken, buildDateXML, runReportAndDownload } = require('../gam/reportTransport');
  const token = await getToken();
  const xml = `
    <dimensions>DATE</dimensions>
    <columns>TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS</columns>
    <columns>TOTAL_LINE_ITEM_LEVEL_ALL_REVENUE</columns>
    ${buildDateXML(startDate, endDate)}
    <dateRangeType>CUSTOM_DATE</dateRangeType>`;
  const raw = await runReportAndDownload(xml, token);
  const byDay = new Map();
  for (const row of raw || []) {
    const day = String(row['Dimension.DATE'] || row['Dimension.date'] || '').slice(0, 10);
    if (!day) continue;
    const cur = byDay.get(day) || { impressions: 0, revenue: 0 };
    cur.impressions += parseInt(row['Column.TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS'] || 0, 10) || 0;
    cur.revenue += parseGamMetricValue(
      'TOTAL_LINE_ITEM_LEVEL_ALL_REVENUE',
      row['Column.TOTAL_LINE_ITEM_LEVEL_ALL_REVENUE']
    );
    byDay.set(day, cur);
  }
  for (const [day, v] of byDay) {
    byDay.set(day, {
      impressions: Math.round(v.impressions),
      revenue: +Number(v.revenue).toFixed(2),
    });
  }
  return byDay;
}

async function fetchDbNetworkTotal(day) {
  const row = await fetchNetworkDayRow(day);
  if (!row) return { impressions: 0, revenue: 0, missing: true };
  return {
    impressions: Math.round(Number(row.impressions) || 0),
    revenue: roundCents(row.revenue),
    missing: false,
  };
}

async function compareDay(day, opts = {}) {
  const skipGam = opts.skipGam === true;
  const db = await fetchDbNetworkTotal(day);
  let gam = { impressions: 0, revenue: 0 };
  if (!skipGam) {
    try {
      gam = await fetchLiveGamNetworkTotal(day);
    } catch (e) {
      logger.warn(`Reconciliation GAM fetch failed for ${day}:`, e.message);
      return { day, dbRev: db.revenue, gamRev: null, deltaPct: null, ok: false, error: e.message };
    }
  }
  const deltaPct = computeDeltaPct(db.revenue, gam.revenue);
  const ok = revenuesMatchCents(db.revenue, gam.revenue);
  return {
    day,
    dbRev: db.revenue,
    dbImp: db.impressions,
    gamRev: gam.revenue,
    gamImp: gam.impressions,
    deltaPct: +deltaPct.toFixed(2),
    ok,
  };
}

async function compareRange(startDate, endDate, opts = {}) {
  const days = listDaysBetween(startDate, endDate);
  const divergent = [];
  const results = [];

  if (days.length <= reconcileBatchDays() && opts.skipGam !== true) {
    try {
      const gamByDay = await fetchLiveGamNetworkRange(startDate, endDate);
      for (const day of days) {
        const db = await fetchDbNetworkTotal(day);
        const gamPresent = gamByDay.has(day);
        const gam = gamByDay.get(day) || { impressions: 0, revenue: 0 };
        // Missing from GAM CSV is not "0 vs 0 OK" — that day still needs a pull.
        const ok = gamPresent && revenuesMatchCents(db.revenue, gam.revenue);
        const deltaPct = computeDeltaPct(db.revenue, gam.revenue);
        const row = {
          day,
          dbRev: db.revenue,
          gamRev: gamPresent ? gam.revenue : null,
          deltaPct: gamPresent ? +deltaPct.toFixed(2) : null,
          ok,
        };
        results.push(row);
        if (!ok) divergent.push(row);
      }
      return { results, divergent, startDate, endDate };
    } catch (e) {
      logger.warn(`Reconciliation batch GAM fetch failed ${startDate}..${endDate}:`, e.message);
    }
  }

  for (const day of days) {
    const row = await compareDay(day, opts);
    results.push(row);
    if (!row.ok && row.gamRev != null) divergent.push(row);
  }
  return { results, divergent, startDate, endDate };
}

async function enqueueResyncDay(day, reason = 'reconcile-fix') {
  if (!isSyncQueueEnabled()) {
    const { streamSyncFromGAM } = require('./gamSyncService');
    await streamSyncFromGAM(day, day, reason, { kpiOnly: true });
    await rebuildNetworkRollupsFromGrain([day], reason);
    return { inline: true };
  }
  return enqueueNetworkKpiDay(day);
}

async function enqueueNetworkKpiDay(day) {
  const { requireClientId } = require('../utils/clientContext');
  const cid = requireClientId();
  try {
    await gamSyncQueue.add('sync-network-kpi', {
      date: day,
      clientId: cid,
    }, {
      jobId: `sync-network-kpi-${cid.slice(0, 8)}-${day}`,
      priority: 1,
      attempts: 2,
      backoff: { type: 'exponential', delay: 20000 },
    });
    return { queued: true };
  } catch (e) {
    if (/JobId|already exists|duplicat/i.test(e.message || '')) {
      return { queued: false, existing: true };
    }
    throw e;
  }
}

async function fixDay(day, opts = {}) {
  const cmp = await compareDay(day, opts);
  if (cmp.gamRev == null) {
    await writeReconciliationLog(day, cmp.dbRev, 0, null, 'gam_error');
    return { ...cmp, action: 'gam_error' };
  }
  if (cmp.ok) {
    await updateNetworkReconciliation(day, {
      gamRevenue: cmp.gamRev,
      deltaPct: cmp.deltaPct,
      impressions: cmp.gamImp || cmp.dbImp,
      revenue: cmp.gamRev,
    });
    await writeReconciliationLog(day, cmp.dbRev, cmp.gamRev, cmp.deltaPct, 'ok');
    return { ...cmp, action: 'ok' };
  }
  await writeReconciliationLog(day, cmp.dbRev, cmp.gamRev, cmp.deltaPct, 'fix');
  if (opts.dryRun) {
    return { ...cmp, action: 'would_fix' };
  }
  await enqueueResyncDay(day, 'reconcile-fix');
  return { ...cmp, action: 'fix' };
}

async function fixRange(startDate, endDate, opts = {}) {
  const { divergent } = await compareRange(startDate, endDate, opts);
  const fixed = [];
  for (const row of divergent) {
    const res = await fixDay(row.day, opts);
    fixed.push(res);
  }
  return { checked: listDaysBetween(startDate, endDate).length, divergent: divergent.length, fixed };
}

async function reconcileDayJob(day) {
  const res = await fixDay(day);
  if (res.action === 'fix') {
    await new Promise((r) => setTimeout(r, 5000));
    const after = await compareDay(day);
    if (after.gamRev != null && !after.ok) {
      logger.warn(`Reconciliation ${day} still divergent after fix: ${after.deltaPct}%`);
    }
  }
  return res;
}

async function reconcileRecentDays() {
  const today = todayInTZ();
  const yesterday = shiftYMD(today, -1);
  logger.info(`Reconciliation recent: ${yesterday} + ${today}`);
  return fixRange(yesterday, today);
}

async function reconcileHistoricalWindow() {
  const hist = historicalRangeForPresets();
  const endDate = hist.yesterday || shiftYMD(todayInTZ(), -1);
  const startDate = hist.startDate;
  logger.info(`Reconciliation historical: ${startDate} → ${endDate}`);
  let fixed = 0;
  let checked = 0;
  const batch = reconcileBatchDays();
  let cursor = startDate;
  while (cursor <= endDate) {
    const batchEnd = shiftYMD(cursor, batch - 1);
    const winEnd = batchEnd > endDate ? endDate : batchEnd;
    const res = await fixRange(cursor, winEnd);
    checked += res.checked;
    fixed += res.fixed.length;
    cursor = shiftYMD(winEnd, 1);
  }
  logger.info(`Reconciliation historical done: checked=${checked} fix_enqueued=${fixed}`);
  return { checked, fixed };
}

async function runBootReconciliation() {
  if (!reconcileOnBoot()) {
    logger.info('Reconciliation boot skipped (RECONCILE_ON_BOOT=false)');
    return;
  }
  try {
    const today = todayInTZ();
    const yesterday = shiftYMD(today, -1);
    logger.info('Reconciliation boot: comparing today + yesterday vs live GAM…');
    const recent = await fixRange(yesterday, today);
    logger.info(`Reconciliation boot: recent_divergent=${recent.divergent} — starting historical drain`);
    const drain = await drainIncompleteHistory();
    const summary = await getLastReconciliationSummary();
    logger.info(
      `Reconciliation boot complete: recent_divergent=${recent.divergent}`
      + ` drain_missing=${drain.missing} drain_queued=${drain.queued}`
      + (summary.worstDeltaPct != null ? ` worst_delta=${summary.worstDeltaPct}%` : '')
    );
    return { recent, drain, summary };
  } catch (e) {
    logger.error('Reconciliation boot failed:', e.message);
    throw e;
  }
}

const drainInFlight = new Set();

async function drainIncompleteHistory() {
  const { isTodayPriorityActive } = require('./syncPriorityGate');
  if (await isTodayPriorityActive()) {
    return { missing: 0, queued: 0, skipped: true, reason: 'today-priority' };
  }
  const { requireClientId, getClientId } = require('../utils/clientContext');
  let cid;
  try {
    cid = getClientId?.() || requireClientId();
  } catch (_) {
    cid = 'unknown';
  }
  if (drainInFlight.has(cid)) {
    return { missing: 0, queued: 0, skipped: true };
  }
  drainInFlight.add(cid);
  try {
    const hist = historicalRangeForPresets();
    const endDate = hist.yesterday || shiftYMD(todayInTZ(), -1);
    const startDate = hist.startDate;
    const { listMissingGrainDates } = require('./gamSyncService');
    const missing = await listMissingGrainDates(startDate, endDate);
    if (!missing.length) {
      logger.info(`Drain: historical window complete (${startDate} → ${endDate})`);
      return { missing: 0, queued: 0, startDate, endDate };
    }
    const batch = missing.slice(0, 7);
    let queued = 0;
    for (const day of batch) {
      const res = await enqueueNetworkKpiDay(day);
      if (res.queued) queued += 1;
    }
    logger.info(
      `Drain: ${missing.length} day(s) still incomplete ${startDate} → ${endDate};`
      + ` queued sync-network-kpi for ${batch.join(', ')}`
    );
    return { missing: missing.length, queued, days: batch, startDate, endDate };
  } catch (e) {
    logger.warn('Drain incomplete history failed:', e.message);
    return { missing: 0, queued: 0, error: e.message };
  } finally {
    drainInFlight.delete(cid);
  }
}

async function getReconciliationStatus() {
  const summary = await getLastReconciliationSummary();
  const { getSyncHealthPublic } = require('./syncHealthStore');
  const health = await getSyncHealthPublic();
  let reconciliationStatus = 'healthy';
  if (summary.recentDivergent > 0 || summary.recentFixes > 0) reconciliationStatus = 'fixing';
  else if (summary.worstDeltaPct != null && summary.worstDeltaPct > 0) {
    reconciliationStatus = 'divergent';
  }
  return {
    ...summary,
    ...health,
    reconciliationStatus,
    reconcileDeltaPct: 0,
  };
}

async function getNetworkRangeCoverage(startDate, endDate) {
  const { listNetworkCoverageDates } = require('./networkRollupStore');
  const missingDates = await listNetworkCoverageDates(startDate, endDate);
  const days = listDaysBetween(startDate, endDate);
  const totalDays = days.length;
  const missingDays = missingDates.length;
  const coveredDays = Math.max(0, totalDays - missingDays);
  return {
    totalDays,
    coveredDays,
    missingDays,
    missingDates,
    complete: missingDays === 0,
    revenueConfidence: missingDays === 0 ? 'verified' : (coveredDays > 0 ? 'partial' : 'none'),
  };
}

module.exports = {
  reconcileDeltaPct,
  revenuesMatchCents,
  roundCents,
  fetchLiveGamNetworkTotal,
  fetchDbNetworkTotal,
  compareDay,
  compareRange,
  fixDay,
  fixRange,
  enqueueResyncDay,
  enqueueNetworkKpiDay,
  drainIncompleteHistory,
  reconcileDayJob,
  reconcileRecentDays,
  reconcileHistoricalWindow,
  runBootReconciliation,
  getReconciliationStatus,
  getNetworkRangeCoverage,
};
