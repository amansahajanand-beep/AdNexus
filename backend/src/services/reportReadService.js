/**
 * Report read helpers — thin wrappers around sync DB reads used by HTTP handlers.
 * Keeps the DB-first → GAM-fallback policy in one place without changing behavior.
 */
function getSyncSvc() {
  try {
    return require('./gamSyncService');
  } catch (_) {
    return null;
  }
}

/**
 * Lean dashboard overview totals from Postgres (null if unavailable / empty).
 */
async function readLeanOverviewFromDb(filters = {}, opts = {}) {
  const sync = getSyncSvc();
  if (!sync?.fetchLeanOverviewTotalsFromDB) return null;
  return sync.fetchLeanOverviewTotalsFromDB(filters, opts);
}

/**
 * Lean dashboard bundle (summary + charts grain) from Postgres.
 */
async function readLeanDashboardBundleFromDb(filters = {}, opts = {}) {
  const sync = getSyncSvc();
  if (!sync?.fetchLeanDashboardBundleFromDB) return null;
  return sync.fetchLeanDashboardBundleFromDB(filters, opts);
}

/**
 * Historical range rows already synced into report_daily / present.
 */
async function readReportRangeFromStore(startDate, endDate, userId) {
  const sync = getSyncSvc();
  if (!sync?.getReportRange) return { rows: [] };
  return sync.getReportRange(startDate, endDate, userId);
}

module.exports = {
  readLeanOverviewFromDb,
  readLeanDashboardBundleFromDb,
  readReportRangeFromStore,
};
