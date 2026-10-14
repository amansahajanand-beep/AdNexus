/**
 * Daily storage maintenance for the summary tables and background-report cache.
 *
 *  - Summary tables (rollup_fill_daily, rollup_request_daily, rollup_unit_country_daily,
 *    rollup_unit_country_fill) are derived data: rows older than SUMMARY_RETENTION_DAYS
 *    (default 180) are deleted. They can always be rebuilt from report_grain.
 *  - Old text-keyed 'ad_unit_country' rows (superseded by rollup_unit_country_fill) are removed.
 *  - report_adhoc (cache of background report jobs) rows whose REPORT DATE is older than
 *    ADHOC_RETENTION_DAYS (default 180) are removed.
 *  - Retention never goes below MIN_RETENTION_DAYS (180): the last 180 days are always kept,
 *    whatever the env says.
 *
 * Deletes run in small batches so no long lock is held and the disk is not flooded with WAL.
 */
const logger = require('../utils/logger');
const { query } = require('../db');

const MIN_RETENTION_DAYS = 180;
const BATCH = 20000;

function retentionFromEnv(name, fallback = MIN_RETENTION_DAYS) {
  const n = parseInt(process.env[name] || String(fallback), 10);
  return Math.max(MIN_RETENTION_DAYS, Number.isFinite(n) ? n : fallback);
}
const MAX_BATCHES = 400; // safety cap per table per run

async function deleteInBatches(label, selectCtidSql, params) {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i += 1) {
    const res = await query(
      `DELETE FROM ${label.table} WHERE ctid IN (${selectCtidSql} LIMIT ${BATCH})`,
      params
    );
    const n = res.rowCount || 0;
    total += n;
    if (n < BATCH) break;
    await new Promise((resolve) => setTimeout(resolve, 250)); // let readers breathe
  }
  return total;
}

async function pruneSummaryTables(retentionDays = retentionFromEnv('SUMMARY_RETENTION_DAYS')) {
  retentionDays = Math.max(MIN_RETENTION_DAYS, retentionDays);
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString().slice(0, 10);
  const tables = ['rollup_fill_daily', 'rollup_request_daily', 'rollup_unit_country_daily', 'rollup_unit_country_fill', 'rollup_roi_earn_daily'];
  const out = {};
  for (const table of tables) {
    try {
      out[table] = await deleteInBatches(
        { table },
        `SELECT ctid FROM ${table} WHERE report_date < $1::date`,
        [cutoff]
      );
    } catch (e) {
      logger.warn(`[storage] prune ${table} failed: ${e.message}`);
    }
  }
  return out;
}

/** The text-keyed ad unit x country rows are no longer read — drop them (batched). */
async function dropObsoleteTextRows() {
  const out = {};
  for (const table of ['rollup_fill_daily', 'rollup_request_daily']) {
    try {
      out[table] = await deleteInBatches(
        { table },
        `SELECT ctid FROM ${table} WHERE kind = 'ad_unit_country'`,
        []
      );
    } catch (e) {
      logger.warn(`[storage] obsolete rows ${table} failed: ${e.message}`);
    }
  }
  return out;
}

async function pruneAdhoc(retentionDays = retentionFromEnv('ADHOC_RETENTION_DAYS')) {
  retentionDays = Math.max(MIN_RETENTION_DAYS, retentionDays);
  try {
    return await deleteInBatches(
      { table: 'report_adhoc' },
      `SELECT ctid FROM report_adhoc WHERE report_date < CURRENT_DATE - $1::int`,
      [retentionDays]
    );
  } catch (e) {
    logger.warn(`[storage] prune report_adhoc failed: ${e.message}`);
    return 0;
  }
}

async function runStorageMaintenance() {
  const t0 = Date.now();
  const summary = await pruneSummaryTables();
  const obsolete = await dropObsoleteTextRows();
  const adhoc = await pruneAdhoc();
  logger.info(
    `[storage] maintenance done in ${Date.now() - t0}ms: summary=${JSON.stringify(summary)}`
    + ` obsolete=${JSON.stringify(obsolete)} report_adhoc=${adhoc}`
  );
  return { summary, obsolete, adhoc };
}

module.exports = { runStorageMaintenance, pruneSummaryTables, dropObsoleteTextRows, pruneAdhoc };
